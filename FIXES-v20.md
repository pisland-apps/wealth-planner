# v20 — Fix installed-shortcut ERR_FAILED on Cloudflare Pages

## Root cause
Cloudflare Pages 301/308-redirects `/index.html` → `/` by default. `manifest.json` had
`start_url: "./index.html"`, so the installed desktop/mobile shortcut always relaunched
at the literal `/index.html` URL. During the service worker's install step,
`cache.addAll([..., './index.html', ...])` fetched that URL, silently followed the
redirect, and cached the result under the `./index.html` key — but that cached
`Response` has `redirected: true` baked in. Chrome refuses to let a service worker
answer a *navigation* request with a redirected `Response`, and fails the whole load
with exactly `net::ERR_FAILED` — matching the screenshot (URL shown is `/index.html`,
generic failure).

The very first-ever load (before the service worker existed) followed the redirect
normally at the network level and landed on `/`, so in-tab reloads kept working — but
the installed shortcut always relaunches fresh at `/index.html`, hitting the poisoned
cache entry every time.

## Fix
- **`manifest.json`** — `start_url` changed from `"./index.html"` to `"./"`, so the
  installed shortcut never targets the URL that gets redirected in the first place.
- **`service-worker.js`**:
  - `./index.html` removed from `APP_SHELL` — `./` is now the only HTML entry point
    ever precached.
  - Navigation requests (`request.mode === 'navigate'`) are now handled by their own
    branch that always resolves through the canonical `./` cache entry, regardless of
    the exact URL requested — so even a stray `/index.html` link, bookmark, or a
    different host's rewrite rules can't route to a redirect-poisoned cache entry.
  - The offline fallback that used to reference the now-removed `./index.html` cache
    key was dead code once navigations stopped reaching that branch — removed.
  - `CACHE_VERSION` bumped to `v20` so existing installs pick up the fix (old poisoned
    cache entries get deleted in the `activate` step, as before).
- **`_headers`** — added a `Cache-Control: no-cache` rule for `/` (in addition to the
  existing `/index.html` rule), since `/` is what Cloudflare Pages actually serves for
  every navigation; the `/index.html` rule never had a chance to apply there because
  the redirect happens before Cloudflare's header rules match on that path.
- **`js/app.js`** — `APP_VERSION` bumped to `v20` (display badge only).

## If you're already seeing this on an installed shortcut
This fix ships in the deployed files, but a shortcut that's already broken needs a
one-time manual recovery, since the broken shortcut can't reach the new service worker
on its own:
1. Open `https://wealth-planner.pages.dev/` directly in a normal browser tab (not the
   broken shortcut) — this bypasses the poisoned cache and loads fresh.
2. Let it fully load once (so the new service worker installs and the old cache gets
   cleared in `activate`).
3. Re-install/re-pin the app from that tab if you want a fresh shortcut, or just delete
   and recreate the existing one — either way it'll now point at `./` per the updated
   manifest.

## Other apps
The same `start_url: "./index.html"` + `./index.html`-precached-navigation-fallback
pattern likely exists in the other single-file PWAs (tax tracker, ledger, investment
tracker, budget reference, Family Health & Shield, border day ledger) if they were
built from the same template and are also hosted on Cloudflare Pages. Happy to apply
the same fix to any of those on request — just say which one(s).
