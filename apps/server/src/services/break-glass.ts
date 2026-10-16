import { ROLES, type Role } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretbox.js';
import { dummyPasswordHash, generatePassword, hashPassword, verifyPassword } from '../lib/password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { type AuthUser, toAuthUser } from './users.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const MAX_BREAK_GLASS_ACCOUNTS = 3;
export const BREAK_GLASS_ROLES: readonly Role[] = ['Operator', 'FireAdmin'];
const EMAIL_DOMAIN = 'break-glass.invalid'; // reserved TLD: can never collide with a real (Entra) address
const TOTP_ISSUER = 'FireSafety';
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export interface IssuedCredentials {
  username: string;
  password: string;
  totpSecret: string;
  otpauthUri: string;
}

export interface BreakGlassAccountInfo {
  username: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  lockedUntil: string | null;
  lastUsedAt: string | null;
  credentialsSetAt: string;
}

export type BreakGlassResult =
  | { ok: true; user: AuthUser }
  /** reason is for the audit log only; the client always gets one generic message. */
  | { ok: false; reason: 'unknown_user' | 'locked' | 'bad_password' | 'bad_totp' | 'user_inactive'; userId?: string; lockedNow?: boolean };

interface AccountRow {
  user_id: string;
  password_hash: string;
  totp_secret_enc: Buffer;
  last_totp_step: string;
  locked: boolean;
  active: boolean;
}

export class BreakGlassService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: { username: string; displayName: string; role: Role }): Promise<IssuedCredentials> {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw badRequest('username: 3-32 chars, a-z 0-9 . _ -, starting with a letter or digit');
    if (!BREAK_GLASS_ROLES.includes(input.role) || !ROLES.includes(input.role)) throw badRequest(`role must be one of ${BREAK_GLASS_ROLES.join(', ')}`);
    const displayName = input.displayName.trim().slice(0, 120) || username;
    const password = generatePassword();
    const totpSecret = generateTotpSecret();
    const passwordHash = await hashPassword(password);
    await withTransaction(this.db, async (c) => {
      // Serialise concurrent creations so the account cap holds.
      await c.query('LOCK TABLE break_glass_account IN SHARE ROW EXCLUSIVE MODE');
      const count = await c.query<{ n: string }>('SELECT count(*) AS n FROM break_glass_account');
      if (Number(count.rows[0]?.n) >= MAX_BREAK_GLASS_ACCOUNTS) throw badRequest(`at most ${MAX_BREAK_GLASS_ACCOUNTS} break-glass accounts are allowed`);
      const dup = await c.query('SELECT 1 FROM break_glass_account WHERE username = $1', [username]);
      if (dup.rowCount) throw badRequest('username already exists');
      const u = await c.query<{ id: string }>(
        `INSERT INTO app_user (email, display_name, roles) VALUES ($1, $2, $3) RETURNING id`,
        [`${username}@${EMAIL_DOMAIN}`, displayName, [input.role]],
      );
      const userId = u.rows[0]!.id;
      await c.query(
        `INSERT INTO break_glass_account (user_id, username, password_hash, totp_secret_enc) VALUES ($1, $2, $3, $4)`,
        [userId, username, passwordHash, this.box.encrypt(totpSecret)],
      );
      // Non-admin roles are building-scoped: grant every existing building so the account is useful in an emergency.
      if (input.role !== 'FireAdmin') {
        await c.query(`INSERT INTO user_building_scope (user_id, building_id) SELECT $1, id FROM building ON CONFLICT DO NOTHING`, [userId]);
      }
    });
    return { username, password, totpSecret, otpauthUri: otpauthUri(TOTP_ISSUER, username, totpSecret) };
  }

  /** New password + TOTP secret, lock cleared, all sessions revoked. Use after every emergency use. */
  async reset(username: string): Promise<IssuedCredentials> {
    const password = generatePassword();
    const totpSecret = generateTotpSecret();
    const passwordHash = await hashPassword(password);
    await withTransaction(this.db, async (c) => {
      const r = await c.query<{ user_id: string }>(
        `UPDATE break_glass_account
            SET password_hash = $2, totp_secret_enc = $3, last_totp_step = 0, failed_attempts = 0,
                locked_until = NULL, credentials_set_at = now()
          WHERE username = $1 RETURNING user_id`,
        [username, passwordHash, this.box.encrypt(totpSecret)],
      );
      if (!r.rows[0]) throw notFound('Break-glass account');
      await c.query('DELETE FROM user_session WHERE user_id = $1', [r.rows[0].user_id]);
    });
    return { username, password, totpSecret, otpauthUri: otpauthUri(TOTP_ISSUER, username, totpSecret) };
  }

  async setActive(username: string, active: boolean): Promise<string> {
    return withTransaction(this.db, async (c) => {
      const r = await c.query<{ user_id: string }>(
        `UPDATE app_user u SET active = $2 FROM break_glass_account b
          WHERE b.username = $1 AND u.id = b.user_id RETURNING u.id AS user_id`,
        [username, active],
      );
      if (!r.rows[0]) throw notFound('Break-glass account');
      if (!active) await c.query('DELETE FROM user_session WHERE user_id = $1', [r.rows[0].user_id]);
      return r.rows[0].user_id;
    });
  }

  async scopeAll(username: string): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO user_building_scope (user_id, building_id)
       SELECT b.user_id, bl.id FROM break_glass_account b CROSS JOIN building bl WHERE b.username = $1
       ON CONFLICT DO NOTHING`,
      [username],
    );
    const exists = await this.db.query('SELECT 1 FROM break_glass_account WHERE username = $1', [username]);
    if (!exists.rowCount) throw notFound('Break-glass account');
    return r.rowCount ?? 0;
  }

  async list(): Promise<BreakGlassAccountInfo[]> {
    const { rows } = await this.db.query(
      `SELECT b.username, u.display_name, u.roles, u.active, b.locked_until, b.last_used_at, b.credentials_set_at
         FROM break_glass_account b JOIN app_user u ON u.id = b.user_id ORDER BY b.username`,
    );
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      roles: r.roles,
      active: r.active,
      lockedUntil: r.locked_until && (r.locked_until as Date).getTime() > this.now() ? (r.locked_until as Date).toISOString() : null,
      lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
      credentialsSetAt: (r.credentials_set_at as Date).toISOString(),
    }));
  }

  /**
   * Verifies username + password + TOTP. Always performs one scrypt verification, whatever the outcome,
   * so response time does not reveal whether the account exists or is locked.
   */
  async authenticate(usernameRaw: string, password: string, code: string): Promise<BreakGlassResult> {
    const username = usernameRaw.trim().toLowerCase();
    const { rows } = USERNAME_RE.test(username)
      ? await this.db.query<AccountRow>(
          `SELECT b.user_id, b.password_hash, b.totp_secret_enc, b.last_totp_step,
                  (b.locked_until IS NOT NULL AND b.locked_until > now()) AS locked, u.active
             FROM break_glass_account b JOIN app_user u ON u.id = b.user_id WHERE b.username = $1`,
          [username],
        )
      : { rows: [] as AccountRow[] };
    const acc = rows[0];
    const passwordOk = await verifyPassword(password, acc?.password_hash ?? (await dummyPasswordHash()));
    if (!acc) return { ok: false, reason: 'unknown_user' };
    if (acc.locked) return { ok: false, reason: 'locked', userId: acc.user_id };

    let step: number | null = null;
    if (passwordOk) {
      let secret: string | null;
      try {
        secret = this.box.decrypt(acc.totp_secret_enc);
      } catch {
        secret = null; // wrong key (e.g. after an incomplete key rotation): fail closed
      }
      step = secret ? verifyTotp(secret, code, this.now(), Number(acc.last_totp_step)) : null;
    }
    if (!passwordOk || step === null) {
      const r = await this.db.query<{ locked: boolean }>(
        `UPDATE break_glass_account
            SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE user_id = $1
          RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
        [acc.user_id, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES],
      );
      return { ok: false, reason: passwordOk ? 'bad_totp' : 'bad_password', userId: acc.user_id, lockedNow: r.rows[0]?.locked ?? false };
    }
    // Atomic replay guard: two concurrent logins with the same code cannot both succeed.
    const claimed = await this.db.query(
      `UPDATE break_glass_account SET last_totp_step = $2, failed_attempts = 0, locked_until = NULL, last_used_at = now()
        WHERE user_id = $1 AND last_totp_step < $2`,
      [acc.user_id, step],
    );
    if (!claimed.rowCount) return { ok: false, reason: 'bad_totp', userId: acc.user_id };
    if (!acc.active) return { ok: false, reason: 'user_inactive', userId: acc.user_id };
    const u = await this.db.query(`SELECT id, email, display_name, roles, active FROM app_user WHERE id = $1`, [acc.user_id]);
    return { ok: true, user: { ...toAuthUser(u.rows[0]), breakGlass: true } };
  }
}
