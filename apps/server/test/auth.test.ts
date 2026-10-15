import { afterEach, describe, expect, it } from 'vitest';
import type { OidcProvider } from '../src/auth/oidc.js';
import { IdentityRejectedError } from '../src/auth/oidc.js';
import { safeReturnTo } from '../src/routes/auth.js';
import { createTestApp, loginAs, ORIGIN, write, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('session auth', () => {
  it('returns 401 without a session', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('sets a hardened cookie and resolves /api/me', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      headers: { origin: ORIGIN },
      payload: { email: 'a@campus.example', displayName: 'A', roles: ['Operator'] },
    });
    expect(res.statusCode).toBe(204);
    const c = res.cookies[0]!;
    expect(c.name).toBe('__Host-fs_sid');
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('Lax');

    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${c.name}=${c.value}` } });
    expect(me.json()).toMatchObject({ email: 'a@campus.example', roles: ['Operator'], globalScope: false });
  });

  it('stores only a hash of the session token', async () => {
    ctx = await createTestApp();
    const cookie = await loginAs(ctx.app, 'h@campus.example', ['Viewer']);
    const token = cookie.split('=')[1]!;
    const { rows } = await ctx.db.query('SELECT token_hash FROM user_session');
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].token_hash).toString('utf8')).not.toContain(token);
  });

  it('logout revokes the session server-side', async () => {
    ctx = await createTestApp();
    const cookie = await loginAs(ctx.app, 'b@campus.example', ['Viewer']);
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: write(cookie) });
    expect(out.statusCode).toBe(204);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('expires idle sessions', async () => {
    ctx = await createTestApp();
    const cookie = await loginAs(ctx.app, 'idle@campus.example', ['Viewer']);
    await ctx.db.query("UPDATE user_session SET last_seen_at = now() - interval '2 hours'");
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects sessions of deactivated users', async () => {
    ctx = await createTestApp();
    const cookie = await loginAs(ctx.app, 'gone@campus.example', ['Viewer']);
    await ctx.db.query('UPDATE app_user SET active = false');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects state-changing requests without our Origin (CSRF)', async () => {
    ctx = await createTestApp();
    const cookie = await loginAs(ctx.app, 'c@campus.example', ['FireAdmin']);
    for (const origin of [undefined, 'https://evil.example']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/admin/faculties',
        headers: origin ? { cookie, origin } : { cookie },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('bad_origin');
    }
  });

  it('does not expose the dev login when AUTH_MODE=oidc', async () => {
    const oidc: OidcProvider = {
      beginLogin: async () => ({ url: new URL('https://idp.example/authorize'), state: 's', nonce: 'n', codeVerifier: 'v' }),
      completeLogin: async () => {
        throw new Error('unused');
      },
    };
    ctx = await createTestApp({
      oidc,
      config: { AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.example', OIDC_TENANT_ID: 't', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' },
    });
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/dev-login', headers: { origin: ORIGIN }, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('sends security headers', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/buildings', '/buildings'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/ok\r\nSet-Cookie:x', '/'],
    [42, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe('OIDC flow', () => {
  const oidcConfig = {
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_TENANT_ID: 'tenant',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
  };

  function fakeProvider(result: () => Promise<unknown>): OidcProvider & { seen: unknown[] } {
    const seen: unknown[] = [];
    return {
      seen,
      beginLogin: async (redirectUri) => {
        seen.push(redirectUri);
        return { url: new URL('https://idp.example/authorize?x=1'), state: 'st', nonce: 'no', codeVerifier: 'cv' };
      },
      completeLogin: async (url, checks) => {
        seen.push(url.href, checks);
        return result() as never;
      },
    };
  }

  async function startLogin(returnTo: string) {
    const res = await ctx!.app.inject({ method: 'GET', url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example/authorize?x=1');
    const c = res.cookies.find((x) => x.name === '__Host-fs_login')!;
    return `${c.name}=${c.value}`;
  }

  it('completes login, creates the user from claims and redirects to returnTo', async () => {
    const provider = fakeProvider(async () => ({ oid: 'o1', tenantId: 'tenant', email: 'so@campus.example', displayName: 'SO', roles: ['SafetyOfficer'], amr: [] }));
    ctx = await createTestApp({ oidc: provider, config: oidcConfig });
    const loginCookie = await startLogin('/buildings');

    const cb = await ctx.app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=st', headers: { cookie: loginCookie } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/buildings');
    expect(provider.seen[0]).toBe(`${ORIGIN}/auth/callback`);
    expect(provider.seen[1]).toBe(`${ORIGIN}/auth/callback?code=abc&state=st`);
    expect(provider.seen[2]).toEqual({ state: 'st', nonce: 'no', codeVerifier: 'cv' });

    const session = cb.cookies.find((x) => x.name === '__Host-fs_sid')!;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${session.name}=${session.value}` } });
    expect(me.json()).toMatchObject({ email: 'so@campus.example', roles: ['SafetyOfficer'] });

    // Login state is single-use.
    const replay = await ctx.app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=st', headers: { cookie: loginCookie } });
    expect(replay.headers.location).toBe('/login?error=login_state_expired');
  });

  it('denies identities rejected by policy and audits the attempt', async () => {
    ctx = await createTestApp({ oidc: fakeProvider(async () => { throw new IdentityRejectedError('no_app_role'); }), config: oidcConfig });
    const loginCookie = await startLogin('/');
    const cb = await ctx.app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=st', headers: { cookie: loginCookie } });
    expect(cb.headers.location).toBe('/login?error=no_app_role');
    expect(cb.cookies.find((x) => x.name === '__Host-fs_sid')).toBeUndefined();
    const { rows } = await ctx.db.query("SELECT outcome, details FROM audit_log WHERE action = 'auth.login'");
    expect(rows).toEqual([{ outcome: 'denied', details: { reason: 'no_app_role' } }]);
  });

  it('rejects a callback without login state', async () => {
    ctx = await createTestApp({ oidc: fakeProvider(async () => ({})), config: oidcConfig });
    const cb = await ctx.app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=st' });
    expect(cb.headers.location).toBe('/login?error=missing_login_state');
  });

  it('does not leak provider errors to the client', async () => {
    ctx = await createTestApp({ oidc: fakeProvider(async () => { throw new Error('internal token endpoint details'); }), config: oidcConfig });
    const loginCookie = await startLogin('/');
    const cb = await ctx.app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=st', headers: { cookie: loginCookie } });
    expect(cb.headers.location).toBe('/login?error=login_failed');
  });
});
