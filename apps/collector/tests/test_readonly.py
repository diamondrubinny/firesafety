"""The collector must never change state on a fire panel."""

import pathlib
import re

FORBIDDEN = [
    "WriteProperty",
    "WritePropertyMultiple",
    "write_property",
    "AcknowledgeAlarm",
    "LifeSafetyOperation",
    "SubscribeCOV",
    "DeviceCommunicationControl",
    "ReinitializeDevice",
    "CreateObject",
    "DeleteObject",
    "AddListElement",
    "RemoveListElement",
    "AtomicWriteFile",
    "ConfirmedPrivateTransfer",
]


def test_collector_source_has_no_write_services():
    src = pathlib.Path(__file__).resolve().parents[1] / "fs_collector"
    offenders = []
    for f in src.glob("*.py"):
        text = f.read_text()
        for word in FORBIDDEN:
            if re.search(rf"\b{word}", text):
                offenders.append(f"{f.name}: {word}")
    assert offenders == []
