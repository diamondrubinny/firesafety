import webpush from 'web-push';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  notificationSettingsSchema,
  type NotificationSecrets,
  type NotificationSettings,
  type NotificationSettingsView,
  type SecretName,
} from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import type { SecretBox } from '../lib/secretbox.js';

const KEY = 'notifications';
const SECRET_NAMES: SecretName[] = ['emailPassword', 'twilioAuthToken', 'smsHttpHeaders', 'whatsappAccessToken'];

interface StoredSecrets extends NotificationSecrets {
  vapidPrivateKey?: string;
}

export interface ResolvedSettings {
  settings: NotificationSettings;
  secrets: StoredSecrets;
  vapidPublicKey: string | null;
}

/** Notification settings: non-secret JSON + an encrypted secret blob. Cached briefly. */
export class SettingsService {
  private cache: { at: number; value: ResolvedSettings } | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async get(): Promise<ResolvedSettings> {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.value;
    const { rows } = await this.db.query<{ value: Record<string, unknown>; secret_enc: Buffer | null }>(
      'SELECT value, secret_enc FROM app_setting WHERE key = $1',
      [KEY],
    );
    let value: ResolvedSettings;
    if (!rows[0]) {
      value = { settings: DEFAULT_NOTIFICATION_SETTINGS, secrets: {}, vapidPublicKey: null };
    } else {
      // Merge with defaults so settings saved by older versions stay valid.
      const merged = deepMerge(DEFAULT_NOTIFICATION_SETTINGS, rows[0].value);
      const parsed = notificationSettingsSchema.safeParse(merged);
      value = {
        settings: parsed.success ? parsed.data : DEFAULT_NOTIFICATION_SETTINGS,
        secrets: rows[0].secret_enc ? (JSON.parse(this.box.decrypt(rows[0].secret_enc)) as StoredSecrets) : {},
        vapidPublicKey: (rows[0].value.vapidPublicKey as string | undefined) ?? null,
      };
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async view(): Promise<NotificationSettingsView> {
    const { settings, secrets, vapidPublicKey } = await this.get();
    return {
      settings,
      secretsConfigured: Object.fromEntries(SECRET_NAMES.map((n) => [n, !!secrets[n]])) as Record<SecretName, boolean>,
      pushPublicKey: vapidPublicKey,
    };
  }

  /** Secrets: undefined keeps the stored value, '' clears it. Returns names of changed fields for auditing. */
  async update(settings: NotificationSettings, patch: NotificationSecrets, userId: string | null): Promise<string[]> {
    const current = await this.get();
    const secrets: StoredSecrets = { ...current.secrets };
    const changed: string[] = [];
    for (const name of SECRET_NAMES) {
      const v = patch[name];
      if (v === undefined) continue;
      if (v === '') delete secrets[name];
      else secrets[name] = v;
      changed.push(`secret:${name}`);
    }
    let vapidPublicKey = current.vapidPublicKey;
    if (!vapidPublicKey || !secrets.vapidPrivateKey) {
      const keys = webpush.generateVAPIDKeys();
      vapidPublicKey = keys.publicKey;
      secrets.vapidPrivateKey = keys.privateKey;
    }
    await this.db.query(
      `INSERT INTO app_setting (key, value, secret_enc, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret_enc = EXCLUDED.secret_enc,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [KEY, JSON.stringify({ ...settings, vapidPublicKey }), this.box.encrypt(JSON.stringify(secrets)), userId],
    );
    this.cache = null;
    return changed;
  }

  /** Ensures VAPID keys exist (users may subscribe to push before an admin saved settings). */
  async ensurePushKeys(): Promise<string> {
    const cur = await this.get();
    if (cur.vapidPublicKey && cur.secrets.vapidPrivateKey) return cur.vapidPublicKey;
    await this.update(cur.settings, {}, null);
    return (await this.get()).vapidPublicKey!;
  }
}

function deepMerge<T>(base: T, over: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || over === null) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
