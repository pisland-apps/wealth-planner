# v11 — Fixes

## 1. Multi-Year Planner → Baseline vs Actual → "Actual (EOY)" — only first row accepted input

**Cause:** Typing a value and then clicking/tabbing into the next year's box
triggered a save on blur, which rebuilt the *entire* table (every row's
`<input>`) from scratch. That destroyed the box you'd just clicked into
before you could type into it, so only the first row you touched ever
seemed to work.

**Fix:** Saving a value now only updates that row's "Variance $" / "Variance %"
cells in place — the input boxes themselves are never rebuilt, so focus is
never lost and every row now accepts input normally.

## 2. Matured FD notice not showing on the main Portfolio Dashboard

**Cause:** The notice was rendered as the *last* step of `renderDashboard()`,
after the allocation/performance charts and holdings list. If any of those
threw an error for a given data set, execution stopped right there and the
notice call was silently skipped — even though the rest of the dashboard
looked fine.

**Fix:** The matured-FD notice is now rendered first, independently, and
each dashboard sub-section is wrapped so one failing part can't block the
others (errors are logged to the console instead of aborting the whole
render).

Only `js/app.js` changed — everything else is identical to v10.
