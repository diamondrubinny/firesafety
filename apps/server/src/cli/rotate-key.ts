import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createSecretBox } from '../lib/secretbox.js';
import { AuditService } from '../services/audit.js';
import { formatReport, RotationAbortedError, rotateKeys } from './rotate-key-core.js';

const USAGE = `Encryption key rotation (SETTINGS_ENCRYPTION_KEY). Run inside the server container.

  1. Back up .env. Generate a key:     node apps/server/dist/cli/rotate-key.js generate
  2. In .env set SETTINGS_ENCRYPTION_KEY=<new> and SETTINGS_ENCRYPTION_KEY_PREVIOUS=<old>; restart the server
  3. Check, then rotate:               node apps/server/dist/cli/rotate-key.js --dry-run
                                       node apps/server/dist/cli/rotate-key.js
  4. Remove SETTINGS_ENCRYPTION_KEY_PREVIOUS from .env and restart. Keep the OLD key as long as
     database backups taken before the rotation are retained (they still need it).
`;

const args = process.argv.slice(2);
if (args[0] === 'generate') {
  process.stdout.write(`${randomBytes(32).toString('base64')}\n`);
  process.exit(0);
}
if (args.some((a) => a !== '--dry-run')) {
  process.stdout.write(USAGE);
  process.exit(args.includes('--help') ? 0 : 2);
}
const config = loadConfig();
if (!config.SETTINGS_ENCRYPTION_KEY) {
  process.stderr.write('SETTINGS_ENCRYPTION_KEY is not set\n');
  process.exit(1);
}
const dryRun = args.includes('--dry-run');
const db = createPool(config);
try {
  const report = await rotateKeys(db, createSecretBox(config), config.SETTINGS_ENCRYPTION_KEY, { dryRun, audit: new AuditService(db) });
  process.stdout.write(formatReport(report));
  const n = report.reduce((s, r) => s + r.reencrypted, 0);
  process.stdout.write(dryRun ? `Dry run: ${n} value(s) would be re-encrypted. Nothing changed.\n` : `Done: ${n} value(s) re-encrypted. Now remove SETTINGS_ENCRYPTION_KEY_PREVIOUS and restart.\n`);
} catch (err) {
  if (err instanceof RotationAbortedError) {
    process.stderr.write(formatReport(err.report));
    process.stderr.write(`ABORTED: ${err.message}. Is SETTINGS_ENCRYPTION_KEY_PREVIOUS set to the old key?\n`);
    process.exitCode = 1;
  } else throw err;
} finally {
  await db.end();
}
