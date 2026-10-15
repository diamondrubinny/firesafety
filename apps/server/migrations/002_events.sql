-- Phase 2: collectors, BACnet devices and points, event log and alarms.

CREATE TABLE collector (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  token_hash       BYTEA NOT NULL UNIQUE,          -- SHA-256 of the bearer token
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  version          TEXT,
  buffer_depth     INTEGER,
  epoch            TEXT,                           -- current outbox epoch reported by the collector
  acked_seq        BIGINT NOT NULL DEFAULT 0      -- highest seq stored for that epoch
);
CREATE UNIQUE INDEX collector_name_uq ON collector (lower(name));

CREATE TABLE bacnet_device (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id     UUID NOT NULL REFERENCES collector(id) ON DELETE CASCADE,
  device_instance  INTEGER NOT NULL,
  address          TEXT NOT NULL,
  name             TEXT,
  vendor           TEXT,
  model            TEXT,
  building_id      UUID REFERENCES building(id) ON DELETE SET NULL,
  online           BOOLEAN NOT NULL DEFAULT false,
  last_error       TEXT,
  last_seen_at     TIMESTAMPTZ,
  UNIQUE (collector_id, device_instance)
);

CREATE TABLE point (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID NOT NULL REFERENCES bacnet_device(id) ON DELETE CASCADE,
  object_type       TEXT NOT NULL,
  object_instance   INTEGER NOT NULL,
  name              TEXT,
  description       TEXT,
  building_id       UUID REFERENCES building(id) ON DELETE SET NULL,
  label             TEXT,
  location          TEXT,
  category          TEXT NOT NULL DEFAULT 'normal',
  event_state       TEXT,
  life_safety_state TEXT,
  out_of_service    BOOLEAN,
  state_changed_at  TIMESTAMPTZ,
  UNIQUE (device_id, object_type, object_instance)
);
CREATE INDEX point_building_idx ON point (building_id);
CREATE INDEX point_abnormal_idx ON point (device_id) WHERE category <> 'normal';

-- Raw, append-only history of everything the collectors reported.
CREATE TABLE event_log (
  id                BIGSERIAL PRIMARY KEY,
  collector_id      UUID NOT NULL REFERENCES collector(id) ON DELETE CASCADE,
  epoch             TEXT NOT NULL,
  seq               BIGINT,                         -- NULL for server-side reconcile entries
  point_id          UUID REFERENCES point(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,
  source_ts         TIMESTAMPTZ,
  observed_at       TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  category          TEXT NOT NULL,
  event_state       TEXT,
  life_safety_state TEXT,
  raw               JSONB NOT NULL,
  UNIQUE (collector_id, epoch, seq)
);
CREATE INDEX event_log_point_idx ON event_log (point_id, id DESC);

-- One row per occurrence (point/device/collector × category). Active while cleared_at IS NULL.
CREATE TABLE alarm (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('point','device_comm','collector_comm')),
  point_id         UUID REFERENCES point(id) ON DELETE CASCADE,
  device_id        UUID REFERENCES bacnet_device(id) ON DELETE CASCADE,
  collector_id     UUID REFERENCES collector(id) ON DELETE CASCADE,
  category         TEXT NOT NULL CHECK (category IN ('fire','prealarm','fault','supervisory','disabled','test')),
  priority         SMALLINT NOT NULL,
  message          TEXT,
  raised_at        TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at       TIMESTAMPTZ,
  acked_at         TIMESTAMPTZ,
  acked_by         UUID REFERENCES app_user(id),
  CHECK (
    (kind = 'point' AND point_id IS NOT NULL) OR
    (kind = 'device_comm' AND device_id IS NOT NULL) OR
    (kind = 'collector_comm' AND collector_id IS NOT NULL)
  )
);
-- At most one active alarm per source.
CREATE UNIQUE INDEX alarm_active_point_uq ON alarm (point_id) WHERE cleared_at IS NULL AND kind = 'point';
CREATE UNIQUE INDEX alarm_active_device_uq ON alarm (device_id) WHERE cleared_at IS NULL AND kind = 'device_comm';
CREATE UNIQUE INDEX alarm_active_collector_uq ON alarm (collector_id) WHERE cleared_at IS NULL AND kind = 'collector_comm';
CREATE INDEX alarm_active_idx ON alarm (priority, raised_at DESC) WHERE cleared_at IS NULL;
CREATE INDEX alarm_raised_idx ON alarm (raised_at DESC);

CREATE TABLE alarm_note (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id         UUID NOT NULL REFERENCES alarm(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES app_user(id),
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  text             TEXT NOT NULL
);
CREATE INDEX alarm_note_alarm_idx ON alarm_note (alarm_id, ts);
