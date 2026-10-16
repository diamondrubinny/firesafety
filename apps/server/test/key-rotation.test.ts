import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS } from '@firesafety/shared';
import { createTestApp, loginAs, testConfig, write, type TestContext } from './helpers.js';
import { createSecretBox, SecretBox } from '../src/lib/secretbox.js';
import { ENCRYPTED_COLUMNS, RotationAbortedError, rotateKeys } from '../src/cli/rotate-key-core.js';
import { SettingsService } from '../src/services/settings.js';
import { BreakGlassService } from '../src/services/break-glass.js';

const OLD = Buffer.alloc(32, 9).toString('base64'); // the key createTestApp uses
const NEW = Buffer.alloc(32, 4).toString('base64');
const OTHER = Buffer.alloc(32, 5).toString('base64');

describe('SecretBox keyring', () => {
  it('encrypts with the primary key and decrypts with previous keys', () => {
    const old = new SecretBox(OLD);
    const ring = new SecretBox(NEW, [OLD]);
    const legacy = old.encrypt('secret');
    expect(ring.decryptWithInfo(legacy)).toEqual({ plaintext: 'secret', primary: false });
    expect(ring.decryptWithInfo(ring.encrypt('x'))).toEqual({ plaintext: 'x', primary: true });
    expect(() => old.decrypt(ring.encrypt('x'))).toThrow(/no matching key/);
    expect(() => ring.decrypt(Buffer.alloc(10))).toThrow();
  });

  it('config validates previous keys', () => {
    expect(() => testConfig({ SETTINGS_ENCRYPTION_KEY: NEW, SETTINGS_ENCRYPTION_KEY_PREVIOUS: NEW })).toThrow(/must differ/);
    expect(() => testConfig({ SETTINGS_ENCRYPTION_KEY: NEW, SETTINGS_ENCRYPTION_KEY_PREVIOUS: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    const cfg = testConfig({ SETTINGS_ENCRYPTION_KEY: NEW, SETTINGS_ENCRYPTION_KEY_PREVIOUS: `${OLD}, ${OTHER}` });
    expect(createSecretBox(cfg).decrypt(new SecretBox(OTHER).encrypt('ok'))).toBe('ok');
  });
});

describe('rotate-key', () => {
  let ctx: TestContext;
  afterEach(async () => ctx?.close());

  /** Settings secrets, a verified + a pending phone, and a break-glass TOTP secret, all under OLD. */
  async function seed() {
    ctx = await createTestApp({ config: { BREAK_GLASS_ENABLED: 'true' } });
    const admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
    const r = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/settings/notifications',
      headers: write(admin),
      payload: { settings: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false }, secrets: { emailPassword: 'smtp-pass-123' } },
    });
    expect(r.statusCode).toBe(200);
    const userId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin } })).json().id;
    const old = new SecretBox(OLD);
    await ctx.db.query(
      `INSERT INTO user_contact (user_id, phone_enc, phone_hint, pending_phone_enc) VALUES ($1, $2, '•••4567', $3)`,
      [userId, old.encrypt('+972501234567'), old.encrypt('+972509999999')],
    );
    const creds = await ctx.app.services.breakGlass.create({ username: 'bg-ops', displayName: 'x', role: 'Operator' });
    return { userId, creds };
  }

  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(ENCRYPTED_COLUMNS.map(async (c) => (await ctx.db.query(`SELECT ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL ORDER BY 1`)).rows)),
    );

  it('covers every encrypted (*_enc) column in the schema', async () => {
    ctx = await createTestApp();
    const { rows } = await ctx.db.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_enc' AND data_type = 'bytea' ORDER BY 1`,
    );
    expect(rows.map((r) => r.c).sort()).toEqual(ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
  });

  it('dry run reports and changes nothing; real run re-encrypts everything under the new key', async () => {
    const { userId, creds } = await seed();
    const ring = new SecretBox(NEW, [OLD]);
    const before = await snapshot();

    const dry = await rotateKeys(ctx.db, ring, NEW, { dryRun: true });
    expect(dry.reduce((s, r) => s + r.reencrypted, 0)).toBe(4);
    expect(await snapshot()).toBe(before);

    const report = await rotateKeys(ctx.db, ring, NEW, { dryRun: false, audit: ctx.app.services.audit });
    expect(report.map((r) => [r.column, r.reencrypted])).toEqual([
      ['app_setting.secret_enc', 1],
      ['user_contact.phone_enc', 1],
      ['user_contact.pending_phone_enc', 1],
      ['break_glass_account.totp_secret_enc', 1],
    ]);

    // Everything is now readable with the NEW key alone.
    const onlyNew = new SecretBox(NEW);
    expect((await new SettingsService(ctx.db, onlyNew).get()).secrets.emailPassword).toBe('smtp-pass-123');
    const c = (await ctx.db.query('SELECT phone_enc, pending_phone_enc FROM user_contact WHERE user_id = $1', [userId])).rows[0];
    expect([onlyNew.decrypt(c.phone_enc), onlyNew.decrypt(c.pending_phone_enc)]).toEqual(['+972501234567', '+972509999999']);
    const bg = new BreakGlassService(ctx.db, onlyNew);
    const { hotp, base32Decode, totpStep } = await import('../src/lib/totp.js');
    const ok = await bg.authenticate('bg-ops', creds.password, hotp(base32Decode(creds.totpSecret), totpStep(Date.now())));
    expect(ok.ok).toBe(true);
    // ...and no longer with the OLD key.
    await expect(new SettingsService(ctx.db, new SecretBox(OLD)).get()).rejects.toThrow();

    const audit = (await ctx.db.query(`SELECT details FROM audit_log WHERE action = 'settings.key_rotation'`)).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/smtp-pass|9725/);

    // Idempotent.
    const again = await rotateKeys(ctx.db, ring, NEW, { dryRun: false });
    expect(again.every((r) => r.reencrypted === 0 && r.alreadyPrimary === r.total)).toBe(true);
  });

  it('aborts without any change when the old key is missing from the ring', async () => {
    await seed();
    const before = await snapshot();
    const err = await rotateKeys(ctx.db, new SecretBox(NEW), NEW, { dryRun: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RotationAbortedError);
    expect((err as RotationAbortedError).report.reduce((s, r) => s + r.undecryptable, 0)).toBe(4);
    expect(await snapshot()).toBe(before);
  });

  it('a running server with the keyring keeps working mid-rotation (no downtime)', async () => {
    await seed();
    const ring = createSecretBox(testConfig({ SETTINGS_ENCRYPTION_KEY: NEW, SETTINGS_ENCRYPTION_KEY_PREVIOUS: OLD }));
    // Before rotation: old data readable through the ring; new writes use the NEW key.
    const svc = new SettingsService(ctx.db, ring);
    expect((await svc.get()).secrets.emailPassword).toBe('smtp-pass-123');
    await rotateKeys(ctx.db, ring, NEW, { dryRun: false });
    expect((await svc.get()).secrets.emailPassword).toBe('smtp-pass-123');
  });
});
