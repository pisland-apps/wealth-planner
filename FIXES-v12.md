# v12 — Fixes

## 1. "My Wealth" was missing the matured-FD notice (v11 only fixed the wrong dashboard)

v11's fix only added the notice to the Unit Trust module's "Portfolio Dashboard"
sub-tab (`#dashboard`). That's a different section from the top-level
"💎 My Wealth" tab (`#wealth`), which is the one meant here as the main
dashboard. The notice now also renders inside "My Wealth", using the same
underlying check, respecting that page's own owner filter (All / a specific
member / Joint).

## 2. Browser "save password?" prompt appearing while typing in Actual (EOY)

The app has several `<input type="password">` fields (encryption passcode,
unlock screen, backup export/import) with no `autocomplete` attribute set.
Some browsers (Chrome/Edge in particular) can misfire their built-in
"Save password?" prompt when *any* input on the page changes, if a password
field is present anywhere in the DOM without an explicit autocomplete hint —
even with no `<form>` tag. Added `autocomplete="new-password"` to every
passcode field, and `autocomplete="off"` to the Actual (EOY) number input,
so the browser stops treating this page as a login form.

If this specific prompt persists after this update, it would help to see
what the dialog actually says/looks like — a screenshot would confirm
whether it's the browser's own password manager (fixed by this change) or
something inside the app itself.

Only `index.html`, `js/app.js`, and `service-worker.js` changed from v11.
