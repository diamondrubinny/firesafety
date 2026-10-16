-- Phase 5: operating procedures (checklists) and their execution per alarm.

CREATE TABLE procedure (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('fire','prealarm','fault','supervisory','disabled','test','comm')),
  building_id  UUID REFERENCES building(id) ON DELETE CASCADE,   -- NULL = applies to every building
  steps        JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  version      INTEGER NOT NULL DEFAULT 1,
  active       BOOLEAN NOT NULL DEFAULT true,
  updated_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active procedure per (category, building) and one global per category.
CREATE UNIQUE INDEX procedure_active_scope_uq ON procedure (category, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE active;

CREATE TABLE procedure_run (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id        UUID NOT NULL UNIQUE REFERENCES alarm(id) ON DELETE CASCADE,
  procedure_id    UUID REFERENCES procedure(id) ON DELETE SET NULL,
  procedure_name  TEXT NOT NULL,
  version         INTEGER NOT NULL,
  steps_snapshot  JSONB NOT NULL,           -- frozen copy: later edits do not rewrite history
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "<index>": { "done": bool, "by": text, "at": iso } }
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_by      UUID REFERENCES app_user(id),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE procedure_step_log (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES procedure_run(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  done        BOOLEAN NOT NULL,
  user_id     UUID REFERENCES app_user(id),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX procedure_step_log_run_idx ON procedure_step_log (run_id, id);

-- Reports filter alarms by time range.
CREATE INDEX IF NOT EXISTS alarm_raised_cat_idx ON alarm (raised_at DESC, category);
