import webpush from 'web-push';
import { httpError, postWithTimeout, ProviderError, type OutboundMessage } from './types.js';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Thrown when the subscription is gone (404/410) and should be deleted. */
export class SubscriptionGone extends ProviderError {
  constructor() {
    super('push subscription expired', false);
  }
}

/** SSRF guard: the endpoint comes from the browser, so only known push services are allowed. */
export function isAllowedPushEndpoint(endpoint: string, allowlist: string[], allowInsecure: boolean): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (allowInsecure && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  return allowlist.some((suffix) => u.hostname === suffix || u.hostname.endsWith(`.${suffix}`));
}

export async function sendPush(
  target: PushTarget,
  msg: OutboundMessage,
  vapid: { subject: string; publicKey: string; privateKey: string },
): Promise<void> {
  // web-push builds the encrypted payload and VAPID headers; we send it ourselves (timeouts, proxy, tests).
  const details = webpush.generateRequestDetails(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    JSON.stringify({ title: msg.title, body: msg.text, url: msg.url, urgent: msg.urgent }),
    {
      vapidDetails: { subject: vapid.subject || 'mailto:noreply@campus.example', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: msg.urgent ? 3600 : 86_400,
      urgency: msg.urgent ? 'high' : 'normal',
    },
  );
  const res = await postWithTimeout(details.endpoint, {
    method: details.method,
    headers: details.headers as Record<string, string>,
    body: details.body as Buffer,
  });
  if (res.status === 404 || res.status === 410) throw new SubscriptionGone();
  if (!res.ok) throw httpError(res.status);
}
