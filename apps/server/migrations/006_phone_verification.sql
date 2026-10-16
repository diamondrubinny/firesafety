-- Phone numbers are saved only after one-time-code verification.
ALTER TABLE user_contact
  ADD COLUMN pending_phone_enc   BYTEA,
  ADD COLUMN pending_code_hash   TEXT,
  ADD COLUMN pending_expires_at  TIMESTAMPTZ,
  ADD COLUMN pending_attempts    SMALLINT NOT NULL DEFAULT 0;
