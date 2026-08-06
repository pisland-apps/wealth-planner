# Security changes made to this app

## 1. Content-Security-Policy (done)

Added a `<meta http-equiv="Content-Security-Policy">` tag in `index.html`.
Key points (full rationale is in comments right above the tag):

- `script-src` allows only `'self'`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` —
  no `'unsafe-inline'`. This is enforceable now because both inline `<script>`
  blocks that used to live in `index.html` were moved to real files:
  `js/pdf-worker-init.js` and `js/app.js`.
- `script-src-attr 'unsafe-inline'` — **required**, and this is a real,
  intentional limitation, not an oversight. This app renders hundreds of
  `onclick=`/`onchange=`/`oninput=` attributes as part of its normal template
  strings (~550 occurrences). CSP treats attribute-based handlers separately
  from `<script>` elements (`script-src-attr` vs `script-src-elem`), so this
  keeps the weaker rule scoped to attributes only — it does **not** re-open
  the door for `<script src="evil.com">` or arbitrary inline `<script>`
  blocks, which are still blocked.
  - The consequence: if unescaped user data ever reaches `innerHTML` with a
    payload like `<img src=x onerror="...">`, `script-src-attr` being
    `'unsafe-inline'` means the browser will still execute it. CSP alone
    cannot close this — see section 2.
  - Fully closing it means migrating all inline handler attributes to
    `addEventListener` (event delegation), which is a much larger refactor
    than what was asked for here and was not done in this patch.
- `worker-src` includes `cdnjs.cloudflare.com` because pdf.js loads its
  worker script from there.
- `connect-src` includes `open.er-api.com` (the exchange-rate API this app
  calls) in addition to `'self'`.
- `img-src` includes `data:` and `blob:` because attachments are rendered
  from data URLs and downloads/PDF previews use `URL.createObjectURL`.
- `frame-ancestors`, `report-uri`, and `sandbox` are **not** included: the
  CSP spec ignores these when delivered via `<meta>`. If this app is ever
  served by a real HTTP server, set a `Content-Security-Policy` response
  header instead (and add `frame-ancestors 'none'` there).

## 2. SRI (integrity + crossorigin) — placeholders only, needs your action

`index.html` now has `integrity="sha384-REPLACE_WITH_REAL_HASH_..."` and
`crossorigin="anonymous"` on the three CDN `<script>` tags. **The hash values
are placeholders and will not work as-is** — I could not compute the real
hashes from this sandbox: it has no outbound network access for hashing, and
fetching the files back through my tools only returns them as opaque binary,
not bytes I can pipe into a hash function. Pasting a hash I hadn't actually
verified would be worse than leaving it blank, since a wrong hash just fails
closed (browser refuses to load the script) — better to generate it properly.

Generate the real hashes yourself with:

```bash
for url in \
  "https://cdn.jsdelivr.net/npm/[email protected]/dist/chart.umd.min.js" \
  "https://cdn.jsdelivr.net/npm/[email protected]/dist/dexie.min.js" \
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; do
  echo "$url"
  curl -s "$url" | openssl dgst -sha384 -binary | openssl base64 -A
  echo
done
```

Each output line is the value to put after `sha384-` (keep the `sha384-`
prefix in the attribute). Alternatively use https://www.srihash.org/ with
each URL. Do this right before you deploy, from a link you trust, and pin
the exact version in the URL (already done here) — SRI only works for
versioned, unchanging files.

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

## Files changed / added

- `index.html` — CSP meta tag, SRI attributes, inline scripts extracted
- `js/pdf-worker-init.js` — new (was inline)
- `js/app.js` — new (was inline); now also contains `escapeHtml()` and
  ~132 call sites wrapped with it
- `service-worker.js` — cache version bumped, new JS files added to the
  app-shell cache list
