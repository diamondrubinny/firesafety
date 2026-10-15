import type { Db } from '../db/pool.js';
import type { AuditEntry, Page } from '@firesafety/shared';

export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditRecord {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  outcome: AuditOutcome;
  ipHash?: string | null;
  /** Must never contain secrets, tokens or personal data beyond what is needed. */
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async write(rec: AuditRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, outcome, ip_hash, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        rec.userId ?? null,
        rec.action,
        rec.entity ?? null,
        rec.entityId ?? null,
        rec.outcome,
        rec.ipHash ?? null,
        JSON.stringify(rec.details ?? {}),
      ],
    );
  }

  async list(limit: number, offset: number): Promise<Page<AuditEntry>> {
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT a.id::text, a.ts, a.user_id, u.email AS user_email, a.action, a.entity, a.entity_id, a.outcome, a.details
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
          ORDER BY a.id DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.db.query<{ count: string }>('SELECT count(*) FROM audit_log'),
    ]);
    return {
      items: items.rows.map((r) => ({
        id: r.id,
        ts: (r.ts as Date).toISOString(),
        userId: r.user_id,
        userEmail: r.user_email,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        outcome: r.outcome,
        details: r.details,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }
}
