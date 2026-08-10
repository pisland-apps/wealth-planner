# Security changes made to this app

## 1. Content-Security-Policy (done)

Added a `<meta http-equiv="Content-Security-Policy">` tag in `index.html`.
Key points (full rationale is in comments right above the tag):

- `script-src` is `'self'` only now — no CDN origin is allowlisted at all.
  All three third-party libraries (chart.js, Dexie, pdf.js + its worker) are
  vendored locally under `./lib/`, matching how the Tax Tracker app vendors
  pdf.js. `cdn.jsdelivr.net` (chart.js, Dexie) and `cdnjs.cloudflare.com`
  (pdf.js) used to be allowlisted here; both have been dropped now that
  every script the app loads is same-origin. This is enforceable without
  `'unsafe-inline'` because both inline `<script>` blocks that used to live
  in `index.html` were moved to real files: `js/pdf-worker-init.js` and
  `js/app.js`.
- `script-src-attr` — **no longer present in the CSP at all**, which means it
  falls back to `script-src 'self'`: inline attribute handlers are blocked
  the same as inline `<script>` blocks. This used to require
  `'unsafe-inline'` because the app rendered ~330 `onclick=`/`onchange=`/
  `oninput=`/`onkeydown=` attributes directly in its template strings. See
  section 6 for how this was closed.
- `worker-src` is `'self'` only — pdf.js now loads its worker script from
  `./lib/pdf.worker.min.js` (same origin), so no external worker-src origin
  is needed.
- `connect-src` includes `open.er-api.com` (the exchange-rate API this app
  calls) in addition to `'self'`.
- `img-src` includes `data:` and `blob:` because attachments are rendered
  from data URLs and downloads/PDF previews use `URL.createObjectURL`.
- `frame-ancestors`, `report-uri`, and `sandbox` are **not** included: the
  CSP spec ignores these when delivered via `<meta>`. If this app is ever
  served by a real HTTP server, set a `Content-Security-Policy` response
  header instead (and add `frame-ancestors 'none'` there).

## 2. SRI (integrity + crossorigin) — no longer applicable

Earlier versions of this app loaded chart.js and Dexie from `cdn.jsdelivr.net`
(and, before that, pdf.js from `cdnjs.cloudflare.com`), so `index.html` had
`integrity="sha384-..."` / `crossorigin="anonymous"` attributes on those
`<script>` tags to guard against a compromised or malicious CDN response.

All three libraries are now vendored locally under `./lib/`:

- `./lib/pdf.min.js` + `./lib/pdf.worker.min.js` — pdf.js 3.11.174
- `./lib/dexie.min.js` — Dexie 3.2.4, the package's own published minified
  build, copied as-is
- `./lib/chart.umd.min.js` — chart.js 4.4.1. The npm package for this
  version doesn't publish a minified UMD build (only an unminified
  `dist/chart.umd.js`), so this was minified from that exact same-version
  source using `terser` — the same content jsdelivr's `.min.js` URL would
  have served, just built locally instead of fetched from a CDN.

SRI exists to protect against a third-party host serving different bytes
than expected. That risk doesn't apply to same-origin files you host and
control yourself, so there's nothing left to pin a hash against, and the
`<script>` tags no longer carry `integrity=`/`crossorigin=` attributes at
all. If you ever update one of these libraries by re-fetching from its
source (npm, a CDN, GitHub releases), verify the new file's checksum
against the publisher's published hash before swapping it into `./lib/` —
that's the same trust step SRI used to automate, just done once at update
time instead of on every page load.

## 3. innerHTML / escaping audit — done

You said the code already has an `escapeHtml` helper that just needed
confirming was used everywhere. **It didn't exist anywhere in the original
file** — I searched for `escapeHtml`, common casing variants, and any
`sanitize`/`strip`/`clean`/`safe`/`encode` helper, and found nothing.

`escapeHtml()` is now defined near the top of `js/app.js`, and every
call site I could find that builds HTML from stored/user-controllable
data is now wrapped with it — 149 `escapeHtml(...)` calls across the
file, covering:

- Member, fund, property, account, plan, and forecast-plan names
- Fund codes and categories, real-estate transaction categories
- Transaction/loan/FD notes, "particular" free-text fields
- Fixed-deposit bank names and status
- Attachment filenames (`att.name` — these come from uploaded files, so
  a maliciously-named file is a real vector, not just form input)
- Date fields (`tx.date`, `fd.maturityDate`, etc.) — lower risk since
  these normally come from `<input type="date">`, but a crafted/imported
  backup file could still smuggle arbitrary strings into them, so they're
  escaped too
- The **print/export windows** (`printWindow.document.write(...)` in the
  PDF/print views for funds, FDs, KWSP accounts, real estate, FX ledger,
  and net-worth summary) — this was a second, entirely separate rendering
  path using the same string-concatenation-into-HTML pattern as
  `innerHTML`, and just as exploitable. Easy to miss since it doesn't say
  `innerHTML` anywhere; found it by grepping for the same field names.

Two things were fixed beyond straight escaping, because they were a
different (worse) shape of bug:

- **Member delete button**: the original code built an inline `onclick`
  handler by hand-escaping only single quotes in the member's name
  (`m.name.replace(/'/g, "\\'")`). A name containing a double quote would
  still break out of the `onclick="..."` attribute entirely — a full
  attribute-injection, not just a display-escaping gap. Replaced with
  `JSON.stringify(m.name)` (correct JS-string escaping) wrapped in
  `escapeHtml(...)` (correct HTML-attribute escaping) — the standard way
  to safely embed a JS string literal inside an HTML attribute.
- Several `value="${...}"` attributes (member name field, real-estate
  purchase-breakdown row inputs) were unescaped, which is an
  attribute-breakout risk distinct from plain text injection — fixed the
  same way.

**What was deliberately left alone, and why:**

- `confirm(...)` / `alert(...)` / `showToast(...)` calls that embed a name
  (e.g. "Delete plan \"${plan.name}\"...") — these render as plain text in
  native browser dialogs or via `.textContent`, not parsed as HTML, so
  escaping them would incorrectly show literal `&quot;` etc. to the user.
- Chart.js `data`/`labels` arrays and other values assigned via
  `.textContent` — same reason, not an HTML-parsing context.
- Numeric fields run through `formatCurrency`/`toFixed`/`parseFloat` —
  these can't carry arbitrary strings regardless of source, so escaping
  would be a no-op.
- IDs (`fund.id`, `m.id`, etc.) — these are Dexie auto-increment primary
  keys, not free text, and are already used in far more places than I
  could practically re-verify individually.

**Verification**: after all edits, `node --check js/app.js` passes (valid
syntax), and a final grep sweep for the same field-name patterns across
the whole file returns no remaining unescaped matches other than the
intentional `confirm()` case above. I was not able to click through the
actual UI in a browser in this environment, so this is static
verification only — worth clicking through each affected screen once
after you pull this in, to confirm text still renders normally.

## 6. Removing inline event handler attributes (done)

`script-src-attr` no longer needs `'unsafe-inline'` (see section 1). Every
`onclick=`/`onchange=`/`oninput=`/`onkeydown=` attribute that used to be
written directly into `index.html` and into the template strings in
`js/app.js` (~330 occurrences total) has been replaced with:

- a `data-action="functionName"` attribute (plus, where the original call
  took arguments, `data-arg` / `data-arg2`; and where it started with
  `event.stopPropagation()` / `event.preventDefault()`, `data-stop="1"` /
  `data-prevent="1"`), and
- a single delegated dispatcher at the bottom of `js/app.js` — a
  `const ACTIONS = { ... }` lookup table mapping each action name to a real
  function reference, plus one `document.addEventListener('click'/'change'/
  'input', dispatchAction)` per event type. `dispatchAction` reads
  `el.dataset.action`/`.arg`/`.arg2` as **plain text** and looks the name up
  in `ACTIONS` — it never passes that text to `eval()` or `new Function()`.

This is what actually closes the gap described in the old section 1 note:
previously, an unescaped member/fund/property name containing
`<img src=x onerror="...">` reaching `innerHTML` would have executed,
because `script-src-attr 'unsafe-inline'` permitted it. Now there is no
inline-attribute execution path in the document at all — even in that
scenario, the browser has nothing to run, and a stray `data-*` attribute
value is just inert text.

Two things were deliberately left outside this refactor:

- `onclick="window.print()"` inside `finishPrintWindow()` in `js/app.js`.
  This button lives in a **separate popup document** created via
  `window.open()` + `document.write()` (used for printed reports), which
  never receives this app's CSP meta tag and isn't part of the audit above —
  it also contains no user-controllable logic (just prints the window).
- The two `onkeydown="if(event.key==='Enter') ..."` handlers (unlock
  passcode, import passcode) became `data-enter-action="..."` attributes
  read by a small dedicated `keydown` listener, rather than being folded
  into the generic `dispatchAction`, since they trigger on a specific key
  rather than on click/change/input.

Because this touched ~330 call sites across two files, it was done with a
scripted, pattern-based conversion (grouping call sites by function name and
argument shape) rather than by hand, with the output re-verified afterward:
`node --check` on `js/app.js`, a full re-scan confirming zero remaining
`on(click|change|input|keydown)=` attributes outside the two exceptions
above, and a cross-check that every `data-action` value used in the markup
has a matching entry in the `ACTIONS` table (and vice versa). None of that
replaces actually clicking through the app — please test each screen (add/
edit/delete flows, filters, the member list, forecast rows, FD attachments,
the print/report buttons, and the passcode lock screen) before relying on
this build.

## Files changed / added

- `index.html` — CSP meta tag now `script-src 'self'` with no CDN origin at
  all; SRI attributes removed (nothing left to pin); inline scripts
  extracted; all three `<script>` tags point at `./lib/`
- `js/pdf-worker-init.js` — new (was inline); worker path now `./lib/`
- `js/app.js` — new (was inline); now also contains `escapeHtml()` and
  ~149 call sites wrapped with it, plus (this version) the `ACTIONS`
  dispatch table and `dispatchAction`/delegated-listener code replacing all
  inline event handler attributes (see section 6)
- `index.html` — (this version, in addition to the above) every
  `onclick=`/`onchange=`/`oninput=`/`onkeydown=` attribute replaced with
  `data-action`/`data-arg`/`data-enter-action` attributes; `script-src-attr`
  removed from the CSP meta tag
- `lib/chart.umd.min.js`, `lib/dexie.min.js`, `lib/pdf.min.js`,
  `lib/pdf.worker.min.js` — new; vendored local copies of all third-party
  libraries, replacing the jsdelivr/cdnjs CDN loads
- `service-worker.js` — cache version bumped again (now v9, this version's
  index.html/app.js changes); previously rewritten so the
  entire app, including the vendored libraries, is one same-origin app
  shell — the separate "best-effort CDN" caching tier was removed since
  there's no CDN left to cache from
