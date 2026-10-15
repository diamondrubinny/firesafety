"""Simulated fire panel exposing LifeSafetyPoint objects over BACnet/IP.

Implements the panel side of GetEventInformation (paged) and sends
UnconfirmedEventNotification (change-of-life-safety) to configured recipients.
"""

from __future__ import annotations

import logging
from typing import Any

from bacpypes3.apdu import GetEventInformationACK, GetEventInformationRequest, UnconfirmedEventNotificationRequest
from bacpypes3.app import Application
from bacpypes3.basetypes import (
    DateTime,
    EventState,
    EventTransitionBits,
    GetEventInformationEventSummary,
    NotificationParameters,
    TimeStamp,
)
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.networkport import NetworkPortObject
from bacpypes3.object import LifeSafetyPointObject
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import Date, ObjectIdentifier, Time

log = logging.getLogger(__name__)

# Simulated state -> (presentValue, eventState, outOfService)
STATES: dict[str, tuple[str, str, bool]] = {
    "quiet": ("quiet", "normal", False),
    "alarm": ("alarm", "life-safety-alarm", False),
    "pre-alarm": ("pre-alarm", "offnormal", False),
    "fault": ("fault", "fault", False),
    "supervisory": ("supervisory", "offnormal", False),
    "disabled": ("quiet", "normal", True),
    "test-alarm": ("test-alarm", "offnormal", False),
}


class SimulatedPanel(Application):
    page_size = 25
    offline = False
    recipients: list[Address]

    async def indication(self, apdu: Any) -> None:  # type: ignore[override]
        if self.offline:
            return  # simulate a dead link: no response at all
        await super().indication(apdu)

    def points(self) -> list[LifeSafetyPointObject]:
        return sorted(
            (o for o in self.objectIdentifier.values() if isinstance(o, LifeSafetyPointObject)),
            key=lambda o: o.objectIdentifier[1],
        )

    async def do_GetEventInformationRequest(self, apdu: GetEventInformationRequest) -> None:  # noqa: N802
        after = apdu.lastReceivedObjectIdentifier
        candidates = [
            o for o in self.points()
            if o.eventState != EventState.normal and (after is None or o.objectIdentifier[1] > after[1])
        ]
        page = candidates[: self.page_size]
        summaries = [
            GetEventInformationEventSummary(
                objectIdentifier=o.objectIdentifier,
                eventState=o.eventState,
                acknowledgedTransitions=EventTransitionBits([1, 1, 1]),
                eventTimeStamps=[TimeStamp(sequenceNumber=0)] * 3,
                notifyType="alarm",
                eventEnable=EventTransitionBits([1, 1, 1]),
                eventPriorities=[1, 1, 1],
            )
            for o in page
        ]
        await self.response(
            GetEventInformationACK(listOfEventSummaries=summaries, moreEvents=len(candidates) > len(page), context=apdu)
        )

    async def set_state(self, instance: int, name: str) -> None:
        if name not in STATES:
            raise ValueError(f"unknown state {name!r}")
        obj = self.objectIdentifier.get(ObjectIdentifier(("life-safety-point", instance)))
        if obj is None:
            raise KeyError(instance)
        pv, es, oos = STATES[name]
        from_state = obj.eventState
        obj.presentValue = pv
        obj.trackingValue = pv
        obj.eventState = es
        obj.outOfService = oos
        obj.statusFlags = [1 if es != "normal" else 0, 1 if es == "fault" else 0, 0, 1 if oos else 0]
        log.info("point %s -> %s", instance, name)
        if es != str(from_state) and not oos:
            await self._notify(obj, str(from_state), es)

    async def _notify(self, obj: LifeSafetyPointObject, from_state: str, to_state: str) -> None:
        for dest in self.recipients:
            req = UnconfirmedEventNotificationRequest(
                destination=dest,
                processIdentifier=1,
                initiatingDeviceIdentifier=self.device_object.objectIdentifier,
                eventObjectIdentifier=obj.objectIdentifier,
                timeStamp=TimeStamp(dateTime=DateTime(date=Date.now(), time=Time.now())),
                notificationClass=1,
                priority=1 if to_state == "life-safety-alarm" else 100,
                eventType="change-of-life-safety",
                messageText=str(obj.objectName),
                notifyType="alarm",
                ackRequired=True,
                fromState=from_state,
                toState=to_state,
                eventValues=NotificationParameters(
                    changeOfLifeSafety={
                        "newState": obj.presentValue,
                        "newMode": obj.mode,
                        "statusFlags": obj.statusFlags,
                        "operationExpected": "none",
                    }
                ),
            )
            await self.request(req)


def create_panel(address: str, device_id: int, points: int, recipients: list[str]) -> SimulatedPanel:
    objects: list[Any] = [
        DeviceObject(
            objectIdentifier=("device", device_id),
            objectName=f"SIM-PANEL-{device_id}",
            vendorIdentifier=999,
            vendorName="Simulator",
            modelName="B-LSC simulator",
        ),
        NetworkPortObject(address, objectIdentifier=("network-port", 1), objectName="NP-1"),
    ]
    for i in range(1, points + 1):
        objects.append(
            LifeSafetyPointObject(
                objectIdentifier=("life-safety-point", i),
                objectName=f"DET-{i:04d}",
                description=f"Simulated detector {i}",
                presentValue="quiet",
                trackingValue="quiet",
                statusFlags=[0, 0, 0, 0],
                eventState="normal",
                reliability="no-fault-detected",
                outOfService=False,
                mode="on",
                acceptedModes=["on", "off"],
                silenced="unsilenced",
                operationExpected="none",
            )
        )
    panel = SimulatedPanel.from_object_list(objects)
    panel.recipients = [Address(r) for r in recipients]
    return panel
