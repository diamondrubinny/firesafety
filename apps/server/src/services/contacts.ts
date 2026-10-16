import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { CHANNELS, maskPhone, normalizePhone, type Channel } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import type { SecretBox } from '../lib/secretbox.js';
import { badRequest, HttpError } from '../lib/errors.js';

export const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;

export interface ContactInfo {
  email: string;
  phone: string | null;
  phoneHint: string | null;
  pendingPhoneHint: string | null;
  channels: Channel[];
  whatsappOptIn: boolean;
}

/** Per-user contact details. Phone numbers are encrypted at rest and masked everywhere else. */
export class ContactService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly codePepper: string,
  ) {}

  private hashCode(userId: string, code: string): string {
    return createHmac('sha256', this.codePepper).update(`${userId}:${code}`).digest('base64url');
  }

  /** Stores a pending number with a fresh one-time code; returns the code for delivery (never persisted in clear). */
  async startPhoneVerification(userId: string, rawPhone: string): Promise<{ phone: string; code: string }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw badRequest('Invalid phone number', [{ path: 'phone', message: 'invalid phone number' }]);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.query(
      `INSERT INTO user_contact (user_id, pending_phone_enc, pending_code_hash, pending_expires_at, pending_attempts)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), 0)
       ON CONFLICT (user_id) DO UPDATE SET pending_phone_enc = EXCLUDED.pending_phone_enc, pending_code_hash = EXCLUDED.pending_code_hash,
         pending_expires_at = EXCLUDED.pending_expires_at, pending_attempts = 0`,
      [userId, this.box.encrypt(phone), this.hashCode(userId, code), OTP_TTL_SECONDS],
    );
    return { phone, code };
  }

  /** Verifies the code (constant-time, max attempts, expiry) and promotes the pending number. */
  async confirmPhoneVerification(userId: string, code: string): Promise<string> {
    const { rows } = await this.db.query<{ pending_phone_enc: Buffer | null; pending_code_hash: string | null; valid: boolean; pending_attempts: number }>(
      `UPDATE user_contact SET pending_attempts = pending_attempts + 1 WHERE user_id = $1
       RETURNING pending_phone_enc, pending_code_hash, pending_attempts, (pending_expires_at > now()) AS valid`,
      [userId],
    );
    const r = rows[0];
    if (!r?.pending_phone_enc || !r.pending_code_hash || !r.valid) throw new HttpError(400, 'code_expired', 'No valid verification in progress');
    if (r.pending_attempts > OTP_MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many attempts; request a new code');
    const expected = Buffer.from(r.pending_code_hash);
    const actual = Buffer.from(this.hashCode(userId, code));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(400, 'code_invalid', 'Invalid code');
    const phone = this.box.decrypt(r.pending_phone_enc);
    await this.db.query(
      `UPDATE user_contact SET phone_enc = pending_phone_enc, phone_hint = $2, pending_phone_enc = NULL,
              pending_code_hash = NULL, pending_expires_at = NULL, pending_attempts = 0, updated_at = now()
        WHERE user_id = $1`,
      [userId, maskPhone(phone)],
    );
    return maskPhone(phone);
  }

  async get(userId: string): Promise<ContactInfo> {
    const { rows } = await this.db.query<{ email: string; phone_enc: Buffer | null; phone_hint: string | null; channels: Channel[] | null; whatsapp_opt_in_at: Date | null; pending_phone_enc: Buffer | null; pending_expires_at: Date | null }>(
      `SELECT u.email, c.phone_enc, c.phone_hint, c.channels, c.whatsapp_opt_in_at, c.pending_phone_enc, c.pending_expires_at
         FROM app_user u LEFT JOIN user_contact c ON c.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) throw badRequest('Unknown user');
    return {
      email: r.email,
      phone: r.phone_enc ? this.box.decrypt(r.phone_enc) : null,
      phoneHint: r.phone_hint,
      pendingPhoneHint: r.pending_phone_enc && r.pending_expires_at && r.pending_expires_at > new Date() ? maskPhone(this.box.decrypt(r.pending_phone_enc)) : null,
      channels: r.channels ?? [...CHANNELS],
      whatsappOptIn: !!r.whatsapp_opt_in_at,
    };
  }

  /** Channels and WhatsApp consent. Phone: keep (false) or delete (true); new numbers require verification. */
  async update(userId: string, input: { deletePhone: boolean; channels: Channel[]; whatsappOptIn: boolean }): Promise<void> {
    await this.db.query(
      `INSERT INTO user_contact (user_id, channels, whatsapp_opt_in_at, updated_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END, now())
       ON CONFLICT (user_id) DO UPDATE SET
         channels = EXCLUDED.channels,
         whatsapp_opt_in_at = CASE WHEN $3 THEN COALESCE(user_contact.whatsapp_opt_in_at, now()) END,
         phone_enc = CASE WHEN $4 THEN NULL ELSE user_contact.phone_enc END,
         phone_hint = CASE WHEN $4 THEN NULL ELSE user_contact.phone_hint END,
         updated_at = now()`,
      [userId, [...new Set(input.channels)], input.whatsappOptIn, input.deletePhone],
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
