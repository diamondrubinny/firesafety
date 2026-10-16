-- Sequence numbers of outbox items that are not stored in event_log (snapshots, inventory),
-- so the pilot report can prove delivery completeness: event_log.seq ∪ ingest_aux_seq.seq
-- must be gap-free per collector epoch.
CREATE TABLE ingest_aux_seq (
  collector_id UUID NOT NULL REFERENCES collector (id) ON DELETE CASCADE,
  epoch        TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('snapshot', 'inventory')),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collector_id, epoch, seq)
);
CREATE INDEX ingest_aux_seq_received_idx ON ingest_aux_seq (received_at);
CREATE INDEX event_log_received_idx ON event_log (received_at);
