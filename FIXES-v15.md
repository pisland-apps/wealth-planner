# v15 — Security fixes (follow-up to v14 review)

v14's XSS pass ("closes the gap so it doesn't rely on CSP alone") missed
several call sites that ultimately trace back to the same root cause: fields
that *look* like fixed enums (currency codes, transaction types, categories)
but are actually free-form strings once a backup file has been imported,
because `applyImportedData()` performs no schema validation and writes
imported records straight into IndexedDB.

All of the following are reachable by importing a crafted (unencrypted or
encrypted, doesn't matter) backup JSON file with a malicious string in one of
these fields, then visiting the view that renders it. Given the site's CSP
(`script-src 'self'`, `script-src-attr 'none'`, no CDN), classic
`<script>`/`onerror=` payloads are very likely blocked in a compliant
browser — but this still allows HTML/CSS injection (phishing overlays, fake
"session expired, re-enter your passcode" prompts, meta-refresh redirects),
and is a real gap if the app is ever deployed somewhere the `_headers` CSP
isn't actually applied.

## Root-cause helper functions fixed (fixes every call site at once)

- `currencySymbol(code)` — unknown/unrecognised currency codes were returned
  raw; now passed through `escapeHtml()`. This is the one with by far the
  widest blast radius, since `formatCurrency()` (used in ~80 places) calls it
  internally and none of those call sites were escaping its output
  themselves — they assumed it always produced a safe, symbol-prefixed
  number string.
- `amanahTxTypeLabel(type)` — non-"Dividend" transaction types were returned
  raw; now escaped.
- `mypSourceLabel(source)` — unrecognised source values were returned raw;
  now escaped.

## Individual call sites fixed (couldn't be fixed at a shared helper)

- Closed Unit Trust funds grid and Amanah Saham funds grid: `fund.code` /
  `fund.category` / `d.fund.category` were interpolated directly instead of
  through `escapeHtml()`.
- KWSP transaction table: `account.name` was interpolated raw.
- Currency Settings modal (`openCurrencyModal` / `renderExchangeRatesInputs`):
  currency codes derived from `getDistinctFundCurrencies()` (i.e. from
  whatever funds/accounts/deposits exist, import-controlled) were used raw
  both as visible text and inside `<option value="...">` / `id="rate-..."`
  attributes. Fixed with `escapeHtml()` for display and `encodeURIComponent()`
  for the DOM id (and the two places that read that id back).
- FX module (holdings cards, holdings table, detail header): `code` (an FX
  currency code, also import-controlled) was interpolated raw in six places
  across card/table HTML and one `data-arg2` attribute.
- Multi-Year Planner "rented properties" dropdown: `p.currency` and
  `p.monthlyRent` were interpolated raw inside `data-currency="..."` /
  `data-rent="..."` attributes — an attacker-controlled currency string
  containing a `"` could have broken out of the attribute.

## Import-time validation (the root-cause fix)

Escaping every render call site (above) closes the holes found so far, but
is inherently a whack-a-mole fix — it only protects against the specific
spots someone thought to check. Added a proper second layer:
`applyImportedData()` now runs every collection through
`importSanitizeCollection()` before it's written to IndexedDB.

For each collection, a small rule table (`IMPORT_FIELD_RULES`) lists the
fields that are *only ever populated from a fixed `<select>` dropdown* in
every part of the UI that writes them — currency codes, transaction/record
types, property type & occupancy status, FD status, loan-transaction action.
Each such field is checked against the same set of values the UI's own
dropdown offers (or, for currency, against the full `CURRENCY_SYMBOLS`
list the app knows how to render — a deliberately wider net than any single
dropdown, so cross-version backups with older/newer currency support still
import cleanly). Anything outside that set — which can only mean the file
was hand-crafted or tampered with, since the app itself never writes
anything else there — is replaced with a safe fallback value instead of
being written as-is.

This is intentionally narrow: free-text fields (`name`, `notes`,
`particular`, etc.) are left untouched, since they're meant to hold
arbitrary text and are already `escapeHtml()`'d at every render site —
"validating" free text would just be reinventing escaping, badly, in a
second place. The point of this layer is specifically the fields the
renderer is allowed to *trust* are one of a handful of known values; now
that trust is actually enforced at the door, so a future render call site
that forgets to escape a `currency`/`type`/`status` field is a much smaller
problem than it would otherwise be — the value reaching it can no longer
contain HTML in the first place.

## Not changed

Same as v14's "not changed" list — exchange-rate lookups still call
`open.er-api.com` directly, and GitHub-Pages-specific header gaps are
unchanged.
