/* Service worker: shows push notifications and opens the related page on click. */
/* global self, URL */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'התרעה', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ניטור בטיחות אש';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      dir: 'rtl',
      lang: 'he',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.url || 'fs-alert',
      renotify: true,
      requireInteraction: !!data.urgent,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only navigate within this origin.
  let target = '/';
  try {
    const u = new URL(event.notification.data && event.notification.data.url, self.location.origin);
    if (u.origin === self.location.origin) target = u.pathname + u.search;
  } catch {
    target = '/';
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
