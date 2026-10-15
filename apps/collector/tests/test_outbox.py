from fs_collector.outbox import Outbox


def test_outbox_persists_and_keeps_epoch(tmp_path):
    path = str(tmp_path / "o.sqlite3")
    ob = Outbox(path)
    epoch = ob.epoch
    s1 = ob.append("event", {"a": 1})
    s2 = ob.append("snapshot", {"b": 2})
    assert s2 > s1
    ob.close()

    ob = Outbox(path)
    assert ob.epoch == epoch
    assert [i.payload for i in ob.pending()] == [{"a": 1}, {"b": 2}]
    ob.delete_through(s1)
    assert ob.depth() == 1
    # seq keeps increasing after deletes (AUTOINCREMENT): never reused within an epoch
    assert ob.append("event", {"c": 3}) > s2
    ob.close()


def test_new_database_gets_new_epoch(tmp_path):
    a = Outbox(str(tmp_path / "a.sqlite3"))
    b = Outbox(str(tmp_path / "b.sqlite3"))
    assert a.epoch != b.epoch
