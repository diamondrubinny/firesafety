import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS } from '@firesafety/shared';
import { createTestApp, loginAs, ORIGIN, write, type TestContext } from './helpers.js';
import { runBreakGlassCli } from '../src/cli/break-glass-cli.js';
import { base32Decode, hotp, totpStep } from '../src/lib/totp.js';
import { MAX_FAILED_ATTEMPTS } from '../src/services/break-glass.js';

const mails: { to: string; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    let data = '';
    stream.on('data', (d) => (data += d.toString()));
    stream.on('end', () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), data });
      cb();
    });
  },
});
let smtpPort = 0;
beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
  smtpPort = (smtp.server.address() as { port: number }).port;
});
afterAll(async () => new Promise<void>((r) => smtp.close(() => r())));

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
  mails.length = 0;
});

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function cli(...argv: string[]) {
  let output = '';
  const code = await runBreakGlassCli(argv, {
    breakGlass: ctx.app.services.breakGlass,
    audit: ctx.app.services.audit,
    enabled: ctx.app.config.BREAK_GLASS_ENABLED,
    out: (s) => (output += s),
  });
  return { code, output };
}

async function createAccount(username = 'bg-ops', role = 'Operator') {
  const r = await cli('create', username, '--role', role, '--name', 'Emergency Ops');
  expect(r.code).toBe(0);
  const password = /Password: +(\S+)/.exec(r.output)![1]!;
  const secret = /TOTP secret: +(\S+)/.exec(r.output)![1]!;
  return { username, password, secret, output: r.output };
}

const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + offset);

function login(body: Record<string, unknown>, ip = freshIp()) {
  return ctx.app.inject({ method: 'POST', url: '/auth/break-glass', headers: { origin: ORIGIN }, remoteAddress: ip, payload: body });
}

async function enableEmailAlerts(adminCookie: string) {
  const r = await ctx.app.inject({
    method: 'PUT',
    url: '/api/admin/settings/notifications',
    headers: write(adminCookie),
    payload: {
      settings: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, email: { enabled: true, host: '127.0.0.1', port: smtpPort, secure: false, user: '', from: 'fire@campus.example' } },
      secrets: {},
    },
  });
  expect(r.statusCode).toBe(200);
}

const audits = async (action: string) =>
  (await ctx.db.query(`SELECT outcome, user_id, details FROM audit_log WHERE action = $1 ORDER BY id`, [action])).rows;

describe('break-glass disabled (default)', () => {
  it('has no login route and advertises nothing', async () => {
    ctx = await createTestApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/mode' })).json()).toEqual({ mode: 'dev', breakGlass: false });
    const r = await login({ username: 'x', password: 'y', code: '123456' });
    expect(r.statusCode).toBe(404);
  });

  it('CLI still prepares accounts but warns that login is off', async () => {
    ctx = await createTestApp();
    const a = await createAccount();
    expect(a.output).toMatch(/BREAK_GLASS_ENABLED is false/);
  });
});

describe('break-glass enabled', () => {
  const enabled = { config: { BREAK_GLASS_ENABLED: 'true' } };

  it('logs in with password + TOTP: short session, banner flag, audit, admin alert', async () => {
    ctx = await createTestApp(enabled);
    const admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
    await enableEmailAlerts(admin);
    const a = await createAccount();
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/mode' })).json()).toEqual({ mode: 'dev', breakGlass: true });

    const r = await login({ username: 'BG-OPS ', password: a.password, code: totp(a.secret) });
    expect(r.statusCode).toBe(204);
    const cookie = r.cookies[0]!;
    expect(cookie.maxAge).toBe(2 * 3600);
    expect(cookie.httpOnly).toBe(true);
    const me = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${cookie.name}=${cookie.value}` } })).json();
    expect(me).toMatchObject({ breakGlass: true, roles: ['Operator'], email: 'bg-ops@break-glass.invalid' });

    const s = (await ctx.db.query(`SELECT method, expires_at - now() < interval '2 hours 1 minute' AS short FROM user_session WHERE user_id = $1`, [me.id])).rows[0];
    expect(s).toEqual({ method: 'break_glass', short: true });
    expect((await audits('auth.login')).at(-1)).toMatchObject({ outcome: 'success', details: { method: 'break_glass' } });
    expect(await audits('break_glass.create')).toHaveLength(1);

    // Alert reaches the (non-break-glass) admin by e-mail, asynchronously.
    await expect.poll(() => mails.length, { timeout: 5000 }).toBe(1);
    expect(mails[0]!.to).toBe('admin@campus.example');
    await expect.poll(async () => (await audits('security.alert')).length, { timeout: 5000 }).toBe(1);
    // SSO sessions keep the normal flag.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin } })).json().breakGlass).toBe(false);
  });

  it('gives one generic answer for every failure and never reveals which factor failed', async () => {
    ctx = await createTestApp(enabled);
    const a = await createAccount();
    const cases = [
      { username: 'nobody', password: a.password, code: totp(a.secret) },
      { username: a.username, password: 'wrong-password', code: totp(a.secret) },
      { username: a.username, password: a.password, code: totp(a.secret, 5) },
    ];
    const bodies = new Set<string>();
    for (const c of cases) {
      const r = await login(c);
      expect(r.statusCode).toBe(401);
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    const reasons = (await audits('auth.break_glass')).map((x) => x.details.reason);
    expect(reasons).toEqual(['unknown_user', 'bad_password', 'bad_totp']);
    // Audit never stores secrets.
    const all = JSON.stringify((await ctx.db.query('SELECT details FROM audit_log')).rows);
    expect(all).not.toContain(a.password);
    expect(all).not.toContain(a.secret);
  });

  it('rejects a replayed TOTP code', async () => {
    ctx = await createTestApp(enabled);
    const a = await createAccount();
    const code = totp(a.secret);
    expect((await login({ username: a.username, password: a.password, code })).statusCode).toBe(204);
    expect((await login({ username: a.username, password: a.password, code })).statusCode).toBe(401);
    // The next step's code still works.
    expect((await login({ username: a.username, password: a.password, code: totp(a.secret, 1) })).statusCode).toBe(204);
  });

  it(`locks after ${MAX_FAILED_ATTEMPTS} failures (even with correct credentials afterwards) and alerts admins`, async () => {
    ctx = await createTestApp(enabled);
    const admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
    await enableEmailAlerts(admin);
    const a = await createAccount();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) expect((await login({ username: a.username, password: 'nope', code: '000000' })).statusCode).toBe(401);
    expect((await login({ username: a.username, password: a.password, code: totp(a.secret) })).statusCode).toBe(401);
    const denied = await audits('auth.break_glass');
    expect(denied.filter((d) => d.details.lockedNow)).toHaveLength(1);
    expect(denied.at(-1)!.details.reason).toBe('locked');
    await expect.poll(() => mails.length, { timeout: 5000 }).toBe(1);
    expect((await cli('list')).output).toMatch(/LOCKED until/);

    // Lock expiry restores access.
    await ctx.db.query(`UPDATE break_glass_account SET locked_until = now() - interval '1 second'`);
    expect((await login({ username: a.username, password: a.password, code: totp(a.secret) })).statusCode).toBe(204);
  });

  it('rate-limits attempts per source address', async () => {
    ctx = await createTestApp(enabled);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await login({ username: 'nobody', password: 'x', code: '123456' }, '10.200.0.1')).statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Unknown names are attacker-controlled: audit is throttled.
    expect(await audits('auth.break_glass')).toHaveLength(1);
  });

  it('reset rotates credentials and revokes sessions; disable blocks login immediately', async () => {
    ctx = await createTestApp(enabled);
    const a = await createAccount();
    const r = await login({ username: a.username, password: a.password, code: totp(a.secret) });
    const cookie = `${r.cookies[0]!.name}=${r.cookies[0]!.value}`;

    const reset = await cli('reset', a.username);
    expect(reset.code).toBe(0);
    const newPassword = /Password: +(\S+)/.exec(reset.output)![1]!;
    const newSecret = /TOTP secret: +(\S+)/.exec(reset.output)![1]!;
    expect(newPassword).not.toBe(a.password);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await login({ username: a.username, password: a.password, code: totp(a.secret, 1) })).statusCode).toBe(401);
    const ok = await login({ username: a.username, password: newPassword, code: totp(newSecret) });
    expect(ok.statusCode).toBe(204);
    const cookie2 = `${ok.cookies[0]!.name}=${ok.cookies[0]!.value}`;

    expect((await cli('disable', a.username)).code).toBe(0);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie2 } })).statusCode).toBe(401);
    expect((await login({ username: a.username, password: newPassword, code: totp(newSecret, 1) })).statusCode).toBe(401);
    expect((await audits('auth.break_glass')).at(-1)!.details.reason).toBe('user_inactive');
    expect((await cli('enable', a.username)).code).toBe(0);
    expect((await audits('break_glass.disable'))).toHaveLength(1);
  });

  it('Operator accounts get every building; admins see a badge; break-glass admins get no alerts', async () => {
    ctx = await createTestApp(enabled);
    const admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
    for (const code of ['A', 'B']) await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: code, code } });
    await createAccount('bg-ops', 'Operator');
    await createAccount('bg-admin', 'FireAdmin');
    const users = (await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json().items;
    const ops = users.find((u: { email: string }) => u.email === 'bg-ops@break-glass.invalid');
    expect(ops).toMatchObject({ breakGlass: true, roles: ['Operator'] });
    expect(ops.buildingIds).toHaveLength(2);
    expect(users.find((u: { email: string }) => u.email === 'admin@campus.example').breakGlass).toBe(false);

    await enableEmailAlerts(admin);
    const sent = await ctx.app.services.notifications.notifyAdmins('t', 'x');
    expect(sent).toEqual({ sent: 1, failed: 0 });
    expect(mails.map((m) => m.to)).toEqual(['admin@campus.example']);
  });

  it('CLI validates input and caps the number of accounts', async () => {
    ctx = await createTestApp(enabled);
    expect((await cli('create', 'Bad Name!')).code).toBe(1);
    expect((await cli('create', 'bg1', '--role', 'Viewer')).code).toBe(1);
    expect((await cli('create', 'bg1', '--role')).code).toBe(1);
    expect((await cli('frobnicate')).code).toBe(2);
    expect((await cli()).code).toBe(0);
    for (const u of ['bg1', 'bg2', 'bg3']) expect((await cli('create', u)).code).toBe(0);
    const fourth = await cli('create', 'bg4');
    expect(fourth.code).toBe(1);
    expect(fourth.output).toMatch(/at most 3/);
    expect((await cli('create', 'bg1')).code).toBe(1);
    expect((await cli('reset', 'missing')).code).toBe(1);
  });

  it('validates the login payload shape', async () => {
    ctx = await createTestApp(enabled);
    expect((await login({ username: 'a', password: 'b', code: '12ab56' })).statusCode).toBe(400);
    expect((await login({ username: 'a', password: 'x'.repeat(129), code: '123456' })).statusCode).toBe(400);
  });
});
