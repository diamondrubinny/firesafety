"""Durable local outbox (SQLite). Survives restarts and network outages.

Each item gets a monotonically increasing seq within an *epoch*. The epoch is a
random id created with the database, so the server can tell a fresh outbox
(e.g. after the file was deleted) from a retransmission.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
from dataclasses import dataclass
from typing import Any, Literal

ItemKind = Literal["event", "snapshot", "points"]


@dataclass(frozen=True)
class OutboxItem:
    seq: int
    kind: ItemKind
    payload: dict[str, Any]


class Outbox:
    def __init__(self, path: str) -> None:
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS item ("
            " seq INTEGER PRIMARY KEY AUTOINCREMENT,"
            " kind TEXT NOT NULL,"
            " payload TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
        )
        row = self._db.execute("SELECT value FROM meta WHERE key = 'epoch'").fetchone()
        if row:
            self.epoch: str = row[0]
        else:
            self.epoch = secrets.token_urlsafe(16)
            self._db.execute("INSERT INTO meta (key, value) VALUES ('epoch', ?)", (self.epoch,))

    def append(self, kind: ItemKind, payload: dict[str, Any]) -> int:
        cur = self._db.execute("INSERT INTO item (kind, payload) VALUES (?, ?)", (kind, json.dumps(payload, separators=(",", ":"))))
        return int(cur.lastrowid or 0)

    def pending(self, limit: int = 500) -> list[OutboxItem]:
        rows = self._db.execute("SELECT seq, kind, payload FROM item ORDER BY seq LIMIT ?", (limit,)).fetchall()
        return [OutboxItem(seq, kind, json.loads(payload)) for seq, kind, payload in rows]

    def delete_through(self, seq: int) -> None:
        self._db.execute("DELETE FROM item WHERE seq <= ?", (seq,))

    def delete(self, seqs: list[int]) -> None:
        self._db.executemany("DELETE FROM item WHERE seq = ?", [(s,) for s in seqs])

    def depth(self) -> int:
        return int(self._db.execute("SELECT count(*) FROM item").fetchone()[0])

    def close(self) -> None:
        self._db.close()
