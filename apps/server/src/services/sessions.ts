import type { Db } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { type AuthUser, toAuthUser } from './users.js';

export type SessionMethod = 'sso' | 'break_glass';

export interface SessionOptions {
  idleMinutes: number;
  absoluteHours: number;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly opts: SessionOptions,
  ) {}

  /** Returns the raw token for the cookie; only its hash is persisted. */
  async create(userId: string, opts: { method?: SessionMethod; absoluteHours?: number } = {}): Promise<string> {
    const token = randomToken();
    await this.db.query(
      `INSERT INTO user_session (token_hash, user_id, expires_at, method)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4)`,
      [sha256(token), userId, opts.absoluteHours ?? this.opts.absoluteHours, opts.method ?? 'sso'],
    );
    return token;
  }

  /** Resolves an active session (absolute + idle expiry, active user) and refreshes last_seen_at. */
  async resolve(token: string): Promise<AuthUser | null> {
    const hash = sha256(token);
    const { rows } = await this.db.query(
      `UPDATE user_session s SET last_seen_at = now()
         FROM app_user u
        WHERE s.token_hash = $1 AND u.id = s.user_id AND u.active
          AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2)
        RETURNING u.id, u.email, u.display_name, u.roles, u.active, s.method`,
      [hash, this.opts.idleMinutes],
    );
    return rows[0] ? toAuthUser(rows[0]) : null;
  }

  /** Read-only validity check (does not extend the idle timeout). Used by background re-validation. */
  async check(token: string): Promise<AuthUser | null> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.email, u.display_name, u.roles, u.active, s.method
         FROM user_session s JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND u.active AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2)`,
      [sha256(token), this.opts.idleMinutes],
    );
    return rows[0] ? toAuthUser(rows[0]) : null;
  }

  async revoke(token: string): Promise<void> {
    await this.db.query('DELETE FROM user_session WHERE token_hash = $1', [sha256(token)]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM user_session WHERE user_id = $1', [userId]);
  }

  async purgeExpired(): Promise<number> {
    const r = await this.db.query(
      `DELETE FROM user_session WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(mins => $1)`,
      [this.opts.idleMinutes],
    );
    await this.db.query('DELETE FROM oidc_login_state WHERE expires_at <= now()');
    return r.rowCount ?? 0;
  }
}
