/*
 * Wealth Planner — Service Worker
 * ------------------------------------------------------------
 * Purpose: make the app fully usable offline after first load.
 * All user data lives in IndexedDB inside the browser, and as of
 * this version every third-party library (chart.js, Dexie, pdf.js)
 * is vendored locally under ./lib/ — there is no CDN dependency
 * left at all, so the whole app is one same-origin shell.
 *
 * Bump CACHE_VERSION whenever index.html or its assets change,
 * so returning visitors pick up the new version instead of a
 * stale cached copy.
 *
 * NOTE: This is separate from APP_VERSION / APP_VERSION_DATE in
 * js/app.js (the display label shown in the version badge). They
 * do not sync automatically — if you bump this, bump that too.
 * See the matching reminder comment near APP_VERSION in js/app.js,
 * and the deploy checklist in README.md.
 */

const CACHE_VERSION = 'v19';
const CACHE_NAME = `wealth-planner-${CACHE_VERSION}`;

// App shell — every same-origin file the app needs, including the
// vendored libraries. No CDN assets left to track separately: all
// three third-party scripts (chart.js, Dexie, pdf.js + its worker)
// live under ./lib/ and are just as "app shell" as index.html itself.
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
  './js/back-nav.js',
  './js/pdf-loader.js',
  './lib/chart.umd.min.js',
  './lib/dexie.min.js',
  './lib/pdf.min.mjs',
  './lib/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Everything is same-origin now, so the whole shell must succeed —
      // there's no separate "best-effort CDN" tier any more.
      await cache.addAll(APP_SHELL);
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
  if (url.origin !== self.location.origin) return; // no cross-origin requests to handle any more

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
});
