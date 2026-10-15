"""Configuration from environment variables (no secrets in code or logs)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

_DEVICE_RE = re.compile(r"^(?P<instance>\d{1,7})@(?P<address>[0-9A-Za-z.:\-\[\]/]+)$")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class PanelTarget:
    instance: int
    address: str


@dataclass(frozen=True)
class Config:
    server_url: str
    token: str
    bacnet_address: str
    bacnet_device_id: int
    panels: tuple[PanelTarget, ...]
    outbox_path: str = "collector-outbox.sqlite3"
    ca_file: str | None = None
    poll_interval: float = 5.0
    snapshot_interval: float = 60.0
    inventory_interval: float = 300.0
    heartbeat_interval: float = 15.0
    request_timeout: float = 5.0
    offline_after_failures: int = 3
    object_types: tuple[str, ...] = ("life-safety-point", "life-safety-zone")
    log_level: str = "INFO"
    extra: dict[str, str] = field(default_factory=dict)

    def redacted(self) -> dict[str, object]:
        """Safe-to-log view of the configuration."""
        return {
            "server_url": self.server_url,
            "token": "***",
            "bacnet_address": self.bacnet_address,
            "bacnet_device_id": self.bacnet_device_id,
            "panels": [f"{p.instance}@{p.address}" for p in self.panels],
            "poll_interval": self.poll_interval,
            "object_types": list(self.object_types),
        }


def parse_panels(value: str) -> tuple[PanelTarget, ...]:
    panels = []
    for raw in filter(None, (v.strip() for v in value.split(","))):
        m = _DEVICE_RE.match(raw)
        if not m:
            raise ConfigError(f"FS_PANELS entry must be <instance>@<address>: {raw!r}")
        instance = int(m["instance"])
        if instance > 4_194_302:
            raise ConfigError(f"BACnet device instance out of range: {instance}")
        panels.append(PanelTarget(instance, m["address"]))
    if not panels:
        raise ConfigError("FS_PANELS must list at least one panel")
    if len({p.instance for p in panels}) != len(panels):
        raise ConfigError("FS_PANELS contains duplicate device instances")
    return tuple(panels)


def load_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)

    def req(key: str) -> str:
        v = env.get(key, "").strip()
        if not v:
            raise ConfigError(f"{key} is required")
        return v

    server_url = req("FS_SERVER_URL").rstrip("/")
    allow_http = env.get("FS_ALLOW_INSECURE_HTTP") == "1"
    if not server_url.startswith("https://") and not (allow_http and server_url.startswith("http://")):
        raise ConfigError("FS_SERVER_URL must use https:// (FS_ALLOW_INSECURE_HTTP=1 only for local development)")
    token = req("FS_COLLECTOR_TOKEN")
    if not re.fullmatch(r"fsc_[A-Za-z0-9_-]{20,100}", token):
        raise ConfigError("FS_COLLECTOR_TOKEN has an invalid format")

    def num(key: str, default: float, lo: float, hi: float) -> float:
        raw = env.get(key)
        if raw is None or raw == "":
            return default
        try:
            v = float(raw)
        except ValueError as err:
            raise ConfigError(f"{key} must be a number") from err
        if not lo <= v <= hi:
            raise ConfigError(f"{key} must be between {lo} and {hi}")
        return v

    device_id = int(num("FS_BACNET_DEVICE_ID", -1, 0, 4_194_302))
    if device_id < 0:
        raise ConfigError("FS_BACNET_DEVICE_ID is required (unique on the BACnet network)")

    object_types = tuple(t.strip() for t in env.get("FS_OBJECT_TYPES", "life-safety-point,life-safety-zone").split(",") if t.strip())

    return Config(
        server_url=server_url,
        token=token,
        bacnet_address=req("FS_BACNET_ADDRESS"),
        bacnet_device_id=device_id,
        panels=parse_panels(req("FS_PANELS")),
        outbox_path=env.get("FS_OUTBOX_PATH", "collector-outbox.sqlite3"),
        ca_file=env.get("FS_CA_FILE") or None,
        poll_interval=num("FS_POLL_INTERVAL", 5.0, 1.0, 300.0),
        snapshot_interval=num("FS_SNAPSHOT_INTERVAL", 60.0, 10.0, 3600.0),
        inventory_interval=num("FS_INVENTORY_INTERVAL", 300.0, 30.0, 86_400.0),
        heartbeat_interval=num("FS_HEARTBEAT_INTERVAL", 15.0, 5.0, 60.0),
        request_timeout=num("FS_REQUEST_TIMEOUT", 5.0, 1.0, 60.0),
        offline_after_failures=int(num("FS_OFFLINE_AFTER_FAILURES", 3, 1, 20)),
        object_types=object_types,
        log_level=env.get("FS_LOG_LEVEL", "INFO").upper(),
    )
