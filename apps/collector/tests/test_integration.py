"""Simulator <-> collector over real BACnet/IP on the loopback interface."""

import asyncio
import itertools

from fs_collector.bacnet import PanelClient, create_application
from fs_collector.config import Config, PanelTarget
from fs_collector.outbox import Outbox
from fs_collector.service import Collector
from fs_simulator.panel import create_panel

_ports = itertools.count(47950, 2)


class FakeUplink:
    def __init__(self):
        self.batches = []
        self.fail = False

    def send(self, batch):
        from fs_collector.uplink import UplinkError

        if self.fail:
            raise UplinkError("down", retryable=True)
        self.batches.append(batch)
        seqs = [e["seq"] for e in batch["events"]] + [s["seq"] for s in batch["snapshots"]]
        return max(seqs, default=0)


def run(coro):
    return asyncio.run(coro)


async def setup(tmp_path, points=60, page_size=25, notify=True):
    p_port, c_port = next(_ports), next(_ports)
    panel = create_panel(f"127.0.0.1/8:{p_port}", 1001, points, [f"127.0.0.1:{c_port}"] if notify else [])
    panel.page_size = page_size
    app = create_application(f"127.0.0.1/8:{c_port}", 4000001)
    cfg = Config(
        server_url="http://x",
        token="fsc_" + "x" * 30,
        bacnet_address="",
        bacnet_device_id=4000001,
        panels=(PanelTarget(1001, f"127.0.0.1:{p_port}"),),
        request_timeout=1.0,
        offline_after_failures=2,
    )
    client = PanelClient(app, f"127.0.0.1:{p_port}", 1001, timeout=1.0)
    uplink = FakeUplink()
    col = Collector(cfg, {1001: client}, Outbox(str(tmp_path / "ob.sqlite3")), uplink)
    app.on_notification = col.on_notification
    return panel, app, col, uplink


def events(col):
    return [i.payload for i in col.outbox.pending() if i.kind == "event"]


def test_poll_detects_alarms_with_paging_and_clears(tmp_path):
    async def go():
        panel, app, col, uplink = await setup(tmp_path, notify=False)
        try:
            for i in range(1, 31):  # more than one GetEventInformation page
                await panel.set_state(i, "fault")
            await panel.set_state(40, "alarm")
            p = col.panels[1001]
            await col.poll_panel(p)
            evs = events(col)
            assert len(evs) == 31
            fire = [e for e in evs if e["objectInstance"] == 40][0]
            assert fire["lifeSafetyState"] == "alarm" and fire["eventState"] == "life-safety-alarm" and fire["source"] == "poll"
            snaps = [i.payload for i in col.outbox.pending() if i.kind == "snapshot"]
            assert len(snaps[0]["nonNormal"]) == 31
            assert p.online

            await col.flush()
            assert col.outbox.depth() == 0
            batch = uplink.batches[-1]
            assert batch["devices"][0] == {"instance": 1001, "address": p.target.address, "online": True, "name": "SIM-PANEL-1001", "vendor": "Simulator", "model": "B-LSC simulator"}

            await panel.set_state(40, "quiet")
            await col.poll_panel(p)
            cleared = events(col)
            assert len(cleared) == 1 and cleared[0]["objectInstance"] == 40 and cleared[0]["lifeSafetyState"] == "quiet"
        finally:
            panel.close()
            app.close()

    run(go())


def test_notification_is_received_immediately(tmp_path):
    async def go():
        panel, app, col, _ = await setup(tmp_path)
        try:
            await panel.set_state(7, "alarm")
            for _ in range(50):
                if events(col):
                    break
                await asyncio.sleep(0.02)
            evs = events(col)
            assert len(evs) == 1
            assert evs[0]["source"] == "notification" and evs[0]["lifeSafetyState"] == "alarm" and evs[0]["objectInstance"] == 7
            assert evs[0]["messageText"] == "DET-0007"
            # the following poll must not duplicate it
            await col.poll_panel(col.panels[1001])
            assert len(events(col)) == 1
        finally:
            panel.close()
            app.close()

    run(go())


def test_inventory_reports_points_and_disabled(tmp_path):
    async def go():
        panel, app, col, uplink = await setup(tmp_path, points=45, notify=False)
        try:
            await panel.set_state(3, "disabled")
            p = col.panels[1001]
            await col.scan_panel(p)
            evs = events(col)
            assert len(evs) == 1 and evs[0]["objectInstance"] == 3 and evs[0]["outOfService"] is True
            pts = [pt for i in col.outbox.pending() if i.kind == "points" for pt in i.payload["points"]]
            assert len(pts) == 45 and pts[0]["name"] == "DET-0001" and pts[0]["description"] == "Simulated detector 1"
            # disabled point stays non-normal across event polls
            await col.poll_panel(p)
            assert len(events(col)) == 1
            await col.flush()
            b = uplink.batches[-1]
            assert b["points"] and col.outbox.depth() == 0
            # Completeness invariant: events + snapshots + inventory cover the outbox sequence without gaps.
            seqs = sorted([e["seq"] for e in b["events"]] + [s["seq"] for s in b["snapshots"]] + b["inventorySeqs"])
            assert b["inventorySeqs"] and seqs == list(range(seqs[0], seqs[-1] + 1))
        finally:
            panel.close()
            app.close()

    run(go())


def test_panel_offline_then_resync(tmp_path):
    async def go():
        panel, app, col, uplink = await setup(tmp_path, notify=False)
        try:
            p = col.panels[1001]
            await col.poll_panel(p)
            assert p.online
            panel.offline = True
            await col.poll_panel(p)
            assert p.online  # one failure is tolerated
            await col.poll_panel(p)
            assert not p.online and p.last_error == "timeout"
            await col.flush()
            assert uplink.batches[-1]["devices"][0]["online"] is False

            await panel.set_state(5, "alarm")  # happens while offline
            panel.offline = False
            await col.poll_panel(p)
            assert p.online
            kinds = [i.kind for i in col.outbox.pending()]
            assert kinds == ["event", "snapshot"]  # change + resync snapshot
        finally:
            panel.close()
            app.close()

    run(go())


def test_events_survive_uplink_outage(tmp_path):
    async def go():
        panel, app, col, uplink = await setup(tmp_path, notify=False)
        try:
            uplink.fail = True
            await panel.set_state(9, "alarm")
            await col.poll_panel(col.panels[1001])
            try:
                await col.flush()
            except Exception:
                pass
            assert col.outbox.depth() == 2  # event + snapshot kept
            uplink.fail = False
            await col.flush()
            assert col.outbox.depth() == 0
            assert uplink.batches[-1]["events"][0]["objectInstance"] == 9
        finally:
            panel.close()
            app.close()

    run(go())


def test_spoofed_notification_from_other_address_is_ignored(tmp_path):
    async def go():
        panel, app, col, _ = await setup(tmp_path, notify=False)
        attacker_port = next(_ports)
        attacker = create_panel(f"127.0.0.1/8:{attacker_port}", 1001, 20, [])
        try:
            # The attacker claims to be device 1001 and sends a fake fire to the collector.
            from bacpypes3.pdu import Address
            attacker.recipients = [Address(f"127.0.0.1:{col_port(app)}")]
            await attacker.set_state(3, "alarm")
            await asyncio.sleep(0.3)
            assert events(col) == []
        finally:
            attacker.close()
            panel.close()
            app.close()

    run(go())


def test_remote_writes_to_collector_objects_are_refused(tmp_path):
    async def go():
        panel, app, col, _ = await setup(tmp_path, notify=False)
        attacker = create_application(f"127.0.0.1/8:{next(_ports)}", 4000099)
        try:
            from bacpypes3.pdu import Address
            from bacpypes3.primitivedata import ObjectIdentifier
            try:
                await asyncio.wait_for(attacker.write_property(Address(f"127.0.0.1:{col_port(app)}"), ObjectIdentifier(("device", 4000001)), "objectName", "pwned"), 3)
                accepted = True
            except BaseException as err:  # noqa: BLE001 - bacpypes3 raises its Error PDU type
                if isinstance(err, asyncio.CancelledError):
                    raise
                assert "service-request-denied" in str(err)
                accepted = False
            assert accepted is False
            assert str(app.device_object.objectName) == "fs-collector-4000001"
            # reads are still answered
            name = await asyncio.wait_for(attacker.read_property(Address(f"127.0.0.1:{col_port(app)}"), ObjectIdentifier(("device", 4000001)), "objectName"), 3)
            assert str(name) == "fs-collector-4000001"
        finally:
            attacker.close()
            panel.close()
            app.close()

    run(go())


def col_port(app):
    for obj in app.objectIdentifier.values():
        if str(obj.objectIdentifier[0]) == "network-port":
            return int(obj.bacnetIPUDPPort)
    raise AssertionError("no network port")
