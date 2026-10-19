// The "service worker": a tiny script the browser keeps for this site, so it
// can show DMI's notifications even when the site isn't open. It doesn't
// store or change any pages.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A notification arrived: show it.
self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'DMI', {
      body: message.body || '',
      tag: message.tag || undefined,
      renotify: Boolean(message.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: message.url || '/' },
    })
  );
});

// Tapped: open the page it's about.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.openWindow(url));
});
