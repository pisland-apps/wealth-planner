# v14 — Security fixes

Based on a security review of v13. Files touched: `index.html`, `js/app.js`,
`service-worker.js`, `_headers` (comment only), plus `js/pdf-worker-init.js`
→ replaced by `js/pdf-loader.js`, and `lib/pdf.min.js` + `lib/pdf.worker.min.js`
→ replaced by `lib/pdf.min.mjs` + `lib/pdf.worker.min.mjs`.

## 1. pdf.js upgraded 3.11.174 → 4.9.155 (fixes CVE-2024-4367, CVSS 8.8)

The vendored pdf.js build predated the fix for a font-handling bug that lets a
maliciously crafted PDF execute arbitrary JS in pdf.js's context. Since the
attachment viewer (`openAttachmentViewer` in `js/app.js`) renders any PDF a
user attaches or imports, an attacker-supplied PDF (e.g. slipped into a
"backup" someone is asked to import, or an attachment shared with the user)
could have reached this.

pdfjs-dist dropped its UMD/global build entirely as of v4.0 — recent versions
ship ES modules only (`pdf.min.mjs` / `pdf.worker.min.mjs`, no more
`pdf.min.js`). Rather than converting the whole app to ES modules (which would
silently stop attaching `app.js`'s top-level functions to `window`, breaking
the `data-action` dispatcher), `js/pdf-loader.js` is a small classic script
that dynamically `import()`s the new build and exposes `window.pdfjsLibReady`,
which `openAttachmentViewer` now awaits before first use.

## 2. Missing `escapeHtml()` on several rendered fields

Most of the codebase consistently escapes dynamic values before dropping them
into `innerHTML`/`document.write`, but a handful of fields were missed:
`tx.units`, `fund.currency`, `account.currency`, `fd.currency`, `tx.currency`
(FX module), `p.type`/`p.status`/`p.currency` (real estate), and
`r.newFixedDepositId`. These are normally constrained by dropdowns/number
inputs in the UI, but the Import feature accepts arbitrary JSON, so a crafted
backup file could have set them to strings containing markup. The page's CSP
(no `unsafe-inline` for scripts) already blocked classic script-execution
payloads here, but this closes the gap so it doesn't rely on CSP alone as the
only defense. All occurrences now go through `escapeHtml()`.

## 3. PBKDF2 iterations 250,000 → 600,000 for anything newly derived

Brings the app's own key derivation (used both for at-rest encryption and for
encrypted export files) in line with current OWASP guidance for
PBKDF2-SHA256. Handled with full backward compatibility:

- The iteration count actually used is now stored alongside the salt
  (`utt-encryption-iterations` in localStorage; `iterations` field in
  encrypted export files) and re-used verbatim whenever a key is re-derived
  (unlock, disable encryption, import).
- Existing installs / existing encrypted backups with no recorded iteration
  count are treated as the old 250,000-iteration default
  (`PBKDF2_ITERATIONS_LEGACY`), so nothing that was already encrypted breaks.
- Only *new* "Enable Encryption" setups and *new* encrypted exports use the
  higher 600,000-iteration default going forward.

## 4. Encryption-off nudge banner

Encryption is opt-in and was easy to miss, tucked into a nav-bar modal — new
installs store everything in plaintext IndexedDB until a user finds and turns
it on. Added a dismissible banner (`#encryptionNudgeBanner`) that shows
whenever encryption is off, with an "Enable Now" button that opens the
existing encryption modal directly, and a "Not now" button that snoozes it
for 30 days (`utt-encryption-nudge-snoozed-until`). Nothing changes for users
who already have encryption on — the banner just never shows.

## 5. `window[el.dataset.fn]` dynamic lookup replaced with a whitelist

The "Print Summary" owner-picker modal used to store a function *name* in a
`data-fn` attribute and call `window[el.dataset.fn](...)` to invoke it. The
value was always one of 5 hardcoded strings from the app's own static markup
— never user data — so this wasn't reachable as a real bug today, but the
pattern itself ("look up an arbitrary global function by name from a DOM
attribute") is fragile: it would become a real arbitrary-function-call
primitive the moment any code path let that attribute's value be influenced
by user/imported data. Replaced with `PRINT_REPORT_FUNCTIONS`, a fixed
whitelist object mapping report-type keys to actual function references,
matching the pattern already used by the main `ACTIONS` dispatcher table.
Buttons now carry `data-report-type` instead of `data-fn`.

---

Not changed in this pass (by request, left for a later decision):
- Exchange-rate lookups still call the third-party `open.er-api.com` API
  directly with the user's base-currency code (no amounts/holdings sent).
- Deployment-header gaps specific to GitHub Pages (frame-ancestors /
  X-Frame-Options can't be delivered via `<meta>` or GH Pages hosting) — not
  applicable if you're deploying via Cloudflare Pages, since `_headers`
  already covers this there.
