import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestApp, loginAs, ORIGIN, write, type TestContext } from './helpers.js';

let ctx: TestContext;
let base: string;

beforeEach(async () => {
  ctx = await createTestApp();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = ctx.app.server.address() as { port: number };
  base = `ws://127.0.0.1:${addr.port}/api/ws`;
});
afterEach(async () => ctx.close());

function connect(headers: Record<string, string>): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base, { headers });
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const until = async (fn: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('websocket', () => {
  it('rejects unauthenticated and cross-origin upgrades', async () => {
    await expect(connect({ origin: ORIGIN })).rejects.toThrow(/status 401/);
    const cookie = await loginAs(ctx.app, 'a@campus.example', ['FireAdmin']);
    await expect(connect({ origin: 'https://evil.example', cookie })).rejects.toThrow(/status 403/);
  });

  it('notifies in-scope clients only, without alarm content', async () => {
    const admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
    const officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'c1' } })).json().token;

    const a = await connect({ origin: ORIGIN, cookie: admin });
    const o = await connect({ origin: ORIGIN, cookie: officer });
    await until(() => a.messages.length > 0 && o.messages.length > 0); // hello

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        epoch: 'epoch-ws-01',
        sentAt: new Date().toISOString(),
        collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 },
        events: [{ seq: 1, deviceInstance: 5, objectType: 'life-safety-point', objectInstance: 1, source: 'poll', observedAt: new Date().toISOString(), lifeSafetyState: 'alarm' }],
      },
    });
    expect(res.statusCode).toBe(200);
    await until(() => a.messages.length > 1);
    expect(a.messages[1]).toEqual({ type: 'alarms', categories: ['fire'] });
    await new Promise((r) => setTimeout(r, 200));
    expect(o.messages).toEqual([{ type: 'hello' }]); // unmapped point is not in the officer's scope
    a.ws.close();
    o.ws.close();
  });

  it('caps live connections per user (oldest closed)', async () => {
    const cookie = await loginAs(ctx.app, 'many@campus.example', ['Viewer']);
    const first = await connect({ origin: ORIGIN, cookie });
    const closed = new Promise<number>((r) => first.ws.on('close', (code) => r(code)));
    const others = [];
    for (let i = 0; i < 5; i++) others.push(await connect({ origin: ORIGIN, cookie }));
    expect(await closed).toBe(4429);
    for (const o of others) o.ws.close();
  });

  it('closes the socket after logout on the next refresh', async () => {
    const cookie = await loginAs(ctx.app, 'b@campus.example', ['Viewer']);
    const c = await connect({ origin: ORIGIN, cookie });
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: ORIGIN } });
    await ctx.app.runJobs();
    expect(await closed).toBe(4401);
  });
});
