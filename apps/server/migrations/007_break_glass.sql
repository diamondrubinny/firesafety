-- Break-glass local accounts: emergency access when Entra ID is unavailable.
-- Created only from the server CLI; disabled unless BREAK_GLASS_ENABLED=true.
CREATE TABLE break_glass_account (
  user_id          UUID PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  username         TEXT NOT NULL,
  password_hash    TEXT NOT NULL,                 -- scrypt$N$r$p$salt$hash
  totp_secret_enc  BYTEA NOT NULL,                -- AES-256-GCM (SETTINGS_ENCRYPTION_KEY)
  last_totp_step   BIGINT NOT NULL DEFAULT 0,     -- replay protection: a code is accepted once
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  credentials_set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  CONSTRAINT break_glass_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$')
);
CREATE UNIQUE INDEX break_glass_username_uq ON break_glass_account (username);

-- How the session was established; break-glass sessions are shown with a permanent banner.
ALTER TABLE user_session
  ADD COLUMN method TEXT NOT NULL DEFAULT 'sso' CHECK (method IN ('sso', 'break_glass'));
