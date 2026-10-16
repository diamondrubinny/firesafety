import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { SecretBox } from '../lib/secretbox.js';
import type { AuditService } from '../services/audit.js';

/** Every column encrypted with SETTINGS_ENCRYPTION_KEY. Keep in sync when adding encrypted data. */
export const ENCRYPTED_COLUMNS = [
  { table: 'app_setting', key: 'key', column: 'secret_enc' },
  { table: 'user_contact', key: 'user_id', column: 'phone_enc' },
  { table: 'user_contact', key: 'user_id', column: 'pending_phone_enc' },
  { table: 'break_glass_account', key: 'user_id', column: 'totp_secret_enc' },
] as const;

export interface RotationReport {
  column: string;
  total: number;
  alreadyPrimary: number;
  reencrypted: number;
  undecryptable: number;
}

export class RotationAbortedError extends Error {
  constructor(public readonly report: RotationReport[]) {
    super('some values cannot be decrypted with the configured keys; nothing was changed');
  }
}

/**
 * Re-encrypts every value under the primary key, in a single transaction.
 * Aborts without changes if any value cannot be decrypted with the keyring.
 */
/** Thrown inside the transaction to roll it back on a dry run. */
class DryRun extends Error {
  constructor(public readonly report: RotationReport[]) {
    super('dry run');
  }
}

export async function rotateKeys(db: Db, box: SecretBox, primaryKeyB64: string, opts: { dryRun: boolean; audit?: AuditService }): Promise<RotationReport[]> {
  try {
    return await rotateInTransaction(db, box, primaryKeyB64, opts);
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  }
}

async function rotateInTransaction(db: Db, box: SecretBox, primaryKeyB64: string, opts: { dryRun: boolean; audit?: AuditService }): Promise<RotationReport[]> {
  const primaryOnly = new SecretBox(primaryKeyB64);
  return withTransaction(db, async (c) => {
    const report: RotationReport[] = [];
    const updates: { table: string; key: string; column: string; id: string; value: Buffer }[] = [];
    for (const { table, key, column } of ENCRYPTED_COLUMNS) {
      // Identifiers come from the constant list above, never from input.
      const { rows } = await c.query<{ id: string; enc: Buffer }>(`SELECT ${key}::text AS id, ${column} AS enc FROM ${table} WHERE ${column} IS NOT NULL FOR UPDATE`);
      const r: RotationReport = { column: `${table}.${column}`, total: rows.length, alreadyPrimary: 0, reencrypted: 0, undecryptable: 0 };
      for (const row of rows) {
        let info: { plaintext: string; primary: boolean };
        try {
          info = box.decryptWithInfo(row.enc);
        } catch {
          r.undecryptable++;
          continue;
        }
        if (info.primary) {
          r.alreadyPrimary++;
          continue;
        }
        const value = primaryOnly.encrypt(info.plaintext);
        if (primaryOnly.decrypt(value) !== info.plaintext) throw new Error('verification failed after re-encryption');
        updates.push({ table, key, column, id: row.id, value });
        r.reencrypted++;
      }
      report.push(r);
    }
    if (report.some((r) => r.undecryptable > 0)) throw new RotationAbortedError(report);
    if (opts.dryRun) throw new DryRun(report); // rolls back, releasing the row locks
    for (const u of updates) await c.query(`UPDATE ${u.table} SET ${u.column} = $2 WHERE ${u.key}::text = $1`, [u.id, u.value]);
    await opts.audit?.write({
      userId: null,
      action: 'settings.key_rotation',
      outcome: 'success',
      details: { via: 'cli', reencrypted: updates.length, columns: report.map((r) => ({ column: r.column, reencrypted: r.reencrypted })) },
    });
    return report;
  });
}

export function formatReport(report: RotationReport[]): string {
  const lines = report.map((r) => `${r.column.padEnd(38)} total=${r.total} primary=${r.alreadyPrimary} reencrypted=${r.reencrypted} undecryptable=${r.undecryptable}`);
  return `${lines.join('\n')}\n`;
}
