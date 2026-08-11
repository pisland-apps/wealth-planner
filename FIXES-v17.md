# v17 — Security fix (follow-up to v16 review)

The v16 review focused on `document.write`-based print reports. A broader
pass afterward found a separate, smaller gap: two label-building helpers
used for `<select>` dropdown options were never covered by the v14/v15/v16
escaping passes because they don't go through `document.write` or the
normal card/table render paths at all.

## `amanahSchemeOptionLabel()` / `kwspAccountOptionLabel()` now escape their output

These build the text shown in the Amanah Saham scheme filter/select and
KWSP account filter/select dropdowns, concatenating `fund.name` /
`fund.code` / `account.name` and household member names — all free text
entered directly in the app's own "Add Fund" / "Add Account" / "Add
Member" forms — with no escaping, then injected via `.innerHTML` at four
call sites (two `renderXFilterOptions` functions, two `select.innerHTML`
assignments).

This is the same class of gap as the v16 print-report issue, just a
different sink, and it was inconsistent with the rest of the app: the main
fund/account list and card views (`renderFunds`, etc.) already escape
these exact same fields correctly.

**Actual severity was low.** Because the injection lands inside a
`<select>`'s `innerHTML`, the browser's "in select" HTML parsing mode only
instantiates `<option>`/`<optgroup>` elements there — other tags are
dropped rather than rendered, so this wasn't a practical path to script
execution even before CSP is considered. Realistic impact was a garbled
dropdown or a forged extra option entry, not code execution. Fixed anyway
for consistency and defense-in-depth, since HTML-parsing "ignore this tag"
behavior in select context isn't identical across every browser engine.

Both functions now wrap `fund.name` / `fund.code` / `account.name` /
owner names in `escapeHtml()` before returning the label string. No
double-escaping risk: both functions are only ever used directly as
`<option>` label content, never re-escaped by a caller.

## Not changed

Same "not changed" list as v14/v15/v16: exchange-rate lookups still call
`open.er-api.com` directly, and GitHub-Pages-specific header gaps are
unchanged.

Only `js/app.js` and `service-worker.js` (cache-version bump) changed
from v16.
