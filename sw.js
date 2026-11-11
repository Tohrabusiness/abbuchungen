/* Service Worker: legt die App-Dateien ab, damit sie auch ohne Netz startet.
 * Strategie: erst aus dem Cache antworten, im Hintergrund aktualisieren.
 * Nach Änderungen an den Dateien CACHE hochzählen. */
const CACHE = 'abbuchungen-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './logic.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    const refresh = fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => null);

    if (cached) { event.waitUntil(refresh); return cached; }
    const fresh = await refresh;
    if (fresh) return fresh;
    if (req.mode === 'navigate') {
      const page = await caches.match('./index.html');
      if (page) return page;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
