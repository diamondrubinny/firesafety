-- Phase 1: identity, sessions, organisation structure, scope and audit.

CREATE TABLE app_user (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_oid      TEXT UNIQUE,               -- Entra ID object id; NULL only for dev/break-glass users
  email          TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  roles          TEXT[] NOT NULL DEFAULT '{}',
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CONSTRAINT app_user_roles_valid CHECK (roles <@ ARRAY['FireAdmin','SafetyOfficer','Operator','Viewer']::TEXT[])
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE user_session (
  token_hash     BYTEA PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX user_session_user_idx ON user_session (user_id);
CREATE INDEX user_session_expires_idx ON user_session (expires_at);

-- Short-lived OIDC login transactions (state / nonce / PKCE verifier).
CREATE TABLE oidc_login_state (
  id             BYTEA PRIMARY KEY,          -- SHA-256 of the random value kept in a cookie
  state          TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  code_verifier  TEXT NOT NULL,
  return_to      TEXT NOT NULL DEFAULT '/',
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE faculty (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX faculty_name_uq ON faculty (lower(name));

CREATE TABLE building (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id     UUID REFERENCES faculty(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL,
  address        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX building_code_uq ON building (lower(code));
CREATE INDEX building_faculty_idx ON building (faculty_id);

CREATE TABLE user_building_scope (
  user_id        UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  building_id    UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, building_id)
);
CREATE INDEX user_building_scope_building_idx ON user_building_scope (building_id);

-- Append-only audit trail. Contains no secrets, tokens or raw IPs.
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id        UUID REFERENCES app_user(id),  -- users are deactivated, never deleted
  action         TEXT NOT NULL,
  entity         TEXT,
  entity_id      TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
  ip_hash        TEXT,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, ts DESC);

-- Prevent modification of audit rows at the database level.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
