# v19 — Lock-screen numpad

## What changed
Added a big on-screen numpad to the passcode unlock screen, for easier entry on
mobile/tablet than the OS keyboard.

- `#unlockPasscode` is now `readonly` + `inputmode="none"`, so tapping or focusing it
  never triggers the mobile virtual keyboard.
- A 12-button numpad (1–9, C, 0, ⌫) sits below the field. Each button carries
  `data-action="unlockNumpadKey"` / `data-arg`, routed through the existing dispatcher
  to `handleUnlockNumpadKey()` in js/app.js, which appends/removes characters directly
  on the (readonly) input's `.value`.
- Physical-keyboard typing still works: a `keydown` listener, scoped to only fire while
  `#unlockOverlay` has the `.active` class, captures printable keys and Backspace and
  applies them the same way. Passcodes aren't digit-only (the "Set a Passcode" field
  accepts any 6+ characters), so this listener accepts any printable character — the
  numpad is a faster input method for numeric passcodes, not a new restriction on what
  a passcode can contain.
- Enter-to-unlock is untouched (already handled by the existing `data-enter-action`
  keydown listener, which fires on `readonly` inputs the same as on any other).

## Files touched
- `index.html` — numpad markup + CSS (`.numpad` / `.numpad-key`), `unlockPasscode`
  input attributes
- `js/app.js` — `handleUnlockNumpadKey()`, physical-keyboard passthrough listener,
  `unlockNumpadKey` entry in `ACTIONS`, `APP_VERSION` bumped to v19
- `service-worker.js` — `CACHE_VERSION` bumped to v19

## Not changed
- The backup-import passcode field (`#importBackupPasscode`) — left as a normal
  keyboard-driven field since the request was specifically about the login/unlock
  screen. Happy to apply the same treatment there if useful.
