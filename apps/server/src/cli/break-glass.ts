import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createSecretBox } from '../lib/secretbox.js';
import { AuditService } from '../services/audit.js';
import { BreakGlassService } from '../services/break-glass.js';
import { runBreakGlassCli } from './break-glass-cli.js';

const config = loadConfig();
if (!config.SETTINGS_ENCRYPTION_KEY && config.NODE_ENV === 'production') throw new Error('SETTINGS_ENCRYPTION_KEY is required');
const db = createPool(config);
try {
  process.exitCode = await runBreakGlassCli(process.argv.slice(2), {
    breakGlass: new BreakGlassService(db, createSecretBox(config)),
    audit: new AuditService(db),
    enabled: config.BREAK_GLASS_ENABLED,
    out: (s) => process.stdout.write(s),
  });
} finally {
  await db.end();
}
