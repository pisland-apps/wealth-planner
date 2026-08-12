# v18 — pdf.js dependency update (4.9.155 → 6.2.108)

Routine maintenance: the vendored pdf.js build (`lib/pdf.min.mjs` +
`lib/pdf.worker.min.mjs`, used by the in-app PDF attachment viewer) was
about a year and a half behind upstream. Updated to the current latest
release, pdfjs-dist **6.2.108**.

## Why

4.9.155 wasn't known-vulnerable — it's on the list of secure versions for
CVE-2024-4367 (the `isEvalSupported`/arbitrary-JS-execution bug this app
was already patched against) — but it predates roughly 18 months of
upstream bug fixes and hardening, with no way to rule out later advisories
without pinning to current. Since this app renders user-uploaded PDFs
(financial statements, receipts) through pdf.js, staying current on the
parser is worth doing opportunistically rather than waiting for a CVE.

## What changed

- `lib/pdf.min.mjs` and `lib/pdf.worker.min.mjs` replaced with the
  official pdfjs-dist 6.2.108 build (fetched via `npm install
  pdfjs-dist@6.2.108`, same-origin vendored copy as before — no CDN).
- `js/pdf-loader.js` comments updated to reference 6.2.108 instead of
  4.9.155.
- `service-worker.js` `CACHE_VERSION` bumped to `v18` and `js/app.js`
  `APP_VERSION`/`APP_VERSION_DATE` bumped to match, per this app's usual
  deploy checklist — required because the two `lib/` files are
  service-worker-cached assets.

## API compatibility check

The app's entire pdf.js surface is small and stable across this version
range: `pdfjsLib.getDocument({data}).promise`, `GlobalWorkerOptions.
workerSrc`, `page.getViewport({scale})`, and `page.render({canvasContext,
viewport}).promise` (all in `js/app.js`'s attachment viewer and
`js/pdf-loader.js`). Verified all four still exist with the same call
shape in the 6.2.108 build before swapping the files in. No changes were
needed to `js/app.js`.

Both new `.mjs` files pass `node --check`. Same file names as before, so
`js/pdf-loader.js`'s dynamic `import('../lib/pdf.min.mjs')` and
`workerSrc` path needed no changes.

## Not changed

Same "not changed" list as prior versions: exchange-rate lookups still
call `open.er-api.com` directly, and GitHub-Pages-specific header gaps
are unchanged.

Files changed from v17: `lib/pdf.min.mjs`, `lib/pdf.worker.min.mjs`,
`js/pdf-loader.js` (comments only), `js/app.js` (version bump only),
`service-worker.js` (cache-version bump only).
