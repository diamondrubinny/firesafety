import { CHANNELS, maskPhone, normalizePhone, type Channel } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import type { SecretBox } from '../lib/secretbox.js';
import { badRequest } from '../lib/errors.js';

export interface ContactInfo {
  email: string;
  phone: string | null;
  phoneHint: string | null;
  channels: Channel[];
  whatsappOptIn: boolean;
}

/** Per-user contact details. Phone numbers are encrypted at rest and masked everywhere else. */
export class ContactService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  async get(userId: string): Promise<ContactInfo> {
    const { rows } = await this.db.query<{ email: string; phone_enc: Buffer | null; phone_hint: string | null; channels: Channel[] | null; whatsapp_opt_in_at: Date | null }>(
      `SELECT u.email, c.phone_enc, c.phone_hint, c.channels, c.whatsapp_opt_in_at
         FROM app_user u LEFT JOIN user_contact c ON c.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) throw badRequest('Unknown user');
    return {
      email: r.email,
      phone: r.phone_enc ? this.box.decrypt(r.phone_enc) : null,
      phoneHint: r.phone_hint,
      channels: r.channels ?? [...CHANNELS],
      whatsappOptIn: !!r.whatsapp_opt_in_at,
    };
  }

  async update(userId: string, input: { phone: string | null; channels: Channel[]; whatsappOptIn: boolean }): Promise<void> {
    let phone: string | null = null;
    if (input.phone) {
      phone = normalizePhone(input.phone);
      if (!phone) throw badRequest('Invalid phone number', [{ path: 'phone', message: 'invalid phone number' }]);
    }
    await this.db.query(
      `INSERT INTO user_contact (user_id, phone_enc, phone_hint, channels, whatsapp_opt_in_at, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, now())
       ON CONFLICT (user_id) DO UPDATE SET
         phone_enc = EXCLUDED.phone_enc, phone_hint = EXCLUDED.phone_hint, channels = EXCLUDED.channels,
         whatsapp_opt_in_at = CASE WHEN $5 THEN COALESCE(user_contact.whatsapp_opt_in_at, now()) END,
         updated_at = now()`,
      [userId, phone ? this.box.encrypt(phone) : null, phone ? maskPhone(phone) : null, [...new Set(input.channels)], input.whatsappOptIn],
    );
  }

  async addPushSubscription(userId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    // An endpoint belongs to one browser; re-subscribing moves it to the current user.
    await this.db.query(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = now()`,
      [userId, sub.endpoint, sub.p256dh, sub.auth],
    );
    // Bound the number of devices per user.
    await this.db.query(
      `DELETE FROM push_subscription WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM push_subscription WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10)`,
      [userId],
    );
  }

  async removePushSubscription(userId: string, endpoint: string): Promise<void> {
    await this.db.query('DELETE FROM push_subscription WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
  }

  async pushSubscriptions(userId: string): Promise<{ id: string; endpoint: string; p256dh: string; auth: string }[]> {
    const { rows } = await this.db.query('SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1', [userId]);
    return rows;
  }

  async deletePushSubscription(id: string): Promise<void> {
    await this.db.query('DELETE FROM push_subscription WHERE id = $1', [id]);
  }
}
