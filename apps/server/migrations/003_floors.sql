-- Phase 3: floors, floor-plan files (quarantined + scanned), point placement.

CREATE TABLE stored_file (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL CHECK (kind IN ('floor_plan')),
  mime           TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256         BYTEA NOT NULL,
  content        BYTEA,                       -- NULL once a file is found infected
  scan_status    TEXT NOT NULL CHECK (scan_status IN ('pending','clean','infected','error','unscanned')),
  scan_detail    TEXT,
  uploaded_by    UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at     TIMESTAMPTZ
);

CREATE TABLE floor (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id    UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  level          INTEGER NOT NULL,
  plan_file_id   UUID REFERENCES stored_file(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX floor_building_name_uq ON floor (building_id, lower(name));
CREATE INDEX floor_building_idx ON floor (building_id, level);

ALTER TABLE point
  ADD COLUMN floor_id UUID REFERENCES floor(id) ON DELETE SET NULL,
  ADD COLUMN x REAL CHECK (x IS NULL OR (x >= 0 AND x <= 1)),
  ADD COLUMN y REAL CHECK (y IS NULL OR (y >= 0 AND y <= 1));
CREATE INDEX point_floor_idx ON point (floor_id);
