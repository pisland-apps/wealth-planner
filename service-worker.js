/*
 * Wealth Planner — Service Worker
 * ------------------------------------------------------------
 * Purpose: make the app fully usable offline after first load.
 * All user data lives in IndexedDB inside the browser, so once
 * the app shell + its CDN libraries are cached, no network is
 * needed at all to open and use the planner.
 *
 * Bump CACHE_VERSION whenever index.html or its assets change,
 * so returning visitors pick up the new version instead of a
 * stale cached copy.
 */

const CACHE_VERSION = 'v5';
const CACHE_NAME = `wealth-planner-${CACHE_VERSION}`;

// App shell — same-origin files that make up the installed app.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './js/app.js',
  './js/pdf-worker-init.js'
];

// Third-party libraries loaded from CDNs (chart.js, Dexie, pdf.js + worker).
// Cached up front too so the very first offline session already works.
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Same-origin shell must succeed.
      await cache.addAll(APP_SHELL);
      // CDN assets are best-effort — don't fail install if one CDN
      // is briefly unreachable at install time; fetch handler below
      // will still cache them opportunistically on first real request.
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { mode: 'cors' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              await cache.put(req, res);
            }
          } catch (err) {
            // Ignore — will retry via runtime caching on next fetch.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('wealth-planner-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // only cache safe reads

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isKnownCdn = CDN_ASSETS.includes(request.url);

  if (isSameOrigin) {
    // App shell: cache-first, falling back to network, then to index.html
    // for any navigation so deep refreshes still work offline.
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
          }
          throw err;
        }
      })()
    );
    return;
  }

  if (isKnownCdn) {
    // Stale-while-revalidate: serve cached copy instantly, refresh in
    // the background so a library update is picked up next launch.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              cache.put(request, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })()
    );
  }
  // Any other cross-origin request: let the browser handle it normally.
});
