import http from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@firesafety/shared';
import { createTestApp, loginAs, write, type TestContext } from './helpers.js';

// ---- fake providers -------------------------------------------------------------
interface Captured { path: string; headers: http.IncomingHttpHeaders; body: string }
const captured: Captured[] = [];
let failNext = 0;
let goneNext = false;
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    captured.push({ path: req.url ?? '', headers: req.headers, body });
    if (goneNext && req.url?.startsWith('/push/')) {
      goneNext = false;
      res.writeHead(410).end();
    } else if (failNext > 0) {
      failNext--;
      res.writeHead(503).end('{"secret":"leaky"}');
    } else res.writeHead(201, { 'content-type': 'application/json' }).end('{}');
  });
});
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
let fakeBase = '';
let smtpPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
  smtpPort = (smtp.server.address() as { port: number }).port;
});
afterAll(async () => {
  fake.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

// ---- fixtures ---------------------------------------------------------------------
let ctx: TestContext;
let admin: string;
let officer: string;
let officerId: string;
let bIn: string;
let token: string;
let seq = 0;

function settings(over: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    push: { enabled: true, subject: 'mailto:ops@campus.example' },
    email: { enabled: true, host: '127.0.0.1', port: smtpPort, secure: false, user: '', from: 'fire@campus.example' },
    sms: {
      enabled: true,
      provider: 'http',
      twilio: { accountSid: '', from: '' },
      http: { url: `${fakeBase}/sms?to={{to}}`, method: 'POST', contentType: 'application/json', bodyTemplate: '{"to":"{{to}}","msg":"{{text}}"}' },
    },
    whatsapp: { enabled: true, provider: 'meta-cloud', phoneNumberId: '1234567890', apiVersion: 'v21.0', templateName: 'fire_alert', templateLanguage: 'he' },
    ...over,
  };
}

async function saveSettings(s: NotificationSettings, secrets: Record<string, string> = { smsHttpHeaders: '{"X-Api-Key":"k-123"}', whatsappAccessToken: 'wa-token-xyz' }) {
  const r = await ctx.app.inject({ method: 'PUT', url: '/api/admin/settings/notifications', headers: write(admin), payload: { settings: s, secrets } });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function fire(objectInstance: number, ls = 'alarm') {
  seq++;
  await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/batch',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      epoch: 'epoch-notify',
      sentAt: new Date().toISOString(),
      collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 },
      events: [{ seq, deviceInstance: 1001, objectType: 'life-safety-point', objectInstance, source: 'poll', observedAt: new Date().toISOString(), lifeSafetyState: ls }],
    },
  });
}

/** A valid browser-style push subscription pointing at the fake push service. */
function pushSubscription(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `${fakeBase}/push/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const rows = async () => (await ctx.db.query('SELECT channel, stage, status, last_error, recipient_hint FROM notification ORDER BY channel, stage')).rows;

beforeEach(async () => {
  ctx = await createTestApp({ config: { TWILIO_API_BASE: fakeBase, WHATSAPP_API_BASE: fakeBase } });
  captured.length = 0;
  mails.length = 0;
  failNext = 0;
  seq = 0;
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
  officerId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: officer } })).json().id;
  bIn = (await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: 'בניין A', code: 'A' } })).json().id;
  await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(admin), payload: { buildingIds: [bIn] } });
  token = (await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'c' } })).json().token;
  // Create the device and assign it to the building, so its points belong to "A".
  await ctx.app.inject({
    method: 'POST', url: '/ingest/v1/batch', headers: { authorization: `Bearer ${token}` },
    payload: { epoch: 'epoch-notify', sentAt: new Date().toISOString(), collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 }, devices: [{ instance: 1001, address: '10.0.0.5', online: true }] },
  });
  const dev = (await ctx.app.inject({ method: 'GET', url: '/api/admin/devices', headers: { cookie: admin } })).json()[0];
  await ctx.app.inject({ method: 'PATCH', url: `/api/admin/devices/${dev.id}`, headers: write(admin), payload: { buildingId: bIn } });
  // Officer: phone + WhatsApp consent + one push device. Admin: e-mail only (no phone).
  await ctx.app.inject({ method: 'PUT', url: '/api/me/notifications', headers: write(officer), payload: { phone: '050-123-4567', channels: ['push', 'email', 'sms', 'whatsapp'], whatsappOptIn: true } });
  await ctx.app.inject({ method: 'POST', url: '/api/me/push-subscriptions', headers: write(officer), payload: pushSubscription('officer-1') });
});
afterEach(async () => ctx.close());

describe('settings', () => {
  it('stores secrets encrypted, never returns them, and audits only names', async () => {
    const view = await saveSettings(settings());
    expect(view.secretsConfigured).toMatchObject({ smsHttpHeaders: true, whatsappAccessToken: true, emailPassword: false });
    expect(JSON.stringify(view)).not.toContain('wa-token-xyz');
    expect(view.pushPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const { rows: db } = await ctx.db.query("SELECT value::text AS v, secret_enc FROM app_setting WHERE key = 'notifications'");
    expect(db[0].v).not.toContain('wa-token-xyz');
    expect(Buffer.from(db[0].secret_enc).toString('latin1')).not.toContain('wa-token-xyz');
    const audit = await ctx.db.query("SELECT details::text AS d FROM audit_log WHERE action = 'settings.notifications.update'");
    expect(audit.rows[0].d).toContain('secret:whatsappAccessToken');
    expect(audit.rows[0].d).not.toContain('wa-token-xyz');
  });

  it('keeps secrets when omitted and clears them with ""', async () => {
    await saveSettings(settings());
    let view = await saveSettings(settings(), {});
    expect(view.secretsConfigured.whatsappAccessToken).toBe(true);
    view = await saveSettings(settings(), { whatsappAccessToken: '' });
    expect(view.secretsConfigured.whatsappAccessToken).toBe(false);
  });

  it('is FireAdmin-only and validates input', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/settings/notifications', headers: { cookie: officer } })).statusCode).toBe(403);
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/admin/settings/notifications', headers: write(admin), payload: { settings: { ...settings(), policy: { ...settings().policy, escalationSeconds: 5 } } } });
    expect(bad.statusCode).toBe(400);
    const badHeaders = await ctx.app.inject({ method: 'PUT', url: '/api/admin/settings/notifications', headers: write(admin), payload: { settings: settings(), secrets: { smsHttpHeaders: 'not json' } } });
    expect(badHeaders.statusCode).toBe(400);
  });
});

describe('user contact and push subscriptions', () => {
  it('stores the phone encrypted and returns only a masked hint', async () => {
    const me = (await ctx.app.inject({ method: 'GET', url: '/api/me/notifications', headers: { cookie: officer } })).json();
    expect(me).toMatchObject({ phoneHint: '+97250•••4567', whatsappOptIn: true, pushSubscriptions: 1 });
    const { rows: db } = await ctx.db.query('SELECT phone_enc FROM user_contact');
    expect(Buffer.from(db[0].phone_enc).toString('latin1')).not.toContain('501234567');
  });

  it('rejects invalid phone numbers', async () => {
    const r = await ctx.app.inject({ method: 'PUT', url: '/api/me/notifications', headers: write(officer), payload: { phone: 'abc', channels: ['sms'], whatsappOptIn: false } });
    expect(r.statusCode).toBe(400);
  });

  it('rejects push endpoints outside the allowlist (SSRF)', async () => {
    for (const endpoint of ['https://169.254.169.254/latest/meta-data', 'https://internal.campus.example/x', 'http://example.com/push']) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/me/push-subscriptions', headers: write(officer), payload: { ...pushSubscription('x'), endpoint } });
      expect(r.statusCode).toBe(400);
    }
  });
});

describe('alarm notifications', () => {
  it('fire: sends push, SMS, WhatsApp and e-mail to in-scope officers; admins by e-mail/push only where possible', async () => {
    await saveSettings(settings());
    await fire(7);
    await ctx.app.runNotifications();

    const sms = captured.find((c) => c.path.startsWith('/sms'))!;
    expect(sms.path).toBe('/sms?to=%2B972501234567');
    expect(sms.headers['x-api-key']).toBe('k-123');
    const smsBody = JSON.parse(sms.body);
    expect(smsBody.to).toBe('+972501234567');
    expect(smsBody.msg).toContain('אש | בניין A');
    expect(smsBody.msg).toMatch(/\/alarms\/[0-9a-f-]{36}/);

    const wa = captured.find((c) => c.path === '/v21.0/1234567890/messages')!;
    expect(wa.headers.authorization).toBe('Bearer wa-token-xyz');
    const waBody = JSON.parse(wa.body);
    expect(waBody).toMatchObject({ messaging_product: 'whatsapp', to: '972501234567', type: 'template', template: { name: 'fire_alert', language: { code: 'he' } } });
    expect(waBody.template.components[0].parameters).toHaveLength(2);

    const push = captured.find((c) => c.path === '/push/officer-1')!;
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(push.headers.authorization).toMatch(/^vapid t=/);
    expect(push.headers.urgency).toBe('high');

    expect(mails.map((m) => m.to).sort()).toEqual(['admin@campus.example', 'officer@campus.example']);

    const all = await rows();
    // Officer: 4 sent. Admin: email sent, push skipped (no device), sms/whatsapp skipped (no phone).
    expect(all.filter((r) => r.status === 'sent')).toHaveLength(5);
    expect(all.filter((r) => r.status === 'skipped').map((r) => r.last_error)).toEqual(
      expect.arrayContaining(['אין מכשיר רשום ל-Push', 'לא הוגדר מספר טלפון']),
    );
    expect(all.find((r) => r.channel === 'sms' && r.status === 'sent')!.recipient_hint).toBe('+97250•••4567');
  });

  it('does nothing while notifications are disabled', async () => {
    await saveSettings({ ...settings(), enabled: false });
    await fire(7);
    await ctx.app.runNotifications();
    expect(captured).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it('respects user opt-out per channel and requires WhatsApp consent', async () => {
    await saveSettings(settings());
    await ctx.app.inject({ method: 'PUT', url: '/api/me/notifications', headers: write(officer), payload: { phone: null, channels: ['sms', 'whatsapp'], whatsappOptIn: false } });
    await fire(7);
    await ctx.app.runNotifications();
    const officerRows = (await ctx.db.query('SELECT channel, status, last_error FROM notification WHERE user_id = $1 ORDER BY channel', [officerId])).rows;
    expect(officerRows).toEqual([
      { channel: 'sms', status: 'sent', last_error: null },
      { channel: 'whatsapp', status: 'skipped', last_error: 'המשתמש לא אישר קבלת WhatsApp' },
    ]);
  });

  it('out-of-scope officers are not notified', async () => {
    await saveSettings(settings());
    await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(admin), payload: { buildingIds: [] } });
    await fire(7);
    await ctx.app.runNotifications();
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM notification WHERE user_id = $1', [officerId])).rows[0].n).toBe(0);
  });

  it('groups a burst into one message per channel and rate-limits follow-ups', async () => {
    await saveSettings({ ...settings(), policy: { ...settings().policy, groupingSeconds: 10 } });
    await fire(1);
    await fire(2);
    await fire(3);
    await ctx.app.runNotifications();
    const smsCalls = captured.filter((c) => c.path.startsWith('/sms'));
    expect(smsCalls).toHaveLength(1);
    expect(JSON.parse(smsCalls[0]!.body).msg).toContain('3 התרעות');

    await fire(4);
    await ctx.app.runNotifications();
    expect(captured.filter((c) => c.path.startsWith('/sms'))).toHaveLength(1); // deferred by the grouping window
    const deferred = (await ctx.db.query("SELECT next_attempt_at > now() AS later FROM notification WHERE channel = 'sms' AND status = 'pending'")).rows;
    expect(deferred.every((r) => r.later)).toBe(true);
  });

  it('retries transient provider failures with backoff without leaking provider responses', async () => {
    await saveSettings({ ...settings(), push: { enabled: false, subject: '' }, email: { ...settings().email, enabled: false }, whatsapp: { ...settings().whatsapp, enabled: false } });
    failNext = 1;
    await fire(7);
    await ctx.app.runNotifications();
    let sms = (await ctx.db.query("SELECT status, attempts, last_error FROM notification WHERE channel = 'sms' AND user_id = $1", [officerId])).rows[0];
    expect(sms).toMatchObject({ status: 'pending', attempts: 1, last_error: 'provider responded HTTP 503' });
    await ctx.db.query("UPDATE notification SET next_attempt_at = now() WHERE status = 'pending'");
    await ctx.app.runNotifications();
    sms = (await ctx.db.query("SELECT status, attempts FROM notification WHERE channel = 'sms' AND user_id = $1", [officerId])).rows[0];
    expect(sms).toEqual({ status: 'sent', attempts: 2 });
  });

  it('removes expired push subscriptions (410)', async () => {
    await saveSettings(settings());
    goneNext = true;
    await fire(7);
    await ctx.app.runNotifications();
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM push_subscription')).rows[0].n).toBe(0);
  });

  it('skips sending when the alarm was acknowledged before delivery', async () => {
    await saveSettings(settings());
    await fire(7);
    await ctx.app.services.notifications.plan();
    const alarmId = (await ctx.db.query('SELECT id FROM alarm')).rows[0].id;
    await ctx.app.inject({ method: 'POST', url: `/api/alarms/${alarmId}/ack`, headers: write(officer), payload: {} });
    await ctx.app.services.notifications.process();
    expect(captured).toHaveLength(0);
    expect((await rows()).every((r) => r.status === 'skipped')).toBe(true);
  });

  it('escalates an unacknowledged fire to admins after the configured delay; ack prevents it', async () => {
    await saveSettings({ ...settings(), policy: { ...settings().policy, escalationSeconds: 30 } });
    await fire(7);
    await fire(8);
    await ctx.app.runNotifications();
    const [a7, a8] = (await ctx.db.query('SELECT a.id FROM alarm a JOIN point p ON p.id = a.point_id ORDER BY p.object_instance')).rows.map((r) => r.id);
    await ctx.app.inject({ method: 'POST', url: `/api/alarms/${a8}/ack`, headers: write(officer), payload: {} });
    await ctx.db.query("UPDATE alarm SET received_at = now() - interval '1 minute'");
    captured.length = 0;
    await ctx.app.runNotifications();
    const esc = (await ctx.db.query("SELECT alarm_id, channel, status FROM notification WHERE stage = 'escalation' AND status = 'sent'")).rows;
    expect(new Set(esc.map((r) => r.alarm_id))).toEqual(new Set([a7]));
    const smsMsg = JSON.parse(captured.find((c) => c.path.startsWith('/sms'))!.body).msg;
    expect(smsMsg).toContain('הסלמה');
    await ctx.app.runNotifications();
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM notification WHERE stage = 'escalation'")).rows[0].n).toBe(esc.length + (await ctx.db.query("SELECT count(*)::int AS n FROM notification WHERE stage = 'escalation' AND status <> 'sent'")).rows[0].n);
  });

  it('communication alarms go to admins only', async () => {
    await saveSettings(settings());
    await ctx.app.inject({
      method: 'POST', url: '/ingest/v1/batch', headers: { authorization: `Bearer ${token}` },
      payload: { epoch: 'epoch-notify', sentAt: new Date().toISOString(), collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 }, devices: [{ instance: 1001, address: '10.0.0.5', online: false }] },
    });
    await ctx.app.runNotifications();
    const users = (await ctx.db.query('SELECT DISTINCT user_id FROM notification')).rows.map((r) => r.user_id);
    expect(users).not.toContain(officerId);
    expect(users).toHaveLength(1);
  });

  it('a new server instance resumes pending deliveries (outbox in the database)', async () => {
    await saveSettings(settings());
    await fire(7);
    await ctx.app.services.notifications.plan();
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM notification WHERE status = 'pending'")).rows[0].n).toBeGreaterThan(0);
    await ctx.app.close();
    const { buildApp } = await import('../src/app.js');
    const { testConfig } = await import('./helpers.js');
    const app2 = await buildApp({ config: testConfig({ TWILIO_API_BASE: fakeBase, WHATSAPP_API_BASE: fakeBase }), db: ctx.db, logger: false, backgroundJobs: false });
    await app2.runNotifications();
    expect((await ctx.db.query("SELECT count(*)::int AS n FROM notification WHERE status = 'pending'")).rows[0].n).toBe(0);
    await app2.close();
    ctx.app = await buildApp({ config: testConfig(), db: ctx.db, logger: false, backgroundJobs: false });
  });
});

describe('test sends', () => {
  it('admin can test each channel; failures are reported without secrets', async () => {
    await saveSettings(settings());
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/admin/settings/notifications/test', headers: write(admin), payload: { channel: 'sms', to: '052-7654321' } });
    expect(ok.json()).toEqual({ ok: true, recipient: '+97252•••4321' });
    failNext = 1;
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/admin/settings/notifications/test', headers: write(admin), payload: { channel: 'whatsapp', to: '052-7654321' } });
    expect(bad.statusCode).toBe(502);
    expect(bad.body).not.toContain('leaky');
    const mail = await ctx.app.inject({ method: 'POST', url: '/api/admin/settings/notifications/test', headers: write(admin), payload: { channel: 'email', to: 'ops@campus.example' } });
    expect(mail.json().ok).toBe(true);
    expect(mails.at(-1)!.to).toBe('ops@campus.example');
  });

  it('Twilio SMS: form-encoded request with basic auth', async () => {
    const sid = `AC${'a'.repeat(32)}`;
    await saveSettings({ ...settings(), sms: { ...settings().sms, provider: 'twilio', twilio: { accountSid: sid, from: '+15005550006' } } }, { twilioAuthToken: 'tw-secret' });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/admin/settings/notifications/test', headers: write(admin), payload: { channel: 'sms', to: '+972527654321' } });
    expect(r.json().ok).toBe(true);
    const call = captured.find((c) => c.path === `/2010-04-01/Accounts/${sid}/Messages.json`)!;
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${sid}:tw-secret`).toString('base64')}`);
    expect(new URLSearchParams(call.body).get('To')).toBe('+972527654321');
    expect(new URLSearchParams(call.body).get('From')).toBe('+15005550006');
  });

  it('user self-test covers their enabled channels', async () => {
    await saveSettings(settings());
    const r = (await ctx.app.inject({ method: 'POST', url: '/api/me/notifications/test', headers: write(officer), payload: {} })).json();
    expect(Object.keys(r.results).sort()).toEqual(['email', 'push', 'sms', 'whatsapp']);
    expect(Object.values(r.results).every((v) => String(v).startsWith('נשלח'))).toBe(true);
  });

  it('delivery log is admin-only and masked', async () => {
    await saveSettings(settings());
    await fire(7);
    await ctx.app.runNotifications();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/notifications', headers: { cookie: officer } })).statusCode).toBe(403);
    const log = (await ctx.app.inject({ method: 'GET', url: '/api/admin/notifications', headers: { cookie: admin } })).json();
    expect(JSON.stringify(log)).not.toContain('501234567');
  });
});
