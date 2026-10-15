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
            assert uplink.batches[-1]["points"] and col.outbox.depth() == 0
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
