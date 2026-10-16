import type { AdminUser, Page, Role } from '@firesafety/shared';
import { isRole } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  /** True when the current session was opened with a break-glass account. */
  breakGlass?: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  roles: string[];
  active: boolean;
  method?: string;
}

export function toAuthUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    roles: r.roles.filter(isRole),
    active: r.active,
    breakGlass: r.method === 'break_glass',
  };
}

export class UserService {
  constructor(private readonly db: Db) {}

  /** Creates or refreshes a user from verified Entra ID claims. Roles always mirror the token. */
  async upsertFromEntra(input: { oid: string; email: string; displayName: string; roles: Role[] }): Promise<AuthUser> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO app_user (entra_oid, email, display_name, roles, last_login_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (entra_oid) DO UPDATE
         SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
             roles = EXCLUDED.roles, last_login_at = now()
       RETURNING id, email, display_name, roles, active`,
      [input.oid, input.email, input.displayName, input.roles],
    );
    return toAuthUser(rows[0]!);
  }

  /** Development only: identifies users by e-mail. */
  async upsertDev(input: { email: string; displayName: string; roles: Role[] }): Promise<AuthUser> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO app_user (email, display_name, roles, last_login_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (lower(email)) DO UPDATE
         SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles, last_login_at = now()
       RETURNING id, email, display_name, roles, active`,
      [input.email, input.displayName, input.roles],
    );
    return toAuthUser(rows[0]!);
  }

  async list(limit: number, offset: number): Promise<Page<AdminUser>> {
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT u.id, u.email, u.display_name, u.roles, u.active, u.last_login_at,
                EXISTS (SELECT 1 FROM break_glass_account b WHERE b.user_id = u.id) AS break_glass,
                COALESCE(array_agg(s.building_id::text) FILTER (WHERE s.building_id IS NOT NULL), '{}') AS building_ids
           FROM app_user u LEFT JOIN user_building_scope s ON s.user_id = u.id
          GROUP BY u.id
          ORDER BY lower(u.display_name), u.id
          LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.db.query<{ count: string }>('SELECT count(*) FROM app_user'),
    ]);
    return {
      items: items.rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        roles: (r.roles as string[]).filter(isRole),
        active: r.active,
        lastLoginAt: r.last_login_at ? (r.last_login_at as Date).toISOString() : null,
        buildingIds: r.building_ids,
        breakGlass: r.break_glass,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    const r = await this.db.query('UPDATE app_user SET active = $2 WHERE id = $1', [userId, active]);
    if (r.rowCount === 0) throw notFound('User');
  }

  /** Replaces the user's building scope atomically. Returns previous and new sizes for auditing. */
  async setScope(userId: string, buildingIds: string[]): Promise<{ before: number; after: number }> {
    const unique = [...new Set(buildingIds)];
    return withTransaction(this.db, async (c) => {
      const user = await c.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [userId]);
      if (user.rowCount === 0) throw notFound('User');
      if (unique.length > 0) {
        const found = await c.query<{ count: string }>('SELECT count(*) FROM building WHERE id = ANY($1::uuid[])', [unique]);
        if (Number(found.rows[0]?.count) !== unique.length) throw badRequest('One or more buildings do not exist');
      }
      const del = await c.query('DELETE FROM user_building_scope WHERE user_id = $1', [userId]);
      if (unique.length > 0) {
        await c.query(
          `INSERT INTO user_building_scope (user_id, building_id) SELECT $1, unnest($2::uuid[])`,
          [userId, unique],
        );
      }
      return { before: del.rowCount ?? 0, after: unique.length };
    });
  }
}
