"""Pure state tracking: turns panel observations into change events.

Two independent sources describe each object:
  * the event view (GetEventInformation and EventNotifications): objects in a
    non-normal event state, with their life-safety state;
  * the scan view (periodic inventory reads): out-of-service, mode and
    reliability, which panels may not report as events (e.g. disabled points).
The effective state merges both; an event is emitted whenever it changes.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable

ObjKey = tuple[str, int]  # (object type, instance)


@dataclass(frozen=True)
class ObjState:
    event_state: str | None = "normal"
    life_safety_state: str | None = None
    out_of_service: bool | None = None
    reliability: str | None = None
    mode: str | None = None

    def is_normal(self) -> bool:
        """Mirror of the server's categorize() == 'normal' (kept deliberately conservative)."""
        return (
            self.event_state in (None, "normal")
            and self.life_safety_state in (None, "quiet")
            and not self.out_of_service
            and self.reliability in (None, "no-fault-detected")
            and self.mode not in ("disabled", "off")
        )


    def semantic(self) -> tuple[object, ...]:
        """Comparison key: equivalent encodings (e.g. reliability None vs no-fault-detected,
        out-of-service None vs False) must not produce duplicate events."""
        return (
            self.event_state or "normal",
            self.life_safety_state or "quiet",
            bool(self.out_of_service),
            self.reliability or "no-fault-detected",
            self.mode if self.mode in ("disabled", "off") else None,
        )


NORMAL = ObjState()


@dataclass(frozen=True)
class Change:
    key: ObjKey
    state: ObjState


class DeviceState:
    def __init__(self) -> None:
        self.events: dict[ObjKey, ObjState] = {}
        self.scan: dict[ObjKey, ObjState] = {}
        self.reported: dict[ObjKey, ObjState] = {}

    def effective(self, key: ObjKey) -> ObjState:
        ev = self.events.get(key)
        sc = self.scan.get(key)
        if ev and sc:
            return replace(
                ev,
                out_of_service=sc.out_of_service if ev.out_of_service is None else ev.out_of_service,
                reliability=ev.reliability or sc.reliability,
                mode=ev.mode or sc.mode,
            )
        if ev:
            return ev
        if sc:
            # Scan data alone (e.g. a disabled point, or the read-back value after an alarm cleared).
            return replace(sc, event_state=sc.event_state or "normal")
        return NORMAL

    def _diff(self, keys: Iterable[ObjKey]) -> list[Change]:
        changes = []
        for key in sorted(set(keys)):
            new = self.effective(key)
            old = self.reported.get(key, NORMAL)
            if new.semantic() != old.semantic():
                changes.append(Change(key, new))
                if new.is_normal():
                    self.reported.pop(key, None)
                else:
                    self.reported[key] = new
        return changes

    def apply_event_view(self, abnormal: dict[ObjKey, ObjState]) -> list[Change]:
        """Full replacement of the event view (from a complete GetEventInformation poll)."""
        touched = set(self.events) | set(abnormal)
        self.events = {k: v for k, v in abnormal.items() if not v.is_normal()}
        return self._diff(touched | set(self.reported))

    def apply_notification(self, key: ObjKey, state: ObjState) -> list[Change]:
        if state.is_normal():
            self.events.pop(key, None)
        else:
            self.events[key] = state
        return self._diff([key])

    def apply_scan(self, scanned: dict[ObjKey, ObjState]) -> list[Change]:
        """Full replacement of the scan view for the scanned objects."""
        touched = set(scanned) | {k for k in self.scan if k in scanned}
        for k, v in scanned.items():
            self.scan[k] = v
        return self._diff(touched)

    def non_normal_keys(self) -> list[ObjKey]:
        return sorted(self.reported)
