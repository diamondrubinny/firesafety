-- Phase 4: settings (secrets encrypted by the application), user contacts, push subscriptions, notification outbox.

CREATE TABLE app_setting (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  secret_enc    BYTEA,                      -- AES-256-GCM (iv | tag | ciphertext); key is NOT in the database
  updated_by    UUID REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_contact (
  user_id             UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  phone_enc           BYTEA,                -- encrypted E.164 number
  phone_hint          TEXT,                 -- masked, for display
  channels            TEXT[] NOT NULL DEFAULT ARRAY['push','email','sms','whatsapp'],
  whatsapp_opt_in_at  TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_contact_channels_valid CHECK (channels <@ ARRAY['push','email','sms','whatsapp']::TEXT[])
);

CREATE TABLE push_subscription (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_subscription_user_idx ON push_subscription (user_id);

CREATE TABLE notification (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id        UUID REFERENCES alarm(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('push','email','sms','whatsapp')),
  stage           TEXT NOT NULL CHECK (stage IN ('initial','escalation')),
  status          TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts        SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  last_error      TEXT,
  recipient_hint  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (alarm_id, user_id, channel, stage)
);
CREATE INDEX notification_due_idx ON notification (next_attempt_at) WHERE status = 'pending';
CREATE INDEX notification_recent_idx ON notification (created_at DESC);
CREATE INDEX notification_user_channel_sent_idx ON notification (user_id, channel, sent_at DESC) WHERE status = 'sent';

ALTER TABLE alarm
  ADD COLUMN notified_at  TIMESTAMPTZ,
  ADD COLUMN escalated_at TIMESTAMPTZ;
-- Alarms that existed before this migration are not notified retroactively.
UPDATE alarm SET notified_at = now();
CREATE INDEX alarm_unnotified_idx ON alarm (received_at) WHERE notified_at IS NULL;
