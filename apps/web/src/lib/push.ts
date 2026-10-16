import { api } from './api';

export type PushSupport = 'supported' | 'unsupported' | 'denied';

export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'supported';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() === 'unsupported') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission (must run from a user gesture), subscribes and registers the device on the server. */
export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'failed'> {
  if (pushSupport() === 'unsupported') return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/api/push/public-key');
  let sub: PushSubscription;
  try {
    sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  } catch {
    // The browser could not reach its push service (e.g. blocked network or unsupported browser mode).
    return 'failed';
  }
  const json = sub.toJSON();
  await api.post('/api/me/push-subscriptions', { endpoint: json.endpoint, keys: json.keys });
  return 'ok';
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.raw('DELETE', '/api/me/push-subscriptions', JSON.stringify({ endpoint: sub.endpoint }), 'application/json').catch(() => undefined);
  await sub.unsubscribe();
}
