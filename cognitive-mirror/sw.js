// Offline cache for Cognitive Mirror. Bump VERSION when shipping changes.
const VERSION = 'mirror-v2';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: answer from cache instantly, refresh in the background.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  const network = caches.open(VERSION).then((cache) =>
    fetch(request).then((res) => {
      if (res.ok) return cache.put(request, res.clone()).then(() => res);
      return res;
    }));
  event.waitUntil(network.catch(() => {}));
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = (await cache.match(request, { ignoreSearch: true })) ||
        (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
      return cached || network.catch(() => Response.error());
    }),
  );
});
