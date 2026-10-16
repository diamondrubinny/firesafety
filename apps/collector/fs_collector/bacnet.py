"""BACnet/IP access (read-only). Uses only: Who-Is/I-Am, ReadProperty,
ReadPropertyMultiple, GetEventInformation, and *receiving* event notifications.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from bacpypes3.apdu import (
    ConfirmedEventNotificationRequest,
    ConfirmedRequestPDU,
    Error,
    GetEventInformationACK,
    GetEventInformationRequest,
    SimpleAckPDU,
    UnconfirmedEventNotificationRequest,
)
from bacpypes3.app import Application
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.networkport import NetworkPortObject
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import ObjectIdentifier

from .state import ObjKey, ObjState

log = logging.getLogger(__name__)

LS_TYPES = ("life-safety-point", "life-safety-zone")
NotificationHandler = Callable[[int, ObjKey, ObjState, dict[str, Any], Address], Awaitable[None]]


def key_of(oid: Any) -> ObjKey:
    return (str(oid[0]), int(oid[1]))


def enum_str(v: Any) -> str | None:
    return None if v is None else str(v)


def timestamp_iso(ts: Any) -> str | None:
    """Best-effort conversion of a BACnet TimeStamp (dateTime choice) to ISO 8601.
    Panel clock and time zone are not trusted for ordering; observedAt is used for that."""
    try:
        dt = ts.dateTime
        if dt is None:
            return None
        d, t = dt.date, dt.time
        local = datetime(d[0] + 1900, d[1], d[2], t[0], t[1], t[2], (t[3] or 0) * 10_000)
        return local.astimezone(timezone.utc).isoformat()
    except Exception:  # noqa: BLE001 - malformed/unspecified timestamps are expected from some panels
        return None


# Incoming confirmed services this device answers. Anything else (e.g. write requests that
# would modify the collector's own Device/NetworkPort objects) is refused.
ALLOWED_INCOMING_CONFIRMED = {
    2,   # confirmedEventNotification
    12,  # readProperty
    14,  # readPropertyMultiple
}


class CollectorApplication(Application):
    """Local BACnet device that listens for event notifications addressed to it."""

    on_notification: NotificationHandler | None = None

    async def indication(self, apdu: Any) -> None:  # type: ignore[override]
        if isinstance(apdu, ConfirmedRequestPDU) and int(apdu.apduService) not in ALLOWED_INCOMING_CONFIRMED:
            await self.response(Error(service_choice=apdu.apduService, errorClass="services", errorCode="serviceRequestDenied", context=apdu))
            return
        await super().indication(apdu)

    async def _handle(self, apdu: Any) -> None:
        try:
            values = apdu.eventValues
            cols = getattr(values, "changeOfLifeSafety", None) if values is not None else None
            state = ObjState(
                event_state=enum_str(apdu.toState),
                life_safety_state=enum_str(cols.newState) if cols is not None else None,
                mode=enum_str(cols.newMode) if cols is not None else None,
            )
            meta = {
                "sourceTs": timestamp_iso(apdu.timeStamp),
                "priority": int(apdu.priority) if apdu.priority is not None else None,
                "messageText": str(apdu.messageText)[:512] if apdu.messageText is not None else None,
            }
            device = int(apdu.initiatingDeviceIdentifier[1])
            if self.on_notification:
                await self.on_notification(device, key_of(apdu.eventObjectIdentifier), state, meta, apdu.pduSource)
        except Exception:  # noqa: BLE001 - never let a malformed notification break the stack
            log.exception("failed to process event notification")

    async def do_UnconfirmedEventNotificationRequest(self, apdu: UnconfirmedEventNotificationRequest) -> None:  # noqa: N802
        await self._handle(apdu)

    async def do_ConfirmedEventNotificationRequest(self, apdu: ConfirmedEventNotificationRequest) -> None:  # noqa: N802
        # Acknowledging receipt of the notification is required by the protocol;
        # it does NOT acknowledge the alarm on the panel.
        await self.response(SimpleAckPDU(context=apdu))
        await self._handle(apdu)


def create_application(address: str, device_id: int) -> CollectorApplication:
    objects = [
        DeviceObject(
            objectIdentifier=("device", device_id),
            objectName=f"fs-collector-{device_id}",
            vendorIdentifier=999,  # 999 = "reserved for testing"; no vendor id has been assigned
            description="Supplementary fire monitoring collector (read-only)",
        ),
        NetworkPortObject(address, objectIdentifier=("network-port", 1), objectName="NP-1"),
    ]
    return CollectorApplication.from_object_list(objects)


class PanelClient:
    def __init__(self, app: Application, address: str, instance: int, timeout: float) -> None:
        self.app = app
        self.addr = Address(address)
        self.instance = instance
        self.timeout = timeout

    async def _req(self, coro: Awaitable[Any]) -> Any:
        return await asyncio.wait_for(coro, self.timeout)

    async def device_info(self) -> dict[str, str | None]:
        res = await self._req(
            self.app.read_property_multiple(
                self.addr, [ObjectIdentifier(("device", self.instance)), ["objectName", "vendorName", "modelName"]]
            )
        )
        values = {str(prop): val for _, prop, _, val in res}
        return {
            "name": _text(values.get("object-name")),
            "vendor": _text(values.get("vendor-name")),
            "model": _text(values.get("model-name")),
        }

    async def event_information(self) -> dict[ObjKey, ObjState]:
        """All objects in a non-normal event state (paged GetEventInformation)."""
        result: dict[ObjKey, ObjState] = {}
        last = None
        for _ in range(1000):  # hard stop against a misbehaving device
            req = GetEventInformationRequest(destination=self.addr)
            if last is not None:
                req.lastReceivedObjectIdentifier = last
            ack = await self._req(self.app.request(req))
            if not isinstance(ack, GetEventInformationACK):
                raise RuntimeError(f"unexpected GetEventInformation response: {type(ack).__name__}")
            for s in ack.listOfEventSummaries or []:
                result[key_of(s.objectIdentifier)] = ObjState(event_state=enum_str(s.eventState))
                last = s.objectIdentifier
            if not ack.moreEvents or not ack.listOfEventSummaries:
                break
        return result

    async def read_states(self, keys: list[ObjKey], chunk: int = 20) -> dict[ObjKey, dict[str, Any]]:
        """presentValue / outOfService / mode / reliability (+ optional names) for life-safety objects."""
        out: dict[ObjKey, dict[str, Any]] = {}
        wanted = [k for k in keys if k[0] in LS_TYPES]
        for i in range(0, len(wanted), chunk):
            args: list[Any] = []
            for k in wanted[i : i + chunk]:
                args += [ObjectIdentifier(k), ["presentValue", "outOfService", "mode", "reliability", "eventState"]]
            res = await self._req(self.app.read_property_multiple(self.addr, args))
            for oid, prop, _, val in res:
                out.setdefault(key_of(oid), {})[str(prop)] = val
        return out

    async def object_list(self) -> list[ObjKey]:
        oid = ObjectIdentifier(("device", self.instance))
        try:
            values = await self._req(self.app.read_property(self.addr, oid, "objectList"))
            return [key_of(v) for v in values]
        except Exception:  # noqa: BLE001 - large lists may need element-by-element reading
            count = int(await self._req(self.app.read_property(self.addr, oid, "objectList", 0)))
            items = []
            for i in range(1, count + 1):
                items.append(key_of(await self._req(self.app.read_property(self.addr, oid, "objectList", i))))
            return items

    async def object_names(self, keys: list[ObjKey], chunk: int = 20) -> dict[ObjKey, dict[str, str | None]]:
        out: dict[ObjKey, dict[str, str | None]] = {}
        for i in range(0, len(keys), chunk):
            args: list[Any] = []
            for k in keys[i : i + chunk]:
                args += [ObjectIdentifier(k), ["objectName", "description"]]
            res = await self._req(self.app.read_property_multiple(self.addr, args))
            for oid, prop, _, val in res:
                out.setdefault(key_of(oid), {})[str(prop)] = _text(val)
        return out


def state_from_props(props: dict[str, Any], event_state: str | None = None) -> ObjState:
    oos = props.get("out-of-service")
    return ObjState(
        event_state=event_state if event_state is not None else enum_str(props.get("event-state")),
        life_safety_state=enum_str(props.get("present-value")),
        out_of_service=None if oos is None or isinstance(oos, Exception) else bool(oos),
        reliability=enum_str(props.get("reliability")),
        mode=enum_str(props.get("mode")),
    )


def _text(v: Any) -> str | None:
    if v is None or isinstance(v, Exception):
        return None
    return str(v)[:512]
