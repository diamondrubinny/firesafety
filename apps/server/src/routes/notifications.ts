import type { FastifyPluginAsync } from 'fastify';
import {
  myNotificationsSchema,
  normalizePhone,
  notificationSettingsUpdateSchema,
  paginationSchema,
  pushSubscriptionSchema,
  testNotificationSchema,
  type Channel,
  type MyNotificationsView,
} from '@firesafety/shared';
import { requireAuth, requireRole, requireUser } from '../auth/guards.js';
import { badRequest, HttpError, parse } from '../lib/errors.js';
import { isAllowedPushEndpoint } from '../services/providers/push.js';
import { ProviderError } from '../services/providers/types.js';

/** Current user's own notification preferences and devices. */
export const myNotificationRoutes: FastifyPluginAsync = async (app) => {
  const { services, config } = app;
  app.addHook('preHandler', requireAuth);
  const allowlist = config.PUSH_ENDPOINT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);

  app.get('/me/notifications', async (req): Promise<MyNotificationsView> => {
    const user = requireUser(req);
    const [contact, subs, resolved] = await Promise.all([
      services.contacts.get(user.id),
      services.contacts.pushSubscriptions(user.id),
      services.settings.get(),
    ]);
    const s = resolved.settings;
    return {
      phoneHint: contact.phoneHint,
      email: contact.email,
      channels: contact.channels,
      whatsappOptIn: contact.whatsappOptIn,
      pushSubscriptions: subs.length,
      available: Object.fromEntries((['push', 'email', 'sms', 'whatsapp'] as Channel[]).map((c) => [c, s.enabled && s[c].enabled])) as Record<Channel, boolean>,
    };
  });

  app.put('/me/notifications', async (req) => {
    const user = requireUser(req);
    const input = parse(myNotificationsSchema, req.body);
    // null phone = keep current number unless explicitly cleared with ""
    const current = await services.contacts.get(user.id);
    const phone = input.phone === null ? current.phone : input.phone === '' ? null : input.phone;
    if (phone && !normalizePhone(phone)) throw badRequest('Invalid phone number', [{ path: 'phone', message: 'invalid phone number' }]);
    await services.contacts.update(user.id, { phone, channels: input.channels, whatsappOptIn: input.whatsappOptIn });
    await services.audit.write({
      userId: user.id,
      action: 'contact.update',
      entity: 'user',
      entityId: user.id,
      outcome: 'success',
      ipHash: req.ipHash,
      details: { channels: input.channels, whatsappOptIn: input.whatsappOptIn, phoneChanged: phone !== current.phone },
    });
    return { ok: true };
  });

  app.get('/push/public-key', async () => ({ publicKey: await services.settings.ensurePushKeys() }));

  app.post('/me/push-subscriptions', async (req, reply) => {
    const user = requireUser(req);
    const sub = parse(pushSubscriptionSchema, req.body);
    if (!isAllowedPushEndpoint(sub.endpoint, allowlist, config.NOTIFY_ALLOW_INSECURE_ENDPOINTS)) {
      throw badRequest('Push endpoint is not an allowed push service');
    }
    await services.contacts.addPushSubscription(user.id, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    return reply.status(201).send({ ok: true });
  });

  app.delete('/me/push-subscriptions', async (req, reply) => {
    const user = requireUser(req);
    const { endpoint } = parse(pushSubscriptionSchema.pick({ endpoint: true }), req.body);
    await services.contacts.removePushSubscription(user.id, endpoint);
    return reply.status(204).send();
  });

  app.post('/me/notifications/test', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    return { results: await services.notifications.sendSelfTest(user.id) };
  });
};

/** FireAdmin: provider configuration (secrets write-only), test sends and the delivery log. */
export const adminNotificationRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireRole('FireAdmin'));

  app.get('/settings/notifications', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return services.settings.view();
  });

  app.put('/settings/notifications', async (req, reply) => {
    const user = requireUser(req);
    const { settings, secrets } = parse(notificationSettingsUpdateSchema, req.body);
    if (secrets.smsHttpHeaders) {
      try {
        const h = JSON.parse(secrets.smsHttpHeaders) as unknown;
        if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new Error();
      } catch {
        throw badRequest('Invalid input', [{ path: 'secrets.smsHttpHeaders', message: 'must be a JSON object' }]);
      }
    }
    const changedSecrets = await services.settings.update(settings, secrets, user.id);
    await services.audit.write({
      userId: user.id,
      action: 'settings.notifications.update',
      entity: 'setting',
      entityId: 'notifications',
      outcome: 'success',
      ipHash: req.ipHash,
      // Never log secret values: only which secrets changed.
      details: { enabled: settings.enabled, changedSecrets },
    });
    reply.header('Cache-Control', 'no-store');
    return services.settings.view();
  });

  app.post('/settings/notifications/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { channel, to } = parse(testNotificationSchema, req.body);
    let target = to;
    if (channel === 'sms' || channel === 'whatsapp') {
      target = to ? (normalizePhone(to) ?? undefined) : undefined;
      if (!target) throw badRequest('Invalid input', [{ path: 'to', message: 'phone number required' }]);
    } else if (channel === 'email' && (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))) {
      throw badRequest('Invalid input', [{ path: 'to', message: 'e-mail address required' }]);
    }
    try {
      const hint = await services.notifications.sendTest(channel, target, user.id);
      await services.audit.write({ userId: user.id, action: 'notification.test', entity: 'channel', entityId: channel, outcome: 'success', ipHash: req.ipHash });
      return { ok: true, recipient: hint };
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'unexpected error';
      await services.audit.write({ userId: user.id, action: 'notification.test', entity: 'channel', entityId: channel, outcome: 'failure', ipHash: req.ipHash, details: { error: message } });
      throw new HttpError(502, 'provider_error', message);
    }
  });

  app.get('/notifications', async (req) => {
    const { limit, offset } = parse(paginationSchema, req.query);
    return services.notifications.deliveryLog(limit, offset);
  });
};
