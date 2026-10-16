import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});

describe('background cycles', () => {
  it('a stuck notification cycle does not silence notifications forever', async () => {
    ctx = await createTestApp();
    let calls = 0;
    vi.spyOn(ctx.app.services.notifications, 'runOnce').mockImplementation(() => {
      calls++;
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve(); // first cycle hangs forever
    });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    void ctx.app.runNotifications();
    await ctx.app.runNotifications(); // overlapping call is skipped
    expect(calls).toBe(1);
    now.mockReturnValue(t0 + 60_000);
    await ctx.app.runNotifications(); // still within the stuck threshold
    expect(calls).toBe(1);
    now.mockReturnValue(t0 + 121_000);
    await ctx.app.runNotifications(); // recovered
    expect(calls).toBe(2);
    await ctx.app.runNotifications(); // and keeps running normally afterwards
    expect(calls).toBe(3);
  });
});
