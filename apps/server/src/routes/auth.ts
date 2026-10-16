import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { breakGlassLoginSchema, devLoginSchema, type AuthModeInfo } from '@firesafety/shared';
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

  async function startSession(reply: FastifyReply, user: AuthUser, breakGlass = false) {
    const hours = breakGlass ? config.BREAK_GLASS_SESSION_HOURS : config.SESSION_ABSOLUTE_HOURS;
    const token = await services.sessions.create(user.id, { method: breakGlass ? 'break_glass' : 'sso', absoluteHours: hours });
    reply.setCookie(cookieNames.session, token, { ...cookieBase, maxAge: hours * 3600 });
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

  app.get('/auth/mode', async (): Promise<AuthModeInfo> => ({ mode: config.AUTH_MODE, breakGlass: config.BREAK_GLASS_ENABLED }));

  if (config.BREAK_GLASS_ENABLED) {
    app.log.warn('BREAK_GLASS_ENABLED: emergency local login is available');
    const israelTime = () => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
    // Best effort and non-blocking: an emergency login must never wait on SMTP/SMS. The outcome is audited.
    const alertAdmins = (title: string, text: string, userId: string | null) => {
      services.notifications
        .notifyAdmins(title, text)
        .then((r) => services.audit.write({ userId, action: 'security.alert', outcome: r.sent > 0 ? 'success' : 'failure', details: { kind: 'break_glass', ...r } }))
        .catch((err: unknown) => app.log.error({ err }, 'break-glass security alert failed'));
    };

    app.post('/auth/break-glass', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const input = parse(breakGlassLoginSchema, req.body);
      const r = await services.breakGlass.authenticate(input.username, input.password, input.code);
      if (!r.ok) {
        const rec = { userId: r.userId ?? null, action: 'auth.break_glass', outcome: 'denied' as const, ipHash: req.ipHash, details: { reason: r.reason, ...(r.lockedNow ? { lockedNow: true } : {}) } };
        // Unknown names are attacker-controlled: throttle them. Real accounts are bounded by the lockout.
        if (r.reason === 'unknown_user') await services.audit.writeThrottled(`auth.break_glass:${req.ipHash}`, rec);
        else await services.audit.write(rec);
        if (r.lockedNow) {
          alertAdmins('חשבון חירום ננעל', `חשבון כניסת חירום ננעל אחרי ניסיונות כושלים חוזרים (${israelTime()}). ייתכן ניסיון פריצה. יש לבדוק ביומן הביקורת.`, r.userId ?? null);
        }
        return reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid credentials' });
      }
      await startSession(reply, r.user, true);
      await services.audit.write({ userId: r.user.id, action: 'auth.login', outcome: 'success', ipHash: req.ipHash, details: { method: 'break_glass', roles: r.user.roles } });
      alertAdmins(
        'בוצעה כניסת חירום',
        `בוצעה כניסת חירום (Break-glass) למערכת ניטור האש בחשבון "${r.user.displayName}" (${israelTime()}). אם הכניסה לא הייתה צפויה, יש להשבית את החשבון מיד.`,
        r.user.id,
      );
      return reply.status(204).send();
    });
  }

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
