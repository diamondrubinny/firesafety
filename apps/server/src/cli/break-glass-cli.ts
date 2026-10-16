import { isRole, type Role } from '@firesafety/shared';
import type { AuditService } from '../services/audit.js';
import { BREAK_GLASS_ROLES, type BreakGlassService, type IssuedCredentials } from '../services/break-glass.js';
import { HttpError } from '../lib/errors.js';

export const USAGE = `Break-glass (emergency) accounts. Run inside the server container:
  docker compose exec server node apps/server/dist/cli/break-glass.js <command> [args]

Commands:
  create <username> [--name "Display name"] [--role Operator|FireAdmin]   (default role: Operator)
  reset <username>        new password + TOTP secret, unlocks, signs out all sessions (do this after every use)
  disable <username>      blocks login and signs out immediately
  enable <username>
  scope-all <username>    grant every current building (Operator accounts)
  list
`;

export interface CliDeps {
  breakGlass: BreakGlassService;
  audit: AuditService;
  enabled: boolean;
  out: (s: string) => void;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new HttpError(400, 'bad_request', `${name} requires a value`);
  args.splice(i, 2);
  return v;
}

function printCredentials(out: (s: string) => void, c: IssuedCredentials) {
  out(
    [
      '',
      '==================== SHOWN ONCE: STORE OFFLINE ====================',
      `Username:     ${c.username}`,
      `Password:     ${c.password}`,
      `TOTP secret:  ${c.totpSecret}`,
      `TOTP URI:     ${c.otpauthUri}`,
      '===================================================================',
      'Add the secret to an authenticator app on a dedicated device (SHA1, 6 digits, 30 s).',
      'Print, seal and store in the control-room safe. Do not save in e-mail, chat or tickets.',
      '',
    ].join('\n'),
  );
}

/** Returns the process exit code. Never logs secrets except the one-time credential block on stdout. */
export async function runBreakGlassCli(argv: string[], deps: CliDeps): Promise<number> {
  const { breakGlass, audit, out } = deps;
  const args = [...argv];
  const cmd = args.shift();
  const log = (action: string, details: Record<string, unknown>) =>
    audit.write({ userId: null, action: `break_glass.${action}`, outcome: 'success', details: { ...details, via: 'cli' } });
  try {
    switch (cmd) {
      case 'create': {
        const name = flag(args, '--name');
        const roleArg = flag(args, '--role') ?? 'Operator';
        const username = args.shift();
        if (!username || args.length) throw new HttpError(400, 'bad_request', 'usage: create <username> [--name ...] [--role ...]');
        if (!isRole(roleArg) || !BREAK_GLASS_ROLES.includes(roleArg)) throw new HttpError(400, 'bad_request', `--role must be one of ${BREAK_GLASS_ROLES.join(', ')}`);
        const role: Role = roleArg;
        const creds = await breakGlass.create({ username, displayName: name ?? `חירום ${username}`, role });
        await log('create', { username: creds.username, role });
        printCredentials(out, creds);
        if (!deps.enabled) out('NOTE: BREAK_GLASS_ENABLED is false: the emergency login is currently switched off.\n');
        return 0;
      }
      case 'reset': {
        const username = args.shift();
        if (!username) throw new HttpError(400, 'bad_request', 'usage: reset <username>');
        const creds = await breakGlass.reset(username);
        await log('reset', { username });
        printCredentials(out, creds);
        return 0;
      }
      case 'disable':
      case 'enable': {
        const username = args.shift();
        if (!username) throw new HttpError(400, 'bad_request', `usage: ${cmd} <username>`);
        await breakGlass.setActive(username, cmd === 'enable');
        await log(cmd, { username });
        out(`${username}: ${cmd}d\n`);
        return 0;
      }
      case 'scope-all': {
        const username = args.shift();
        if (!username) throw new HttpError(400, 'bad_request', 'usage: scope-all <username>');
        const added = await breakGlass.scopeAll(username);
        await log('scope_all', { username, added });
        out(`${username}: ${added} building(s) added\n`);
        return 0;
      }
      case 'list': {
        const rows = await breakGlass.list();
        if (rows.length === 0) out('No break-glass accounts.\n');
        for (const r of rows) {
          out(
            `${r.username}\troles=${r.roles.join(',')}\t${r.active ? 'active' : 'DISABLED'}${r.lockedUntil ? `\tLOCKED until ${r.lockedUntil}` : ''}` +
              `\tlast used: ${r.lastUsedAt ?? 'never'}\tcredentials set: ${r.credentialsSetAt}\n`,
          );
        }
        out(`Emergency login is ${deps.enabled ? 'ENABLED' : 'disabled'} (BREAK_GLASS_ENABLED).\n`);
        return 0;
      }
      default:
        out(USAGE);
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      out(`Error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
