const CACHE = 'ai-dev-deck-v3';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match('./index.html'));
    }),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'AI DEV DECK', body: event.data?.text() || '状態が更新されました。' }; }
  const title = data.title || 'AI DEV DECK';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '状態が更新されました。',
    icon: data.icon || './icon.svg',
    badge: data.badge || './icon.svg',
    tag: data.tag,
    data: data.data || {},
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = buildInboxTarget(event.notification.data || {});
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});

function buildInboxTarget(data) {
  const target = new URL('./', self.registration.scope);
  target.searchParams.set('supervisor', 'inbox');
  if (typeof data.projectId === 'string' && data.projectId) target.searchParams.set('projectId', data.projectId);
  if (typeof data.kind === 'string' && data.kind) target.searchParams.set('kind', data.kind);
  return target.href;
}
