-- Fire / pre-alarm events that cleared at the panel before anyone acknowledged them stay in the
-- active list (latched) until acknowledged. When a newer event opens on the same point, older
-- unacknowledged events of that point are marked superseded so only the latest one is shown.
ALTER TABLE alarm ADD COLUMN superseded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX alarm_latched_idx ON alarm (category) WHERE acked_at IS NULL AND cleared_at IS NOT NULL AND NOT superseded;
