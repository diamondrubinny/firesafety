"""Collector orchestration: poll panels, track state, buffer, upload."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import __version__
from .bacnet import PanelClient, state_from_props
from .config import Config, PanelTarget
from .outbox import Outbox
from .state import Change, DeviceState, ObjKey, ObjState
from .uplink import Uplink, UplinkError

log = logging.getLogger(__name__)

MAX_EVENTS_PER_BATCH = 1000
MAX_POINTS_PER_BATCH = 2000


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PanelRuntime:
    target: PanelTarget
    client: PanelClient
    state: DeviceState = field(default_factory=DeviceState)
    online: bool = False
    failures: int = 0
    last_error: str | None = None
    info: dict[str, str | None] = field(default_factory=dict)
    last_snapshot: float = 0.0
    synced: bool = False  # first full poll done since (re)connect


class Collector:
    def __init__(self, config: Config, clients: dict[int, PanelClient], outbox: Outbox, uplink: Uplink) -> None:
        self.config = config
        self.outbox = outbox
        self.uplink = uplink
        self.panels = {t.instance: PanelRuntime(t, clients[t.instance]) for t in config.panels}
        self.started = time.monotonic()
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()

    # ---- events -------------------------------------------------------------------

    def _emit(self, device: int, changes: list[Change], source: str, meta: dict[str, Any] | None = None) -> None:
        for ch in changes:
            s: ObjState = ch.state
            self.outbox.append(
                "event",
                {
                    "deviceInstance": device,
                    "objectType": ch.key[0],
                    "objectInstance": ch.key[1],
                    "source": source,
                    "observedAt": utcnow(),
                    "eventState": s.event_state,
                    "lifeSafetyState": s.life_safety_state,
                    "outOfService": s.out_of_service,
                    "reliability": s.reliability,
                    "mode": s.mode,
                    **(meta or {}),
                },
            )
        if changes:
            self._wake.set()

    async def on_notification(self, device: int, key: ObjKey, state: ObjState, meta: dict[str, Any], source: Any = None) -> None:
        panel = self.panels.get(device)
        if panel is None:
            log.warning("notification from unconfigured device %s ignored", device)
            return
        # The device id inside the message is not proof of origin: require the configured panel address.
        if source is not None and source != panel.client.addr:
            log.warning("notification claiming device %s from unexpected address %s ignored", device, source)
            return
        self._emit(device, panel.state.apply_notification(key, state), "notification", meta)

    # ---- polling ------------------------------------------------------------------

    async def poll_panel(self, p: PanelRuntime) -> None:
        try:
            if not p.info:
                p.info = await p.client.device_info()
            abnormal = await p.client.event_information()
            # Enrich with life-safety state for objects that are, or were, abnormal.
            keys = sorted(set(abnormal) | set(p.state.reported))
            props = await p.client.read_states(keys) if keys else {}
            view = {k: state_from_props(props.get(k, {}), event_state=abnormal[k].event_state) for k in abnormal}
            # Read-back values of objects that left the event list (e.g. "quiet" after an alarm).
            changes = p.state.apply_scan({k: state_from_props(v) for k, v in props.items() if k not in abnormal})
            changes += p.state.apply_event_view(view)
            self._emit(p.target.instance, changes, "poll")
            self._mark_online(p)
            now = time.monotonic()
            if not p.synced or now - p.last_snapshot >= self.config.snapshot_interval:
                self._snapshot(p)
                p.last_snapshot = now
                p.synced = True
        except Exception as err:  # noqa: BLE001 - any failure counts against panel health
            self._mark_failure(p, err)

    async def scan_panel(self, p: PanelRuntime) -> None:
        """Inventory: names/descriptions for the server and out-of-service/disabled detection."""
        try:
            objects = [k for k in await p.client.object_list() if k[0] in self.config.object_types]
            names = await p.client.object_names(objects)
            props = await p.client.read_states(objects)
            changes = p.state.apply_scan({k: state_from_props(v) for k, v in props.items()})
            self._emit(p.target.instance, changes, "inventory")
            for i in range(0, len(objects), 200):
                self.outbox.append(
                    "points",
                    {
                        "points": [
                            {
                                "deviceInstance": p.target.instance,
                                "objectType": k[0],
                                "objectInstance": k[1],
                                **{kk: vv for kk, vv in (("name", names.get(k, {}).get("object-name")), ("description", names.get(k, {}).get("description"))) if vv},
                            }
                            for k in objects[i : i + 200]
                        ]
                    },
                )
            self._wake.set()
        except Exception as err:  # noqa: BLE001
            log.warning("inventory of device %s failed: %s", p.target.instance, type(err).__name__)

    def _snapshot(self, p: PanelRuntime) -> None:
        self.outbox.append(
            "snapshot",
            {
                "deviceInstance": p.target.instance,
                "takenAt": utcnow(),
                "nonNormal": [{"objectType": t, "objectInstance": i} for t, i in p.state.non_normal_keys()],
            },
        )
        self._wake.set()

    def _mark_online(self, p: PanelRuntime) -> None:
        if not p.online:
            log.info("device %s online", p.target.instance)
            self._wake.set()
        p.online, p.failures, p.last_error = True, 0, None

    def _mark_failure(self, p: PanelRuntime, err: Exception) -> None:
        p.failures += 1
        p.last_error = type(err).__name__ if not isinstance(err, asyncio.TimeoutError) else "timeout"
        if p.online and p.failures >= self.config.offline_after_failures:
            log.warning("device %s offline after %s failures (%s)", p.target.instance, p.failures, p.last_error)
            p.online = False
            p.synced = False  # resync (snapshot) on reconnect
            self._wake.set()
        elif p.failures == 1:
            log.info("device %s request failed: %s", p.target.instance, p.last_error)

    # ---- upload -------------------------------------------------------------------

    def build_batch(self) -> tuple[dict[str, Any], list[int], int]:
        """Returns (batch, seqs of 'points' items to drop on success, max event/snapshot seq)."""
        events: list[dict[str, Any]] = []
        snapshots: list[dict[str, Any]] = []
        points: list[dict[str, Any]] = []
        points_seqs: list[int] = []
        max_seq = 0
        for item in self.outbox.pending(limit=2000):
            if item.kind == "points":
                if len(points) + len(item.payload["points"]) > MAX_POINTS_PER_BATCH:
                    break
                points.extend(item.payload["points"])
                points_seqs.append(item.seq)
            else:
                if len(events) + len(snapshots) >= MAX_EVENTS_PER_BATCH:
                    break
                (events if item.kind == "event" else snapshots).append({"seq": item.seq, **item.payload})
                max_seq = item.seq
        devices = [
            {
                "instance": p.target.instance,
                "address": p.target.address,
                "online": p.online,
                **{k: v for k, v in p.info.items() if v},
                **({"error": p.last_error} if p.last_error and not p.online else {}),
            }
            for p in self.panels.values()
            # Report a device only after the first attempt, so startup does not flap "offline".
            if p.online or p.failures >= self.config.offline_after_failures
        ]
        batch = {
            "epoch": self.outbox.epoch,
            "sentAt": utcnow(),
            "collector": {
                "version": __version__,
                "uptimeSeconds": int(time.monotonic() - self.started),
                "bufferDepth": self.outbox.depth(),
            },
            "devices": devices,
            "points": points,
            "events": events,
            "snapshots": snapshots,
        }
        return batch, points_seqs, max_seq

    async def flush(self) -> bool:
        """Sends one batch. Items are deleted only after the server confirms them."""
        batch, points_seqs, max_seq = self.build_batch()
        acked = await asyncio.to_thread(self.uplink.send, batch)
        if acked > 0:
            self.outbox.delete_through(min(acked, max_seq) if max_seq else 0)
        if points_seqs:
            self.outbox.delete(points_seqs)
        return bool(batch["events"] or batch["snapshots"] or batch["points"])

    # ---- loops --------------------------------------------------------------------

    async def poll_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.gather(*(self.poll_panel(p) for p in self.panels.values()))
            await self._sleep(self.config.poll_interval)

    async def scan_loop(self) -> None:
        while not self._stop.is_set():
            for p in self.panels.values():
                await self.scan_panel(p)
            await self._sleep(self.config.inventory_interval)

    async def uplink_loop(self) -> None:
        backoff = 1.0
        last_sent = 0.0
        while not self._stop.is_set():
            try:
                timeout = max(0.0, self.config.heartbeat_interval - (time.monotonic() - last_sent))
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout)
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()
                more = True
                while more and not self._stop.is_set():
                    more = await self.flush() and self.outbox.depth() > 0
                last_sent = time.monotonic()
                backoff = 1.0
            except UplinkError as err:
                # Never drop events: keep them in the outbox and retry with backoff.
                (log.warning if err.retryable else log.error)("%s (buffered: %s)", err, self.outbox.depth())
                await self._sleep(backoff if err.retryable else 30.0)
                backoff = min(backoff * 2, 30.0)
                self._wake.set()

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), seconds)
        except asyncio.TimeoutError:
            pass

    async def run(self) -> None:
        await asyncio.gather(self.poll_loop(), self.scan_loop(), self.uplink_loop())

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
