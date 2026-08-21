const CACHE = 'ai-dev-deck-v4';
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
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  // Never cache/intercept Cloudflare Worker, OpenAI, GitHub, or any other
  // cross-origin API request. Supervisor state must always come from network.
  if (url.origin !== scope.origin) return;

  // HTML/navigation should prefer the network so a newly deployed app shell is
  // visible immediately after reload. Offline mode falls back to cached index.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Only same-origin static assets reach this cache path. Vite's hashed assets
  // are safe to cache-first because a new build gets a new URL.
  event.respondWith(cacheFirstStatic(request));
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(new URL('./index.html', self.registration.scope).href, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

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
