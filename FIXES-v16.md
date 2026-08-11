# v16 — Security fixes (follow-up to v15 review)

The v14/v15 passes fixed escaping in the app's normal render functions, but
missed a separate code path: the "Print Report" popups, which build a new
window via `window.open('', '_blank')` and populate it with `document.write()`.

Unlike the spots v15 fixed (only reachable by importing a crafted backup
file), these were reachable directly through the app's own forms — no
import needed. Typing a value like `Foo</title><style>...` into an ordinary
"Add Fixed Deposit" bank name field, a fund/account/property name, or a
household member name, then opening that record's print report, would
inject markup into the popup's `<head>`/`<h1>`.

Actual severity was HTML/CSS injection only, not script execution — the
popup inherits the opener's CSP (`script-src 'self'`, no
`script-src-attr` override), so `<script>` tags and `onerror=` attributes
are already blocked. But it could still be used for a phishing overlay or a
`<meta http-equiv="refresh">` redirect, which CSP doesn't cover.

## 1. `openReportWindow(title, ...)` now escapes `title`

This is the single choke point every "Print Report" call goes through, so
fixing it here covers all 13 call sites at once — including the ones that
were passing raw `fund.name` / `fd.bankName` / `account.name` / `p.name` /
a currency `code` straight into the popup's `<title>` with no escaping at
all.

## 2. Six `reportTitle` variables were also written raw into `<h1>`

The multi-record report functions (Amanah, KWSP, FD, Unit Trust, FX,
Wealth) build a `reportTitle` that includes the household member's name
(`ownerName`) and write it twice: once as the window title (now covered by
fix #1) and again as the page's `<h1>` via a separate, un-escaped
`document.write('<h1>' + reportTitle + '</h1>')`. All six now go through
`escapeHtml(reportTitle)`.

## 3. `fd.placementDate` / `fd.maturityDate` unescaped in the single-FD print view

The list-view FD print report already escaped these two date fields; the
single-FD print view (`printFdSingleReport`) didn't. Now consistent with
the list view.

## Not changed

`fd.status` in the same single-FD print view is left as-is: unlike
`bankName`/dates, `status` is a fixed dropdown in the UI and is clamped to
a known enum on import (`IMPORT_FIELD_RULES`), so it can't carry markup.

Same "not changed" list as v14/v15: exchange-rate lookups still call
`open.er-api.com` directly, and GitHub-Pages-specific header gaps are
unchanged.

Only `js/app.js` and `service-worker.js` (cache-version bump) changed from
v15.
