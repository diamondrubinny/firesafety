from fs_collector.state import DeviceState, ObjState

K1 = ("life-safety-point", 1)
K2 = ("life-safety-point", 2)
FIRE = ObjState(event_state="life-safety-alarm", life_safety_state="alarm")
FAULT = ObjState(event_state="fault", life_safety_state="fault")


def test_event_view_emits_new_changed_and_cleared():
    s = DeviceState()
    assert [c.key for c in s.apply_event_view({K1: FIRE})] == [K1]
    assert s.apply_event_view({K1: FIRE}) == []  # no change, no event
    ch = s.apply_event_view({K1: FAULT, K2: FIRE})
    assert {c.key: c.state for c in ch} == {K1: FAULT, K2: FIRE}
    ch = s.apply_event_view({K2: FIRE})
    assert len(ch) == 1 and ch[0].key == K1 and ch[0].state.is_normal()
    assert s.non_normal_keys() == [K2]


def test_notification_then_poll_does_not_duplicate():
    s = DeviceState()
    assert len(s.apply_notification(K1, FIRE)) == 1
    assert s.apply_event_view({K1: FIRE}) == []


def test_disabled_point_from_scan_survives_event_polls():
    s = DeviceState()
    disabled = ObjState(event_state="normal", life_safety_state="quiet", out_of_service=True)
    ch = s.apply_scan({K1: disabled})
    assert len(ch) == 1 and ch[0].state.out_of_service
    # GetEventInformation does not list it (event state normal) -> must stay disabled
    assert s.apply_event_view({}) == []
    assert s.non_normal_keys() == [K1]
    # re-enabled
    ch = s.apply_scan({K1: ObjState(event_state="normal", life_safety_state="quiet", out_of_service=False)})
    assert len(ch) == 1 and ch[0].state.is_normal()


def test_fire_on_disabled_point_keeps_disable_flag():
    s = DeviceState()
    s.apply_scan({K1: ObjState(life_safety_state="quiet", out_of_service=True)})
    ch = s.apply_notification(K1, FIRE)
    assert ch[0].state.life_safety_state == "alarm" and ch[0].state.out_of_service is True


def test_normal_definition():
    assert ObjState().is_normal()
    assert ObjState(event_state="normal", life_safety_state="quiet", reliability="no-fault-detected", mode="on").is_normal()
    assert not ObjState(reliability="open-loop").is_normal()
    assert not ObjState(mode="disabled").is_normal()
