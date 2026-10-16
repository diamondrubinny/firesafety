import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { devLoginSchema } from '@firesafety/shared';
import { randomToken, sha256 } from '../lib/crypto.js';
import { notFound, parse } from '../lib/errors.js';
import { IdentityRejectedError } from '../auth/oidc.js';
import type { AuthUser } from '../services/users.js';

const LOGIN_STATE_TTL_SECONDS = 600;

/** Only same-site relative paths are accepted (prevents open redirect). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n\t]/.test(value)) return '/';
  return value;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { config, services, cookieNames } = app;
  const authRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  const cookieBase = { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax' as const };

  async function startSession(reply: FastifyReply, user: AuthUser) {
    const token = await services.sessions.create(user.id);
    reply.setCookie(cookieNames.session, token, { ...cookieBase, maxAge: config.SESSION_ABSOLUTE_HOURS * 3600 });
  }

  app.get('/auth/login', { config: authRateLimit }, async (req, reply) => {
    const returnTo = safeReturnTo((req.query as Record<string, unknown>).returnTo);
    if (!app.oidc) return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);

    const tx = await app.oidc.beginLogin(`${config.PUBLIC_ORIGIN}/auth/callback`);
    const handle = randomToken();
    await app.db.query(
      `INSERT INTO oidc_login_state (id, state, nonce, code_verifier, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [sha256(handle), tx.state, tx.nonce, tx.codeVerifier, returnTo, LOGIN_STATE_TTL_SECONDS],
    );
    reply.setCookie(cookieNames.login, handle, { ...cookieBase, maxAge: LOGIN_STATE_TTL_SECONDS });
    return reply.redirect(tx.url.href);
  });

  app.get('/auth/callback', { config: authRateLimit }, async (req, reply) => {
    if (!app.oidc) throw notFound();
    const handle = req.cookies[cookieNames.login];
    reply.clearCookie(cookieNames.login, cookieBase);
    const fail = async (reason: string, details: Record<string, unknown> = {}) => {
      await services.audit.writeThrottled(`auth.login:${req.ipHash}:${reason}`, { action: 'auth.login', outcome: 'denied', ipHash: req.ipHash, details: { reason, ...details } });
      return reply.redirect(`/login?error=${encodeURIComponent(reason)}`);
    };
    if (!handle) return fail('missing_login_state');

    const { rows } = await app.db.query(
      `DELETE FROM oidc_login_state WHERE id = $1 RETURNING state, nonce, code_verifier, return_to, expires_at > now() AS valid`,
      [sha256(handle)],
    );
    const tx = rows[0];
    if (!tx?.valid) return fail('login_state_expired');

    let user: AuthUser;
    try {
      // Build the callback URL from the configured origin, never from the Host header.
      const callbackUrl = new URL(req.url, config.PUBLIC_ORIGIN);
      const identity = await app.oidc.completeLogin(callbackUrl, {
        state: tx.state,
        nonce: tx.nonce,
        codeVerifier: tx.code_verifier,
      });
      user = await services.users.upsertFromEntra(identity);
    } catch (err) {
      if (err instanceof IdentityRejectedError) return fail(err.reason);
      req.log.warn({ err }, 'OIDC callback failed');
      return fail('login_failed');
    }
    if (!user.active) return fail('user_inactive', { userId: user.id });

    await startSession(reply, user);
    await services.audit.write({ userId: user.id, action: 'auth.login', outcome: 'success', ipHash: req.ipHash, details: { method: 'oidc', roles: user.roles } });
    return reply.redirect(safeReturnTo(tx.return_to));
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[cookieNames.session];
    if (token) await services.sessions.revoke(token);
    reply.clearCookie(cookieNames.session, cookieBase);
    if (req.user) await services.audit.write({ userId: req.user.id, action: 'auth.logout', outcome: 'success', ipHash: req.ipHash });
    return reply.status(204).send();
  });

  app.get('/auth/mode', async () => ({ mode: config.AUTH_MODE }));

  // Development-only login. Double-guarded: config validation forbids AUTH_MODE=dev in production.
  if (config.AUTH_MODE === 'dev' && config.NODE_ENV !== 'production') {
    app.log.warn('AUTH_MODE=dev: development login endpoint is ENABLED. Never use in production.');
    app.post('/auth/dev-login', { config: authRateLimit }, async (req, reply) => {
      const input = parse(devLoginSchema, req.body);
      const user = await services.users.upsertDev(input);
      if (!user.active) return reply.status(403).send({ error: 'forbidden', message: 'User is inactive' });
      await startSession(reply, user);
      await services.audit.write({ userId: user.id, action: 'auth.login', outcome: 'success', ipHash: req.ipHash, details: { method: 'dev' } });
      return reply.status(204).send();
    });
  }
};
