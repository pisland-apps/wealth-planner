// --- App version (display label only) --------------------------------------
// This is purely a "what code shipped in this build" label shown in the
// version badge (#versionBadge, see index.html). It is NOT the same thing as
// CACHE_VERSION in service-worker.js, which controls actual cache busting —
// the two live in different files and do not sync automatically.
// If you bump one, bump the other too. See the matching reminder comment
// near CACHE_VERSION in service-worker.js, and the deploy checklist in
// README.md, which covers updating both together.
const APP_VERSION = 'v13';
const APP_VERSION_DATE = '2026-08-11';

(function renderVersionBadge() {
  const badge = document.getElementById('versionBadge');
  if (badge) {
    badge.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;
  }
})();

// --- HTML-escaping helper -------------------------------------------------
// This function did not exist anywhere in the original codebase. ~150 places
// assign to .innerHTML using template strings that interpolate user-entered
// data (member names, fund names, transaction notes, etc.) with no escaping
// at all — a stored-XSS hole, e.g. a member name of `<img src=x onerror=...>`
// would execute wherever that member's name is rendered. Every call site
// that builds HTML from user data has been updated to use this helper
// (149 call sites as of this patch).
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

// Database setup
const db = new Dexie('UnitTrustDB');
db.version(2).stores({
  funds: '++id, name, code, category, currency, nav, createdAt',
  transactions: '++id, fundId, type, date, units, price, amount, notes, createdAt',
  navHistory: '++id, fundId, date, nav, createdAt'
});
db.version(3).stores({
  funds: '++id, name, code, category, currency, nav, createdAt',
  transactions: '++id, fundId, type, date, units, price, amount, notes, createdAt',
  navHistory: '++id, fundId, date, nav, createdAt',
  members: '++id, name, createdAt',
  amanahFunds: '++id, name, code, currency, price, createdAt',
  amanahTransactions: '++id, amanahFundId, type, date, units, price, amount, notes, createdAt'
}).upgrade(async tx => {
  // Existing installs used a fixed Husband/Wife/Joint text field — migrate to member-based ownership
  const membersTable = tx.table('members');
  const existing = await membersTable.toArray();
  async function ensureMember(name) {
    let m = existing.find(x => x.name === name);
    if (!m) { const id = await membersTable.add({ name, createdAt: new Date() }); m = { id, name }; existing.push(m); }
    return m;
  }
  const husband = await ensureMember('Husband');
  const wife = await ensureMember('Wife');
  await tx.table('funds').toCollection().modify(fund => {
    if (!fund.ownerIds) {
      if (fund.owner === 'Husband') fund.ownerIds = [husband.id];
      else if (fund.owner === 'Wife') fund.ownerIds = [wife.id];
      else if (fund.owner === 'Joint') fund.ownerIds = [husband.id, wife.id];
      else fund.ownerIds = [];
    }
  });
});
db.version(4).stores({
  kwspAccounts: '++id, name, currency, createdAt',
  kwspTransactions: '++id, kwspAccountId, type, date, amount, notes, createdAt'
});
db.version(5).stores({
  fixedDeposits: '++id, bankName, currency, status, createdAt',
  fdMaturityRecords: '++id, fixedDepositId, createdAt'
});
db.version(6).stores({
  fdInterestPayouts: '++id, fixedDepositId, date, createdAt'
});
db.version(7).stores({
  realEstateProperties: '++id, name, createdAt',
  realEstateTx: '++id, propertyId, date, createdAt',
  realEstateLoanTx: '++id, propertyId, date, createdAt'
});
db.version(8).stores({
  fxTransactions: '++id, type, currency, date, amount, rate, totalBase, notes, createdAt'
});
db.version(9).stores({
  // One row per calendar day a snapshot was captured (auto-captured once/day on app
  // load, or manually via "Save Snapshot Now"). Powers the My Wealth trend chart.
  wealthSnapshots: '++id, date, createdAt'
});
db.version(10).stores({
  // Saved "what-if" income projections. `lines` (fund/account picks + rate
  // assumptions) and `propertyLines` (rented properties + expected rent) are
  // stored as plain arrays on the record — nothing here reads back from or
  // writes to the real ledgers, so editing a forecast never touches actual data.
  incomeForecasts: '++id, name, createdAt'
});
db.version(11).stores({
  // Multi-Year Planner: a full staged cashflow simulator that sits alongside
  // the Quick Forecasts above. mypIncomeRanges links to incomeForecasts by
  // id (not a copy of the amount), so it always reflects that scenario's
  // current Total Yearly Income when the planner runs.
  mypFunds: '++id, name',
  mypFundRules: '++id, fundId',
  mypIncomeRanges: '++id, forecastId',
  mypExpenseCategories: '++id, name',
  mypExpenseRanges: '++id, categoryId',
  mypBaselines: '++id',
  mypBaselineValues: '++id, baselineId, year',
  mypActuals: '++id, year'
});
db.version(12).stores({
  // Income Timeline switched to fully manual entry (name + year-range +
  // amount), mirroring the Expense Budget model — no longer linked to
  // Income Forecast scenarios.
  mypIncomeCategories: '++id, name',
  mypIncomeRanges: '++id, categoryId'
});
db.version(13).stores({
  // Multi-Year Planner now supports multiple saved plans (e.g. one per
  // household member) via mypPlans, with planId added to every top-level
  // entity. On first load after this upgrade, any pre-existing unscoped
  // records are migrated into an auto-created "My Plan" so nothing is lost.
  mypPlans: '++id, name',
  mypFunds: '++id, name, planId',
  mypIncomeCategories: '++id, name, planId',
  mypExpenseCategories: '++id, name, planId',
  mypBaselines: '++id, planId',
  mypActuals: '++id, year, planId'
});
db.version(14).stores({
  // One saved forecast snapshot per plan (upserted every time "Generate
  // Forecast" runs) so switching plans never loses the last generated
  // result — it's shown as a clickable card instead of needing a re-run.
  mypSavedForecasts: '++id, planId'
});

// ==================== ENCRYPTION CORE ====================
// Fully wired in across every module (funds, KWSP, Amanah Saham, Fixed
// Deposit, Real Estate, Foreign Currency) via the enc*() wrappers below — every table's
// CRUD goes through them, so toggling "Encryption: On" in the nav bar
// actually encrypts everything, not just some modules.
//
// Design:
// - Passphrase is never stored anywhere. It's used once to derive an AES-GCM key
//   (via PBKDF2, 250,000 iterations) which lives only in the `encryptionKey`
//   in-memory variable for the current tab session. Refresh/close = key is gone.
// - Per table, a small set of structural fields stay plaintext (the auto-increment
//   `id`, and any foreign key used in a Dexie `.where().equals()` query, e.g.
//   `fundId`). Everything else — names, amounts, dates, notes, owner links — is
//   bundled into one JSON blob and encrypted as a single AES-GCM ciphertext per
//   record, stored under a single `_enc` field.
// - A random salt (not secret) and a "canary" ciphertext (a known constant,
//   encrypted) are stored in localStorage. The canary lets us verify a passphrase
//   is correct on unlock, instead of silently decrypting the whole DB into garbage.

let encryptionKey = null; // CryptoKey | null — in-memory only, never persisted
const ENC_CANARY_PLAINTEXT = 'utt-encryption-canary-v1';

// PBKDF2 iteration count. Bumped from 250,000 (in-line with current OWASP
// guidance for PBKDF2-SHA256) for anything newly derived — fresh "Enable
// Encryption" setups and fresh encrypted exports. Existing installs / existing
// encrypted backup files keep working: the iteration count actually used is
// always stored alongside the salt (localStorage's utt-encryption-iterations,
// or the export file's own `iterations` field) and re-used verbatim on
// unlock/import, so re-deriving the key always matches how it was originally
// derived. PBKDF2_ITERATIONS_LEGACY is only a fallback for salts/backups saved
// before this field existed.
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_ITERATIONS_LEGACY = 250000;

const PLAIN_FIELDS = {
  funds: ['id'],
  transactions: ['id', 'fundId'],
  navHistory: ['id', 'fundId'],
  members: ['id'],
  amanahFunds: ['id'],
  amanahTransactions: ['id', 'amanahFundId'],
  kwspAccounts: ['id'],
  kwspTransactions: ['id', 'kwspAccountId'],
  fixedDeposits: ['id'],
  fdMaturityRecords: ['id', 'fixedDepositId'],
  fdInterestPayouts: ['id', 'fixedDepositId'],
  realEstateProperties: ['id'],
  realEstateTx: ['id', 'propertyId'],
  realEstateLoanTx: ['id', 'propertyId'],
  fxTransactions: ['id'],
  wealthSnapshots: ['id', 'date'],
  incomeForecasts: ['id'],
  mypPlans: ['id'],
  mypFunds: ['id', 'planId'],
  mypFundRules: ['id', 'fundId'],
  mypIncomeCategories: ['id', 'planId'],
  mypIncomeRanges: ['id', 'categoryId'],
  mypExpenseCategories: ['id', 'planId'],
  mypExpenseRanges: ['id', 'categoryId'],
  mypBaselines: ['id', 'planId'],
  mypBaselineValues: ['id', 'baselineId', 'year'],
  mypActuals: ['id', 'year', 'planId'],
  mypSavedForecasts: ['id', 'planId']
};

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Derives an AES-GCM CryptoKey from a passphrase. Pass an existing base64 salt to
// re-derive the same key (unlock); omit it to generate a fresh salt (first-time setup).
// `iterations` must match whatever was used the first time this salt was derived —
// callers re-deriving an existing key (unlock, disable, import) MUST pass the
// iteration count that was stored alongside that salt, not just the current default.
async function deriveEncryptionKey(passphrase, saltB64, iterations) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const iters = iterations || PBKDF2_ITERATIONS; // fresh setup (no saltB64 passed) uses the current default
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { key, saltB64: bytesToBase64(salt), iterations: iters };
}

// Reads the iteration count that was actually used for the app's own encrypted-at-rest
// storage. Installs that enabled encryption before this field existed have no
// utt-encryption-iterations entry — those were derived at the old 250,000-iteration
// default, so fall back to that rather than the current (higher) default.
function getStoredEncryptionIterations() {
  try {
    const raw = localStorage.getItem('utt-encryption-iterations');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : PBKDF2_ITERATIONS_LEGACY;
  } catch (e) { return PBKDF2_ITERATIONS_LEGACY; }
}

// Encrypts an arbitrary JS value (object/array/string) into a transportable {iv, data} shape.
async function encryptValue(key, plainValue) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(plainValue));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipherBuf)) };
}

// Reverses encryptValue(). Throws if the key is wrong or data is corrupted (AES-GCM is authenticated).
async function decryptValue(key, encShape) {
  const iv = base64ToBytes(encShape.iv);
  const data = base64ToBytes(encShape.data);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// Splits a record into {plaintext structural fields} + {everything else, encrypted under _enc}.
async function encryptRecord(table, obj) {
  if (!encryptionKey) return obj; // encryption not active — passthrough, unchanged behavior
  const plainKeys = PLAIN_FIELDS[table] || ['id'];
  const plainPart = {};
  const secretPart = {};
  Object.keys(obj).forEach(k => {
    if (plainKeys.includes(k)) plainPart[k] = obj[k];
    else secretPart[k] = obj[k];
  });
  plainPart._enc = await encryptValue(encryptionKey, secretPart);
  return plainPart;
}

// Reassembles a full record from its plaintext fields + decrypted _enc blob.
async function decryptRecord(row) {
  if (!row || !row._enc) return row; // not an encrypted record — return as-is
  if (!encryptionKey) throw new Error('Data is encrypted but no key is loaded — unlock first.');
  const secretPart = await decryptValue(encryptionKey, row._enc);
  const { _enc, ...plainPart } = row;
  return Object.assign({}, plainPart, secretPart);
}

// ---- Table-aware CRUD wrappers. Behave exactly like calling db[table] directly when
// encryption is off; transparently encrypt/decrypt when it's on. These are what future
// call-site migration will switch to, table by table. ----
async function encGetAll(table) {
  const rows = await db[table].toArray();
  return Promise.all(rows.map(decryptRecord));
}
async function encGet(table, id) {
  const row = await db[table].get(id);
  return row ? decryptRecord(row) : row;
}
async function encAdd(table, obj) {
  const encoded = await encryptRecord(table, obj);
  return db[table].add(encoded);
}
async function encUpdate(table, id, changes) {
  if (!encryptionKey) return db[table].update(id, changes);
  const existing = await encGet(table, id);
  const merged = Object.assign({}, existing, changes);
  const encoded = await encryptRecord(table, merged);
  return db[table].update(id, encoded);
}
async function encBulkAdd(table, arr) {
  const encoded = await Promise.all(arr.map(o => encryptRecord(table, o)));
  return db[table].bulkAdd(encoded);
}
// delete/clear/count never touch record content, so they're identical either way —
// call db[table].delete()/.clear()/.count() directly, no wrapper needed.

// ---- Self-test: proves the round-trip works correctly before this is ever relied on. ----
async function _encryptionSelfTest() {
  const testKey = (await deriveEncryptionKey('test-passphrase-do-not-use', null)).key;
  const savedKey = encryptionKey;
  encryptionKey = testKey;
  try {
    const original = { name: 'Test Fund', amount: 1234.56, notes: 'hello 世界', ownerIds: [1, 2] };
    const encoded = await encryptRecord('funds', { id: 99, ...original });
    if (!encoded._enc || encoded.id !== 99) throw new Error('encryptRecord did not preserve plain id field');
    const decoded = await decryptRecord(encoded);
    if (JSON.stringify(decoded) !== JSON.stringify({ id: 99, ...original })) throw new Error('round-trip mismatch');
    // Wrong key should fail to decrypt (AES-GCM auth tag check)
    const wrongKey = (await deriveEncryptionKey('wrong-passphrase', null)).key;
    encryptionKey = wrongKey;
    let wrongKeyFailed = false;
    try { await decryptRecord(encoded); } catch (e) { wrongKeyFailed = true; }
    if (!wrongKeyFailed) throw new Error('decryption should have failed with the wrong key, but did not');
    console.log('✅ Encryption self-test passed');
    return true;
  } catch (e) {
    console.error('❌ Encryption self-test failed:', e);
    return false;
  } finally {
    encryptionKey = savedKey;
  }
}

// ---- Enable / disable / unlock management ----
function isEncryptionEnabled() {
  try { return localStorage.getItem('utt-encryption-enabled') === 'true'; } catch (e) { return false; }
}

function updateEncryptionNavBtn() {
  const btn = document.getElementById('encryptionNavBtn');
  if (btn) btn.textContent = isEncryptionEnabled() ? '🔒 Encryption: On' : '🔓 Encryption: Off';
  const lockBtn = document.getElementById('lockNowBtn');
  if (lockBtn) lockBtn.classList.toggle('hidden', !isEncryptionEnabled());
  setupAutoLock();
  checkEncryptionNudge();
}

// ---- Fullscreen lock screen: manual lock + auto-lock ----
// Locking simply drops the in-memory encryptionKey and shows the same
// blocking, full-viewport unlock overlay used at startup — the passcode
// is never persisted anywhere, so once it's dropped from memory the
// underlying data is unreadable until the user unlocks again.
const AUTO_LOCK_IDLE_MS = 5 * 60 * 1000; // auto-lock after 5 min of inactivity
let autoLockTimer = null;
let autoLockListenersAttached = false;

function lockNow() {
  if (!isEncryptionEnabled()) return; // nothing to lock if encryption is off
  encryptionKey = null;
  document.getElementById('unlockPasscode').value = '';
  document.getElementById('unlockStatus').textContent = '';
  showUnlockOverlay();
}

function resetAutoLockTimer() {
  if (!isEncryptionEnabled() || encryptionKey === null) return;
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => lockNow(), AUTO_LOCK_IDLE_MS);
}

function setupAutoLock() {
  if (!isEncryptionEnabled()) { clearTimeout(autoLockTimer); return; }
  resetAutoLockTimer();
  if (autoLockListenersAttached) return;
  autoLockListenersAttached = true;
  ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
    document.addEventListener(evt, resetAutoLockTimer, { passive: true });
  });
  // Also lock immediately when the tab/app is hidden or backgrounded —
  // e.g. switching apps on a phone — rather than waiting out the idle timer.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isEncryptionEnabled() && encryptionKey !== null) {
      lockNow();
    }
  });
}

async function openEncryptionModal() {
  const enabled = isEncryptionEnabled();
  document.getElementById('encryptionModalOff').classList.toggle('hidden', enabled);
  document.getElementById('encryptionModalOn').classList.toggle('hidden', !enabled);
  document.getElementById('encPasscode1').value = '';
  document.getElementById('encPasscode2').value = '';
  document.getElementById('encDisablePasscode').value = '';
  document.getElementById('encModalStatus').textContent = '';
  document.getElementById('encModalStatus2').textContent = '';
  document.getElementById('encryptionModal').classList.add('active');
}
function closeEncryptionModal() {
  document.getElementById('encryptionModal').classList.remove('active');
  // Clear passcode fields on every close path (cancel AND after a successful
  // submit) — not just on open. Leaving a typed passcode sitting in a
  // type="password" input anywhere in the DOM is what makes Chrome's save-
  // password heuristic misfire later: it can pair that leftover (still
  // non-empty) password field with the next unrelated text/number field the
  // user edits and types into (e.g. the Multi-Year Planner's "Actual (EOY)"
  // box), and prompt to save that combination as a login.
  document.getElementById('encPasscode1').value = '';
  document.getElementById('encPasscode2').value = '';
  document.getElementById('encDisablePasscode').value = '';
}

async function submitEnableEncryption() {
  const p1 = document.getElementById('encPasscode1').value;
  const p2 = document.getElementById('encPasscode2').value;
  const status = document.getElementById('encModalStatus');
  if (!p1 || p1.length < 6) { status.textContent = '⚠️ Passcode must be at least 6 characters.'; status.style.color = '#dd6b20'; return; }
  if (p1 !== p2) { status.textContent = '⚠️ Passcodes do not match.'; status.style.color = '#dd6b20'; return; }
  status.textContent = 'Encrypting your data — this may take a moment...';
  status.style.color = '#718096';
  try {
    const { key, saltB64, iterations } = await deriveEncryptionKey(p1, null);
    encryptionKey = key;
    // One-time migration: re-write every existing (currently plaintext) record through the encrypted wrapper.
    const tables = ['funds', 'transactions', 'navHistory', 'members', 'amanahFunds', 'amanahTransactions', 'kwspAccounts', 'kwspTransactions', 'fixedDeposits', 'fdMaturityRecords', 'fdInterestPayouts', 'realEstateProperties', 'realEstateTx', 'realEstateLoanTx', 'fxTransactions', 'wealthSnapshots', 'incomeForecasts', 'mypPlans', 'mypFunds', 'mypFundRules', 'mypIncomeCategories', 'mypIncomeRanges', 'mypExpenseCategories', 'mypExpenseRanges', 'mypBaselines', 'mypBaselineValues', 'mypActuals', 'mypSavedForecasts'];
    for (const table of tables) {
      const rows = await db[table].toArray();
      for (const row of rows) {
        const encoded = await encryptRecord(table, row);
        await db[table].put(encoded);
      }
    }
    const canary = await encryptValue(key, ENC_CANARY_PLAINTEXT);
    localStorage.setItem('utt-encryption-salt', saltB64);
    localStorage.setItem('utt-encryption-canary', JSON.stringify(canary));
    localStorage.setItem('utt-encryption-iterations', String(iterations));
    localStorage.setItem('utt-encryption-enabled', 'true');
    closeEncryptionModal();
    updateEncryptionNavBtn();
    showToast('🔒 Encryption enabled — your data is now encrypted at rest');
    await initApp();
  } catch (e) {
    status.textContent = '❌ Something went wrong: ' + e.message;
    status.style.color = '#e53e3e';
    encryptionKey = null;
  }
}

async function submitDisableEncryption() {
  const passcode = document.getElementById('encDisablePasscode').value;
  const status = document.getElementById('encModalStatus2');
  if (!passcode) { status.textContent = '⚠️ Enter your current passcode to confirm.'; status.style.color = '#dd6b20'; return; }
  status.textContent = 'Verifying passcode...';
  status.style.color = '#718096';
  try {
    const saltB64 = localStorage.getItem('utt-encryption-salt');
    const { key } = await deriveEncryptionKey(passcode, saltB64, getStoredEncryptionIterations());
    const canary = JSON.parse(localStorage.getItem('utt-encryption-canary'));
    const decoded = await decryptValue(key, canary);
    if (decoded !== ENC_CANARY_PLAINTEXT) throw new Error('wrong passcode');
    // Passcode confirmed correct — decrypt everything back to plaintext.
    encryptionKey = key;
    status.textContent = 'Decrypting your data — this may take a moment...';
    const tables = ['funds', 'transactions', 'navHistory', 'members', 'amanahFunds', 'amanahTransactions', 'kwspAccounts', 'kwspTransactions', 'fixedDeposits', 'fdMaturityRecords', 'fdInterestPayouts', 'realEstateProperties', 'realEstateTx', 'realEstateLoanTx', 'fxTransactions', 'wealthSnapshots', 'incomeForecasts', 'mypPlans', 'mypFunds', 'mypFundRules', 'mypIncomeCategories', 'mypIncomeRanges', 'mypExpenseCategories', 'mypExpenseRanges', 'mypBaselines', 'mypBaselineValues', 'mypActuals', 'mypSavedForecasts'];
    for (const table of tables) {
      const rows = await db[table].toArray();
      for (const row of rows) {
        const decoded2 = await decryptRecord(row);
        await db[table].put(decoded2);
      }
    }
    encryptionKey = null;
    localStorage.removeItem('utt-encryption-salt');
    localStorage.removeItem('utt-encryption-canary');
    localStorage.removeItem('utt-encryption-iterations');
    localStorage.removeItem('utt-encryption-enabled');
    closeEncryptionModal();
    updateEncryptionNavBtn();
    showToast('🔓 Encryption disabled — your data is stored as plaintext again');
    await initApp();
  } catch (e) {
    status.textContent = '❌ Incorrect passcode.';
    status.style.color = '#e53e3e';
  }
}

function showUnlockOverlay() {
  document.getElementById('unlockOverlay').classList.add('active');
  document.getElementById('unlockPasscode').focus();
}
function hideUnlockOverlay() {
  document.getElementById('unlockOverlay').classList.remove('active');
}

async function attemptUnlock() {
  const passcode = document.getElementById('unlockPasscode').value;
  const status = document.getElementById('unlockStatus');
  if (!passcode) { status.textContent = 'Enter your passcode.'; return; }
  status.textContent = 'Unlocking...';
  status.style.color = '#718096';
  try {
    const saltB64 = localStorage.getItem('utt-encryption-salt');
    const { key } = await deriveEncryptionKey(passcode, saltB64, getStoredEncryptionIterations());
    const canary = JSON.parse(localStorage.getItem('utt-encryption-canary'));
    const decoded = await decryptValue(key, canary);
    if (decoded !== ENC_CANARY_PLAINTEXT) throw new Error('wrong passcode');
    encryptionKey = key;
    document.getElementById('unlockPasscode').value = '';
    hideUnlockOverlay();
    await initApp();
  } catch (e) {
    status.textContent = '❌ Incorrect passcode. Try again.';
    status.style.color = '#e53e3e';
    document.getElementById('unlockPasscode').value = '';
    document.getElementById('unlockPasscode').focus();
  }
}

let currentFundId = null;
let charts = {};

// View mode state (card vs list/table), persisted per section
function loadViewMode(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
}
function saveViewMode(key, mode) {
  try { localStorage.setItem(key, mode); } catch (e) { /* private browsing - ignore */ }
}
let fundsViewMode = loadViewMode('utt-funds-view', 'card');
let closedViewMode = loadViewMode('utt-closed-view', 'list');
let navViewMode = loadViewMode('utt-nav-view', 'card');
let fundsOwnerFilter = loadViewMode('utt-funds-owner-filter', 'All');
let closedOwnerFilter = loadViewMode('utt-closed-owner-filter', 'All');
let dashOwnerFilter = loadViewMode('utt-dash-owner-filter', 'All');

function setFundsOwnerFilter(owner) {
  fundsOwnerFilter = owner;
  saveViewMode('utt-funds-owner-filter', owner);
  renderFunds();
}

function setClosedOwnerFilter(owner) {
  closedOwnerFilter = owner;
  saveViewMode('utt-closed-owner-filter', owner);
  renderClosedFunds();
}

function setDashOwnerFilter(owner) {
  dashOwnerFilter = owner;
  saveViewMode('utt-dash-owner-filter', owner);
  renderDashboard();
}

async function renderDashOwnerFilterOptions() {
  const select = document.getElementById('dash-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (dashOwnerFilter === 'All' || members.some(m => String(m.id) === String(dashOwnerFilter))) ? dashOwnerFilter : 'All';
}

async function renderFundsOwnerFilterOptions() {
  const select = document.getElementById('funds-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (fundsOwnerFilter === 'All' || members.some(m => String(m.id) === String(fundsOwnerFilter))) ? fundsOwnerFilter : 'All';
}

async function renderClosedOwnerFilterOptions() {
  const select = document.getElementById('closed-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (closedOwnerFilter === 'All' || members.some(m => String(m.id) === String(closedOwnerFilter))) ? closedOwnerFilter : 'All';
}

function setFundsView(mode) {
  fundsViewMode = mode;
  saveViewMode('utt-funds-view', mode);
  document.getElementById('funds-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('funds-view-list-btn').classList.toggle('active', mode === 'list');
  renderFunds();
}

function setClosedView(mode) {
  closedViewMode = mode;
  saveViewMode('utt-closed-view', mode);
  document.getElementById('closed-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('closed-view-list-btn').classList.toggle('active', mode === 'list');
  renderClosedFunds();
}

function setNavView(mode) {
  navViewMode = mode;
  saveViewMode('utt-nav-view', mode);
  document.getElementById('nav-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('nav-view-table-btn').classList.toggle('active', mode === 'table');
  document.getElementById('nav-view-history-btn').classList.toggle('active', mode === 'history');
  document.getElementById('nav-date-row').classList.toggle('hidden', mode === 'history');
  document.getElementById('nav-update-btn').classList.toggle('hidden', mode === 'history');
  renderNavUpdateList();
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  if (isEncryptionEnabled()) {
    showUnlockOverlay();
  } else {
    await initApp();
  }
});

async function initApp() {
  document.getElementById('nav-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('txDate').value = new Date().toISOString().split('T')[0];
  updateCurrencyNavBtn();
  updateEncryptionNavBtn();
  document.getElementById('funds-view-card-btn').classList.toggle('active', fundsViewMode === 'card');
  document.getElementById('funds-view-list-btn').classList.toggle('active', fundsViewMode === 'list');
  document.getElementById('closed-view-card-btn').classList.toggle('active', closedViewMode === 'card');
  document.getElementById('closed-view-list-btn').classList.toggle('active', closedViewMode === 'list');
  document.getElementById('nav-view-card-btn').classList.toggle('active', navViewMode === 'card');
  document.getElementById('nav-view-table-btn').classList.toggle('active', navViewMode === 'table');
  document.getElementById('nav-view-history-btn').classList.toggle('active', navViewMode === 'history');
  document.getElementById('nav-date-row').classList.toggle('hidden', navViewMode === 'history');
  document.getElementById('nav-update-btn').classList.toggle('hidden', navViewMode === 'history');
  document.getElementById('funds-owner-filter').value = fundsOwnerFilter;
  document.getElementById('closed-owner-filter').value = closedOwnerFilter;
  document.getElementById('amanah-view-card-btn').classList.toggle('active', amanahViewMode === 'card');
  document.getElementById('amanah-view-list-btn').classList.toggle('active', amanahViewMode === 'list');
  await renderFundsOwnerFilterOptions();
  await renderClosedOwnerFilterOptions();
  await renderDashOwnerFilterOptions();
  const funds = await db.funds.count();
  if (funds === 0) await addSampleData();
  await fxMigrateLegacyLocalStorageData();
  await renderDashboard();
  await renderFunds();
  await renderTransactions();
  await renderNavUpdateList();
  await renderClosedFunds();
  await renderAmanahAll();
  await renderKwspAll();
  await renderFdAll();
  await renderRealEstateAll();
  await renderFxAll();
  await renderWealthAll();
  switchModule(currentModule);
  checkBackupReminder();
  checkEncryptionNudge();
}

// ==================== BACKUP REMINDER ====================
// Data lives in this browser's IndexedDB only (nothing is synced anywhere),
// so it disappears if the browser data is cleared. Nudge for a periodic Export.
const BACKUP_REMINDER_DAYS = 14;
function checkBackupReminder() {
  try {
    const last = localStorage.getItem('utt-last-export');
    const lastDate = last ? new Date(last) : null;
    const daysSince = lastDate ? (new Date() - lastDate) / (24 * 60 * 60 * 1000) : Infinity;
    if (daysSince >= BACKUP_REMINDER_DAYS) {
      const msg = lastDate
        ? 'It\'s been ' + Math.floor(daysSince) + ' days since your last export — consider backing up your data.'
        : 'Your data is only stored in this browser. Consider using Export to back it up.';
      setTimeout(() => showToast(msg), 800);
    }
  } catch (e) { /* localStorage unavailable (e.g. private browsing) - skip reminder */ }
}

// ==================== ENCRYPTION NUDGE ====================
// Encryption is opt-in (data is stored in plaintext IndexedDB until a user turns
// it on via the nav bar), which is easy to miss since it's tucked away in a modal.
// Surface a one-time, dismissible banner instead of leaving it purely opt-in-and-
// hidden. "One-time" per browser: shown once, then snoozed for a while if the
// user dismisses it rather than enabling — similar in spirit to the backup
// reminder above, but less frequent since this is a one-off setup nudge, not a
// recurring task.
const ENCRYPTION_NUDGE_SNOOZE_DAYS = 30;
function checkEncryptionNudge() {
  const banner = document.getElementById('encryptionNudgeBanner');
  if (!banner) return;
  if (isEncryptionEnabled()) { banner.classList.add('hidden'); return; }
  try {
    const snoozedUntil = localStorage.getItem('utt-encryption-nudge-snoozed-until');
    if (snoozedUntil && new Date(snoozedUntil) > new Date()) { banner.classList.add('hidden'); return; }
  } catch (e) { /* localStorage unavailable — fall through and show the banner */ }
  banner.classList.remove('hidden');
}
function dismissEncryptionNudge() {
  const banner = document.getElementById('encryptionNudgeBanner');
  if (banner) banner.classList.add('hidden');
  try {
    const snoozeUntil = new Date(Date.now() + ENCRYPTION_NUDGE_SNOOZE_DAYS * 24 * 60 * 60 * 1000);
    localStorage.setItem('utt-encryption-nudge-snoozed-until', snoozeUntil.toISOString());
  } catch (e) { /* private browsing - ignore, banner just won't stay dismissed */ }
}
function enableEncryptionFromNudge() {
  const banner = document.getElementById('encryptionNudgeBanner');
  if (banner) banner.classList.add('hidden');
  openEncryptionModal();
}

// Sample data
async function addSampleData() {
  const fund1 = await encAdd('funds', {
    name: 'Global Equity Fund', code: 'GEF001', category: 'Equity', currency: 'USD', nav: 1.2345, createdAt: new Date('2024-01-15')
  });
  const fund2 = await encAdd('funds', {
    name: 'Asia Pacific Bond', code: 'APB002', category: 'Bond', currency: 'USD', nav: 0.9876, createdAt: new Date('2024-03-20')
  });
  await encBulkAdd('transactions', [
    { fundId: fund1, type: 'Buy', date: '2024-01-15', units: 1000, price: 1.1000, amount: 1100.00, notes: 'Initial investment', createdAt: new Date() },
    { fundId: fund1, type: 'Buy', date: '2024-06-15', units: 500, price: 1.1500, amount: 575.00, notes: 'Top up', createdAt: new Date() },
    { fundId: fund1, type: 'Dividend', date: '2024-07-15', units: 50, price: 1.2000, amount: 60.00, notes: 'Semi-annual dividend', createdAt: new Date() },
    { fundId: fund1, type: 'Dividend Cheque', date: '2025-01-15', units: 0, price: 0, amount: 75.00, notes: 'Cheque payout', createdAt: new Date() },
    { fundId: fund2, type: 'Buy', date: '2024-03-20', units: 2000, price: 0.9500, amount: 1900.00, notes: 'Initial investment', createdAt: new Date() },
    { fundId: fund2, type: 'Contribution', date: '2024-09-20', units: 1000, price: 0.9700, amount: 970.00, notes: 'Monthly contribution', createdAt: new Date() }
  ]);
  await encBulkAdd('navHistory', [
    { fundId: fund1, date: '2024-01-15', nav: 1.1000, createdAt: new Date() },
    { fundId: fund1, date: '2024-06-15', nav: 1.1500, createdAt: new Date() },
    { fundId: fund1, date: '2024-12-15', nav: 1.2000, createdAt: new Date() },
    { fundId: fund1, date: '2025-01-15', nav: 1.2345, createdAt: new Date() },
    { fundId: fund2, date: '2024-03-20', nav: 0.9500, createdAt: new Date() },
    { fundId: fund2, date: '2024-09-20', nav: 0.9700, createdAt: new Date() },
    { fundId: fund2, date: '2025-01-15', nav: 0.9876, createdAt: new Date() }
  ]);
}

// Tab switching
let lastUnitTrustTab = 'dashboard';
let currentModule = loadViewMode('utt-current-module', 'unittrust');

function switchTab(tab) {
  lastUnitTrustTab = tab;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById(tab).classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'funds') { showFundsList(); renderFunds(); }
  if (tab === 'transactions') renderTransactions();
  if (tab === 'closed') renderClosedFunds();
}

function switchModule(module) {
  currentModule = module;
  saveViewMode('utt-current-module', module);
  document.querySelectorAll('.module-tab').forEach(b => b.classList.toggle('active', b.dataset.module === module));
  document.getElementById('unittrust-subnav').classList.toggle('hidden', module !== 'unittrust');
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  if (module === 'wealth') {
    document.getElementById('wealth').classList.add('active');
    renderWealthAll();
  } else if (module === 'amanah') {
    document.getElementById('amanah').classList.add('active');
    renderAmanahAll();
  } else if (module === 'kwsp') {
    document.getElementById('kwsp').classList.add('active');
    renderKwspAll();
  } else if (module === 'fd') {
    document.getElementById('fd').classList.add('active');
    renderFdAll();
  } else if (module === 'realestate') {
    document.getElementById('realestate').classList.add('active');
    renderRealEstateAll();
  } else if (module === 'fx') {
    document.getElementById('fx').classList.add('active');
    renderFxAll();
  } else if (module === 'forecast') {
    document.getElementById('forecast').classList.add('active');
    renderForecastList();
  } else if (module === 'planner') {
    document.getElementById('planner').classList.add('active');
    mypInitPlanner();
  } else {
    switchTab(lastUnitTrustTab);
  }
}

// Toast
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Format helpers
// ==================== CURRENCY ====================
const CURRENCY_SYMBOLS = { USD:'$', MYR:'RM', SGD:'S$', EUR:'€', GBP:'£', JPY:'¥', AUD:'A$', CNY:'¥', HKD:'HK$', INR:'₹', IDR:'Rp', THB:'฿', NZD:'NZ$', CHF:'CHF ', KRW:'₩', PHP:'₱', VND:'₫', TWD:'NT$', BND:'B$' };
const CURRENCY_FLAGS = { USD:'🇺🇸', MYR:'🇲🇾', SGD:'🇸🇬', EUR:'🇪🇺', GBP:'🇬🇧', JPY:'🇯🇵', AUD:'🇦🇺', CNY:'🇨🇳', HKD:'🇭🇰', INR:'🇮🇳', IDR:'🇮🇩', THB:'🇹🇭', NZD:'🇳🇿', CHF:'🇨🇭', KRW:'🇰🇷', PHP:'🇵🇭', VND:'🇻🇳', TWD:'🇹🇼', BND:'🇧🇳' };
function currencyFlag(code) {
  const c = (code || getBaseCurrency() || 'USD').toUpperCase();
  return CURRENCY_FLAGS[c] || '💱';
}

const MEMBER_COLORS = ['#4299e1', '#ed64a6', '#48bb78', '#ed8936', '#805ad5', '#f56565', '#38b2ac', '#d69e2e'];
async function getMembers() {
  const rows = await db.members.orderBy('id').toArray();
  return Promise.all(rows.map(decryptRecord));
}
function memberColor(memberId) {
  return MEMBER_COLORS[memberId % MEMBER_COLORS.length];
}
// ownerIds: array of member ids; membersById: Map or object of id -> member (avoids repeated DB lookups when rendering lists)
function ownerBadgeHtml(ownerIds, membersById) {
  if (!ownerIds || ownerIds.length === 0) return '';
  const names = ownerIds.map(id => (membersById && membersById[id]) ? membersById[id].name : null).filter(Boolean);
  if (names.length === 0) return '';
  const icon = names.length > 1 ? '👫' : '👤';
  const color = memberColor(ownerIds[0]);
  const label = escapeHtml(names.join(' & '));
  return `<span style="display:inline-block;background:${color}18;color:${color};border:1px solid ${color}40;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;">${icon} ${label}</span>`;
}
async function membersByIdMap() {
  const members = await getMembers();
  const map = {};
  members.forEach(m => { map[m.id] = m; });
  return map;
}

async function renderOwnerCheckboxes(containerId, selectedIds) {
  selectedIds = selectedIds || [];
  const members = await getMembers();
  const container = document.getElementById(containerId);
  if (members.length === 0) {
    container.innerHTML = '<span style="font-size:13px;color:#a0aec0;">No members yet — add one via 👥 Members in the nav bar.</span>';
    return;
  }
  container.innerHTML = members.map(m => {
    const checked = selectedIds.includes(m.id);
    return `<label class="owner-check-pill ${checked ? 'checked' : ''}" data-action="toggleCheckedDelayed">
      <input type="checkbox" value="${m.id}" ${checked ? 'checked' : ''}>${escapeHtml(m.name)}
    </label>`;
  }).join('');
}

function getCheckedOwnerIds(containerId) {
  const container = document.getElementById(containerId);
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(el => parseInt(el.value));
}
function getBaseCurrency() {
  try { return localStorage.getItem('utt-base-currency') || 'USD'; } catch (e) { return 'USD'; }
}
function setBaseCurrency(code) {
  try { localStorage.setItem('utt-base-currency', code); } catch (e) { /* private browsing - ignore */ }
}
function getExchangeRates() {
  try { return JSON.parse(localStorage.getItem('utt-exchange-rates') || '{}'); } catch (e) { return {}; }
}
function setExchangeRates(rates) {
  try { localStorage.setItem('utt-exchange-rates', JSON.stringify(rates)); } catch (e) { /* private browsing - ignore */ }
}
function currencySymbol(code) {
  const c = (code || getBaseCurrency() || 'USD').toUpperCase();
  return CURRENCY_SYMBOLS[c] || (c + ' ');
}
// Rate = how many units of the base currency equal 1 unit of `currency`
function getRate(currency) {
  const base = getBaseCurrency();
  if (!currency || currency === base) return 1;
  const r = parseFloat(getExchangeRates()[currency]);
  return (!isNaN(r) && r > 0) ? r : 1;
}
function hasRate(currency) {
  const base = getBaseCurrency();
  if (!currency || currency === base) return true;
  const r = parseFloat(getExchangeRates()[currency]);
  return !isNaN(r) && r > 0;
}
function toBase(amount, currency) {
  return (parseFloat(amount) || 0) * getRate(currency);
}
async function getDistinctFundCurrencies() {
  const funds = await encGetAll('funds');
  const fxTx = await encGetAll('fxTransactions');
  return Array.from(new Set([...funds.map(f => f.currency), ...fxTx.map(t => t.currency)].filter(Boolean))).sort();
}
function groupFundsByCurrency(funds) {
  const groups = {};
  funds.forEach(f => {
    const cur = f.currency || 'N/A';
    if (!groups[cur]) groups[cur] = [];
    groups[cur].push(f);
  });
  return groups;
}

const CURRENCY_GROUP_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #48bb78 0%, #38a169 100%)',
  'linear-gradient(135deg, #4299e1 0%, #3182ce 100%)',
  'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)',
  'linear-gradient(135deg, #f56565 0%, #e53e3e 100%)',
  'linear-gradient(135deg, #9f7aea 0%, #805ad5 100%)'
];
const CURRENCY_GROUP_COLORS = ['#667eea', '#48bb78', '#4299e1', '#ed8936', '#f56565', '#9f7aea'];
function currencyGroupHeaderHtml(cur, count, index, statsText) {
  const gradient = CURRENCY_GROUP_GRADIENTS[index % CURRENCY_GROUP_GRADIENTS.length];
  return `<div class="currency-group-header" style="grid-column: 1 / -1; background: ${gradient};">
    <h3>${cur} <span style="font-weight:400;opacity:0.85;">(${count} fund${count !== 1 ? 's' : ''})</span></h3>
    <div class="currency-group-header-stats">${statsText}</div>
  </div>`;
}
function currencyGroupRowHtml(cur, count, index, colspan, statsText) {
  const color = CURRENCY_GROUP_COLORS[index % CURRENCY_GROUP_COLORS.length];
  return `<tr><td colspan="${colspan}" style="background:${color}18;border-left:4px solid ${color};font-weight:700;color:${color};padding:10px 12px;">${cur} <span style="font-weight:500;color:#4a5568;">(${count} fund${count !== 1 ? 's' : ''})</span>${statsText ? ` — <span style="font-weight:500;color:#4a5568;">${statsText}</span>` : ''}</td></tr>`;
}

function formatCurrency(val, currency) {
  return currencySymbol(currency) + parseFloat(val || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Accounting-negative style for amounts that represent a cost or liability
// increase (loan drawdowns, bank charges, credit notes): shown in red,
// wrapped in parentheses, e.g. (RM1,234.56).
function formatCurrencyNeg(val, currency) {
  const amt = parseFloat(val || 0);
  if (amt === 0) return '-';
  return `<span style="color:#e53e3e;">(${formatCurrency(Math.abs(amt), currency)})</span>`;
}

// Red text (no brackets) for a primary balance figure that represents debt
// (e.g. Mortgage) — a paid-off 0 still reads as a plain RM0.00.
function formatDebtAmount(val, currency) {
  const amt = parseFloat(val || 0);
  if (amt > 0) return `<span style="color:#e53e3e;">${formatCurrency(amt, currency)}</span>`;
  if (amt < 0) return `<span style="color:#48bb78;">Surplus ${formatCurrency(Math.abs(amt), currency)}</span>`;
  return formatCurrency(0, currency);
}

function formatNav(val) {
  return '$' + parseFloat(val || 0).toFixed(4);
}

// 判断基金是否已清仓（units <= 0 且没有未卖出的买入记录）
// ===== FIXED: isFundActive - A fund is CLOSED only if it has transactions AND units <= 0 =====
// A new fund with NO transactions is ACTIVE (shows in My Funds)
function isFundActive(fund, transactions) {
  const fundTx = transactions.filter(t => t.fundId === fund.id);
  // If no transactions at all, it's a new fund -> ACTIVE
  if (fundTx.length === 0) return true;
  // If has transactions, check if units > 0
  const units = fundTx.reduce((sum, t) => {
    if (t.type === 'Buy' || t.type === 'Contribution' || t.type === 'Dividend') return sum + (parseFloat(t.units) || 0);
    if (t.type === 'Sell') return sum - (parseFloat(t.units) || 0);
    return sum;
  }, 0);
  return units > 0.0001;
}

function getTxTypeColor(type) {
  const colors = { 'Buy': '#c6f6d5', 'Sell': '#fed7d7', 'Dividend': '#bee3f8', 'Dividend (Reinvest)': '#c3dafe', 'Dividend Cheque': '#feebc8', 'Contribution': '#e9d8fd', 'Bonus Units': '#d6f5e3', 'Annual Fee': '#fbd38d' };
  return colors[type] || '#e2e8f0';
}

// The Add Transaction dropdown labels the 'Dividend' type as "Dividend (Cash)" to distinguish
// it from "Dividend (Reinvest)" — this makes every other display of that type consistent with it.
function amanahTxTypeLabel(type) {
  return type === 'Dividend' ? 'Dividend (Cash)' : type;
}

// Calculate fund metrics
function calcFundMetrics(fund, transactions) {
  const fundTx = transactions.filter(t => t.fundId === fund.id);
  const units = fundTx.reduce((sum, t) => {
    if (t.type === 'Buy' || t.type === 'Contribution' || t.type === 'Dividend') return sum + (parseFloat(t.units) || 0);
    if (t.type === 'Sell') return sum - (parseFloat(t.units) || 0);
    return sum;
  }, 0);
  const invested = fundTx.reduce((sum, t) => {
    if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0);
    if (t.type === 'Sell') return sum - (parseFloat(t.amount) || 0);
    return sum;
  }, 0);
  const divCheque = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const divReinvest = fundTx.filter(t => t.type === 'Dividend').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const currentValue = units * fund.nav;
  const pl = currentValue + divCheque - invested;
  const returnPct = invested > 0 ? (pl / invested * 100) : 0;
  const buys = fundTx.filter(t => t.type === 'Buy' || t.type === 'Contribution').sort((a, b) => new Date(a.date) - new Date(b.date));
  let yearsHeld = 'New', years = 0, annualised = 0;
  if (buys.length > 0) {
    const firstDate = new Date(buys[0].date);
    years = (new Date() - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
    yearsHeld = years < 0.1 ? 'New' : years.toFixed(1) + ' yrs';
    if (years > 0 && invested > 0) {
      const totalReturn = (currentValue + divCheque) / invested;
      annualised = (Math.pow(totalReturn, 1 / years) - 1) * 100;
    }
  }
  return { units, invested, divCheque, divReinvest, currentValue, pl, returnPct, yearsHeld, years, annualised, buys };
}

// ==================== DASHBOARD ====================
async function renderDashboard() {
  // Render the matured-FD notice first and independently of everything else
  // below. It used to be the LAST line in this function, after the chart
  // renders — so if renderAllocationChart/renderPerformanceChart/etc threw
  // (e.g. a Chart.js edge case with a particular data shape), execution
  // stopped right there and this call was silently skipped, even though the
  // stat numbers above it had already been filled in. That made the notice
  // look like it "never shows" on the main dashboard even when FDs really
  // were overdue. It doesn't depend on funds/transactions, so there's no
  // reason it needs to wait for them anyway.
  try { await renderDashFdMaturedNotice(); } catch (e) { console.error('renderDashFdMaturedNotice failed:', e); }

  let funds = await encGetAll('funds');
  const transactions = await encGetAll('transactions');
  if (dashOwnerFilter !== 'All') { const fid = parseInt(dashOwnerFilter); funds = funds.filter(f => (f.ownerIds || []).includes(fid)); }
  const base = getBaseCurrency();
  document.getElementById('dash-base-currency-note').textContent = currencyFlag(base) + ' All totals converted to ' + base + (funds.some(f => !hasRate(f.currency)) ? ' ⚠️ some rates not set' : '') + ' · 💱 Currency to adjust';
  let totalValue = 0, totalInvested = 0, totalDivCheque = 0, totalDivReinvest = 0, firstBuyDate = null;
  const activeFunds = [];
  for (const fund of funds) {
    if (!isFundActive(fund, transactions)) continue; // Skip closed funds
    activeFunds.push(fund);
    const m = calcFundMetrics(fund, transactions);
    totalValue += toBase(m.currentValue, fund.currency);
    totalInvested += toBase(m.invested, fund.currency);
    totalDivCheque += toBase(m.divCheque, fund.currency);
    totalDivReinvest += toBase(m.divReinvest, fund.currency);
    if (m.buys.length > 0) {
      const d = new Date(m.buys[0].date);
      if (!firstBuyDate || d < firstBuyDate) firstBuyDate = d;
    }
  }
  const totalDividends = totalDivCheque + totalDivReinvest;
  const pl = totalValue + totalDivCheque - totalInvested;
  const plPct = totalInvested > 0 ? (pl / totalInvested * 100) : 0;
  let annualised = 0;
  if (firstBuyDate && totalInvested > 0) {
    const years = (new Date() - firstBuyDate) / (365.25 * 24 * 60 * 60 * 1000);
    if (years > 0) {
      const totalReturn = (totalValue + totalDivCheque) / totalInvested;
      annualised = (Math.pow(totalReturn, 1 / years) - 1) * 100;
    }
  }
  document.getElementById('dash-portfolio-value').textContent = formatCurrency(totalValue);
  document.getElementById('dash-fund-count').textContent = funds.length + ' fund' + (funds.length !== 1 ? 's' : '');
  document.getElementById('dash-invested').textContent = formatCurrency(totalInvested);
  document.getElementById('dash-pl').textContent = (pl >= 0 ? '+' : '') + formatCurrency(pl);
  document.getElementById('dash-pl-pct').textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(2) + '%';
  document.getElementById('dash-pl-card').className = 'stat-card ' + (pl >= 0 ? 'green' : 'red');
  document.getElementById('dash-annualised').textContent = annualised.toFixed(2) + '%';
  document.getElementById('dash-dividends').textContent = formatCurrency(totalDividends);
  // Each of these is independent UI; wrap separately so a failure in one
  // (e.g. a chart edge case) can't stop the others from rendering.
  try { renderCurrencyGroups(activeFunds, transactions); } catch (e) { console.error('renderCurrencyGroups failed:', e); }
  try { renderAllocationChart(funds, transactions); } catch (e) { console.error('renderAllocationChart failed:', e); }
  try { renderPerformanceChart(funds, transactions); } catch (e) { console.error('renderPerformanceChart failed:', e); }
  try { renderDashboardHoldings(funds, transactions); } catch (e) { console.error('renderDashboardHoldings failed:', e); }
}

// Shared by both dashboards that should surface this warning: the Unit
// Trust module's "Portfolio Dashboard" sub-tab, and the top-level "💎 My
// Wealth" dashboard (the app's actual home/landing tab). containerId picks
// which one to render into; ownerFilterValue is that page's own owner
// filter ('All', a member id, or — for My Wealth — 'joint').
async function renderFdMaturedNoticeInto(containerId, ownerFilterValue) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let deposits = await encGetAll('fixedDeposits');
  if (ownerFilterValue === 'joint') {
    deposits = deposits.filter(f => (f.ownerIds || []).length > 1);
  } else if (ownerFilterValue !== 'All' && ownerFilterValue != null) {
    const fid = parseInt(ownerFilterValue);
    deposits = deposits.filter(f => (f.ownerIds || []).includes(fid));
  }
  const matured = deposits.filter(isFdOverdue).sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
  if (matured.length === 0) { container.innerHTML = ''; return; }
  const items = matured.map(fd => {
    const days = Math.abs(fdDaysToMaturity(fd));
    return `<li>${escapeHtml(fd.bankName)} — matured ${escapeHtml(fd.maturityDate)} (${days} day${days !== 1 ? 's' : ''} ago) `
      + `<button class="icon-btn" title="Process Maturity" data-action="openProcessMaturityModal" data-arg="${fd.id}" style="padding:2px 8px;">📜 Process</button></li>`;
  }).join('');
  container.innerHTML = `<div class="stat-card" style="border-left:4px solid #e53e3e;margin-bottom:20px;background:#fff5f5;">
    <h3 style="color:#e53e3e;">⚠️ ${matured.length} Fixed Deposit${matured.length !== 1 ? 's' : ''} Matured — Action Needed</h3>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:14px;color:#4a5568;">${items}</ul>
  </div>`;
}

async function renderDashFdMaturedNotice() {
  // The "Matured FD" notice has been removed from the Unit Trust module's
  // Portfolio Dashboard per user request. It still appears on the top-level
  // "My Wealth" dashboard (see renderFdMaturedNoticeInto('wealth-fd-matured-notice', ...)
  // below), which is unaffected since it doesn't call this function.
  const container = document.getElementById('dash-fd-matured-notice');
  if (container) container.innerHTML = '';
}


function renderCurrencyGroups(activeFunds, transactions) {
  const container = document.getElementById('dash-currency-groups');
  const groups = groupFundsByCurrency(activeFunds);
  const currencies = Object.keys(groups).sort();
  if (currencies.length <= 1) { container.innerHTML = ''; return; }
  const base = getBaseCurrency();
  container.innerHTML = '<h3 style="margin: 0 0 15px; color: #4a5568;">By Currency</h3><div class="stats-grid">' +
    currencies.map(cur => {
      let value = 0, invested = 0, divCheque = 0;
      groups[cur].forEach(fund => {
        const m = calcFundMetrics(fund, transactions);
        value += m.currentValue; invested += m.invested; divCheque += m.divCheque;
      });
      const pl = value + divCheque - invested;
      const plPct = invested > 0 ? (pl / invested * 100) : 0;
      const converted = toBase(value, cur);
      const rateNote = cur === base ? '' : (hasRate(cur) ? `<div class="sub">≈ ${formatCurrency(converted)}</div>` : `<div class="sub" style="color:#dd6b20;">⚠️ rate not set</div>`);
      return `<div class="stat-card ${pl >= 0 ? 'green' : 'red'}">
        <h3>${cur} (${groups[cur].length} fund${groups[cur].length !== 1 ? 's' : ''})</h3>
        <div class="value">${formatCurrency(value, cur)}</div>
        <div class="sub">Invested: ${formatCurrency(invested, cur)} · P/L: ${pl >= 0 ? '+' : ''}${formatCurrency(pl, cur)} (${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%)</div>
        ${rateNote}
      </div>`;
    }).join('') + '</div>';
}

function renderDashboardHoldings(funds, transactions) {
  const tbody = document.getElementById('dash-holdings-body');
  if (!tbody) return;
  const activeFunds = funds.filter(f => isFundActive(f, transactions));
  if (activeFunds.length === 0) { tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#a0aec0;">No active funds</td></tr>'; return; }
  const groups = groupFundsByCurrency(activeFunds);
  const currencies = Object.keys(groups).sort();
  const multiCurrency = currencies.length > 1;
  tbody.innerHTML = currencies.map((cur, idx) => {
    const rows = groups[cur].map(fund => {
      const m = calcFundMetrics(fund, transactions);
      const plClass = m.pl >= 0 ? 'positive' : 'negative';
      return `<tr>
        <td><strong>${escapeHtml(fund.name)}</strong>${fund.code ? `<div style="font-size:11px;color:#718096;font-weight:normal;margin-top:2px;">${escapeHtml(fund.code)}</div>` : ''}</td>
        <td>${escapeHtml(fund.category)}</td>
        <td>${m.units.toFixed(4)}</td>
        <td>${formatNav(fund.nav)}</td>
        <td><strong>${formatCurrency(m.currentValue, fund.currency)}</strong></td>
        <td>${formatCurrency(m.invested, fund.currency)}</td>
        <td class="${plClass}">${m.pl >= 0 ? '+' : ''}${formatCurrency(m.pl, fund.currency)}</td>
        <td class="${plClass}">${m.returnPct.toFixed(2)}%</td>
        <td class="${plClass}">${m.annualised.toFixed(2)}%</td>
        <td>${m.yearsHeld}</td>
      </tr>`;
    }).join('');
    if (!multiCurrency) return rows;
    return currencyGroupRowHtml(cur, groups[cur].length, idx, 10) + rows;
  }).join('');
}

function renderAllocationChart(funds, transactions) {
  const ctx = document.getElementById('allocationChart');
  if (!ctx) return;
  if (charts.allocation) charts.allocation.destroy();
  const data = funds.filter(fund => isFundActive(fund, transactions)).map(fund => {
    const m = calcFundMetrics(fund, transactions);
    return { name: fund.name, value: toBase(m.currentValue, fund.currency) };
  }).filter(d => d.value > 0);
  if (data.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';
  charts.allocation = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: data.map(d => d.name), datasets: [{ data: data.map(d => d.value), backgroundColor: ['#667eea', '#48bb78', '#ed8936', '#f56565', '#4299e1', '#9f7aea', '#38b2ac'] }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: function(context) { const total = context.dataset.data.reduce((a, b) => a + b, 0); const pct = ((context.raw / total) * 100).toFixed(1); return context.label + ': ' + formatCurrency(context.raw) + ' (' + pct + '%)'; } } }
      }
    }
  });
}

function renderPerformanceChart(funds, transactions) {
  const ctx = document.getElementById('performanceChart');
  if (!ctx) return;
  if (charts.performance) charts.performance.destroy();
  const activeFunds = funds.filter(f => isFundActive(f, transactions));
  const data = activeFunds.map(fund => {
    const m = calcFundMetrics(fund, transactions);
    return { name: fund.name, return: m.returnPct, annualised: m.annualised, years: m.yearsHeld };
  });
  if (data.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';
  charts.performance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.name),
      datasets: [
        { label: 'Annualised Return %', data: data.map(d => d.annualised), backgroundColor: data.map(d => d.annualised >= 0 ? '#48bb78' : '#f56565'), borderRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      scales: { y: { ticks: { callback: v => v.toFixed(1) + '%' } } },
      plugins: {
        title: { display: true, text: 'Performance Comparison (Annualised)' },
        tooltip: {
          callbacks: {
            afterLabel: function(context) {
              const idx = context.dataIndex;
              return 'Holding: ' + data[idx].years;
            },
            label: function(context) {
              return context.dataset.label + ': ' + context.raw.toFixed(2) + '%';
            }
          }
        }
      }
    }
  });
}

// ==================== FUNDS ====================
async function renderFunds() {
  const allFunds = await encGetAll('funds');
  const transactions = await encGetAll('transactions');
  const membersById = await membersByIdMap();
  let funds = allFunds.filter(f => isFundActive(f, transactions));
  if (fundsOwnerFilter !== 'All') { const fid = parseInt(fundsOwnerFilter); funds = funds.filter(f => (f.ownerIds || []).includes(fid)); }
  const grid = document.getElementById('fund-grid');
  const empty = document.getElementById('funds-empty');
  if (funds.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    const filterSelect = document.getElementById('funds-owner-filter');
    const filterLabel = filterSelect && filterSelect.selectedOptions[0] ? filterSelect.selectedOptions[0].textContent : '';
    empty.querySelector('h3').textContent = fundsOwnerFilter !== 'All' ? 'No funds for ' + filterLabel : 'No funds yet';
    empty.querySelector('p').textContent = fundsOwnerFilter !== 'All' ? 'Try a different owner filter, or add a fund with this owner.' : 'Add your first fund to start tracking';
    return;
  }
  empty.classList.add('hidden');
  const groups = groupFundsByCurrency(funds);
  const currencies = Object.keys(groups).sort();
  const multiCurrency = currencies.length > 1;

  function groupTotals(groupFunds) {
    let value = 0, invested = 0, divCheque = 0;
    groupFunds.forEach(fund => {
      const m = calcFundMetrics(fund, transactions);
      value += m.currentValue; invested += m.invested; divCheque += m.divCheque;
    });
    return { value, invested, pl: value + divCheque - invested };
  }

  if (fundsViewMode === 'list') {
    grid.className = '';
    grid.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Fund</th><th>Owner</th><th>Category</th><th>Currency</th><th>Units</th><th>NAV</th><th>Value</th><th>Invested</th><th>P/L</th><th>Return</th><th>Annualised</th><th>Holding</th><th>Actions</th></tr></thead>
      <tbody>` + currencies.map((cur, idx) => {
      const rows = groups[cur].map(fund => {
        const m = calcFundMetrics(fund, transactions);
        const plClass = m.pl >= 0 ? 'positive' : 'negative';
        return `<tr>
          <td><a href="#" data-action="showFundDetail" data-prevent="1" data-arg="${fund.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(fund.name)}</a>${fund.code ? `<div style="font-size:11px;color:#718096;margin-top:2px;">${escapeHtml(fund.code)}</div>` : ''}</td>
          <td>${ownerBadgeHtml(fund.ownerIds, membersById)}</td>
          <td>${escapeHtml(fund.category)}</td>
          <td>${escapeHtml(fund.currency)}</td>
          <td>${m.units.toFixed(4)}</td>
          <td>${formatNav(fund.nav)}</td>
          <td>${formatCurrency(m.currentValue, fund.currency)}</td>
          <td>${formatCurrency(m.invested, fund.currency)}</td>
          <td class="${plClass}">${m.pl >= 0 ? '+' : ''}${formatCurrency(m.pl, fund.currency)}</td>
          <td class="${plClass}">${m.returnPct.toFixed(2)}%</td>
          <td class="${plClass}">${m.annualised.toFixed(2)}%</td>
          <td>${m.yearsHeld}</td>
          <td><div class="tx-actions">
            <button class="icon-btn" title="Edit" data-action="openFundModal" data-stop="1" data-arg="${fund.id}">✏️</button>
            <button class="icon-btn" title="Delete" data-action="deleteFund" data-stop="1" data-arg="${fund.id}">🗑️</button>
          </div></td>
        </tr>`;
      }).join('');
      if (!multiCurrency) return rows;
      const t = groupTotals(groups[cur]);
      const statsText = `Value: ${formatCurrency(t.value, cur)} · Invested: ${formatCurrency(t.invested, cur)} · P/L: ${t.pl >= 0 ? '+' : ''}${formatCurrency(t.pl, cur)}`;
      return currencyGroupRowHtml(cur, groups[cur].length, idx, 13, statsText) + rows;
    }).join('') + `</tbody></table></div>`;
    return;
  }

  grid.className = 'fund-grid';
  grid.innerHTML = currencies.map((cur, idx) => {
    const cards = groups[cur].map(fund => {
      const m = calcFundMetrics(fund, transactions);
      const plClass = m.pl >= 0 ? 'positive' : 'negative';
      return `<div class="fund-card" data-action="showFundDetail" data-arg="${fund.id}">
        <div class="actions">
          <button class="icon-btn" title="Edit" data-action="openFundModal" data-stop="1" data-arg="${fund.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteFund" data-stop="1" data-arg="${fund.id}">🗑️</button>
        </div>
        <div class="fund-header">
          <div>
            <div class="fund-name">${escapeHtml(fund.name)}</div>
            <div style="font-size: 12px; color: #718096; margin-top: 4px;">${[fund.code, fund.category, fund.currency].filter(Boolean).map(escapeHtml).join(' | ')}</div>
            <div style="margin-top: 6px;">${ownerBadgeHtml(fund.ownerIds, membersById)}</div>
          </div>
        </div>
        <div class="fund-stats">
          <div class="stat"><div class="stat-label">Value</div><div class="stat-value">${formatCurrency(m.currentValue, fund.currency)}</div></div>
          <div class="stat"><div class="stat-label">Invested</div><div class="stat-value">${formatCurrency(m.invested, fund.currency)}</div></div>
          <div class="stat"><div class="stat-label">P/L</div><div class="stat-value ${plClass}">${m.pl >= 0 ? '+' : ''}${formatCurrency(m.pl, fund.currency)}</div></div>
          <div class="stat"><div class="stat-label">Return</div><div class="stat-value ${plClass}">${m.returnPct.toFixed(2)}%</div></div>
          <div class="stat"><div class="stat-label">Annualised</div><div class="stat-value ${plClass}">${m.annualised.toFixed(2)}%</div></div>
          <div class="stat"><div class="stat-label">Holding</div><div class="stat-value">${m.yearsHeld}</div></div>
        </div>
        <div style="font-size: 12px; color: #718096; margin-top: 8px;">NAV: ${formatNav(fund.nav)} | Units: ${m.units.toFixed(4)}</div>
      </div>`;
    }).join('');
    if (!multiCurrency) return cards;
    const t = groupTotals(groups[cur]);
    const statsText = `Value: ${formatCurrency(t.value, cur)} · Invested: ${formatCurrency(t.invested, cur)} · P/L: ${t.pl >= 0 ? '+' : ''}${formatCurrency(t.pl, cur)}`;
    return currencyGroupHeaderHtml(cur, groups[cur].length, idx, statsText) + cards;
  }).join('');
}

function showFundsList() {
  document.getElementById('funds-list-view').classList.remove('hidden');
  document.getElementById('fund-detail-view').classList.add('hidden');
  currentFundId = null;
}

async function showFundDetail(fundId) {
  currentFundId = fundId;
  const fund = await encGet('funds', fundId);
  if (!fund) return;
  const transactions = await encGetAll('transactions');
  const m = calcFundMetrics(fund, transactions);
  document.getElementById('funds-list-view').classList.add('hidden');
  document.getElementById('fund-detail-view').classList.remove('hidden');
  document.getElementById('detail-fund-name').textContent = fund.name;
  document.getElementById('detail-title').textContent = fund.name;
  const detailCodeEl = document.getElementById('detail-code');
  detailCodeEl.textContent = fund.code || '';
  detailCodeEl.style.display = fund.code ? 'block' : 'none';
  document.getElementById('detail-owner').innerHTML = ownerBadgeHtml(fund.ownerIds, await membersByIdMap());
  document.getElementById('detail-value').textContent = formatCurrency(m.currentValue, fund.currency);
  document.getElementById('detail-invested').textContent = formatCurrency(m.invested, fund.currency);
  document.getElementById('detail-pl').textContent = (m.pl >= 0 ? '+' : '') + formatCurrency(m.pl, fund.currency);
  document.getElementById('detail-pl').className = 'value ' + (m.pl >= 0 ? 'positive' : 'negative');
  document.getElementById('detail-return').textContent = m.returnPct.toFixed(2) + '%';
  document.getElementById('detail-return').className = 'value ' + (m.returnPct >= 0 ? 'positive' : 'negative');
  document.getElementById('detail-annualised').textContent = m.annualised.toFixed(2) + '%';
  document.getElementById('detail-annualised').className = 'value ' + (m.annualised >= 0 ? 'positive' : 'negative');
  document.getElementById('detail-units').textContent = m.units.toFixed(4);
  document.getElementById('detail-nav').textContent = formatNav(fund.nav);
  document.getElementById('detail-years').textContent = m.yearsHeld;
  // Transaction table
  const fundTx = transactions.filter(t => t.fundId === fundId).sort((a, b) => new Date(b.date) - new Date(a.date));
  const txTable = document.getElementById('detail-tx-table');
  if (fundTx.length === 0) {
    txTable.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#a0aec0;">No transactions yet</td></tr>';
  } else {
    txTable.innerHTML = fundTx.map(tx => `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(tx.type)}</span></td>
      <td>${tx.units ? escapeHtml(tx.units) : '-'}</td>
      <td>${tx.price ? formatCurrency(tx.price, fund.currency) : '-'}</td>
      <td>${formatCurrency(tx.amount, fund.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="editTransaction" data-arg="${tx.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteTransaction" data-arg="${tx.id}">🗑️</button>
      </div></td>
    </tr>`).join('');
  }
  // NAV history table
  const navHistoryRaw = await db.navHistory.where('fundId').equals(fundId).toArray();
  const navHistory = (await Promise.all(navHistoryRaw.map(decryptRecord))).sort((a, b) => new Date(a.date) - new Date(b.date));
  const navTable = document.getElementById('detail-nav-table');
  if (navHistory.length === 0) {
    navTable.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No NAV history yet</td></tr>';
  } else {
    navTable.innerHTML = navHistory.map((n, i) => {
      const prev = i > 0 ? navHistory[i-1].nav : n.nav;
      const change = n.nav - prev;
      const changePct = prev > 0 ? (change / prev * 100) : 0;
      const changeClass = change >= 0 ? 'positive' : 'negative';
      return `<tr><td>${escapeHtml(n.date)}</td><td>${formatNav(n.nav)}</td><td class="${changeClass}">${change >= 0 ? '+' : ''}${change.toFixed(4)}</td><td class="${changeClass}">${change >= 0 ? '+' : ''}${changePct.toFixed(2)}%</td></tr>`;
    }).join('');
  }
  // Fund timeline chart
  await renderFundTimelineChart(fund, fundTx, navHistory);
  await renderNavChart(fund, navHistory);
}

async function renderFundTimelineChart(fund, transactions, navHistory) {
  const ctx = document.getElementById('fundTimelineChart');
  if (!ctx) return;
  if (charts.fundTimeline) charts.fundTimeline.destroy();
  const allDates = [...new Set(transactions.map(t => t.date))].sort();
  if (allDates.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';
  const valueData = allDates.map(date => {
    const txUpToDate = transactions.filter(t => t.fundId === fund.id && t.date <= date);
    const units = txUpToDate.reduce((sum, t) => {
      if (t.type === 'Buy' || t.type === 'Contribution' || t.type === 'Dividend') return sum + (parseFloat(t.units) || 0);
      if (t.type === 'Sell') return sum - (parseFloat(t.units) || 0);
      return sum;
    }, 0);
    const navOnDate = navHistory.filter(n => n.date <= date).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const nav = navOnDate ? navOnDate.nav : fund.nav;
    return units * nav;
  });
  const unitsData = allDates.map(date => {
    const txUpToDate = transactions.filter(t => t.fundId === fund.id && t.date <= date);
    return txUpToDate.reduce((sum, t) => {
      if (t.type === 'Buy' || t.type === 'Contribution' || t.type === 'Dividend') return sum + (parseFloat(t.units) || 0);
      if (t.type === 'Sell') return sum - (parseFloat(t.units) || 0);
      return sum;
    }, 0);
  });
  charts.fundTimeline = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allDates,
      datasets: [
        { label: 'Fund Value', data: valueData, borderColor: '#667eea', backgroundColor: '#667eea20', fill: true, yAxisID: 'y', tension: 0.4 },
        { label: 'Units Held', data: unitsData, borderColor: '#48bb78', backgroundColor: '#48bb7820', fill: false, yAxisID: 'y1', tension: 0.4 }
      ]
    },
    options: {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Value (' + (fund.currency || '') + ')' }, ticks: { callback: v => formatCurrency(v, fund.currency) } },
        y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Units' }, grid: { drawOnChartArea: false } }
      },
      plugins: { tooltip: { callbacks: { label: function(context) { return context.dataset.label + ': ' + (context.dataset.yAxisID === 'y' ? formatCurrency(context.raw, fund.currency) : context.raw.toFixed(4)); } } } }
    }
  });
}

async function renderNavChart(fund, navHistory) {
  const ctx = document.getElementById('navChart');
  if (!ctx) return;
  if (charts.navChart) charts.navChart.destroy();
  const data = navHistory.filter(n => n.fundId === fund.id).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (data.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';
  charts.navChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(n => n.date),
      datasets: [{ label: 'NAV', data: data.map(n => n.nav), borderColor: '#ed8936', backgroundColor: '#ed893620', fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#ed8936' }]
    },
    options: {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      scales: { y: { beginAtZero: false, ticks: { callback: v => formatCurrency(v, fund.currency) } } },
      plugins: { tooltip: { callbacks: { label: function(context) { return 'NAV: ' + formatCurrency(context.raw, fund.currency); } } } }
    }
  });
}

// ==================== TRANSACTIONS ====================
async function renderTransactions() {
  const transactions = await encGetAll('transactions');
  const funds = await encGetAll('funds');
  const tbody = document.getElementById('all-tx-table');
  const empty = document.getElementById('tx-empty');
  if (transactions.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
  tbody.innerHTML = transactions.map(tx => {
    const fund = funds.find(f => f.id === tx.fundId);
    return `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td>${fund ? escapeHtml(fund.name) : 'Unknown'}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(tx.type)}</span></td>
      <td>${tx.units ? escapeHtml(tx.units) : '-'}</td>
      <td>${tx.price ? formatCurrency(tx.price, fund && fund.currency) : '-'}</td>
      <td>${formatCurrency(tx.amount, fund && fund.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="editTransaction" data-arg="${tx.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteTransaction" data-arg="${tx.id}">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

// ==================== NAV UPDATE ====================

async function renderClosedFunds() {
  let allFunds = await encGetAll('funds');
  const transactions = await encGetAll('transactions');
  const membersById = await membersByIdMap();
  if (closedOwnerFilter !== 'All') { const fid = parseInt(closedOwnerFilter); allFunds = allFunds.filter(f => (f.ownerIds || []).includes(fid)); }
  const closedFunds = allFunds.filter(f => !isFundActive(f, transactions));
  const container = document.getElementById('closed-funds-container');
  const empty = document.getElementById('closed-empty');
  let currentPL = 0, currentInvested = 0;
  let closedPL = 0, closedInvested = 0;
  for (const fund of allFunds) {
    const m = calcFundMetrics(fund, transactions);
    if (isFundActive(fund, transactions)) {
      currentPL += toBase(m.pl, fund.currency);
      currentInvested += toBase(m.invested, fund.currency);
    } else {
      closedPL += toBase(m.pl, fund.currency);
      closedInvested += toBase(m.invested, fund.currency);
    }
  }
  const totalPL = currentPL + closedPL;
  const totalInvested = currentInvested + closedInvested;
  const totalReturnPct = totalInvested > 0 ? (totalPL / totalInvested * 100) : 0;
  document.getElementById('summary-current-pl').textContent = (currentPL >= 0 ? '+' : '') + formatCurrency(currentPL);
  document.getElementById('summary-current-pl').className = 'value ' + (currentPL >= 0 ? 'positive' : 'negative');
  document.getElementById('summary-closed-pl').textContent = (closedPL >= 0 ? '+' : '') + formatCurrency(closedPL);
  document.getElementById('summary-closed-pl').className = 'value ' + (closedPL >= 0 ? 'positive' : 'negative');
  document.getElementById('summary-total-pl').textContent = (totalPL >= 0 ? '+' : '') + formatCurrency(totalPL);
  document.getElementById('summary-total-pl').className = 'value ' + (totalPL >= 0 ? 'positive' : 'negative');
  document.getElementById('summary-total-return').textContent = (totalReturnPct >= 0 ? '+' : '') + totalReturnPct.toFixed(2) + '%';
  document.getElementById('summary-total-return').className = 'value ' + (totalReturnPct >= 0 ? 'positive' : 'negative');
  if (closedFunds.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const closedData = closedFunds.map(fund => {
    const fundTx = transactions.filter(t => t.fundId === fund.id).sort((a, b) => new Date(a.date) - new Date(b.date));
    const invested = fundTx.reduce((sum, t) => { if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0); return sum; }, 0);
    const redeemed = fundTx.filter(t => t.type === 'Sell').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
    const divCheque = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
    const divReinvest = fundTx.filter(t => t.type === 'Dividend').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
    const realisedPL = redeemed + divCheque - invested;
    const returnPct = invested > 0 ? (realisedPL / invested * 100) : 0;
    const firstBuy = fundTx.find(t => t.type === 'Buy' || t.type === 'Contribution');
    const lastSell = fundTx.slice().reverse().find(t => t.type === 'Sell');
    let holdingPeriod = '-';
    if (firstBuy && lastSell) {
      const years = (new Date(lastSell.date) - new Date(firstBuy.date)) / (365.25 * 24 * 60 * 60 * 1000);
      holdingPeriod = years < 1 ? (years * 12).toFixed(1) + ' mths' : years.toFixed(1) + ' yrs';
    }
    return { fund, invested, redeemed, dividends: divCheque + divReinvest, realisedPL, returnPct, holdingPeriod, closedDate: lastSell ? lastSell.date : '-' };
  });

  const groups = {};
  closedData.forEach(d => {
    const cur = d.fund.currency || 'N/A';
    if (!groups[cur]) groups[cur] = [];
    groups[cur].push(d);
  });
  const currencies = Object.keys(groups).sort();
  const multiCurrency = currencies.length > 1;

  function groupTotals(items) {
    let invested = 0, redeemed = 0, dividends = 0, realisedPL = 0;
    items.forEach(d => { invested += d.invested; redeemed += d.redeemed; dividends += d.dividends; realisedPL += d.realisedPL; });
    return { invested, redeemed, dividends, realisedPL };
  }

  if (closedViewMode === 'card') {
    container.innerHTML = `<div class="fund-grid">` + currencies.map((cur, idx) => {
      const cards = groups[cur].map(d => {
        const plClass = d.realisedPL >= 0 ? 'positive' : 'negative';
        return `<div class="fund-card" data-action="showClosedFundDetail" data-arg="${d.fund.id}">
          <div class="actions">
            <button class="icon-btn" title="Edit" data-action="openFundModal" data-stop="1" data-arg="${d.fund.id}">✏️</button>
            <button class="icon-btn" title="Delete" data-action="deleteFund" data-stop="1" data-arg="${d.fund.id}">🗑️</button>
          </div>
          <div class="fund-header">
            <div>
              <div class="fund-name">${escapeHtml(d.fund.name)}</div>
              <div style="font-size: 12px; color: #718096; margin-top: 4px;">${[d.fund.code, d.fund.category].filter(Boolean).join(' | ')}</div>
              <div style="margin-top: 6px;">${ownerBadgeHtml(d.fund.ownerIds, membersById)}</div>
            </div>
          </div>
          <div class="fund-stats">
            <div class="stat"><div class="stat-label">Invested</div><div class="stat-value">${formatCurrency(d.invested, d.fund.currency)}</div></div>
            <div class="stat"><div class="stat-label">Redeemed</div><div class="stat-value">${formatCurrency(d.redeemed, d.fund.currency)}</div></div>
            <div class="stat"><div class="stat-label">Realised P/L</div><div class="stat-value ${plClass}">${d.realisedPL >= 0 ? '+' : ''}${formatCurrency(d.realisedPL, d.fund.currency)}</div></div>
            <div class="stat"><div class="stat-label">Return</div><div class="stat-value ${plClass}">${d.returnPct.toFixed(2)}%</div></div>
            <div class="stat"><div class="stat-label">Dividends</div><div class="stat-value">${formatCurrency(d.dividends, d.fund.currency)}</div></div>
            <div class="stat"><div class="stat-label">Holding</div><div class="stat-value">${d.holdingPeriod}</div></div>
          </div>
          <div style="font-size: 12px; color: #718096; margin-top: 8px;">Closed: ${escapeHtml(d.closedDate)}</div>
        </div>`;
      }).join('');
      if (!multiCurrency) return cards;
      const t = groupTotals(groups[cur]);
      const statsText = `Invested: ${formatCurrency(t.invested, cur)} · Realised P/L: ${t.realisedPL >= 0 ? '+' : ''}${formatCurrency(t.realisedPL, cur)}`;
      return currencyGroupHeaderHtml(cur, groups[cur].length, idx, statsText) + cards;
    }).join('') + `</div>`;
    return;
  }

  container.innerHTML = `<div class="table-scroll">
    <table>
      <thead><tr><th>Fund</th><th>Owner</th><th>Category</th><th>Total Invested</th><th>Total Redeemed</th><th>Dividends</th><th>Realised P/L</th><th>Return %</th><th>Holding Period</th><th>Closed Date</th><th>Actions</th></tr></thead>
      <tbody>` + currencies.map((cur, idx) => {
    const rows = groups[cur].map(d => {
      const plClass = d.realisedPL >= 0 ? 'positive' : 'negative';
      return `<tr>
        <td><a href="#" data-action="showClosedFundDetail" data-prevent="1" data-arg="${d.fund.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(d.fund.name)}</a>${d.fund.code ? `<div style="font-size:11px;color:#718096;margin-top:2px;">${escapeHtml(d.fund.code)}</div>` : ''}</td>
        <td>${ownerBadgeHtml(d.fund.ownerIds, membersById)}</td>
        <td>${escapeHtml(d.fund.category)}</td>
        <td>${formatCurrency(d.invested, d.fund.currency)}</td>
        <td>${formatCurrency(d.redeemed, d.fund.currency)}</td>
        <td>${formatCurrency(d.dividends, d.fund.currency)}</td>
        <td class="${plClass}">${d.realisedPL >= 0 ? '+' : ''}${formatCurrency(d.realisedPL, d.fund.currency)}</td>
        <td class="${plClass}">${d.returnPct.toFixed(2)}%</td>
        <td>${d.holdingPeriod}</td>
        <td>${escapeHtml(d.closedDate)}</td>
        <td><div class="tx-actions">
          <button class="icon-btn" title="Edit" data-action="openFundModal" data-arg="${d.fund.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteFund" data-arg="${d.fund.id}">🗑️</button>
        </div></td>
      </tr>`;
    }).join('');
    if (!multiCurrency) return rows;
    const t = groupTotals(groups[cur]);
    const statsText = `Invested: ${formatCurrency(t.invested, cur)} · Realised P/L: ${t.realisedPL >= 0 ? '+' : ''}${formatCurrency(t.realisedPL, cur)}`;
    return currencyGroupRowHtml(cur, groups[cur].length, idx, 11, statsText) + rows;
  }).join('') + `</tbody></table></div>`;
}

async function renderNavUpdateList() {
  if (navViewMode === 'history') { await renderNavHistoryLog(); return; }
  const allFunds = await encGetAll('funds');
  const transactions = await encGetAll('transactions');
  const funds = allFunds.filter(f => isFundActive(f, transactions));
  const container = document.getElementById('nav-update-list');
  if (funds.length === 0) { container.style.display = ''; container.innerHTML = '<p style="color:#a0aec0;">No active funds to update</p>'; return; }
  if (navViewMode === 'table') {
    container.style.display = '';
    container.style.gridTemplateColumns = '';
    container.style.gap = '';
    container.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Fund</th><th>Current NAV</th><th>New NAV</th></tr></thead>
      <tbody>` + funds.map(fund => `
      <tr>
        <td><strong>${escapeHtml(fund.name)}</strong>${fund.code ? `<div style="font-size:11px;color:#718096;margin-top:2px;">${escapeHtml(fund.code)}</div>` : ''}</td>
        <td>${formatNav(fund.nav)}</td>
        <td><input type="number" id="nav-${fund.id}" step="0.0001" value="${fund.nav}" placeholder="New NAV" style="width: 140px; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px;"></td>
      </tr>`).join('') + `</tbody></table></div>`;
    return;
  }
  container.style.display = 'grid';
  container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
  container.style.gap = '12px';
  container.innerHTML = funds.map(fund => `
    <div style="background: white; padding: 14px; border-radius: 10px; border: 1px solid #e2e8f0;">
      <div style="font-weight: 600; font-size: 14px; color: #2d3748; margin-bottom: 8px;">${escapeHtml(fund.name)}</div>
      <div style="font-size: 12px; color: #718096; margin-bottom: 10px;">Current: ${formatNav(fund.nav)}</div>
      <input type="number" id="nav-${fund.id}" step="0.0001" value="${fund.nav}" placeholder="New NAV" style="width: 100%; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px;">
    </div>
  `).join('');
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const year = String(d.getFullYear()).slice(-2);
  return day + '-' + month + '-' + year;
}

async function renderNavHistoryLog() {
  const funds = await encGetAll('funds');
  const navHistory = await encGetAll('navHistory');
  const container = document.getElementById('nav-update-list');
  container.style.display = '';
  container.style.gridTemplateColumns = '';
  container.style.gap = '';
  if (navHistory.length === 0) {
    container.innerHTML = '<p style="color:#a0aec0;">No NAV history recorded yet — history builds up as you use Update All Prices.</p>';
    return;
  }
  // Only show funds that actually have recorded history, kept in their original (creation) order
  const fundIdsWithHistory = new Set(navHistory.map(h => h.fundId));
  const cols = funds.filter(f => fundIdsWithHistory.has(f.id));
  // Pivot: date -> fundId -> latest entry for that date
  const byDate = {};
  navHistory.forEach(h => {
    if (!byDate[h.date]) byDate[h.date] = {};
    const existing = byDate[h.date][h.fundId];
    if (!existing || (h.createdAt && (!existing.createdAt || h.createdAt > existing.createdAt))) {
      byDate[h.date][h.fundId] = h;
    }
  });
  const dates = Object.keys(byDate).sort((a, b) => new Date(a) - new Date(b));
  container.innerHTML = `
    <div style="background: white; border-radius: 12px; border: 1px solid #cbd5e0; overflow: hidden;">
      <div style="padding: 16px 20px; font-size: 16px; font-weight: 700; color: #2d3748; border-bottom: 1px solid #e2e8f0;">📜 Historical NAV / Unit Price Log</div>
      <div class="table-scroll">
        <table style="table-layout: auto;">
          <thead><tr>
            <th style="background: #667eea; color: white;">No.</th>
            <th style="background: #667eea; color: white;">Date</th>
            ${cols.map(f => `<th style="background: #667eea; color: white; white-space: normal; min-width: 90px; line-height: 1.3;">${escapeHtml(f.name)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${dates.map((date, i) => `<tr style="background: ${i % 2 === 0 ? '#eef1fc' : 'white'};">
              <td style="font-weight: 600; color: #718096;">${i + 1}</td>
              <td style="font-weight: 600;">${formatDateShort(date)}</td>
              ${cols.map(f => {
                const entry = byDate[date][f.id];
                return `<td class="nowrap">${entry ? parseFloat(entry.nav).toFixed(4) : '-'}</td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function updateAllNav() {
  const date = document.getElementById('nav-date').value;
  if (!date) { showToast('Please select a date'); return; }
  const funds = await encGetAll('funds');
  let updated = 0;
  for (const fund of funds) {
    const input = document.getElementById('nav-' + fund.id);
    if (!input) continue;
    const nav = parseFloat(input.value);
    if (isNaN(nav) || nav <= 0) continue;
    await encUpdate('funds', fund.id, { nav: nav });
    await encAdd('navHistory', { fundId: fund.id, date: date, nav: nav, createdAt: new Date() });
    updated++;
  }
  showToast(updated + ' fund(s) NAV updated');
  await renderDashboard();
  await renderFunds();
  await renderNavUpdateList();
  if (currentFundId) await showFundDetail(currentFundId);
}

// ==================== MODALS ====================
async function openFundModal(fundId) {
  document.getElementById('fundModalTitle').textContent = fundId ? 'Edit Fund' : 'Add Fund';
  document.getElementById('fundId').value = fundId || '';
  if (fundId) {
    const fund = await encGet('funds', fundId);
    document.getElementById('fundName').value = fund.name;
    document.getElementById('fundCode').value = fund.code || '';
    document.getElementById('fundCategory').value = fund.category;
    document.getElementById('fundCurrency').value = fund.currency;
    document.getElementById('fundNav').value = fund.nav;
    await renderOwnerCheckboxes('fundOwnersList', fund.ownerIds || []);
  } else {
    document.getElementById('fundName').value = '';
    document.getElementById('fundCode').value = '';
    document.getElementById('fundCategory').value = 'Equity';
    document.getElementById('fundCurrency').value = 'USD';
    document.getElementById('fundNav').value = '';
    await renderOwnerCheckboxes('fundOwnersList', []);
  }
  document.getElementById('fundModal').classList.add('active');
}

function closeFundModal() { document.getElementById('fundModal').classList.remove('active'); }

async function openCurrencyModal() {
  const currencies = await getDistinctFundCurrencies();
  const base = getBaseCurrency();
  const rates = getExchangeRates();
  // Base currency dropdown: fund currencies plus the current base (in case it's not used by any fund yet) plus common defaults
  const options = Array.from(new Set([...currencies, base, 'USD', 'MYR', 'SGD', 'EUR', 'GBP'])).sort();
  const baseSelect = document.getElementById('baseCurrencySelect');
  baseSelect.innerHTML = options.map(c => `<option value="${c}" ${c === base ? 'selected' : ''}>${c}</option>`).join('');
  baseSelect.onchange = renderExchangeRatesInputs;
  renderExchangeRatesInputs();
  document.getElementById('currencyModal').classList.add('active');
}

async function renderExchangeRatesInputs() {
  const currencies = await getDistinctFundCurrencies();
  const base = document.getElementById('baseCurrencySelect').value;
  const rates = getExchangeRates();
  const others = currencies.filter(c => c !== base);
  const list = document.getElementById('exchangeRatesList');
  if (others.length === 0) {
    list.innerHTML = '<p style="color:#a0aec0;font-size:13px;">All your funds are already in the base currency — no exchange rates needed.</p>';
    return;
  }
  list.innerHTML = others.map(c => `
    <div class="form-group">
      <label>1 ${c} = ? ${base}</label>
      <input type="number" step="0.0001" min="0" id="rate-${c}" value="${rates[c] || ''}" placeholder="e.g. 4.7000">
    </div>
  `).join('');
}

function closeCurrencyModal() { document.getElementById('currencyModal').classList.remove('active'); }

async function openMembersModal() {
  await renderMembersList();
  document.getElementById('membersModal').classList.add('active');
}
function closeMembersModal() {
  document.getElementById('membersModal').classList.remove('active');
  // Refresh anything that displays owner info, in case names/list changed
  renderFunds();
  renderClosedFunds();
  renderFundsOwnerFilterOptions();
  renderClosedOwnerFilterOptions();
  renderDashOwnerFilterOptions().then(() => renderDashboard());
  if (typeof renderAmanahAll === 'function') renderAmanahAll();
  if (typeof renderKwspAll === 'function') renderKwspAll();
  if (typeof renderFdAll === 'function') renderFdAll();
  if (typeof renderFxAll === 'function') renderFxAll();
}

async function renderMembersList() {
  const members = await getMembers();
  const list = document.getElementById('membersList');
  if (members.length === 0) {
    list.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No members yet — add the people who hold funds below.</p>';
    return;
  }
  list.innerHTML = members.map(m => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;">
      <span style="width:10px;height:10px;border-radius:50%;background:${memberColor(m.id)};flex-shrink:0;"></span>
      <input type="text" value="${escapeHtml(m.name)}" id="member-name-${m.id}" style="flex:1;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;" data-action="renameMember" data-arg="${m.id}">
      <button class="icon-btn" title="Delete" data-action="deleteMember" data-arg="${m.id}" data-arg2="${escapeHtml(m.name)}">🗑️</button>
    </div>
  `).join('');
}

async function addMember() {
  const input = document.getElementById('newMemberName');
  const name = input.value.trim();
  if (!name) { showToast('Enter a name first'); return; }
  await encAdd('members', { name, createdAt: new Date() });
  input.value = '';
  await renderMembersList();
  showToast('Member added');
}

async function renameMember(id, name) {
  name = name.trim();
  if (!name) { await renderMembersList(); return; }
  await encUpdate('members', id, { name });
  showToast('Member renamed');
}

async function deleteMember(id, name) {
  if (!confirm('Remove "' + name + '"? Funds owned by them will become unassigned (not deleted).')) return;
  await db.members.delete(id);
  const funds = await encGetAll('funds');
  for (const fund of funds) {
    if (fund.ownerIds && fund.ownerIds.includes(id)) {
      await encUpdate('funds', fund.id, { ownerIds: fund.ownerIds.filter(oid => oid !== id) });
    }
  }
  const amanahFunds = await encGetAll('amanahFunds');
  for (const fund of amanahFunds) {
    if (fund.ownerIds && fund.ownerIds.includes(id)) {
      await encUpdate('amanahFunds', fund.id, { ownerIds: fund.ownerIds.filter(oid => oid !== id) });
    }
  }
  const kwspAccounts = await encGetAll('kwspAccounts');
  for (const acct of kwspAccounts) {
    if (acct.ownerIds && acct.ownerIds.includes(id)) {
      await encUpdate('kwspAccounts', acct.id, { ownerIds: acct.ownerIds.filter(oid => oid !== id) });
    }
  }
  const fixedDeposits = await encGetAll('fixedDeposits');
  for (const fd of fixedDeposits) {
    if (fd.ownerIds && fd.ownerIds.includes(id)) {
      await encUpdate('fixedDeposits', fd.id, { ownerIds: fd.ownerIds.filter(oid => oid !== id) });
    }
  }
  const fxTransactions = await encGetAll('fxTransactions');
  for (const tx of fxTransactions) {
    if (tx.ownerIds && tx.ownerIds.includes(id)) {
      await encUpdate('fxTransactions', tx.id, { ownerIds: tx.ownerIds.filter(oid => oid !== id) });
    }
  }
  await renderMembersList();
  showToast('Member removed');
  if (typeof renderKwspAll === 'function') await renderKwspAll();
  if (typeof renderFdAll === 'function') await renderFdAll();
  if (typeof renderFxAll === 'function') await renderFxAll();
  if (typeof renderWealthAll === 'function') await renderWealthAll();
}

async function openPrintOwnerModal(reportType) {
  reportType = reportType || 'unittrust';
  const members = await getMembers();
  const container = document.getElementById('printOwnerButtons');
  const titles = { unittrust: 'Print Portfolio Summary', amanah: 'Print Amanah Saham Report', kwsp: 'Print KWSP Report', fd: 'Print Fixed Deposit Report', fx: 'Print Foreign Currency Report' };
  const allLabels = { unittrust: '👥 All Funds', amanah: '👥 All Schemes', kwsp: '👥 All Accounts', fd: '👥 All Deposits', fx: '👥 All Currencies' };
  document.getElementById('printOwnerModalTitle').textContent = titles[reportType];
  const allLabel = allLabels[reportType];
  let html = `<button class="btn btn-primary" style="justify-content:flex-start;" data-action="closeAndPrint" data-report-type="${reportType}" data-arg="All">${allLabel}</button>`;
  html += members.map(m => `<button class="btn btn-secondary" style="justify-content:flex-start;" data-action="closeAndPrint" data-report-type="${reportType}" data-arg="${m.id}">👤 ${escapeHtml(m.name)} Only</button>`).join('');
  container.innerHTML = html;
  document.getElementById('printOwnerModal').classList.add('active');
}
function closePrintOwnerModal() { document.getElementById('printOwnerModal').classList.remove('active'); }

async function fetchLiveRates() {
  const base = document.getElementById('baseCurrencySelect').value;
  const currencies = await getDistinctFundCurrencies();
  const others = currencies.filter(c => c !== base);
  const statusEl = document.getElementById('fetchRatesStatus');
  const btn = document.getElementById('fetchRatesBtn');
  if (others.length === 0) {
    statusEl.textContent = 'No other currencies to fetch — all your funds are already in the base currency.';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Fetching latest rates…';
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/' + encodeURIComponent(base));
    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
    const data = await res.json();
    if (data.result !== 'success' || !data.rates) throw new Error('Unexpected response');
    let filled = 0;
    others.forEach(c => {
      // API gives "1 base = X units of c"; our rate convention is "1 c = ? base", so invert
      const rate = data.rates[c];
      if (rate && rate > 0) {
        const input = document.getElementById('rate-' + c);
        if (input) { input.value = (1 / rate).toFixed(4); filled++; }
      }
    });
    const missed = others.length - filled;
    statusEl.textContent = '✅ Filled ' + filled + ' rate' + (filled !== 1 ? 's' : '') + ' as of ' + (data.time_last_update_utc || 'just now') + '.' + (missed > 0 ? ' ' + missed + ' currenc' + (missed !== 1 ? 'ies' : 'y') + ' not found — enter manually.' : '') + ' Review and click Save to apply.';
  } catch (err) {
    statusEl.textContent = '⚠️ Could not fetch live rates (' + err.message + '). Check your internet connection, or enter rates manually below.';
  } finally {
    btn.disabled = false;
  }
}

async function saveCurrencySettings() {
  const base = document.getElementById('baseCurrencySelect').value;
  const currencies = await getDistinctFundCurrencies();
  const others = currencies.filter(c => c !== base);
  const rates = getExchangeRates();
  others.forEach(c => {
    const input = document.getElementById('rate-' + c);
    if (input) {
      const v = parseFloat(input.value);
      if (!isNaN(v) && v > 0) rates[c] = v; else delete rates[c];
    }
  });
  setBaseCurrency(base);
  setExchangeRates(rates);
  closeCurrencyModal();
  showToast('Currency settings saved');
  updateCurrencyNavBtn();
  await renderDashboard();
  await renderFunds();
  await renderClosedFunds();
  if (typeof renderFxAll === 'function') await renderFxAll();
}

function updateCurrencyNavBtn() {
  const btn = document.getElementById('currencyNavBtn');
  if (btn) btn.textContent = currencyFlag(getBaseCurrency()) + ' ' + getBaseCurrency();
}

async function saveFund() {
  const id = document.getElementById('fundId').value;
  const data = {
    name: document.getElementById('fundName').value,
    code: document.getElementById('fundCode').value,
    category: document.getElementById('fundCategory').value,
    currency: document.getElementById('fundCurrency').value,
    ownerIds: getCheckedOwnerIds('fundOwnersList'),
    nav: parseFloat(document.getElementById('fundNav').value) || 0
  };
  if (!data.name) { showToast('Please fill in fund name'); return; }
  if (id) {
    await encUpdate('funds', parseInt(id), data);
    showToast('Fund updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('funds', data);
    showToast('Fund added!');
  }
  closeFundModal();
  await renderFunds();
  await renderDashboard();
  await renderNavUpdateList();
  await renderClosedFunds();
}

async function deleteFund(fundId) {
  if (!confirm('Delete this fund and all its transactions?')) return;
  await db.transactions.where('fundId').equals(fundId).delete();
  await db.navHistory.where('fundId').equals(fundId).delete();
  await db.funds.delete(fundId);
  showToast('Fund deleted');
  await renderFunds();
  await renderDashboard();
  await renderNavUpdateList();
  await renderClosedFunds();
  showFundsList();
}

function deleteCurrentFund() { if (currentFundId) deleteFund(currentFundId); }

async function openTxModal(fundId, txId) {
  const funds = await encGetAll('funds');
  const select = document.getElementById('txFundSelect');
  select.innerHTML = funds.map(f => `<option value="${f.id}">${escapeHtml(f.name)} (${escapeHtml(f.code)})</option>`).join('');
  document.getElementById('txModalTitle').textContent = txId ? 'Edit Transaction' : 'Add Transaction';
  document.getElementById('txId').value = txId || '';
  if (txId) {
    const tx = await encGet('transactions', parseInt(txId));
    document.getElementById('txFundSelect').value = tx.fundId;
    document.getElementById('txType').value = tx.type;
    document.getElementById('txDate').value = tx.date;
    document.getElementById('txUnits').value = tx.units || '';
    document.getElementById('txPrice').value = tx.price || '';
    document.getElementById('txAmount').value = tx.amount || '';
    document.getElementById('txNotes').value = tx.notes || '';
    // 验证：如果三个值都有，检查 Price 是否正确（Units * Price 应该 ≈ Amount）
    const u = parseFloat(tx.units) || 0;
    const p = parseFloat(tx.price) || 0;
    const a = parseFloat(tx.amount) || 0;
    if (u > 0 && p > 0 && a > 0) {
      const calculated = u * p;
      // 如果偏差超过 0.05，用 Amount/Units 重新计算 Price
      if (Math.abs(calculated - a) > 0.05) {
        document.getElementById('txPrice').value = (a / u).toFixed(4);
      }
    }
  } else {
    document.getElementById('txFundSelect').value = fundId || (funds.length > 0 ? funds[0].id : '');
    document.getElementById('txType').value = 'Buy';
    document.getElementById('txDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('txUnits').value = '';
    document.getElementById('txPrice').value = '';
    document.getElementById('txAmount').value = '';
    document.getElementById('txNotes').value = '';
  }
  onTxTypeChange();
  document.getElementById('txModal').classList.add('active');
}

function openTxModalForCurrentFund() { if (currentFundId) openTxModal(currentFundId); }
function closeTxModal() { document.getElementById('txModal').classList.remove('active'); }

function onTxTypeChange() {
  const type = document.getElementById('txType').value;
  const unitsInput = document.getElementById('txUnits');
  const priceInput = document.getElementById('txPrice');
  if (type === 'Dividend Cheque') {
    unitsInput.value = 0; unitsInput.disabled = true;
    priceInput.value = 0; priceInput.disabled = true;
  } else {
    unitsInput.disabled = false; priceInput.disabled = false;
  }
}

let lastEditedField = null;

function autoCalcTx(field) {
  if (field) lastEditedField = field;
  const units = parseFloat(document.getElementById('txUnits').value) || 0;
  const price = parseFloat(document.getElementById('txPrice').value) || 0;
  const amount = parseFloat(document.getElementById('txAmount').value) || 0;
  const type = document.getElementById('txType').value;
  if (type === 'Dividend Cheque') return;

  // 策略：基于最后编辑的字段，计算第三个字段
  // 如果三个都有值，优先根据最后编辑的字段重新计算被修改的关联字段
  if (lastEditedField === 'units' && price > 0) {
    document.getElementById('txAmount').value = (units * price).toFixed(2);
  } else if (lastEditedField === 'price' && units > 0) {
    document.getElementById('txAmount').value = (units * price).toFixed(2);
  } else if (lastEditedField === 'amount' && units > 0) {
    document.getElementById('txPrice').value = (amount / units).toFixed(4);
  } else if (lastEditedField === 'amount' && price > 0) {
    document.getElementById('txUnits').value = (amount / price).toFixed(4);
  } else if (lastEditedField === 'units' && amount > 0) {
    document.getElementById('txPrice').value = (amount / units).toFixed(4);
  } else if (lastEditedField === 'price' && amount > 0) {
    document.getElementById('txUnits').value = (amount / price).toFixed(4);
  }
  // 回退逻辑：如果只有两个字段有值
  else if (units && price && !amount) document.getElementById('txAmount').value = (units * price).toFixed(2);
  else if (units && amount && !price) document.getElementById('txPrice').value = (amount / units).toFixed(4);
  else if (price && amount && !units) document.getElementById('txUnits').value = (amount / price).toFixed(4);
}

async function saveTransaction() {
  const id = document.getElementById('txId').value;
  const data = {
    fundId: parseInt(document.getElementById('txFundSelect').value),
    type: document.getElementById('txType').value,
    date: document.getElementById('txDate').value,
    units: parseFloat(document.getElementById('txUnits').value) || 0,
    price: parseFloat(document.getElementById('txPrice').value) || 0,
    amount: parseFloat(document.getElementById('txAmount').value) || 0,
    notes: document.getElementById('txNotes').value
  };
  if (!data.fundId || !data.date) { showToast('Please select fund and date'); return; }
  if (id) {
    await encUpdate('transactions', parseInt(id), data);
    showToast('Transaction updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('transactions', data);
    showToast('Transaction added!');
  }
  closeTxModal();
  await renderTransactions();
  await renderFunds();
  await renderDashboard();
  await renderClosedFunds();
  if (currentFundId) await showFundDetail(currentFundId);
}

async function editTransaction(txId) { await openTxModal(null, txId); }

async function deleteTransaction(txId) {
  if (!confirm('Delete this transaction?')) return;
  await db.transactions.delete(txId);
  showToast('Transaction deleted');
  await renderTransactions();
  await renderFunds();
  await renderDashboard();
  await renderClosedFunds();
  if (currentFundId) await showFundDetail(currentFundId);
}


// ==================== CLOSED FUND DETAIL MODAL ====================
let currentClosedFundId = null;

async function showClosedFundDetail(fundId) {
  currentClosedFundId = fundId;
  const fund = await encGet('funds', fundId);
  if (!fund) return;
  const transactions = await encGetAll('transactions');
  const fundTx = transactions.filter(t => t.fundId === fundId).sort((a, b) => new Date(a.date) - new Date(b.date));

  document.getElementById('closedFundModalTitle').textContent = fund.name + (fund.code ? ' (' + fund.code + ')' : '') + ' — Closed Fund';
  document.getElementById('closedFundModalOwner').innerHTML = ownerBadgeHtml(fund.ownerIds, await membersByIdMap());

  const invested = fundTx.reduce((sum, t) => { if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0); return sum; }, 0);
  const redeemed = fundTx.filter(t => t.type === 'Sell').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const divCheque = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const divReinvest = fundTx.filter(t => t.type === 'Dividend').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const realisedPL = redeemed + divCheque - invested;
  const returnPct = invested > 0 ? (realisedPL / invested * 100) : 0;

  const firstBuy = fundTx.find(t => t.type === 'Buy' || t.type === 'Contribution');
  const lastSell = fundTx.slice().reverse().find(t => t.type === 'Sell');
  let holdingPeriod = '-';
  if (firstBuy && lastSell) {
    const years = (new Date(lastSell.date) - new Date(firstBuy.date)) / (365.25 * 24 * 60 * 60 * 1000);
    holdingPeriod = years < 1 ? (years * 12).toFixed(1) + ' mths' : years.toFixed(1) + ' yrs';
  }

  document.getElementById('cf-invested').textContent = formatCurrency(invested, fund.currency);
  document.getElementById('cf-redeemed').textContent = formatCurrency(redeemed, fund.currency);
  document.getElementById('cf-dividends').textContent = formatCurrency(divCheque + divReinvest, fund.currency);
  document.getElementById('cf-pl').textContent = (realisedPL >= 0 ? '+' : '') + formatCurrency(realisedPL, fund.currency);
  document.getElementById('cf-pl').className = 'value ' + (realisedPL >= 0 ? 'positive' : 'negative');
  document.getElementById('cf-return').textContent = (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%';
  document.getElementById('cf-return').className = 'value ' + (returnPct >= 0 ? 'positive' : 'negative');
  document.getElementById('cf-holding').textContent = holdingPeriod;

  const txTable = document.getElementById('cf-tx-table');
  if (fundTx.length === 0) {
    txTable.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#a0aec0;">No transactions</td></tr>';
  } else {
    txTable.innerHTML = fundTx.map(tx => `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(tx.type)}</span></td>
      <td>${tx.units ? escapeHtml(tx.units) : '-'}</td>
      <td>${tx.price ? formatCurrency(tx.price, fund.currency) : '-'}</td>
      <td>${formatCurrency(tx.amount, fund.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
    </tr>`).join('');
  }

  document.getElementById('closedFundModal').classList.add('active');
}

function closeClosedFundModal() {
  document.getElementById('closedFundModal').classList.remove('active');
  currentClosedFundId = null;
}

function editClosedFundFromModal() {
  const fundId = currentClosedFundId;
  closeClosedFundModal();
  openFundModal(fundId);
}

async function deleteClosedFundFromModal() {
  if (!currentClosedFundId) return;
  const fundId = currentClosedFundId;
  if (!confirm('Delete this fund and all its transactions?')) return;
  await db.transactions.where('fundId').equals(fundId).delete();
  await db.navHistory.where('fundId').equals(fundId).delete();
  await db.funds.delete(fundId);
  showToast('Fund deleted');
  closeClosedFundModal();
  await renderClosedFunds();
  await renderFunds();
  await renderDashboard();
  await renderNavUpdateList();
}

// ==================== EXPORT / IMPORT ====================
function openExportModal() {
  document.getElementById('exportEncryptToggle').checked = true;
  document.getElementById('exportPasscode1').value = '';
  document.getElementById('exportPasscode2').value = '';
  document.getElementById('exportModalStatus').textContent = '';
  onExportEncryptToggleChange();
  document.getElementById('exportModal').classList.add('active');
}
function closeExportModal() {
  document.getElementById('exportModal').classList.remove('active');
  // Same reasoning as closeEncryptionModal: clear on every close, not just
  // on open, so a leftover passcode never lingers in the DOM for Chrome's
  // password-save heuristic to pick up later.
  document.getElementById('exportPasscode1').value = '';
  document.getElementById('exportPasscode2').value = '';
}

function onExportEncryptToggleChange() {
  const encrypt = document.getElementById('exportEncryptToggle').checked;
  document.getElementById('exportPasscodeFields').classList.toggle('hidden', !encrypt);
  document.getElementById('exportWarningNote').classList.toggle('hidden', encrypt);
}

async function confirmExport() {
  const status = document.getElementById('exportModalStatus');
  const encrypt = document.getElementById('exportEncryptToggle').checked;
  const funds = await encGetAll('funds');
  const transactions = await encGetAll('transactions');
  const navHistory = await encGetAll('navHistory');
  const members = await encGetAll('members');
  const amanahFunds = await encGetAll('amanahFunds');
  const amanahTransactions = await encGetAll('amanahTransactions');
  const kwspAccounts = await encGetAll('kwspAccounts');
  const kwspTransactions = await encGetAll('kwspTransactions');
  const fixedDeposits = await encGetAll('fixedDeposits');
  const fdMaturityRecords = await encGetAll('fdMaturityRecords');
  const fdInterestPayouts = await encGetAll('fdInterestPayouts');
  const realEstateProperties = await encGetAll('realEstateProperties');
  const realEstateTx = await encGetAll('realEstateTx');
  const realEstateLoanTx = await encGetAll('realEstateLoanTx');
  const fxTransactions = await encGetAll('fxTransactions');
  const wealthSnapshots = await encGetAll('wealthSnapshots');
  const incomeForecasts = await encGetAll('incomeForecasts');
  const mypFunds = await encGetAll('mypFunds');
  const mypFundRules = await encGetAll('mypFundRules');
  const mypPlans = await encGetAll('mypPlans');
  const mypIncomeCategories = await encGetAll('mypIncomeCategories');
  const mypIncomeRanges = await encGetAll('mypIncomeRanges');
  const mypExpenseCategories = await encGetAll('mypExpenseCategories');
  const mypExpenseRanges = await encGetAll('mypExpenseRanges');
  const mypBaselines = await encGetAll('mypBaselines');
  const mypBaselineValues = await encGetAll('mypBaselineValues');
  const mypActuals = await encGetAll('mypActuals');
  const mypSavedForecasts = await encGetAll('mypSavedForecasts');
  const data = { funds, transactions, navHistory, members, amanahFunds, amanahTransactions, kwspAccounts, kwspTransactions, fixedDeposits, fdMaturityRecords, fdInterestPayouts, realEstateProperties, realEstateTx, realEstateLoanTx, fxTransactions, wealthSnapshots, incomeForecasts, mypPlans, mypFunds, mypFundRules, mypIncomeCategories, mypIncomeRanges, mypExpenseCategories, mypExpenseRanges, mypBaselines, mypBaselineValues, mypActuals, mypSavedForecasts, exportDate: new Date().toISOString() };

  let outputBlob, filenameSuffix = '';
  if (encrypt) {
    const p1 = document.getElementById('exportPasscode1').value;
    const p2 = document.getElementById('exportPasscode2').value;
    if (!p1 || p1.length < 6) { status.textContent = '⚠️ Passcode must be at least 6 characters.'; status.style.color = '#dd6b20'; return; }
    if (p1 !== p2) { status.textContent = '⚠️ Passcodes do not match.'; status.style.color = '#dd6b20'; return; }
    status.textContent = 'Encrypting backup...';
    status.style.color = '#718096';
    try {
      const { key, saltB64, iterations } = await deriveEncryptionKey(p1, null);
      const canary = await encryptValue(key, ENC_CANARY_PLAINTEXT);
      const payload = await encryptValue(key, data);
      const wrapped = { encrypted: true, salt: saltB64, iterations, canary, payload, exportDate: data.exportDate };
      outputBlob = new Blob([JSON.stringify(wrapped, null, 2)], { type: 'application/json' });
      filenameSuffix = '-encrypted';
    } catch (e) {
      status.textContent = '❌ Something went wrong: ' + e.message;
      status.style.color = '#e53e3e';
      return;
    }
  } else {
    outputBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  }
  const url = URL.createObjectURL(outputBlob);
  const a = document.createElement('a');
  a.href = url; a.download = 'wealth-planner-data-' + new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0') + '-' + String(new Date().getDate()).padStart(2,'0') + filenameSuffix + '.json';
  a.click(); URL.revokeObjectURL(url);
  try { localStorage.setItem('utt-last-export', new Date().toISOString()); } catch (e) { /* private browsing - ignore */ }
  closeExportModal();
  showToast(encrypt ? '🔒 Encrypted backup exported!' : '⚠️ Plaintext backup exported!');
}

let pendingImportEncryptedData = null;

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const raw = JSON.parse(e.target.result);
      if (raw.encrypted === true) {
        pendingImportEncryptedData = raw;
        document.getElementById('importBackupPasscode').value = '';
        document.getElementById('importPasscodeStatus').textContent = '';
        document.getElementById('importPasscodeModal').classList.add('active');
        return;
      }
      await applyImportedData(raw);
    } catch (err) { showToast('Import failed: ' + err.message); }
  };
  reader.readAsText(file);
  input.value = '';
}

function closeImportPasscodeModal() {
  document.getElementById('importPasscodeModal').classList.remove('active');
  pendingImportEncryptedData = null;
  // Same reasoning as closeEncryptionModal/closeExportModal.
  document.getElementById('importBackupPasscode').value = '';
}

async function confirmImportPasscode() {
  const passcode = document.getElementById('importBackupPasscode').value;
  const status = document.getElementById('importPasscodeStatus');
  if (!passcode) { status.textContent = 'Enter the passcode.'; return; }
  status.textContent = 'Decrypting...';
  status.style.color = '#718096';
  try {
    // Older backup files (exported before this field existed) don't have `iterations`
    // recorded — those were derived with the old 250,000-iteration default.
    const backupIterations = pendingImportEncryptedData.iterations || PBKDF2_ITERATIONS_LEGACY;
    const { key } = await deriveEncryptionKey(passcode, pendingImportEncryptedData.salt, backupIterations);
    const canaryCheck = await decryptValue(key, pendingImportEncryptedData.canary);
    if (canaryCheck !== ENC_CANARY_PLAINTEXT) throw new Error('wrong passcode');
    const data = await decryptValue(key, pendingImportEncryptedData.payload);
    document.getElementById('importPasscodeModal').classList.remove('active');
    pendingImportEncryptedData = null;
    document.getElementById('importBackupPasscode').value = '';
    await applyImportedData(data);
  } catch (e) {
    status.textContent = '❌ Incorrect passcode.';
    status.style.color = '#e53e3e';
  }
}

async function applyImportedData(data) {
  try {
    // Imported JSON is always plaintext-shaped by this point (decrypted already, if it was encrypted).
    // If app-level encryption is currently active, encBulkAdd re-encrypts each record on the way in.
    if (data.funds) { await db.funds.clear(); await encBulkAdd('funds', data.funds); }
    if (data.transactions) { await db.transactions.clear(); await encBulkAdd('transactions', data.transactions); }
    if (data.navHistory) { await db.navHistory.clear(); await encBulkAdd('navHistory', data.navHistory); }
    if (data.members) { await db.members.clear(); await encBulkAdd('members', data.members); }
    if (data.amanahFunds) { await db.amanahFunds.clear(); await encBulkAdd('amanahFunds', data.amanahFunds); }
    if (data.amanahTransactions) { await db.amanahTransactions.clear(); await encBulkAdd('amanahTransactions', data.amanahTransactions); }
    if (data.kwspAccounts) { await db.kwspAccounts.clear(); await encBulkAdd('kwspAccounts', data.kwspAccounts); }
    if (data.kwspTransactions) { await db.kwspTransactions.clear(); await encBulkAdd('kwspTransactions', data.kwspTransactions); }
    if (data.fixedDeposits) { await db.fixedDeposits.clear(); await encBulkAdd('fixedDeposits', data.fixedDeposits); }
    if (data.fdMaturityRecords) { await db.fdMaturityRecords.clear(); await encBulkAdd('fdMaturityRecords', data.fdMaturityRecords); }
    if (data.fdInterestPayouts) { await db.fdInterestPayouts.clear(); await encBulkAdd('fdInterestPayouts', data.fdInterestPayouts); }
    if (data.realEstateProperties) { await db.realEstateProperties.clear(); await encBulkAdd('realEstateProperties', data.realEstateProperties); }
    if (data.realEstateTx) { await db.realEstateTx.clear(); await encBulkAdd('realEstateTx', data.realEstateTx); }
    if (data.realEstateLoanTx) { await db.realEstateLoanTx.clear(); await encBulkAdd('realEstateLoanTx', data.realEstateLoanTx); }
    if (data.fxTransactions) { await db.fxTransactions.clear(); await encBulkAdd('fxTransactions', data.fxTransactions); }
    if (data.wealthSnapshots) { await db.wealthSnapshots.clear(); await encBulkAdd('wealthSnapshots', data.wealthSnapshots); }
    if (data.incomeForecasts) { await db.incomeForecasts.clear(); await encBulkAdd('incomeForecasts', data.incomeForecasts); }
    if (data.mypFunds) { await db.mypFunds.clear(); await encBulkAdd('mypFunds', data.mypFunds); }
    if (data.mypFundRules) { await db.mypFundRules.clear(); await encBulkAdd('mypFundRules', data.mypFundRules); }
    if (data.mypPlans) { await db.mypPlans.clear(); await encBulkAdd('mypPlans', data.mypPlans); }
    if (data.mypIncomeCategories) { await db.mypIncomeCategories.clear(); await encBulkAdd('mypIncomeCategories', data.mypIncomeCategories); }
    if (data.mypIncomeRanges) { await db.mypIncomeRanges.clear(); await encBulkAdd('mypIncomeRanges', data.mypIncomeRanges); }
    if (data.mypExpenseCategories) { await db.mypExpenseCategories.clear(); await encBulkAdd('mypExpenseCategories', data.mypExpenseCategories); }
    if (data.mypExpenseRanges) { await db.mypExpenseRanges.clear(); await encBulkAdd('mypExpenseRanges', data.mypExpenseRanges); }
    if (data.mypBaselines) { await db.mypBaselines.clear(); await encBulkAdd('mypBaselines', data.mypBaselines); }
    if (data.mypBaselineValues) { await db.mypBaselineValues.clear(); await encBulkAdd('mypBaselineValues', data.mypBaselineValues); }
    if (data.mypActuals) { await db.mypActuals.clear(); await encBulkAdd('mypActuals', data.mypActuals); }
    if (data.mypSavedForecasts) { await db.mypSavedForecasts.clear(); await encBulkAdd('mypSavedForecasts', data.mypSavedForecasts); }
    try { localStorage.setItem('utt-last-export', new Date().toISOString()); } catch (e) { /* private browsing - ignore */ }
    showToast('Data imported successfully!');
    await renderDashboard();
    await renderFunds();
    await renderTransactions();
    await renderNavUpdateList();
    await renderClosedFunds();
    await renderFundsOwnerFilterOptions();
    await renderClosedOwnerFilterOptions();
    await renderDashOwnerFilterOptions();
    await renderDashboard();
    if (typeof renderAmanahAll === 'function') await renderAmanahAll();
    if (typeof renderKwspAll === 'function') await renderKwspAll();
    if (typeof renderFdAll === 'function') await renderFdAll();
    if (typeof renderRealEstateAll === 'function') await renderRealEstateAll();
    if (typeof renderFxAll === 'function') await renderFxAll();
    if (typeof renderWealthAll === 'function') await renderWealthAll();
  } catch (err) { showToast('Import failed: ' + err.message); }
}

// ==================== AMANAH SAHAM ====================
let amanahViewMode = loadViewMode('utt-amanah-view', 'card');
let amanahOwnerFilter = loadViewMode('utt-amanah-owner-filter', 'All');

function calcAmanahMetrics(fund, transactions) {
  const fundTx = transactions.filter(t => t.amanahFundId === fund.id);
  const buys = fundTx.filter(t => t.type === 'Buy');
  const sells = fundTx.filter(t => t.type === 'Sell');
  const bonus = fundTx.filter(t => t.type === 'Bonus Units');
  const dividends = fundTx.filter(t => t.type === 'Dividend');
  const dividendsReinvest = fundTx.filter(t => t.type === 'Dividend (Reinvest)');
  const fees = fundTx.filter(t => t.type === 'Annual Fee');
  const unitsBought = buys.reduce((s, t) => s + (parseFloat(t.units) || 0), 0);
  const unitsSold = sells.reduce((s, t) => s + (parseFloat(t.units) || 0), 0);
  const unitsBonus = bonus.reduce((s, t) => s + (parseFloat(t.units) || 0), 0);
  const unitsReinvest = dividendsReinvest.reduce((s, t) => s + (parseFloat(t.units) || 0), 0);
  const unitsFee = fees.reduce((s, t) => s + (parseFloat(t.units) || 0), 0);
  const units = unitsBought - unitsSold + unitsBonus + unitsReinvest - unitsFee;
  const invested = buys.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const redeemed = sells.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalFees = fees.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const dividendsCash = dividends.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const dividendsReinvestAmount = dividendsReinvest.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalDividends = dividendsCash + dividendsReinvestAmount;
  const currentValue = units * (parseFloat(fund.price) || 0);
  // Reinvested dividends already turned into extra units (already reflected in currentValue) —
  // only cash dividends get added here, or they'd be counted twice.
  const pl = currentValue + dividendsCash - invested;
  const returnPct = invested > 0 ? (pl / invested * 100) : 0;
  return { units, invested, redeemed, totalDividends, totalFees, currentValue, pl, returnPct, buys };
}

function isAmanahFundActive(fund, transactions) {
  const fundTx = transactions.filter(t => t.amanahFundId === fund.id);
  if (fundTx.length === 0) return true; // new scheme, no transactions yet
  const m = calcAmanahMetrics(fund, transactions);
  return m.units > 0.0001;
}

async function renderAmanahAll() {
  await renderAmanahOwnerFilterOptions();
  await renderAmanahDashboard();
  await renderAmanahFunds();
  await renderAmanahLedgerSchemeFilterOptions();
  await renderAmanahLedger();
  await populateAmanahTxFundSelect();
}

async function renderAmanahOwnerFilterOptions() {
  const select = document.getElementById('amanah-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (amanahOwnerFilter === 'All' || members.some(m => String(m.id) === String(amanahOwnerFilter))) ? amanahOwnerFilter : 'All';
}

function setAmanahOwnerFilter(owner) {
  amanahOwnerFilter = owner;
  saveViewMode('utt-amanah-owner-filter', owner);
  renderAmanahDashboard();
  renderAmanahFunds();
}

function setAmanahView(mode) {
  amanahViewMode = mode;
  saveViewMode('utt-amanah-view', mode);
  document.getElementById('amanah-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('amanah-view-list-btn').classList.toggle('active', mode === 'list');
  renderAmanahFunds();
}

async function renderAmanahDashboard() {
  let funds = await encGetAll('amanahFunds');
  const transactions = await encGetAll('amanahTransactions');
  if (amanahOwnerFilter !== 'All') { const fid = parseInt(amanahOwnerFilter); funds = funds.filter(f => (f.ownerIds || []).includes(fid)); }
  let totalValue = 0, totalInvested = 0, totalDividends = 0, totalPL = 0;
  funds.forEach(fund => {
    const m = calcAmanahMetrics(fund, transactions);
    totalValue += toBase(m.currentValue, fund.currency);
    totalInvested += toBase(m.invested, fund.currency);
    totalDividends += toBase(m.totalDividends, fund.currency);
    totalPL += toBase(m.pl, fund.currency);
  });
  const returnPct = totalInvested > 0 ? (totalPL / totalInvested * 100) : 0;
  document.getElementById('amanah-total-value').textContent = formatCurrency(totalValue);
  document.getElementById('amanah-scheme-count').textContent = funds.length + ' scheme' + (funds.length !== 1 ? 's' : '');
  document.getElementById('amanah-total-invested').textContent = formatCurrency(totalInvested);
  document.getElementById('amanah-return-pct').textContent = (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%';
  document.getElementById('amanah-total-dividends').textContent = formatCurrency(totalDividends);
}

async function renderAmanahFunds() {
  let funds = await encGetAll('amanahFunds');
  const transactions = await encGetAll('amanahTransactions');
  const membersById = await membersByIdMap();
  if (amanahOwnerFilter !== 'All') { const fid = parseInt(amanahOwnerFilter); funds = funds.filter(f => (f.ownerIds || []).includes(fid)); }
  const grid = document.getElementById('amanah-fund-grid');
  const empty = document.getElementById('amanah-empty');
  if (funds.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (amanahViewMode === 'list') {
    grid.className = '';
    grid.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Scheme</th><th>Owner</th><th>Units</th><th>Price</th><th>Value</th><th>Invested</th><th>Dividends</th><th>P/L</th><th>Return</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>` + funds.map(fund => {
      const m = calcAmanahMetrics(fund, transactions);
      const active = isAmanahFundActive(fund, transactions);
      const plClass = m.pl >= 0 ? 'positive' : 'negative';
      return `<tr>
        <td><a href="#" data-action="showAmanahFundDetail" data-prevent="1" data-arg="${fund.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(fund.name)}</a>${fund.code ? `<div style="font-size:11px;color:#718096;margin-top:2px;">${escapeHtml(fund.code)}</div>` : ''}</td>
        <td>${ownerBadgeHtml(fund.ownerIds, membersById)}</td>
        <td>${m.units.toFixed(4)}</td>
        <td>${formatCurrency(fund.price, fund.currency)}</td>
        <td>${formatCurrency(m.currentValue, fund.currency)}</td>
        <td>${formatCurrency(m.invested, fund.currency)}</td>
        <td>${formatCurrency(m.totalDividends, fund.currency)}</td>
        <td class="${plClass}">${m.pl >= 0 ? '+' : ''}${formatCurrency(m.pl, fund.currency)}</td>
        <td class="${plClass}">${m.returnPct.toFixed(2)}%</td>
        <td>${active ? '<span class="positive">Active</span>' : '<span style="color:#a0aec0;">Redeemed</span>'}</td>
        <td><div class="tx-actions">
          <button class="icon-btn" title="Ledger" data-action="filterAmanahLedgerByScheme" data-arg="${fund.id}">📒</button>
          <button class="icon-btn" title="Edit" data-action="openAmanahFundModal" data-arg="${fund.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteAmanahFund" data-arg="${fund.id}">🗑️</button>
        </div></td>
      </tr>`;
    }).join('') + `</tbody></table></div>`;
    return;
  }

  grid.className = 'fund-grid';
  grid.innerHTML = funds.map(fund => {
    const m = calcAmanahMetrics(fund, transactions);
    const active = isAmanahFundActive(fund, transactions);
    const plClass = m.pl >= 0 ? 'positive' : 'negative';
    return `<div class="fund-card">
      <div class="actions">
        <button class="icon-btn" title="Ledger" data-action="filterAmanahLedgerByScheme" data-stop="1" data-arg="${fund.id}">📒</button>
        <button class="icon-btn" title="Edit" data-action="openAmanahFundModal" data-stop="1" data-arg="${fund.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteAmanahFund" data-stop="1" data-arg="${fund.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name"><a href="#" data-action="showAmanahFundDetail" data-prevent="1" data-arg="${fund.id}" style="color:#2d3748;text-decoration:none;cursor:pointer;">${escapeHtml(fund.name)}</a>${!active ? ' <span style="font-size:11px;font-weight:500;color:#a0aec0;">(Redeemed)</span>' : ''}</div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${[fund.code, fund.currency].filter(Boolean).join(' | ')}</div>
          <div style="margin-top: 6px;">${ownerBadgeHtml(fund.ownerIds, membersById)}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Value</div><div class="stat-value">${formatCurrency(m.currentValue, fund.currency)}</div></div>
        <div class="stat"><div class="stat-label">Invested</div><div class="stat-value">${formatCurrency(m.invested, fund.currency)}</div></div>
        <div class="stat"><div class="stat-label">Dividends</div><div class="stat-value">${formatCurrency(m.totalDividends, fund.currency)}</div></div>
        <div class="stat"><div class="stat-label">P/L</div><div class="stat-value ${plClass}">${m.pl >= 0 ? '+' : ''}${formatCurrency(m.pl, fund.currency)}</div></div>
        <div class="stat"><div class="stat-label">Return</div><div class="stat-value ${plClass}">${m.returnPct.toFixed(2)}%</div></div>
      </div>
      <div style="font-size: 12px; color: #718096; margin-top: 8px;">Price: ${formatCurrency(fund.price, fund.currency)} / unit</div>
    </div>`;
  }).join('');
}

async function openAmanahFundModal(fundId) {
  document.getElementById('amanahFundModalTitle').textContent = fundId ? 'Edit Scheme' : 'Add Scheme';
  document.getElementById('amanahFundId').value = fundId || '';
  if (fundId) {
    const fund = await encGet('amanahFunds', fundId);
    document.getElementById('amanahFundName').value = fund.name;
    document.getElementById('amanahFundCode').value = fund.code || '';
    document.getElementById('amanahFundCurrency').value = fund.currency;
    document.getElementById('amanahFundPrice').value = fund.price;
    await renderOwnerCheckboxes('amanahFundOwnersList', fund.ownerIds || []);
  } else {
    document.getElementById('amanahFundName').value = '';
    document.getElementById('amanahFundCode').value = '';
    document.getElementById('amanahFundCurrency').value = 'MYR';
    document.getElementById('amanahFundPrice').value = '1.0000';
    await renderOwnerCheckboxes('amanahFundOwnersList', []);
  }
  document.getElementById('amanahFundModal').classList.add('active');
}
function closeAmanahFundModal() { document.getElementById('amanahFundModal').classList.remove('active'); }

async function saveAmanahFund() {
  const id = document.getElementById('amanahFundId').value;
  const data = {
    name: document.getElementById('amanahFundName').value,
    code: document.getElementById('amanahFundCode').value,
    currency: document.getElementById('amanahFundCurrency').value,
    price: parseFloat(document.getElementById('amanahFundPrice').value) || 0,
    ownerIds: getCheckedOwnerIds('amanahFundOwnersList')
  };
  if (!data.name) { showToast('Please fill in scheme name'); return; }
  if (id) {
    await encUpdate('amanahFunds', parseInt(id), data);
    showToast('Scheme updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('amanahFunds', data);
    showToast('Scheme added!');
  }
  closeAmanahFundModal();
  await renderAmanahAll();
}

async function deleteAmanahFund(fundId) {
  if (!confirm('Delete this scheme and all its transactions?')) return;
  await db.amanahTransactions.where('amanahFundId').equals(fundId).delete();
  await db.amanahFunds.delete(fundId);
  showToast('Scheme deleted');
  await renderAmanahAll();
}

let currentAmanahFundId = null;

async function showAmanahFundDetail(fundId) {
  currentAmanahFundId = fundId;
  const fund = await encGet('amanahFunds', fundId);
  if (!fund) return;
  const transactions = await encGetAll('amanahTransactions');
  const m = calcAmanahMetrics(fund, transactions);
  document.getElementById('amanahFundDetailTitle').textContent = fund.name + (fund.code ? ' (' + fund.code + ')' : '');
  document.getElementById('amanahFundDetailOwner').innerHTML = ownerBadgeHtml(fund.ownerIds, await membersByIdMap());
  document.getElementById('afd-value').textContent = formatCurrency(m.currentValue, fund.currency);
  document.getElementById('afd-invested').textContent = formatCurrency(m.invested, fund.currency);
  document.getElementById('afd-dividends').textContent = formatCurrency(m.totalDividends, fund.currency);
  document.getElementById('afd-return').textContent = m.returnPct.toFixed(2) + '%';
  document.getElementById('afd-return').className = 'value ' + (m.returnPct >= 0 ? 'positive' : 'negative');
  const fundTx = transactions.filter(t => t.amanahFundId === fundId).sort((a, b) => new Date(b.date) - new Date(a.date));
  const txTable = document.getElementById('afd-tx-table');
  if (fundTx.length === 0) {
    txTable.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#a0aec0;">No transactions yet</td></tr>';
  } else {
    txTable.innerHTML = fundTx.map(tx => `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${amanahTxTypeLabel(tx.type)}</span></td>
      <td>${tx.units ? escapeHtml(tx.units) : '-'}</td>
      <td>${tx.price ? formatCurrency(tx.price, fund.currency) : '-'}</td>
      <td>${formatCurrency(tx.amount, fund.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
    </tr>`).join('');
  }
  document.getElementById('amanahFundDetailModal').classList.add('active');
}

function closeAmanahFundDetailModal() {
  document.getElementById('amanahFundDetailModal').classList.remove('active');
  currentAmanahFundId = null;
}

function editAmanahFundFromDetail() {
  const fundId = currentAmanahFundId;
  closeAmanahFundDetailModal();
  openAmanahFundModal(fundId);
}

async function deleteAmanahFundFromDetail() {
  const fundId = currentAmanahFundId;
  if (!fundId) return;
  closeAmanahFundDetailModal();
  await deleteAmanahFund(fundId);
}

let amanahLedgerSchemeFilter = 'All';

function amanahSchemeOptionLabel(fund, membersById) {
  const names = (fund.ownerIds || []).map(id => membersById[id] ? membersById[id].name : null).filter(Boolean);
  const ownerPart = names.length > 0 ? ' — ' + names.join(' & ') : '';
  return fund.name + (fund.code ? ' (' + fund.code + ')' : '') + ownerPart;
}

async function renderAmanahLedgerSchemeFilterOptions() {
  const select = document.getElementById('amanah-ledger-scheme-filter');
  if (!select) return;
  const funds = await encGetAll('amanahFunds');
  const membersById = await membersByIdMap();
  const options = funds.map(f => `<option value="${f.id}">${amanahSchemeOptionLabel(f, membersById)}</option>`);
  select.innerHTML = '<option value="All">📒 All Schemes</option>' + options.join('');
  select.value = funds.some(f => String(f.id) === String(amanahLedgerSchemeFilter)) ? amanahLedgerSchemeFilter : 'All';
}

function setAmanahLedgerSchemeFilter(fundId) {
  amanahLedgerSchemeFilter = fundId;
  renderAmanahLedger();
}

function filterAmanahLedgerByScheme(fundId) {
  amanahLedgerSchemeFilter = String(fundId);
  const select = document.getElementById('amanah-ledger-scheme-filter');
  if (select) select.value = amanahLedgerSchemeFilter;
  renderAmanahLedger();
  const anchor = document.getElementById('amanah-ledger-anchor');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function printAmanahFundReport(fundId) {
  if (!fundId) return;
  const fund = await encGet('amanahFunds', fundId);
  if (!fund) return;
  const transactions = await encGetAll('amanahTransactions');
  const m = calcAmanahMetrics(fund, transactions);
  const extraStyle = '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}';
  const printWindow = openReportWindow('Amanah Saham — ' + fund.name, extraStyle);
  printWindow.document.write('<h1>' + escapeHtml(fund.name) + (fund.code ? ' (' + escapeHtml(fund.code) + ')' : '') + '</h1>');
  printWindow.document.write('<p>Currency: ' + fund.currency + ' | Fixed Price: ' + formatCurrency(fund.price, fund.currency) + ' | Generated: ' + new Date().toLocaleDateString() + '</p>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Current Value', formatCurrency(m.currentValue, fund.currency)));
  printWindow.document.write(statCardHtml('Invested', formatCurrency(m.invested, fund.currency)));
  printWindow.document.write(statCardHtml('Dividends', formatCurrency(m.totalDividends, fund.currency)));
  printWindow.document.write(statCardHtml('Return %', m.returnPct.toFixed(2) + '%', m.returnPct));
  printWindow.document.write('</div>');
  printWindow.document.write('<h2>Transactions</h2>');
  const fundTx = transactions.filter(t => t.amanahFundId === fundId).sort((a, b) => new Date(b.date) - new Date(a.date));
  const fundTxForDisplay = fundTx.map(t => Object.assign({}, t, { type: amanahTxTypeLabel(t.type) }));
  printWindow.document.write(txHistoryTableHtml(fundTxForDisplay, fund.currency));
  finishPrintWindow(printWindow);
}

async function populateAmanahTxFundSelect() {
  const select = document.getElementById('amanahTxFundId');
  if (!select) return;
  const funds = await encGetAll('amanahFunds');
  const membersById = await membersByIdMap();
  select.innerHTML = funds.map(f => `<option value="${f.id}">${amanahSchemeOptionLabel(f, membersById)}</option>`).join('');
}

let amanahLastEditedField = null;
function calcAmanahTxAmount(changed) {
  amanahLastEditedField = changed;
  const units = parseFloat(document.getElementById('amanahTxUnits').value) || 0;
  const price = parseFloat(document.getElementById('amanahTxPrice').value) || 0;
  const amountEl = document.getElementById('amanahTxAmount');
  if (changed === 'units' || changed === 'price') {
    if (units && price) amountEl.value = (units * price).toFixed(2);
  } else if (changed === 'amount') {
    const amount = parseFloat(amountEl.value) || 0;
    if (amount && price) document.getElementById('amanahTxUnits').value = (amount / price).toFixed(4);
  }
}

function onAmanahTxTypeChange() {
  const type = document.getElementById('amanahTxType').value;
  const row = document.getElementById('amanahTxUnitsPriceRow');
  row.style.display = type === 'Dividend' ? 'none' : 'grid';
}

async function openAmanahTxModal(fundId, txId) {
  document.getElementById('amanahTxModalTitle').textContent = txId ? 'Edit Transaction' : 'Add Transaction';
  document.getElementById('amanahTxId').value = txId || '';
  await populateAmanahTxFundSelect();
  if (txId) {
    const tx = await encGet('amanahTransactions', txId);
    document.getElementById('amanahTxFundId').value = tx.amanahFundId;
    document.getElementById('amanahTxType').value = tx.type;
    document.getElementById('amanahTxDate').value = tx.date;
    document.getElementById('amanahTxUnits').value = tx.units || '';
    document.getElementById('amanahTxPrice').value = tx.price || '';
    document.getElementById('amanahTxAmount').value = tx.amount || '';
    document.getElementById('amanahTxNotes').value = tx.notes || '';
  } else {
    document.getElementById('amanahTxFundId').value = fundId || (document.getElementById('amanahTxFundId').options[0] ? document.getElementById('amanahTxFundId').options[0].value : '');
    document.getElementById('amanahTxType').value = 'Buy';
    document.getElementById('amanahTxDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('amanahTxUnits').value = '';
    document.getElementById('amanahTxPrice').value = '';
    document.getElementById('amanahTxAmount').value = '';
    document.getElementById('amanahTxNotes').value = '';
    await onAmanahTxFundChange();
  }
  onAmanahTxTypeChange();
  document.getElementById('amanahTxModal').classList.add('active');
}

async function onAmanahTxFundChange() {
  const fundId = parseInt(document.getElementById('amanahTxFundId').value);
  if (!fundId) return;
  const fund = await encGet('amanahFunds', fundId);
  if (fund) document.getElementById('amanahTxPrice').value = fund.price;
}
function closeAmanahTxModal() { document.getElementById('amanahTxModal').classList.remove('active'); }

async function saveAmanahTx() {
  const id = document.getElementById('amanahTxId').value;
  const data = {
    amanahFundId: parseInt(document.getElementById('amanahTxFundId').value),
    type: document.getElementById('amanahTxType').value,
    date: document.getElementById('amanahTxDate').value,
    units: parseFloat(document.getElementById('amanahTxUnits').value) || 0,
    price: parseFloat(document.getElementById('amanahTxPrice').value) || 0,
    amount: parseFloat(document.getElementById('amanahTxAmount').value) || 0,
    notes: document.getElementById('amanahTxNotes').value
  };
  if (!data.amanahFundId || !data.date) { showToast('Please select a scheme and date'); return; }
  if (id) {
    await encUpdate('amanahTransactions', parseInt(id), data);
    showToast('Transaction updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('amanahTransactions', data);
    showToast('Transaction added!');
  }
  closeAmanahTxModal();
  await renderAmanahAll();
}

async function editAmanahTx(txId) { await openAmanahTxModal(null, txId); }

async function deleteAmanahTx(txId) {
  if (!confirm('Delete this transaction?')) return;
  await db.amanahTransactions.delete(txId);
  showToast('Transaction deleted');
  await renderAmanahAll();
}

async function renderAmanahLedger() {
  let transactions = await encGetAll('amanahTransactions');
  const funds = await encGetAll('amanahFunds');
  const fundsById = {};
  funds.forEach(f => { fundsById[f.id] = f; });
  if (amanahLedgerSchemeFilter !== 'All') { const fid = parseInt(amanahLedgerSchemeFilter); transactions = transactions.filter(t => t.amanahFundId === fid); }
  const tbody = document.getElementById('amanah-ledger-body');
  if (!tbody) return;
  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#a0aec0;">No transactions yet</td></tr>';
    return;
  }
  const sorted = transactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  tbody.innerHTML = sorted.map(tx => {
    const fund = fundsById[tx.amanahFundId];
    return `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td>${fund ? escapeHtml(fund.name) : 'Unknown'}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${amanahTxTypeLabel(tx.type)}</span></td>
      <td>${tx.units ? escapeHtml(tx.units) : '-'}</td>
      <td>${tx.price ? formatCurrency(tx.price, fund && fund.currency) : '-'}</td>
      <td>${formatCurrency(tx.amount, fund && fund.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="editAmanahTx" data-arg="${tx.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteAmanahTx" data-arg="${tx.id}">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function printAmanahReport(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const extraStyle = '@page { size: auto; margin: 15mm; }' +
    '@media print { @page { size: landscape; } }' +
    'body{padding:20px;font-size:11pt;max-width:100%;margin:0;}' +
    'table{font-size:9pt;}' +
    'th,td{padding:6px 8px;}' +
    '.stats{grid-template-columns:repeat(6,1fr);}' +
    '.stat-card{padding:12px 8px;}' +
    '.stat-card h3{font-size:8pt;text-transform:uppercase;}' +
    '.stat-card .value{font-size:14pt;}' +
    '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}' +
    '.holdings-table .fund-code{font-size:8pt;color:#718096;font-weight:normal;margin-top:2px;}';
  const reportTitle = 'Amanah Saham Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, extraStyle);
  const base = getBaseCurrency();
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency: ' + base + (ownerName ? ' &nbsp;|&nbsp; Owner: ' + ownerName : '') + '</div>');
  const allFunds = await encGetAll('amanahFunds');
  const funds = ownerFilter === 'All' ? allFunds : allFunds.filter(f => (f.ownerIds || []).includes(parseInt(ownerFilter)));
  const transactions = await encGetAll('amanahTransactions');
  if (funds.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No schemes found for this owner.</p>');
    finishPrintWindow(printWindow);
    return;
  }
  let totalValue = 0, totalInvested = 0, totalDividends = 0, totalPL = 0;
  funds.forEach(fund => {
    const m = calcAmanahMetrics(fund, transactions);
    totalValue += toBase(m.currentValue, fund.currency);
    totalInvested += toBase(m.invested, fund.currency);
    totalDividends += toBase(m.totalDividends, fund.currency);
    totalPL += toBase(m.pl, fund.currency);
  });
  const returnPct = totalInvested > 0 ? (totalPL / totalInvested * 100) : 0;
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Total Value', formatCurrency(totalValue)));
  printWindow.document.write(statCardHtml('Total Invested', formatCurrency(totalInvested)));
  printWindow.document.write(statCardHtml('Total Dividends', formatCurrency(totalDividends)));
  printWindow.document.write(statCardHtml('Total P/L', (totalPL >= 0 ? '+' : '') + formatCurrency(totalPL), totalPL));
  printWindow.document.write(statCardHtml('Return %', returnPct.toFixed(2) + '%', returnPct));
  printWindow.document.write(statCardHtml('Schemes', funds.length));
  printWindow.document.write('</div>');

  printWindow.document.write('<h2>Schemes</h2>');
  printWindow.document.write('<table class="holdings-table"><colgroup><col style="width:26%"><col style="width:10%"><col style="width:10%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:10%"><col style="width:8%"></colgroup><thead><tr><th>Scheme</th><th>Units</th><th>Price</th><th>Value</th><th>Invested</th><th>Dividends</th><th>P/L</th><th>Return</th></tr></thead><tbody>');
  funds.forEach(fund => {
    const m = calcAmanahMetrics(fund, transactions);
    printWindow.document.write('<tr><td>' + escapeHtml(fund.name) + (fund.code ? '<div class="fund-code">' + escapeHtml(fund.code) + '</div>' : '') + '</td><td class="nowrap">' + m.units.toFixed(4) + '</td><td class="nowrap">' + formatCurrency(fund.price, fund.currency) + '</td><td class="nowrap">' + formatCurrency(m.currentValue, fund.currency) + '</td><td class="nowrap">' + formatCurrency(m.invested, fund.currency) + '</td><td class="nowrap">' + formatCurrency(m.totalDividends, fund.currency) + '</td><td class="nowrap ' + (m.pl >= 0 ? 'positive' : 'negative') + '">' + (m.pl >= 0 ? '+' : '') + formatCurrency(m.pl, fund.currency) + '</td><td class="nowrap">' + m.returnPct.toFixed(2) + '%</td></tr>');
  });
  printWindow.document.write('</tbody></table>');

  printWindow.document.write('<h2>Transaction Ledger</h2>');
  const fundsById = {};
  funds.forEach(f => { fundsById[f.id] = f; });
  const relevantTx = transactions.filter(t => fundsById[t.amanahFundId]).sort((a, b) => new Date(b.date) - new Date(a.date));
  let ledgerHtml = '<table><thead><tr><th>Date</th><th>Scheme</th><th>Type</th><th>Units</th><th>Price</th><th>Amount</th><th>Notes</th></tr></thead><tbody>';
  relevantTx.forEach(tx => {
    const fund = fundsById[tx.amanahFundId];
    ledgerHtml += '<tr><td>' + escapeHtml(tx.date) + '</td><td>' + (fund ? escapeHtml(fund.name) : '-') + '</td><td>' + escapeHtml(amanahTxTypeLabel(tx.type)) + '</td><td>' + (tx.units ? escapeHtml(tx.units) : '-') + '</td><td>' + (tx.price ? formatCurrency(tx.price, fund && fund.currency) : '-') + '</td><td>' + formatCurrency(tx.amount, fund && fund.currency) + '</td><td>' + (escapeHtml(tx.notes) || '-') + '</td></tr>';
  });
  ledgerHtml += '</tbody></table>';
  printWindow.document.write(ledgerHtml);

  finishPrintWindow(printWindow);
}

// ==================== KWSP ====================
let kwspViewMode = loadViewMode('utt-kwsp-view', 'card');
let kwspOwnerFilter = loadViewMode('utt-kwsp-owner-filter', 'All');
let kwspLedgerAccountFilter = 'All';
let currentKwspAccountId = null;

function calcKwspMetrics(account, transactions) {
  const acctTx = transactions.filter(t => t.kwspAccountId === account.id);
  const employeeContrib = acctTx.filter(t => t.type === 'Contribution (Employee)').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const employerContrib = acctTx.filter(t => t.type === 'Contribution (Employer)').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalContributions = employeeContrib + employerContrib;
  const totalDividends = acctTx.filter(t => t.type === 'Dividend').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalWithdrawals = acctTx.filter(t => t.type === 'Withdrawal').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const balance = totalContributions + totalDividends - totalWithdrawals;
  const returnPct = totalContributions > 0 ? (totalDividends / totalContributions * 100) : 0;
  return { employeeContrib, employerContrib, totalContributions, totalDividends, totalWithdrawals, balance, returnPct };
}

function kwspAccountOptionLabel(account, membersById) {
  const names = (account.ownerIds || []).map(id => membersById[id] ? membersById[id].name : null).filter(Boolean);
  const ownerPart = names.length > 0 ? ' — ' + names.join(' & ') : '';
  return account.name + ownerPart;
}

async function renderKwspAll() {
  await renderKwspOwnerFilterOptions();
  await renderKwspDashboard();
  await renderKwspAccounts();
  await renderKwspLedgerAccountFilterOptions();
  await renderKwspLedger();
  await populateKwspTxAccountSelect();
}

async function renderKwspOwnerFilterOptions() {
  const select = document.getElementById('kwsp-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (kwspOwnerFilter === 'All' || members.some(m => String(m.id) === String(kwspOwnerFilter))) ? kwspOwnerFilter : 'All';
}

function setKwspOwnerFilter(owner) {
  kwspOwnerFilter = owner;
  saveViewMode('utt-kwsp-owner-filter', owner);
  renderKwspDashboard();
  renderKwspAccounts();
}

function setKwspView(mode) {
  kwspViewMode = mode;
  saveViewMode('utt-kwsp-view', mode);
  document.getElementById('kwsp-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('kwsp-view-list-btn').classList.toggle('active', mode === 'list');
  renderKwspAccounts();
}

async function renderKwspDashboard() {
  let accounts = await encGetAll('kwspAccounts');
  const transactions = await encGetAll('kwspTransactions');
  if (kwspOwnerFilter !== 'All') { const fid = parseInt(kwspOwnerFilter); accounts = accounts.filter(a => (a.ownerIds || []).includes(fid)); }
  let totalBalance = 0, totalContributions = 0, totalEmployee = 0, totalEmployer = 0, totalDividends = 0, totalWithdrawals = 0;
  accounts.forEach(account => {
    const m = calcKwspMetrics(account, transactions);
    totalBalance += toBase(m.balance, account.currency);
    totalContributions += toBase(m.totalContributions, account.currency);
    totalEmployee += toBase(m.employeeContrib, account.currency);
    totalEmployer += toBase(m.employerContrib, account.currency);
    totalDividends += toBase(m.totalDividends, account.currency);
    totalWithdrawals += toBase(m.totalWithdrawals, account.currency);
  });
  const returnPct = totalContributions > 0 ? (totalDividends / totalContributions * 100) : 0;
  document.getElementById('kwsp-total-balance').textContent = formatCurrency(totalBalance);
  document.getElementById('kwsp-account-count').textContent = accounts.length + ' account' + (accounts.length !== 1 ? 's' : '');
  document.getElementById('kwsp-total-contributions').textContent = formatCurrency(totalContributions);
  document.getElementById('kwsp-contributions-breakdown').textContent = 'Employee: ' + formatCurrency(totalEmployee) + ' · Employer: ' + formatCurrency(totalEmployer);
  document.getElementById('kwsp-total-dividends').textContent = formatCurrency(totalDividends);
  document.getElementById('kwsp-return-pct').textContent = returnPct.toFixed(2) + '%';
  document.getElementById('kwsp-total-withdrawals').textContent = formatCurrency(totalWithdrawals);
}

async function renderKwspAccounts() {
  let accounts = await encGetAll('kwspAccounts');
  const transactions = await encGetAll('kwspTransactions');
  const membersById = await membersByIdMap();
  if (kwspOwnerFilter !== 'All') { const fid = parseInt(kwspOwnerFilter); accounts = accounts.filter(a => (a.ownerIds || []).includes(fid)); }
  const grid = document.getElementById('kwsp-account-grid');
  const empty = document.getElementById('kwsp-empty');
  if (accounts.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (kwspViewMode === 'list') {
    grid.className = '';
    grid.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Account</th><th>Owner</th><th>Balance</th><th>Employee</th><th>Employer</th><th>Dividends</th><th>Withdrawals</th><th>Return</th><th>Actions</th></tr></thead>
      <tbody>` + accounts.map(account => {
      const m = calcKwspMetrics(account, transactions);
      return `<tr>
        <td><a href="#" data-action="showKwspAccountDetail" data-prevent="1" data-arg="${account.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(account.name)}</a></td>
        <td>${ownerBadgeHtml(account.ownerIds, membersById)}</td>
        <td>${formatCurrency(m.balance, account.currency)}</td>
        <td>${formatCurrency(m.employeeContrib, account.currency)}</td>
        <td>${formatCurrency(m.employerContrib, account.currency)}</td>
        <td>${formatCurrency(m.totalDividends, account.currency)}</td>
        <td>${formatCurrency(m.totalWithdrawals, account.currency)}</td>
        <td class="positive">${m.returnPct.toFixed(2)}%</td>
        <td><div class="tx-actions">
          <button class="icon-btn" title="Ledger" data-action="filterKwspLedgerByAccount" data-stop="1" data-arg="${account.id}">📒</button>
          <button class="icon-btn" title="Edit" data-action="openKwspAccountModal" data-stop="1" data-arg="${account.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteKwspAccount" data-stop="1" data-arg="${account.id}">🗑️</button>
        </div></td>
      </tr>`;
    }).join('') + `</tbody></table></div>`;
    return;
  }

  grid.className = 'fund-grid';
  grid.innerHTML = accounts.map(account => {
    const m = calcKwspMetrics(account, transactions);
    return `<div class="fund-card">
      <div class="actions">
        <button class="icon-btn" title="Ledger" data-action="filterKwspLedgerByAccount" data-stop="1" data-arg="${account.id}">📒</button>
        <button class="icon-btn" title="Edit" data-action="openKwspAccountModal" data-stop="1" data-arg="${account.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteKwspAccount" data-stop="1" data-arg="${account.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name"><a href="#" data-action="showKwspAccountDetail" data-prevent="1" data-arg="${account.id}" style="color:#2d3748;text-decoration:none;cursor:pointer;">${escapeHtml(account.name)}</a></div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${escapeHtml(account.currency)}</div>
          <div style="margin-top: 6px;">${ownerBadgeHtml(account.ownerIds, membersById)}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Balance</div><div class="stat-value">${formatCurrency(m.balance, account.currency)}</div></div>
        <div class="stat"><div class="stat-label">Employee</div><div class="stat-value">${formatCurrency(m.employeeContrib, account.currency)}</div></div>
        <div class="stat"><div class="stat-label">Employer</div><div class="stat-value">${formatCurrency(m.employerContrib, account.currency)}</div></div>
        <div class="stat"><div class="stat-label">Dividends</div><div class="stat-value positive">${formatCurrency(m.totalDividends, account.currency)}</div></div>
        <div class="stat"><div class="stat-label">Withdrawals</div><div class="stat-value">${formatCurrency(m.totalWithdrawals, account.currency)}</div></div>
        <div class="stat"><div class="stat-label">Return</div><div class="stat-value positive">${m.returnPct.toFixed(2)}%</div></div>
      </div>
    </div>`;
  }).join('');
}

async function openKwspAccountModal(accountId) {
  document.getElementById('kwspAccountModalTitle').textContent = accountId ? 'Edit Account' : 'Add Account';
  document.getElementById('kwspAccountId').value = accountId || '';
  if (accountId) {
    const account = await encGet('kwspAccounts', accountId);
    document.getElementById('kwspAccountName').value = account.name;
    document.getElementById('kwspAccountCurrency').value = account.currency;
    await renderOwnerCheckboxes('kwspAccountOwnersList', account.ownerIds || []);
  } else {
    document.getElementById('kwspAccountName').value = '';
    document.getElementById('kwspAccountCurrency').value = 'MYR';
    await renderOwnerCheckboxes('kwspAccountOwnersList', []);
  }
  document.getElementById('kwspAccountModal').classList.add('active');
}
function closeKwspAccountModal() { document.getElementById('kwspAccountModal').classList.remove('active'); }

async function saveKwspAccount() {
  const id = document.getElementById('kwspAccountId').value;
  const data = {
    name: document.getElementById('kwspAccountName').value,
    currency: document.getElementById('kwspAccountCurrency').value,
    ownerIds: getCheckedOwnerIds('kwspAccountOwnersList')
  };
  if (!data.name) { showToast('Please fill in account name'); return; }
  if (id) {
    await encUpdate('kwspAccounts', parseInt(id), data);
    showToast('Account updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('kwspAccounts', data);
    showToast('Account added!');
  }
  closeKwspAccountModal();
  await renderKwspAll();
}

async function deleteKwspAccount(accountId) {
  if (!confirm('Delete this account and all its transactions?')) return;
  await db.kwspTransactions.where('kwspAccountId').equals(accountId).delete();
  await db.kwspAccounts.delete(accountId);
  showToast('Account deleted');
  await renderKwspAll();
}

async function showKwspAccountDetail(accountId) {
  currentKwspAccountId = accountId;
  const account = await encGet('kwspAccounts', accountId);
  if (!account) return;
  const transactions = await encGetAll('kwspTransactions');
  const m = calcKwspMetrics(account, transactions);
  document.getElementById('kwspAccountDetailTitle').textContent = account.name;
  document.getElementById('kwspAccountDetailOwner').innerHTML = ownerBadgeHtml(account.ownerIds, await membersByIdMap());
  document.getElementById('kad-balance').textContent = formatCurrency(m.balance, account.currency);
  document.getElementById('kad-employee').textContent = formatCurrency(m.employeeContrib, account.currency);
  document.getElementById('kad-employer').textContent = formatCurrency(m.employerContrib, account.currency);
  document.getElementById('kad-dividends').textContent = formatCurrency(m.totalDividends, account.currency);
  document.getElementById('kad-withdrawals').textContent = formatCurrency(m.totalWithdrawals, account.currency);
  document.getElementById('kad-return').textContent = m.returnPct.toFixed(2) + '%';
  const acctTx = transactions.filter(t => t.kwspAccountId === accountId).sort((a, b) => new Date(b.date) - new Date(a.date));
  const txTable = document.getElementById('kad-tx-table');
  if (acctTx.length === 0) {
    txTable.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No transactions yet</td></tr>';
  } else {
    txTable.innerHTML = acctTx.map(tx => `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(tx.type)}</span></td>
      <td>${formatCurrency(tx.amount, account.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
    </tr>`).join('');
  }
  document.getElementById('kwspAccountDetailModal').classList.add('active');
}

function closeKwspAccountDetailModal() {
  document.getElementById('kwspAccountDetailModal').classList.remove('active');
  currentKwspAccountId = null;
}

function editKwspAccountFromDetail() {
  const accountId = currentKwspAccountId;
  closeKwspAccountDetailModal();
  openKwspAccountModal(accountId);
}

async function deleteKwspAccountFromDetail() {
  const accountId = currentKwspAccountId;
  if (!accountId) return;
  closeKwspAccountDetailModal();
  await deleteKwspAccount(accountId);
}

async function renderKwspLedgerAccountFilterOptions() {
  const select = document.getElementById('kwsp-ledger-account-filter');
  if (!select) return;
  const accounts = await encGetAll('kwspAccounts');
  const membersById = await membersByIdMap();
  const options = accounts.map(a => `<option value="${a.id}">${kwspAccountOptionLabel(a, membersById)}</option>`);
  select.innerHTML = '<option value="All">📒 All Accounts</option>' + options.join('');
  select.value = accounts.some(a => String(a.id) === String(kwspLedgerAccountFilter)) ? kwspLedgerAccountFilter : 'All';
}

function setKwspLedgerAccountFilter(accountId) {
  kwspLedgerAccountFilter = accountId;
  renderKwspLedger();
}

function filterKwspLedgerByAccount(accountId) {
  kwspLedgerAccountFilter = String(accountId);
  const select = document.getElementById('kwsp-ledger-account-filter');
  if (select) select.value = kwspLedgerAccountFilter;
  renderKwspLedger();
  const anchor = document.getElementById('kwsp-ledger-anchor');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function populateKwspTxAccountSelect() {
  const select = document.getElementById('kwspTxAccountId');
  if (!select) return;
  const accounts = await encGetAll('kwspAccounts');
  const membersById = await membersByIdMap();
  select.innerHTML = accounts.map(a => `<option value="${a.id}">${kwspAccountOptionLabel(a, membersById)}</option>`).join('');
}

async function openKwspTxModal(accountId, txId) {
  document.getElementById('kwspTxModalTitle').textContent = txId ? 'Edit Transaction' : 'Add Transaction';
  document.getElementById('kwspTxId').value = txId || '';
  await populateKwspTxAccountSelect();
  if (txId) {
    const tx = await encGet('kwspTransactions', txId);
    document.getElementById('kwspTxAccountId').value = tx.kwspAccountId;
    document.getElementById('kwspTxType').value = tx.type;
    document.getElementById('kwspTxDate').value = tx.date;
    document.getElementById('kwspTxAmount').value = tx.amount || '';
    document.getElementById('kwspTxNotes').value = tx.notes || '';
  } else {
    document.getElementById('kwspTxAccountId').value = accountId || (document.getElementById('kwspTxAccountId').options[0] ? document.getElementById('kwspTxAccountId').options[0].value : '');
    document.getElementById('kwspTxType').value = 'Contribution (Employee)';
    document.getElementById('kwspTxDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('kwspTxAmount').value = '';
    document.getElementById('kwspTxNotes').value = '';
  }
  document.getElementById('kwspTxModal').classList.add('active');
}
function closeKwspTxModal() { document.getElementById('kwspTxModal').classList.remove('active'); }

async function saveKwspTx() {
  const id = document.getElementById('kwspTxId').value;
  const data = {
    kwspAccountId: parseInt(document.getElementById('kwspTxAccountId').value),
    type: document.getElementById('kwspTxType').value,
    date: document.getElementById('kwspTxDate').value,
    amount: parseFloat(document.getElementById('kwspTxAmount').value) || 0,
    notes: document.getElementById('kwspTxNotes').value
  };
  if (!data.kwspAccountId || !data.date) { showToast('Please select an account and date'); return; }
  if (id) {
    await encUpdate('kwspTransactions', parseInt(id), data);
    showToast('Transaction updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('kwspTransactions', data);
    showToast('Transaction added!');
  }
  closeKwspTxModal();
  await renderKwspAll();
}

async function editKwspTx(txId) { await openKwspTxModal(null, txId); }

async function deleteKwspTx(txId) {
  if (!confirm('Delete this transaction?')) return;
  await db.kwspTransactions.delete(txId);
  showToast('Transaction deleted');
  await renderKwspAll();
}

async function renderKwspLedger() {
  let transactions = await encGetAll('kwspTransactions');
  const accounts = await encGetAll('kwspAccounts');
  const accountsById = {};
  accounts.forEach(a => { accountsById[a.id] = a; });
  if (kwspLedgerAccountFilter !== 'All') { const fid = parseInt(kwspLedgerAccountFilter); transactions = transactions.filter(t => t.kwspAccountId === fid); }
  const tbody = document.getElementById('kwsp-ledger-body');
  if (!tbody) return;
  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#a0aec0;">No transactions yet</td></tr>';
    return;
  }
  const sorted = transactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  tbody.innerHTML = sorted.map(tx => {
    const account = accountsById[tx.kwspAccountId];
    return `<tr>
      <td>${escapeHtml(tx.date)}</td>
      <td>${account ? account.name : 'Unknown'}</td>
      <td><span style="background:${getTxTypeColor(tx.type)};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(tx.type)}</span></td>
      <td>${formatCurrency(tx.amount, account && account.currency)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="editKwspTx" data-arg="${tx.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteKwspTx" data-arg="${tx.id}">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function printKwspReport(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const extraStyle = '@page { size: auto; margin: 15mm; }' +
    '@media print { @page { size: landscape; } }' +
    'body{padding:20px;font-size:11pt;max-width:100%;margin:0;}' +
    'table{font-size:9pt;}' +
    'th,td{padding:6px 8px;}' +
    '.stats{grid-template-columns:repeat(6,1fr);}' +
    '.stat-card{padding:12px 8px;}' +
    '.stat-card h3{font-size:8pt;text-transform:uppercase;}' +
    '.stat-card .value{font-size:14pt;}' +
    '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}';
  const reportTitle = 'KWSP Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, extraStyle);
  const base = getBaseCurrency();
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency: ' + base + (ownerName ? ' &nbsp;|&nbsp; Owner: ' + ownerName : '') + '</div>');
  const allAccounts = await encGetAll('kwspAccounts');
  const accounts = ownerFilter === 'All' ? allAccounts : allAccounts.filter(a => (a.ownerIds || []).includes(parseInt(ownerFilter)));
  const transactions = await encGetAll('kwspTransactions');
  if (accounts.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No accounts found for this owner.</p>');
    finishPrintWindow(printWindow);
    return;
  }
  let totalBalance = 0, totalContributions = 0, totalDividends = 0, totalWithdrawals = 0;
  accounts.forEach(account => {
    const m = calcKwspMetrics(account, transactions);
    totalBalance += toBase(m.balance, account.currency);
    totalContributions += toBase(m.totalContributions, account.currency);
    totalDividends += toBase(m.totalDividends, account.currency);
    totalWithdrawals += toBase(m.totalWithdrawals, account.currency);
  });
  const returnPct = totalContributions > 0 ? (totalDividends / totalContributions * 100) : 0;
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Total Balance', formatCurrency(totalBalance)));
  printWindow.document.write(statCardHtml('Total Contributions', formatCurrency(totalContributions)));
  printWindow.document.write(statCardHtml('Total Dividends', formatCurrency(totalDividends)));
  printWindow.document.write(statCardHtml('Total Withdrawals', formatCurrency(totalWithdrawals)));
  printWindow.document.write(statCardHtml('Return %', returnPct.toFixed(2) + '%', returnPct));
  printWindow.document.write(statCardHtml('Accounts', accounts.length));
  printWindow.document.write('</div>');

  printWindow.document.write('<h2>Accounts</h2>');
  printWindow.document.write('<table class="holdings-table"><colgroup><col style="width:30%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th>Account</th><th>Balance</th><th>Employee</th><th>Employer</th><th>Dividends</th><th>Withdrawals</th></tr></thead><tbody>');
  accounts.forEach(account => {
    const m = calcKwspMetrics(account, transactions);
    printWindow.document.write('<tr><td>' + escapeHtml(account.name) + '</td><td class="nowrap">' + formatCurrency(m.balance, account.currency) + '</td><td class="nowrap">' + formatCurrency(m.employeeContrib, account.currency) + '</td><td class="nowrap">' + formatCurrency(m.employerContrib, account.currency) + '</td><td class="nowrap">' + formatCurrency(m.totalDividends, account.currency) + '</td><td class="nowrap">' + formatCurrency(m.totalWithdrawals, account.currency) + '</td></tr>');
  });
  printWindow.document.write('</tbody></table>');

  printWindow.document.write('<h2>Transaction Ledger</h2>');
  const accountsById = {};
  accounts.forEach(a => { accountsById[a.id] = a; });
  const relevantTx = transactions.filter(t => accountsById[t.kwspAccountId]).sort((a, b) => new Date(b.date) - new Date(a.date));
  let ledgerHtml = '<table><thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead><tbody>';
  relevantTx.forEach(tx => {
    const account = accountsById[tx.kwspAccountId];
    ledgerHtml += '<tr><td>' + escapeHtml(tx.date) + '</td><td>' + (account ? escapeHtml(account.name) : '-') + '</td><td>' + escapeHtml(tx.type) + '</td><td>' + formatCurrency(tx.amount, account && account.currency) + '</td><td>' + (escapeHtml(tx.notes) || '-') + '</td></tr>';
  });
  ledgerHtml += '</tbody></table>';
  printWindow.document.write(ledgerHtml);

  finishPrintWindow(printWindow);
}

async function printKwspAccountReport(accountId) {
  if (!accountId) return;
  const account = await encGet('kwspAccounts', accountId);
  if (!account) return;
  const transactions = await encGetAll('kwspTransactions');
  const m = calcKwspMetrics(account, transactions);
  const extraStyle = '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}';
  const printWindow = openReportWindow('KWSP — ' + account.name, extraStyle);
  printWindow.document.write('<h1>' + escapeHtml(account.name) + '</h1>');
  printWindow.document.write('<p>Currency: ' + account.currency + ' | Generated: ' + new Date().toLocaleDateString() + '</p>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Current Balance', formatCurrency(m.balance, account.currency)));
  printWindow.document.write(statCardHtml('Employee Contrib.', formatCurrency(m.employeeContrib, account.currency)));
  printWindow.document.write(statCardHtml('Employer Contrib.', formatCurrency(m.employerContrib, account.currency)));
  printWindow.document.write(statCardHtml('Dividends', formatCurrency(m.totalDividends, account.currency)));
  printWindow.document.write(statCardHtml('Withdrawals', formatCurrency(m.totalWithdrawals, account.currency)));
  printWindow.document.write(statCardHtml('Return %', m.returnPct.toFixed(2) + '%', m.returnPct));
  printWindow.document.write('</div>');
  printWindow.document.write('<h2>Transactions</h2>');
  const acctTx = transactions.filter(t => t.kwspAccountId === accountId).sort((a, b) => new Date(b.date) - new Date(a.date));
  printWindow.document.write(txHistoryTableHtml(acctTx, account.currency));
  finishPrintWindow(printWindow);
}

// ==================== FIXED DEPOSIT ====================
let fdViewMode = loadViewMode('utt-fd-view', 'card');
let fdOwnerFilter = loadViewMode('utt-fd-owner-filter', 'All');
let currentFdId = null;

function calcFdMaturityFromTenure() {
  const placement = document.getElementById('fdPlacementDate').value;
  const tenure = parseFloat(document.getElementById('fdTenureMonths').value);
  if (!placement || !tenure) return;
  const d = new Date(placement + 'T00:00:00');
  d.setMonth(d.getMonth() + tenure);
  document.getElementById('fdMaturityDate').value = d.toISOString().split('T')[0];
}

// ==================== ATTACHMENT VIEWER ====================
// In-app viewer for receipt/PDF attachments stored as base64 data URLs.
// Deliberately does NOT navigate to the data: URL or embed it in an iframe:
// - Navigating a link straight to a data: URL makes most browsers treat it
//   as a download rather than something to view.
// - iframes showing a data: PDF render blank in some browsers, and can be
//   blocked outright by the browser's own PDF-handling setting regardless.
// Instead, PDFs are decoded and rendered page-by-page onto <canvas> via
// pdf.js, and images are shown via a Blob object URL. A "Save a Copy" link
// is kept separate so the file can still be downloaded under its real name
// when that's what someone actually wants.
let avObjectUrls = []; // object URLs created for the currently-open attachment — revoked on close/replace

function dataURLtoUint8Array(dataUrl) {
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dataURLtoBlob(dataUrl) {
  const header = dataUrl.substring(0, dataUrl.indexOf(','));
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  return new Blob([dataURLtoUint8Array(dataUrl)], { type: mime });
}

// att: { name, type, data } — data is the base64 data: URL as stored in IndexedDB
async function openAttachmentViewer(att) {
  avObjectUrls.forEach(url => URL.revokeObjectURL(url));
  avObjectUrls = [];

  document.getElementById('avTitle').textContent = att.name || 'Attachment';
  const saveBtn = document.getElementById('avSaveCopyBtn');
  saveBtn.setAttribute('download', att.name || 'attachment');
  saveBtn.href = att.data;

  const content = document.getElementById('avContent');
  content.innerHTML = '<div style="padding: 40px; color: #718096;">Loading…</div>';
  document.getElementById('attachmentViewerModal').classList.add('active');

  const isImage = att.type && att.type.startsWith('image/');
  const isPdf = att.type === 'application/pdf' || /\.pdf$/i.test(att.name || '');

  try {
    if (isImage) {
      const blob = dataURLtoBlob(att.data);
      const url = URL.createObjectURL(blob);
      avObjectUrls.push(url);
      content.innerHTML = '';
      const img = document.createElement('img');
      img.src = url;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      content.appendChild(img);
    } else if (isPdf) {
      const pdfjsLib = await window.pdfjsLibReady; // pdf.js is loaded async (ESM-only build) — see js/pdf-loader.js
      const bytes = dataURLtoUint8Array(att.data);
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      content.innerHTML = '';
      const containerWidth = content.clientWidth || 800;
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.1, (containerWidth - 20) / unscaledViewport.width);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto 12px';
        canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
        content.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } else {
      content.innerHTML = '<div style="padding: 40px; color: #718096;">Preview not available for this file type — use "Save a Copy" to download it.</div>';
    }
  } catch (e) {
    content.innerHTML = '<div style="padding: 40px; color: #e53e3e;">Could not preview this file: ' + escapeHtml(e.message) + '</div>';
  }
}

function closeAttachmentViewer() {
  document.getElementById('attachmentViewerModal').classList.remove('active');
  avObjectUrls.forEach(url => URL.revokeObjectURL(url));
  avObjectUrls = [];
  document.getElementById('avContent').innerHTML = '';
}

let fdAttachmentsPending = []; // newly staged files this session: [{name, type, data}, ...]
let fdExistingAttachments = []; // attachments already saved on the FD being edited
let fdRemovedExistingIndexes = new Set(); // indexes into fdExistingAttachments marked for removal

// Handles both the new `attachments` array format and the older single-attachment fields, for FDs saved before this feature existed
function getFdAttachmentsList(fd) {
  if (fd.attachments && Array.isArray(fd.attachments)) return fd.attachments;
  if (fd.attachmentData) return [{ name: fd.attachmentName, type: fd.attachmentType, data: fd.attachmentData }];
  return [];
}

// FD-specific glue: looks up the attachment by index on a given FD and opens it in the viewer
async function openFdAttachment(fdId, index) {
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) { showToast('This deposit has been deleted'); return; }
  const att = getFdAttachmentsList(fd)[index];
  if (!att) { showToast('Attachment not found'); return; }
  openAttachmentViewer(att);
}

function handleFdAttachmentSelect(event) {
  const files = Array.from(event.target.files || []);
  files.forEach(file => {
    if (file.size > 8 * 1024 * 1024) { showToast('Skipped ' + file.name + ' — over 8MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      fdAttachmentsPending.push({ name: file.name, type: file.type, data: reader.result });
      renderFdAttachmentPreview();
    };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function renderFdAttachmentPreview() {
  const container = document.getElementById('fdAttachmentPreview');
  let html = '';
  fdExistingAttachments.forEach((att, i) => {
    if (fdRemovedExistingIndexes.has(i)) return;
    html += '<div style="margin-top:4px;">📎 ' + escapeHtml(att.name) + ' <a href="#" data-action="removeFdExistingAttachment" data-arg="' + i + '" style="color:#e53e3e;">Remove</a></div>';
  });
  fdAttachmentsPending.forEach((att, i) => {
    html += '<div style="margin-top:4px;">📎 ' + escapeHtml(att.name) + ' <span style="color:#48bb78;">(new)</span> <a href="#" data-action="removeFdPendingAttachment" data-arg="' + i + '" style="color:#e53e3e;">Remove</a></div>';
  });
  container.innerHTML = html || '<span style="color:#a0aec0;">No attachments</span>';
}

function removeFdExistingAttachment(index) {
  fdRemovedExistingIndexes.add(index);
  renderFdAttachmentPreview();
}
function removeFdPendingAttachment(index) {
  fdAttachmentsPending.splice(index, 1);
  renderFdAttachmentPreview();
}

function calcFdInterest(fd) {
  const days = (new Date(fd.maturityDate) - new Date(fd.placementDate)) / (1000 * 60 * 60 * 24);
  const years = days / 365;
  return (parseFloat(fd.principal) || 0) * ((parseFloat(fd.interestRate) || 0) / 100) * Math.max(years, 0);
}

// Estimated interest for one payout period, for FDs that pay interest monthly / half-yearly instead of at maturity
function calcFdInterimInterestEstimate(fd) {
  const principal = parseFloat(fd.principal) || 0;
  const rate = (parseFloat(fd.interestRate) || 0) / 100;
  if (fd.payoutFrequency === 'monthly') return principal * rate / 12;
  if (fd.payoutFrequency === 'halfyearly') return principal * rate / 2;
  return 0;
}

function fdPayoutFrequencyLabel(fd) {
  if (fd.payoutFrequency === 'monthly') return 'Monthly';
  if (fd.payoutFrequency === 'halfyearly') return 'Half-Yearly';
  return 'Upon Maturity';
}

function fdDaysToMaturity(fd) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maturity = new Date(fd.maturityDate);
  return Math.round((maturity - today) / (1000 * 60 * 60 * 24));
}

function isFdOverdue(fd) { return fd.status === 'Active' && fdDaysToMaturity(fd) < 0; }
function isFdMaturingSoon(fd) { const d = fdDaysToMaturity(fd); return fd.status === 'Active' && d >= 0 && d <= 30; }

function fdMaturityStatusText(fd) {
  if (fd.status === 'Renewed') return '🔄 Renewed into a new term';
  if (fd.status === 'Closed') return '✅ Closed (withdrawn)';
  if (fd.status !== 'Active') return 'Matured (processed)'; // legacy fallback for records created before Renewed/Closed existed
  const d = fdDaysToMaturity(fd);
  if (d < 0) return '⚠️ Matured ' + Math.abs(d) + ' day' + (Math.abs(d) !== 1 ? 's' : '') + ' ago — needs processing';
  if (d === 0) return '⚠️ Matures today';
  return 'Matures in ' + d + ' day' + (d !== 1 ? 's' : '');
}

async function renderFdAll() {
  await renderFdOwnerFilterOptions();
  await renderFdDashboard();
  await renderFdAccounts();
  await renderFdMaturityRecords();
  await renderFdInterestByYear();
}

async function renderFdOwnerFilterOptions() {
  const select = document.getElementById('fd-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (fdOwnerFilter === 'All' || members.some(m => String(m.id) === String(fdOwnerFilter))) ? fdOwnerFilter : 'All';
}

function setFdOwnerFilter(owner) {
  fdOwnerFilter = owner;
  saveViewMode('utt-fd-owner-filter', owner);
  renderFdDashboard();
  renderFdAccounts();
  renderFdMaturityRecords();
  renderFdInterestByYear();
}

function setFdView(mode) {
  fdViewMode = mode;
  saveViewMode('utt-fd-view', mode);
  document.getElementById('fd-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('fd-view-list-btn').classList.toggle('active', mode === 'list');
  renderFdAccounts();
}

async function renderFdDashboard() {
  let deposits = await encGetAll('fixedDeposits');
  const records = await encGetAll('fdMaturityRecords');
  const interimPayouts = await encGetAll('fdInterestPayouts');
  if (fdOwnerFilter !== 'All') { const fid = parseInt(fdOwnerFilter); deposits = deposits.filter(f => (f.ownerIds || []).includes(fid)); }
  const activeDeposits = deposits.filter(f => f.status === 'Active');
  let totalPrincipal = 0;
  activeDeposits.forEach(fd => { totalPrincipal += toBase(fd.principal, fd.currency); });
  const relevantIds = new Set(deposits.map(f => f.id));
  const depositsById = {}; deposits.forEach(f => { depositsById[f.id] = f; });
  const currentYear = new Date().getFullYear();
  let totalInterest = 0;
  records.filter(r => relevantIds.has(r.fixedDepositId) && new Date(r.maturityDate).getFullYear() === currentYear).forEach(r => { totalInterest += toBase(r.interestEarned, r.currency); });
  interimPayouts.filter(p => relevantIds.has(p.fixedDepositId) && new Date(p.date).getFullYear() === currentYear).forEach(p => {
    const cur = depositsById[p.fixedDepositId] ? depositsById[p.fixedDepositId].currency : undefined;
    totalInterest += toBase(p.amount, cur);
  });
  const maturingSoon = activeDeposits.filter(isFdMaturingSoon).length;
  const overdue = activeDeposits.filter(isFdOverdue).length;
  document.getElementById('fd-total-principal').textContent = formatCurrency(totalPrincipal);
  document.getElementById('fd-active-count').textContent = activeDeposits.length + ' active';
  document.getElementById('fd-total-interest').textContent = formatCurrency(totalInterest);
  document.getElementById('fd-interest-year-label').textContent = String(currentYear);
  document.getElementById('fd-maturing-soon').textContent = maturingSoon;
  document.getElementById('fd-overdue-count').textContent = overdue;
  document.getElementById('fd-overdue-card').style.display = overdue > 0 ? '' : 'none';
}

async function renderFdAccounts() {
  let deposits = await encGetAll('fixedDeposits');
  const membersById = await membersByIdMap();
  deposits = deposits.filter(f => f.status !== 'Closed');
  if (fdOwnerFilter !== 'All') { const fid = parseInt(fdOwnerFilter); deposits = deposits.filter(f => (f.ownerIds || []).includes(fid)); }
  deposits.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
  const grid = document.getElementById('fd-grid');
  const empty = document.getElementById('fd-empty');
  if (deposits.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (fdViewMode === 'list') {
    grid.className = '';
    grid.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Bank</th><th>Owner</th><th>Principal</th><th>Rate</th><th>Placement</th><th>Maturity</th><th>Auto-Renew</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>` + deposits.map(fd => {
      const overdue = isFdOverdue(fd);
      return `<tr style="${overdue ? 'background:#fff5f5;' : ''}">
        <td><a href="#" data-action="showFdDetail" data-prevent="1" data-arg="${fd.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(fd.bankName)}</a>${getFdAttachmentsList(fd).length > 0 ? ' 📎' : ''}</td>
        <td>${ownerBadgeHtml(fd.ownerIds, membersById)}</td>
        <td>${formatCurrency(fd.principal, fd.currency)}</td>
        <td>${parseFloat(fd.interestRate).toFixed(2)}%</td>
        <td>${escapeHtml(fd.placementDate)}</td>
        <td>${escapeHtml(fd.maturityDate)}</td>
        <td>${fd.autoRenew === true || fd.autoRenew === 'true' ? '✅ Yes' : '❌ No'}</td>
        <td>${fdMaturityStatusText(fd)}</td>
        <td><div class="tx-actions">
          ${fd.status === 'Active' ? `<button class="icon-btn" title="Process Maturity" data-action="openProcessMaturityModal" data-arg="${fd.id}">📜</button>` : ''}
          <button class="icon-btn" title="Edit" data-action="openFdModal" data-arg="${fd.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteFd" data-arg="${fd.id}">🗑️</button>
        </div></td>
      </tr>`;
    }).join('') + `</tbody></table></div>`;
    return;
  }

  grid.className = 'fund-grid';
  grid.innerHTML = deposits.map(fd => {
    const overdue = isFdOverdue(fd);
    const soon = isFdMaturingSoon(fd);
    const badgeColor = fd.status !== 'Active' ? '#a0aec0' : (overdue ? '#e53e3e' : (soon ? '#dd6b20' : '#48bb78'));
    return `<div class="fund-card" style="${overdue ? 'border-color:#feb2b2;' : ''}">
      <div class="actions">
        ${fd.status === 'Active' ? `<button class="icon-btn" title="Process Maturity" data-action="openProcessMaturityModal" data-stop="1" data-arg="${fd.id}">📜</button>` : ''}
        <button class="icon-btn" title="Edit" data-action="openFdModal" data-stop="1" data-arg="${fd.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteFd" data-stop="1" data-arg="${fd.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name"><a href="#" data-action="showFdDetail" data-prevent="1" data-arg="${fd.id}" style="color:#2d3748;text-decoration:none;cursor:pointer;">${escapeHtml(fd.bankName)}</a>${getFdAttachmentsList(fd).length > 0 ? ' <span title="Has attachment">📎</span>' : ''}</div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${escapeHtml(fd.currency)} · ${parseFloat(fd.interestRate).toFixed(2)}% p.a. · ${fd.autoRenew === true || fd.autoRenew === 'true' ? 'Auto-Renew' : 'No Auto-Renew'}</div>
          <div style="margin-top: 6px;">${ownerBadgeHtml(fd.ownerIds, membersById)}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Principal</div><div class="stat-value">${formatCurrency(fd.principal, fd.currency)}</div></div>
        <div class="stat"><div class="stat-label">Est. Interest</div><div class="stat-value positive">${formatCurrency(calcFdInterest(fd), fd.currency)}</div></div>
        <div class="stat"><div class="stat-label">Placement</div><div class="stat-value">${escapeHtml(fd.placementDate)}</div></div>
        <div class="stat"><div class="stat-label">Maturity</div><div class="stat-value">${escapeHtml(fd.maturityDate)}</div></div>
      </div>
      <div style="font-size: 12px; color: ${badgeColor}; margin-top: 8px; font-weight: 600;">${fdMaturityStatusText(fd)}</div>
    </div>`;
  }).join('');
}

async function openFdModal(fdId) {
  document.getElementById('fdModalTitle').textContent = fdId ? 'Edit Fixed Deposit' : 'Add Fixed Deposit';
  document.getElementById('fdId').value = fdId || '';
  fdAttachmentsPending = [];
  fdRemovedExistingIndexes = new Set();
  document.getElementById('fdAttachmentInput').value = '';
  if (fdId) {
    const fd = await encGet('fixedDeposits', fdId);
    document.getElementById('fdBankName').value = fd.bankName;
    document.getElementById('fdPrincipal').value = fd.principal;
    document.getElementById('fdCurrency').value = fd.currency;
    document.getElementById('fdRate').value = fd.interestRate;
    document.getElementById('fdAutoRenew').value = String(fd.autoRenew);
    document.getElementById('fdPlacementDate').value = fd.placementDate;
    document.getElementById('fdTenureMonths').value = fd.tenureMonths || '';
    document.getElementById('fdMaturityDate').value = fd.maturityDate;
    document.getElementById('fdPayoutFrequency').value = fd.payoutFrequency || 'maturity';
    document.getElementById('fdNotes').value = fd.notes || '';
    fdExistingAttachments = getFdAttachmentsList(fd);
    renderFdAttachmentPreview();
    await renderOwnerCheckboxes('fdOwnersList', fd.ownerIds || []);
  } else {
    document.getElementById('fdBankName').value = '';
    document.getElementById('fdPrincipal').value = '';
    document.getElementById('fdCurrency').value = 'MYR';
    document.getElementById('fdRate').value = '';
    document.getElementById('fdAutoRenew').value = 'false';
    document.getElementById('fdPlacementDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('fdTenureMonths').value = '';
    document.getElementById('fdMaturityDate').value = '';
    document.getElementById('fdPayoutFrequency').value = 'maturity';
    document.getElementById('fdNotes').value = '';
    fdExistingAttachments = [];
    renderFdAttachmentPreview();
    await renderOwnerCheckboxes('fdOwnersList', []);
  }
  document.getElementById('fdModal').classList.add('active');
}
function closeFdModal() { document.getElementById('fdModal').classList.remove('active'); }

async function saveFd() {
  const id = document.getElementById('fdId').value;
  const data = {
    bankName: document.getElementById('fdBankName').value,
    principal: parseFloat(document.getElementById('fdPrincipal').value) || 0,
    currency: document.getElementById('fdCurrency').value,
    interestRate: parseFloat(document.getElementById('fdRate').value) || 0,
    autoRenew: document.getElementById('fdAutoRenew').value === 'true',
    placementDate: document.getElementById('fdPlacementDate').value,
    tenureMonths: parseFloat(document.getElementById('fdTenureMonths').value) || null,
    maturityDate: document.getElementById('fdMaturityDate').value,
    payoutFrequency: document.getElementById('fdPayoutFrequency').value || 'maturity',
    notes: document.getElementById('fdNotes').value,
    ownerIds: getCheckedOwnerIds('fdOwnersList')
  };
  if (!data.bankName || !data.placementDate || !data.maturityDate) { showToast('Please fill in bank name, placement date, and maturity date'); return; }
  // Only touch attachment fields if something actually changed — leaves existing attachments untouched otherwise (encUpdate merges over them)
  if (fdAttachmentsPending.length > 0 || fdRemovedExistingIndexes.size > 0) {
    const remainingExisting = fdExistingAttachments.filter((att, i) => !fdRemovedExistingIndexes.has(i));
    data.attachments = [...remainingExisting, ...fdAttachmentsPending];
    // Migrate away from the old single-attachment fields now that this record uses the array format
    data.attachmentName = null; data.attachmentType = null; data.attachmentData = null;
  }
  if (id) {
    await encUpdate('fixedDeposits', parseInt(id), data);
    showToast('Fixed deposit updated!');
  } else {
    data.status = 'Active';
    data.createdAt = new Date();
    await encAdd('fixedDeposits', data);
    showToast('Fixed deposit added!');
  }
  closeFdModal();
  await renderFdAll();
}

async function deleteFd(fdId) {
  if (!confirm('Delete this fixed deposit? Its maturity history records will be kept for reference.')) return;
  await db.fixedDeposits.delete(fdId);
  showToast('Fixed deposit deleted');
  await renderFdAll();
}

async function showFdDetail(fdId) {
  currentFdId = fdId;
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) { showToast('This deposit has been deleted — only its maturity record remains'); return; }
  document.getElementById('fdDetailTitle').textContent = fd.bankName;
  document.getElementById('fdDetailOwner').innerHTML = ownerBadgeHtml(fd.ownerIds, await membersByIdMap());
  document.getElementById('fdd-principal').textContent = formatCurrency(fd.principal, fd.currency);
  document.getElementById('fdd-rate').textContent = parseFloat(fd.interestRate).toFixed(2) + '%';
  document.getElementById('fdd-tenure').textContent = fd.tenureMonths ? (fd.tenureMonths % 12 === 0 ? (fd.tenureMonths / 12) + ' yr' + (fd.tenureMonths / 12 !== 1 ? 's' : '') : fd.tenureMonths + ' mths') : '-';
  document.getElementById('fdd-placement').textContent = fd.placementDate;
  document.getElementById('fdd-maturity').textContent = fd.maturityDate;
  document.getElementById('fdd-payout-frequency').textContent = fdPayoutFrequencyLabel(fd);
  document.getElementById('fdd-autorenew').textContent = (fd.autoRenew === true || fd.autoRenew === 'true') ? '✅ Yes' : '❌ No';
  document.getElementById('fdd-status').textContent = fdMaturityStatusText(fd);
  const attachEl = document.getElementById('fdd-attachment');
  const attachments = getFdAttachmentsList(fd);
  if (attachments.length > 0) {
    attachEl.innerHTML = '<strong>Receipts:</strong><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;">' +
      attachments.map((att, i) => {
        if (att.type && att.type.startsWith('image/')) {
          return '<a href="#" data-action="openFdAttachment" data-arg="' + fd.id + '" data-arg2="' + i + '"><img src="' + att.data + '" style="max-width:150px;max-height:150px;border-radius:8px;border:1px solid #e2e8f0;"></a>';
        }
        // Opens in the in-app viewer rather than navigating to the data: URL directly —
        // browsers treat a direct data: URL navigation as a download, not something to view.
        return '<a href="#" data-action="openFdAttachment" data-arg="' + fd.id + '" data-arg2="' + i + '" style="color:#667eea;align-self:center;">📎 ' + escapeHtml(att.name || 'View attachment') + '</a>';
      }).join('') + '</div>';
  } else {
    attachEl.innerHTML = '';
  }

  const interimSection = document.getElementById('fdd-interim-payouts-section');
  if (fd.payoutFrequency === 'monthly' || fd.payoutFrequency === 'halfyearly') {
    interimSection.style.display = '';
    const payouts = (await encGetAll('fdInterestPayouts')).filter(p => p.fixedDepositId === fdId).sort((a, b) => new Date(b.date) - new Date(a.date));
    const payoutsTable = document.getElementById('fdd-interim-payouts-table');
    if (payouts.length === 0) {
      payoutsTable.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No interest received yet</td></tr>';
    } else {
      payoutsTable.innerHTML = payouts.map(p => `<tr>
        <td>${escapeHtml(p.date)}</td>
        <td class="positive">${formatCurrency(p.amount, fd.currency)}</td>
        <td>${escapeHtml(p.notes || '-')}</td>
        <td><div class="tx-actions">
          <button class="icon-btn" title="Delete" data-action="deleteFdInterestPayout" data-arg="${p.id}">🗑️</button>
        </div></td>
      </tr>`).join('');
    }
  } else {
    interimSection.style.display = 'none';
  }

  const allRecords = await encGetAll('fdMaturityRecords');
  const history = allRecords.filter(r => r.fixedDepositId === fdId).sort((a, b) => new Date(b.maturityDate) - new Date(a.maturityDate));
  const table = document.getElementById('fdd-history-table');
  if (history.length === 0) {
    table.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#a0aec0;">No maturity events yet</td></tr>';
  } else {
    table.innerHTML = history.map(r => `<tr>
      <td>${escapeHtml(r.maturityDate)}</td>
      <td><span style="background:${r.action === 'Renewed' ? '#c6f6d5' : '#fed7d7'};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(r.action)}</span></td>
      <td>${formatCurrency(r.principal, r.currency)}</td>
      <td>${formatCurrency(r.interestEarned, r.currency)}</td>
      <td>${r.action === 'Renewed' ? 'New deposit #' + escapeHtml(r.newFixedDepositId) : formatCurrency(r.payoutAmount, r.currency)}</td>
      <td>${escapeHtml(r.notes || '-')}</td>
    </tr>`).join('');
  }
  document.getElementById('fdDetailModal').classList.add('active');
}

function closeFdDetailModal() {
  document.getElementById('fdDetailModal').classList.remove('active');
  currentFdId = null;
}

async function openFdInterestPayoutModal(fdId) {
  if (!fdId) return;
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) return;
  document.getElementById('fipFdId').value = fdId;
  document.getElementById('fipDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('fipAmount').value = calcFdInterimInterestEstimate(fd).toFixed(2);
  document.getElementById('fipNotes').value = '';
  document.getElementById('fdInterestPayoutModal').classList.add('active');
}

function closeFdInterestPayoutModal() {
  document.getElementById('fdInterestPayoutModal').classList.remove('active');
}

async function saveFdInterestPayout() {
  const fdId = parseInt(document.getElementById('fipFdId').value);
  const date = document.getElementById('fipDate').value;
  const amount = parseFloat(document.getElementById('fipAmount').value) || 0;
  const notes = document.getElementById('fipNotes').value;
  if (!date) { showToast('Please select the date interest was received'); return; }
  await encAdd('fdInterestPayouts', { fixedDepositId: fdId, date, amount, notes, createdAt: new Date() });
  showToast('Interest payout recorded');
  closeFdInterestPayoutModal();
  await showFdDetail(fdId);
  await renderFdDashboard();
  await renderFdInterestByYear();
}

async function deleteFdInterestPayout(payoutId) {
  if (!confirm('Delete this interest payout record?')) return;
  await db.fdInterestPayouts.delete(payoutId);
  showToast('Interest payout deleted');
  if (currentFdId) await showFdDetail(currentFdId);
  await renderFdDashboard();
  await renderFdInterestByYear();
}

function editFdFromDetail() {
  const fdId = currentFdId;
  closeFdDetailModal();
  openFdModal(fdId);
}

async function deleteFdFromDetail() {
  const fdId = currentFdId;
  if (!fdId) return;
  closeFdDetailModal();
  await deleteFd(fdId);
}

async function openProcessMaturityModal(fdId) {
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) return;
  document.getElementById('pmFdId').value = fdId;
  const interest = calcFdInterest(fd);
  document.getElementById('pmSummary').innerHTML =
    '<strong>' + escapeHtml(fd.bankName) + '</strong><br>' +
    'Principal: ' + formatCurrency(fd.principal, fd.currency) + '<br>' +
    'Rate: ' + parseFloat(fd.interestRate).toFixed(2) + '% p.a. over ' + escapeHtml(fd.placementDate) + ' → ' + escapeHtml(fd.maturityDate) + '<br>' +
    'Estimated Interest (simple interest): ' + formatCurrency(interest, fd.currency);
  document.getElementById('pmInterestReceived').value = interest.toFixed(2);
  const isRenew = (fd.autoRenew === true || fd.autoRenew === 'true');
  document.getElementById('pmActionRenew').checked = isRenew;
  document.getElementById('pmActionClose').checked = !isRenew;
  document.getElementById('pmRenewFields').style.display = isRenew ? 'block' : 'none';
  document.getElementById('pmNewRate').value = fd.interestRate;
  document.getElementById('pmNewPrincipal').value = ((parseFloat(fd.principal) || 0) + interest).toFixed(2);
  let newMaturity;
  if (fd.tenureMonths) {
    newMaturity = new Date(fd.maturityDate + 'T00:00:00');
    newMaturity.setMonth(newMaturity.getMonth() + parseFloat(fd.tenureMonths));
  } else {
    const tenureDays = (new Date(fd.maturityDate) - new Date(fd.placementDate)) / (1000 * 60 * 60 * 24);
    newMaturity = new Date(fd.maturityDate);
    newMaturity.setDate(newMaturity.getDate() + tenureDays);
  }
  document.getElementById('pmNewMaturityDate').value = newMaturity.toISOString().split('T')[0];
  document.getElementById('pmNotes').value = '';
  updatePmPayoutSummary(fd);
  document.getElementById('processMaturityModal').classList.add('active');
}

function onPmActionChange() {
  const isRenew = document.getElementById('pmActionRenew').checked;
  document.getElementById('pmRenewFields').style.display = isRenew ? 'block' : 'none';
  updatePmPayoutSummaryFromForm();
}

function onPmInterestChange() {
  updatePmPayoutSummaryFromForm();
}

async function updatePmPayoutSummaryFromForm() {
  const fdId = parseInt(document.getElementById('pmFdId').value);
  const fd = await encGet('fixedDeposits', fdId);
  if (fd) updatePmPayoutSummary(fd);
}

function updatePmPayoutSummary(fd) {
  const interest = parseFloat(document.getElementById('pmInterestReceived').value) || 0;
  const payout = (parseFloat(fd.principal) || 0) + interest;
  const isRenew = document.getElementById('pmActionRenew').checked;
  document.getElementById('pmPayoutSummary').innerHTML = isRenew
    ? 'This deposit will be marked <strong>Renewed</strong> and a new deposit created with the principal shown above.'
    : 'This deposit will be marked <strong>Closed</strong>. Total payout: <strong>' + formatCurrency(payout, fd.currency) + '</strong>';
}

function closeProcessMaturityModal() { document.getElementById('processMaturityModal').classList.remove('active'); }

async function confirmProcessMaturity() {
  const fdId = parseInt(document.getElementById('pmFdId').value);
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) return;
  const interest = parseFloat(document.getElementById('pmInterestReceived').value) || 0;
  const renew = document.getElementById('pmActionRenew').checked;
  const notes = document.getElementById('pmNotes').value;

  if (renew) {
    const newPrincipal = parseFloat(document.getElementById('pmNewPrincipal').value) || (parseFloat(fd.principal) + interest);
    const newRate = parseFloat(document.getElementById('pmNewRate').value) || fd.interestRate;
    const newMaturityDate = document.getElementById('pmNewMaturityDate').value;
    const newFdId = await encAdd('fixedDeposits', {
      bankName: fd.bankName,
      principal: newPrincipal,
      currency: fd.currency,
      interestRate: newRate,
      autoRenew: fd.autoRenew,
      placementDate: fd.maturityDate,
      tenureMonths: fd.tenureMonths || null,
      payoutFrequency: fd.payoutFrequency || 'maturity',
      maturityDate: newMaturityDate,
      ownerIds: fd.ownerIds || [],
      notes: fd.notes || '',
      status: 'Active',
      createdAt: new Date()
    });
    await encUpdate('fixedDeposits', fdId, { status: 'Renewed' });
    await encAdd('fdMaturityRecords', {
      fixedDepositId: fdId, bankName: fd.bankName, maturityDate: fd.maturityDate, action: 'Renewed',
      principal: fd.principal, interestEarned: interest, newFixedDepositId: newFdId, currency: fd.currency,
      notes: notes, createdAt: new Date()
    });
    showToast('Deposit renewed into a new term');
  } else {
    const payout = (parseFloat(fd.principal) || 0) + interest;
    await encUpdate('fixedDeposits', fdId, { status: 'Closed' });
    await encAdd('fdMaturityRecords', {
      fixedDepositId: fdId, bankName: fd.bankName, maturityDate: fd.maturityDate, action: 'Withdrawn',
      principal: fd.principal, interestEarned: interest, payoutAmount: payout, currency: fd.currency,
      notes: notes, createdAt: new Date()
    });
    showToast('Deposit withdrawn and closed');
  }
  closeProcessMaturityModal();
  await renderFdAll();
}

async function renderFdMaturityRecords() {
  let records = await encGetAll('fdMaturityRecords');
  const allDeposits = await encGetAll('fixedDeposits');
  const existingFdIds = new Set(allDeposits.map(f => f.id));
  if (fdOwnerFilter !== 'All') {
    const fid = parseInt(fdOwnerFilter);
    const ownedIds = new Set(allDeposits.filter(f => (f.ownerIds || []).includes(fid)).map(f => f.id));
    records = records.filter(r => ownedIds.has(r.fixedDepositId));
  }
  const tbody = document.getElementById('fd-maturity-body');
  if (!tbody) return;
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#a0aec0;">No maturity events recorded yet</td></tr>';
    return;
  }
  const sorted = records.slice().sort((a, b) => new Date(b.maturityDate) - new Date(a.maturityDate));
  tbody.innerHTML = sorted.map(r => {
    const stillExists = existingFdIds.has(r.fixedDepositId);
    const bankCell = stillExists
      ? `<a href="#" data-action="showFdDetail" data-prevent="1" data-arg="${r.fixedDepositId}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(r.bankName)}</a>`
      : `${escapeHtml(r.bankName)} <span style="color:#a0aec0;font-size:11px;">(deposit deleted)</span>`;
    return `<tr>
    <td>${escapeHtml(r.maturityDate)}</td>
    <td>${bankCell}</td>
    <td><span style="background:${r.action === 'Renewed' ? '#c6f6d5' : '#fed7d7'};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(r.action)}</span></td>
    <td>${formatCurrency(r.principal, r.currency)}</td>
    <td class="positive">${formatCurrency(r.interestEarned, r.currency)}</td>
    <td>${r.action === 'Renewed' ? 'New deposit #' + escapeHtml(r.newFixedDepositId) : formatCurrency(r.payoutAmount, r.currency)}</td>
    <td>${escapeHtml(r.notes || '-')}</td>
  </tr>`;
  }).join('');
}

async function renderFdInterestByYear() {
  let records = await encGetAll('fdMaturityRecords');
  let interimPayouts = await encGetAll('fdInterestPayouts');
  const allDeposits = await encGetAll('fixedDeposits');
  const depositsById = {}; allDeposits.forEach(f => { depositsById[f.id] = f; });
  if (fdOwnerFilter !== 'All') {
    const fid = parseInt(fdOwnerFilter);
    const ownedIds = new Set(allDeposits.filter(f => (f.ownerIds || []).includes(fid)).map(f => f.id));
    records = records.filter(r => ownedIds.has(r.fixedDepositId));
    interimPayouts = interimPayouts.filter(p => ownedIds.has(p.fixedDepositId));
  }
  const container = document.getElementById('fd-interest-by-year');
  if (!container) return;
  if (records.length === 0 && interimPayouts.length === 0) { container.innerHTML = ''; return; }
  const byYear = {};
  records.forEach(r => {
    const year = new Date(r.maturityDate).getFullYear();
    if (!byYear[year]) byYear[year] = { total: 0, count: 0 };
    byYear[year].total += toBase(r.interestEarned, r.currency);
    byYear[year].count += 1;
  });
  interimPayouts.forEach(p => {
    const year = new Date(p.date).getFullYear();
    if (!byYear[year]) byYear[year] = { total: 0, count: 0 };
    const cur = depositsById[p.fixedDepositId] ? depositsById[p.fixedDepositId].currency : undefined;
    byYear[year].total += toBase(p.amount, cur);
    byYear[year].count += 1;
  });
  const years = Object.keys(byYear).sort((a, b) => b - a);
  container.innerHTML = '<h4 style="margin:0 0 10px;color:#4a5568;font-size:14px;">Interest Earned by Year</h4>' +
    '<div class="table-scroll"><table style="max-width:500px;">' +
    '<thead><tr><th>Year</th><th>Total Interest Earned</th><th>Payout Events</th></tr></thead><tbody>' +
    years.map(y => `<tr><td>${y}</td><td class="positive">${formatCurrency(byYear[y].total)}</td><td>${byYear[y].count}</td></tr>`).join('') +
    '</tbody></table></div>';
}

async function printFdReport(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const extraStyle = '@page { size: auto; margin: 15mm; }' +
    '@media print { @page { size: landscape; } }' +
    'body{padding:20px;font-size:11pt;max-width:100%;margin:0;}' +
    'table{font-size:9pt;}' +
    'th,td{padding:6px 8px;}' +
    '.stats{grid-template-columns:repeat(6,1fr);}' +
    '.stat-card{padding:12px 8px;}' +
    '.stat-card h3{font-size:8pt;text-transform:uppercase;}' +
    '.stat-card .value{font-size:14pt;}' +
    '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}';
  const reportTitle = 'Fixed Deposit Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, extraStyle);
  const base = getBaseCurrency();
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency: ' + base + (ownerName ? ' &nbsp;|&nbsp; Owner: ' + ownerName : '') + '</div>');
  const allDeposits = await encGetAll('fixedDeposits');
  const deposits = ownerFilter === 'All' ? allDeposits : allDeposits.filter(f => (f.ownerIds || []).includes(parseInt(ownerFilter)));
  if (deposits.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No fixed deposits found for this owner.</p>');
    finishPrintWindow(printWindow);
    return;
  }
  const activeDeposits = deposits.filter(f => f.status === 'Active');
  let totalPrincipal = 0;
  activeDeposits.forEach(fd => { totalPrincipal += toBase(fd.principal, fd.currency); });
  const allRecords = await encGetAll('fdMaturityRecords');
  const depositIds = new Set(deposits.map(f => f.id));
  const relevantRecords = allRecords.filter(r => depositIds.has(r.fixedDepositId));
  let totalInterest = 0;
  relevantRecords.forEach(r => { totalInterest += toBase(r.interestEarned, r.currency); });

  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Total Principal (Active)', formatCurrency(totalPrincipal)));
  printWindow.document.write(statCardHtml('Total Interest Earned', formatCurrency(totalInterest)));
  printWindow.document.write(statCardHtml('Active Deposits', activeDeposits.length));
  printWindow.document.write(statCardHtml('Total Deposits', deposits.length));
  printWindow.document.write('</div>');

  printWindow.document.write('<h2>Deposits</h2>');
  const visibleDeposits = deposits.filter(f => f.status !== 'Closed');
  printWindow.document.write('<table class="holdings-table"><colgroup><col style="width:22%"><col style="width:13%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:9%"><col style="width:9%"></colgroup><thead><tr><th>Bank</th><th>Principal</th><th>Rate</th><th>Placement</th><th>Maturity</th><th>Auto-Renew</th><th>Status</th><th>Est. Interest</th></tr></thead><tbody>');
  visibleDeposits.forEach(fd => {
    printWindow.document.write('<tr><td>' + escapeHtml(fd.bankName) + '</td><td class="nowrap">' + formatCurrency(fd.principal, fd.currency) + '</td><td class="nowrap">' + parseFloat(fd.interestRate).toFixed(2) + '%</td><td class="nowrap">' + escapeHtml(fd.placementDate) + '</td><td class="nowrap">' + escapeHtml(fd.maturityDate) + '</td><td class="nowrap">' + ((fd.autoRenew === true || fd.autoRenew === 'true') ? 'Yes' : 'No') + '</td><td class="nowrap">' + escapeHtml(fd.status) + '</td><td class="nowrap">' + formatCurrency(calcFdInterest(fd), fd.currency) + '</td></tr>');
  });
  printWindow.document.write('</tbody></table>');

  printWindow.document.write('<h2>Maturity Records</h2>');
  const byYear = {};
  relevantRecords.forEach(r => {
    const year = new Date(r.maturityDate).getFullYear();
    if (!byYear[year]) byYear[year] = { total: 0, count: 0 };
    byYear[year].total += toBase(r.interestEarned, r.currency);
    byYear[year].count += 1;
  });
  const years = Object.keys(byYear).sort((a, b) => b - a);
  if (years.length > 0) {
    printWindow.document.write('<h3 style="font-size:12pt;margin-bottom:8px;">Interest Earned by Year</h3>');
    let yearHtml = '<table style="max-width:500px;"><thead><tr><th>Year</th><th>Total Interest Earned</th><th>Maturity Events</th></tr></thead><tbody>';
    years.forEach(y => { yearHtml += '<tr><td>' + y + '</td><td>' + formatCurrency(byYear[y].total) + '</td><td>' + byYear[y].count + '</td></tr>'; });
    yearHtml += '</tbody></table>';
    printWindow.document.write(yearHtml);
  }
  const sortedRecords = relevantRecords.slice().sort((a, b) => new Date(b.maturityDate) - new Date(a.maturityDate));
  let recHtml = '<table><thead><tr><th>Maturity Date</th><th>Bank</th><th>Action</th><th>Principal</th><th>Interest Earned</th><th>Payout / New Deposit</th><th>Notes</th></tr></thead><tbody>';
  sortedRecords.forEach(r => {
    recHtml += '<tr><td>' + escapeHtml(r.maturityDate) + '</td><td>' + escapeHtml(r.bankName) + '</td><td>' + escapeHtml(r.action) + '</td><td>' + formatCurrency(r.principal, r.currency) + '</td><td>' + formatCurrency(r.interestEarned, r.currency) + '</td><td>' + (r.action === 'Renewed' ? 'New deposit #' + escapeHtml(r.newFixedDepositId) : formatCurrency(r.payoutAmount, r.currency)) + '</td><td>' + (escapeHtml(r.notes) || '-') + '</td></tr>';
  });
  recHtml += '</tbody></table>';
  printWindow.document.write(recHtml);

  finishPrintWindow(printWindow);
}

async function printFdSingleReport(fdId) {
  if (!fdId) return;
  const fd = await encGet('fixedDeposits', fdId);
  if (!fd) return;
  const extraStyle = '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}';
  const printWindow = openReportWindow('Fixed Deposit — ' + fd.bankName, extraStyle);
  printWindow.document.write('<h1>' + escapeHtml(fd.bankName) + '</h1>');
  printWindow.document.write('<p>Currency: ' + fd.currency + ' | Generated: ' + new Date().toLocaleDateString() + '</p>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Principal', formatCurrency(fd.principal, fd.currency)));
  printWindow.document.write(statCardHtml('Interest Rate', parseFloat(fd.interestRate).toFixed(2) + '%'));
  printWindow.document.write(statCardHtml('Placement Date', fd.placementDate));
  printWindow.document.write(statCardHtml('Maturity Date', fd.maturityDate));
  printWindow.document.write(statCardHtml('Auto-Renew', (fd.autoRenew === true || fd.autoRenew === 'true') ? 'Yes' : 'No'));
  printWindow.document.write(statCardHtml('Status', fd.status));
  printWindow.document.write('</div>');
  printWindow.document.write('<h2>Maturity History</h2>');
  const allRecords = await encGetAll('fdMaturityRecords');
  const history = allRecords.filter(r => r.fixedDepositId === fdId).sort((a, b) => new Date(b.maturityDate) - new Date(a.maturityDate));
  if (history.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No maturity events yet.</p>');
  } else {
    let html = '<table><thead><tr><th>Maturity Date</th><th>Action</th><th>Principal</th><th>Interest Earned</th><th>Payout / New Deposit</th><th>Notes</th></tr></thead><tbody>';
    history.forEach(r => {
      html += '<tr><td>' + escapeHtml(r.maturityDate) + '</td><td>' + escapeHtml(r.action) + '</td><td>' + formatCurrency(r.principal, r.currency) + '</td><td>' + formatCurrency(r.interestEarned, r.currency) + '</td><td>' + (r.action === 'Renewed' ? 'New deposit #' + escapeHtml(r.newFixedDepositId) : formatCurrency(r.payoutAmount, r.currency)) + '</td><td>' + (escapeHtml(r.notes) || '-') + '</td></tr>';
    });
    html += '</tbody></table>';
    printWindow.document.write(html);
  }
  finishPrintWindow(printWindow);
}

// ==================== PRINT HELPERS ====================
// Shared by all three print/report functions below so report styling and
// table markup only has to be maintained in one place.
function printBaseStyles() {
  return 'body{font-family:Arial,sans-serif;padding:40px;max-width:800px;margin:0 auto;}' +
    'h1{color:#667eea;}h2{color:#4a5568;margin-top:30px;}' +
    'table{width:100%;border-collapse:collapse;margin-top:15px;}' +
    'th,td{padding:10px;text-align:left;border-bottom:1px solid #e2e8f0;}' +
    'th{background:#f7fafc;font-weight:600;}' +
    '.stats{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:15px;margin:20px 0;}' +
    '.stat-card{background:#f7fafc;padding:15px;border-radius:10px;text-align:center;}' +
    '.stat-card h3{font-size:12px;color:#718096;margin-bottom:6px;}' +
    '.stat-card .value{font-size:20px;font-weight:bold;color:#2d3748;}' +
    '.positive{color:#48bb78;}.negative{color:#f56565;}';
}

// label, display value, and (optionally) a raw number used only to pick the positive/negative class
function statCardHtml(label, value, plNumber) {
  const cls = plNumber === undefined ? '' : (plNumber >= 0 ? 'positive' : 'negative');
  return '<div class="stat-card"><h3>' + label + '</h3><div class="value ' + cls + '">' + value + '</div></div>';
}

function txHistoryTableHtml(transactions, currency) {
  let html = '<table><thead><tr><th>Date</th><th>Type</th><th>Units</th><th>Price</th><th>Amount</th><th>Notes</th></tr></thead><tbody>';
  transactions.forEach(tx => {
    html += '<tr><td>' + escapeHtml(tx.date) + '</td><td>' + escapeHtml(tx.type) + '</td><td>' + (tx.units ? escapeHtml(tx.units) : '-') + '</td><td>' + (tx.price ? formatCurrency(tx.price, currency) : '-') + '</td><td>' + formatCurrency(tx.amount, currency) + '</td><td>' + (escapeHtml(tx.notes) || '-') + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

function openReportWindow(title, extraStyle) {
  const printWindow = window.open('', '_blank');
  printWindow.document.write('<html><head><title>' + title + '</title><style>' + printBaseStyles() + (extraStyle || '') + '</style></head><body>');
  return printWindow;
}

function finishPrintWindow(printWindow) {
  // NOTE: this popup's CSP is inherited from the main app document (browsers
  // apply "local scheme inheritance" to about:blank windows opened via
  // window.open()), so — like the rest of the app since the v9 refactor —
  // it can't use an inline onclick="..." attribute here either. The button
  // is wired up with a real addEventListener call below instead, which
  // isn't restricted by script-src-attr.
  printWindow.document.write('<div class="no-print" style="position:fixed;top:16px;right:16px;z-index:999;"><button id="printReportBtn" style="background:#667eea;color:white;border:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.2);">🖨️ Print</button></div>');
  printWindow.document.write('<style>@media print { .no-print { display: none !important; } }</style>');
  printWindow.document.write('</body></html>');
  printWindow.document.close();
  const btn = printWindow.document.getElementById('printReportBtn');
  if (btn) btn.addEventListener('click', () => printWindow.print());
}

// ==================== PRINT ====================
async function printPortfolioSummary(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const extraStyle = '@page { size: auto; margin: 15mm; }' +
    '@media print { @page { size: landscape; } }' +
    'body{padding:20px;font-size:11pt;}' +
    '.page-break{page-break-before:always;}' +
    'h1{font-size:18pt;margin-bottom:6px;}' +
    '.subtitle{color:#718096;font-size:10pt;margin-bottom:15px;}' +
    'table{font-size:9pt;}' +
    'th,td{padding:6px 8px;}' +
    '.stats{grid-template-columns:repeat(6,1fr);}' +
    '.stat-card{padding:12px 8px;}' +
    '.stat-card h3{font-size:8pt;text-transform:uppercase;}' +
    '.stat-card .value{font-size:14pt;}' +
    '.section-title{font-size:13pt;color:#4a5568;margin:20px 0 8px;font-weight:600;}' +
    '.currency-title{font-size:15pt;color:#667eea;margin:25px 0 4px;font-weight:700;border-bottom:2px solid #667eea;padding-bottom:4px;}' +
    '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}' +
    '.holdings-table .fund-code{font-size:8pt;color:#718096;font-weight:normal;margin-top:2px;}';
  const reportTitle = 'Portfolio Summary Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, extraStyle);
  const base = getBaseCurrency();
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency for converted totals: ' + base + (ownerName ? ' &nbsp;|&nbsp; Owner: ' + ownerName : '') + '</div>');
  encGetAll('funds').then(allFunds => {
    const funds = ownerFilter === 'All' ? allFunds : allFunds.filter(f => (f.ownerIds || []).includes(parseInt(ownerFilter)));
    encGetAll('transactions').then(transactions => {
      if (funds.length === 0) {
        printWindow.document.write('<p style="color:#a0aec0;">No funds found for this owner.</p>');
        finishPrintWindow(printWindow);
        return;
      }
      const activeFunds = funds.filter(f => isFundActive(f, transactions));
      const closedFunds = funds.filter(f => !isFundActive(f, transactions));
      const activeGroups = groupFundsByCurrency(activeFunds);
      const closedGroups = groupFundsByCurrency(closedFunds);
      const allCurrencies = Array.from(new Set([...Object.keys(activeGroups), ...Object.keys(closedGroups)])).sort();

      let currentPLBase = 0, currentInvestedBase = 0, closedPLBase = 0, closedInvestedBase = 0;
      let firstSection = true;

      allCurrencies.forEach(cur => {
        const curActive = activeGroups[cur] || [];
        const curClosed = closedGroups[cur] || [];
        if (curActive.length === 0 && curClosed.length === 0) return;
        printWindow.document.write(firstSection ? '' : '<div class="page-break"></div>');
        firstSection = false;
        printWindow.document.write('<div class="currency-title">' + cur + '</div>');

        if (curActive.length > 0) {
          let value = 0, invested = 0, divCheque = 0, firstDate = null;
          curActive.forEach(fund => {
            const m = calcFundMetrics(fund, transactions);
            value += m.currentValue; invested += m.invested; divCheque += m.divCheque;
            if (m.buys.length > 0) { const d = new Date(m.buys[0].date); if (!firstDate || d < firstDate) firstDate = d; }
          });
          const pl = value + divCheque - invested;
          const plPct = invested > 0 ? (pl / invested * 100) : 0;
          let annualised = 0;
          if (firstDate && invested > 0) { const years = (new Date() - firstDate) / (365.25 * 24 * 60 * 60 * 1000); if (years > 0) { annualised = (Math.pow((value + divCheque) / invested, 1 / years) - 1) * 100; } }
          currentPLBase += toBase(pl, cur);
          currentInvestedBase += toBase(invested, cur);

          printWindow.document.write('<div class="section-title">Current Holdings (' + curActive.length + ' fund' + (curActive.length !== 1 ? 's' : '') + ')</div>');
          printWindow.document.write('<div class="stats">');
          printWindow.document.write(statCardHtml('Portfolio Value', formatCurrency(value, cur)));
          printWindow.document.write(statCardHtml('Total Invested', formatCurrency(invested, cur)));
          printWindow.document.write(statCardHtml('P/L', (pl >= 0 ? '+' : '') + formatCurrency(pl, cur), pl));
          printWindow.document.write(statCardHtml('Return %', plPct.toFixed(2) + '%', plPct));
          printWindow.document.write(statCardHtml('Annualised', annualised.toFixed(2) + '%'));
          printWindow.document.write(statCardHtml('Active Funds', curActive.length));
          printWindow.document.write('</div>');

          printWindow.document.write('<table class="holdings-table"><colgroup><col style="width:26%"><col style="width:9%"><col style="width:9%"><col style="width:8%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:6%"><col style="width:6%"><col style="width:6%"></colgroup><thead><tr><th>Fund</th><th>Category</th><th>Units</th><th>NAV</th><th>Value</th><th>Invested</th><th>P/L</th><th>Return</th><th>Annualised</th><th>Holding</th></tr></thead><tbody>');
          curActive.forEach(fund => {
            const m = calcFundMetrics(fund, transactions);
            printWindow.document.write('<tr><td>' + escapeHtml(fund.name) + (fund.code ? '<div class="fund-code">' + escapeHtml(fund.code) + '</div>' : '') + '</td><td>' + escapeHtml(fund.category) + '</td><td class="nowrap">' + m.units.toFixed(4) + '</td><td class="nowrap">' + formatNav(fund.nav) + '</td><td class="nowrap">' + formatCurrency(m.currentValue, cur) + '</td><td class="nowrap">' + formatCurrency(m.invested, cur) + '</td><td class="nowrap ' + (m.pl >= 0 ? 'positive' : 'negative') + '">' + (m.pl >= 0 ? '+' : '') + formatCurrency(m.pl, cur) + '</td><td class="nowrap">' + m.returnPct.toFixed(2) + '%</td><td class="nowrap">' + m.annualised.toFixed(2) + '%</td><td class="nowrap">' + m.yearsHeld + '</td></tr>');
          });
          printWindow.document.write('</tbody></table>');
        }

        if (curClosed.length > 0) {
          let invested = 0, redeemed = 0, divCheque = 0, divReinvest = 0;
          const closedRows = curClosed.map(fund => {
            const fundTx = transactions.filter(t => t.fundId === fund.id).sort((a, b) => new Date(a.date) - new Date(b.date));
            const inv = fundTx.reduce((sum, t) => { if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0); return sum; }, 0);
            const red = fundTx.filter(t => t.type === 'Sell').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
            const divChq = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
            const divRe = fundTx.filter(t => t.type === 'Dividend').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
            const pl = red + divChq - inv;
            const retPct = inv > 0 ? (pl / inv * 100) : 0;
            const lastSell = fundTx.slice().reverse().find(t => t.type === 'Sell');
            invested += inv; redeemed += red; divCheque += divChq; divReinvest += divRe;
            return { fund, inv, red, divChq, divRe, pl, retPct, closedDate: lastSell ? lastSell.date : '-' };
          });
          const closedPL = redeemed + divCheque - invested;
          const closedPLPct = invested > 0 ? (closedPL / invested * 100) : 0;
          closedPLBase += toBase(closedPL, cur);
          closedInvestedBase += toBase(invested, cur);

          printWindow.document.write('<div class="section-title">Closed Funds (' + curClosed.length + ' fund' + (curClosed.length !== 1 ? 's' : '') + ')</div>');
          printWindow.document.write('<div class="stats">');
          printWindow.document.write(statCardHtml('Total Invested', formatCurrency(invested, cur)));
          printWindow.document.write(statCardHtml('Total Redeemed', formatCurrency(redeemed, cur)));
          printWindow.document.write(statCardHtml('Dividends', formatCurrency(divCheque + divReinvest, cur)));
          printWindow.document.write(statCardHtml('Realised P/L', (closedPL >= 0 ? '+' : '') + formatCurrency(closedPL, cur), closedPL));
          printWindow.document.write(statCardHtml('Return %', closedPLPct.toFixed(2) + '%', closedPLPct));
          printWindow.document.write(statCardHtml('Closed Funds', curClosed.length));
          printWindow.document.write('</div>');

          printWindow.document.write('<table class="holdings-table"><colgroup><col style="width:32%"><col style="width:10%"><col style="width:11%"><col style="width:11%"><col style="width:11%"><col style="width:12%"><col style="width:7%"><col style="width:6%"></colgroup><thead><tr><th>Fund</th><th>Category</th><th>Invested</th><th>Redeemed</th><th>Dividends</th><th>Realised P/L</th><th>Return %</th><th>Closed Date</th></tr></thead><tbody>');
          closedRows.forEach(r => {
            printWindow.document.write('<tr><td>' + escapeHtml(r.fund.name) + (r.fund.code ? '<div class="fund-code">' + escapeHtml(r.fund.code) + '</div>' : '') + '</td><td>' + escapeHtml(r.fund.category) + '</td><td class="nowrap">' + formatCurrency(r.inv, cur) + '</td><td class="nowrap">' + formatCurrency(r.red, cur) + '</td><td class="nowrap">' + formatCurrency(r.divChq + r.divRe, cur) + '</td><td class="nowrap ' + (r.pl >= 0 ? 'positive' : 'negative') + '">' + (r.pl >= 0 ? '+' : '') + formatCurrency(r.pl, cur) + '</td><td class="nowrap">' + r.retPct.toFixed(2) + '%</td><td class="nowrap">' + escapeHtml(r.closedDate) + '</td></tr>');
          });
          printWindow.document.write('</tbody></table>');
        }
      });

      // Final page: Overall Investment Outcome, converted to base currency
      const totalPLBase = currentPLBase + closedPLBase;
      const totalInvestedBase = currentInvestedBase + closedInvestedBase;
      const totalReturnPctBase = totalInvestedBase > 0 ? (totalPLBase / totalInvestedBase * 100) : 0;
      const missingRates = allCurrencies.filter(c => !hasRate(c));

      printWindow.document.write('<div class="page-break"></div>');
      printWindow.document.write('<div class="section-title">Overall Investment Outcome (converted to ' + base + ')</div>');
      if (missingRates.length > 0) {
        printWindow.document.write('<p style="color:#dd6b20;font-size:9pt;">⚠️ No exchange rate set for: ' + missingRates.join(', ') + ' — those amounts were treated as 1:1 with ' + base + ' in this total. Set rates via Currency Settings for an accurate figure.</p>');
      }
      printWindow.document.write('<div class="stats">');
      printWindow.document.write(statCardHtml('Current P/L', (currentPLBase >= 0 ? '+' : '') + formatCurrency(currentPLBase), currentPLBase));
      printWindow.document.write(statCardHtml('Closed P/L', (closedPLBase >= 0 ? '+' : '') + formatCurrency(closedPLBase), closedPLBase));
      printWindow.document.write(statCardHtml('Total Outcome', (totalPLBase >= 0 ? '+' : '') + formatCurrency(totalPLBase), totalPLBase));
      printWindow.document.write(statCardHtml('Overall Return %', totalReturnPctBase.toFixed(2) + '%', totalReturnPctBase));
      printWindow.document.write(statCardHtml('Total Invested', formatCurrency(totalInvestedBase)));
      printWindow.document.write(statCardHtml('Total Funds', activeFunds.length + closedFunds.length));
      printWindow.document.write('</div>');

      if (allCurrencies.length > 1) {
        printWindow.document.write('<div class="section-title">By Currency</div>');
        printWindow.document.write('<table><thead><tr><th>Currency</th><th>Funds</th><th>Rate to ' + base + '</th><th>Native P/L</th><th>Converted P/L (' + base + ')</th></tr></thead><tbody>');
        allCurrencies.forEach(cur => {
          const curFunds = [...(activeGroups[cur] || []), ...(closedGroups[cur] || [])];
          let nativePL = 0;
          curFunds.forEach(fund => {
            const isActive = isFundActive(fund, transactions);
            const m = calcFundMetrics(fund, transactions);
            if (isActive) { nativePL += m.pl; }
            else {
              const fundTx = transactions.filter(t => t.fundId === fund.id);
              const inv = fundTx.reduce((sum, t) => { if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0); return sum; }, 0);
              const red = fundTx.filter(t => t.type === 'Sell').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
              const divChq = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
              nativePL += red + divChq - inv;
            }
          });
          const rateLabel = cur === base ? '1 (base)' : (hasRate(cur) ? getRate(cur).toFixed(4) : '⚠️ not set');
          printWindow.document.write('<tr><td>' + cur + '</td><td>' + curFunds.length + '</td><td>' + rateLabel + '</td><td class="' + (nativePL >= 0 ? 'positive' : 'negative') + '">' + (nativePL >= 0 ? '+' : '') + formatCurrency(nativePL, cur) + '</td><td class="' + (nativePL >= 0 ? 'positive' : 'negative') + '">' + (toBase(nativePL, cur) >= 0 ? '+' : '') + formatCurrency(toBase(nativePL, cur)) + '</td></tr>');
        });
        printWindow.document.write('</tbody></table>');
      }

      finishPrintWindow(printWindow);
    });
  });
}


function printFundReport() {
  if (!currentFundId) return;
  const printWindow = openReportWindow('Fund Report');
  encGet('funds', currentFundId).then(fund => {
    encGetAll('transactions').then(transactions => {
      const m = calcFundMetrics(fund, transactions);
      printWindow.document.write('<h1>' + escapeHtml(fund.name) + (fund.code ? ' (' + escapeHtml(fund.code) + ')' : '') + '</h1>');
      printWindow.document.write('<p>Category: ' + escapeHtml(fund.category) + ' | Currency: ' + escapeHtml(fund.currency) + ' | Generated: ' + new Date().toLocaleDateString() + '</p>');
      printWindow.document.write('<div class="stats">');
      printWindow.document.write(statCardHtml('Current Value', formatCurrency(m.currentValue, fund.currency)));
      printWindow.document.write(statCardHtml('Invested', formatCurrency(m.invested, fund.currency)));
      printWindow.document.write(statCardHtml('P/L', (m.pl >= 0 ? '+' : '') + formatCurrency(m.pl, fund.currency), m.pl));
      printWindow.document.write(statCardHtml('Return %', m.returnPct.toFixed(2) + '%', m.returnPct));
      printWindow.document.write(statCardHtml('Annualised', m.annualised.toFixed(2) + '%'));
      printWindow.document.write(statCardHtml('Units', m.units.toFixed(4)));
      printWindow.document.write(statCardHtml('NAV', formatNav(fund.nav)));
      printWindow.document.write(statCardHtml('Holding', m.yearsHeld));
      printWindow.document.write('</div>');
      printWindow.document.write('<h2>Transactions</h2>');
      const fundTx = transactions.filter(t => t.fundId === currentFundId).sort((a, b) => new Date(b.date) - new Date(a.date));
      printWindow.document.write(txHistoryTableHtml(fundTx, fund.currency));
      finishPrintWindow(printWindow);
    });
  });
}

function printClosedFundReport() {
  if (!currentClosedFundId) return;
  const printWindow = openReportWindow('Closed Fund Report');
  encGet('funds', currentClosedFundId).then(fund => {
    encGetAll('transactions').then(transactions => {
      const fundTx = transactions.filter(t => t.fundId === currentClosedFundId).sort((a, b) => new Date(a.date) - new Date(b.date));
      const invested = fundTx.reduce((sum, t) => { if (t.type === 'Buy' || t.type === 'Contribution') return sum + (parseFloat(t.amount) || 0); return sum; }, 0);
      const redeemed = fundTx.filter(t => t.type === 'Sell').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
      const divCheque = fundTx.filter(t => t.type === 'Dividend Cheque').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
      const divReinvest = fundTx.filter(t => t.type === 'Dividend').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
      const realisedPL = redeemed + divCheque - invested;
      const returnPct = invested > 0 ? (realisedPL / invested * 100) : 0;
      const firstBuy = fundTx.find(t => t.type === 'Buy' || t.type === 'Contribution');
      const lastSell = fundTx.slice().reverse().find(t => t.type === 'Sell');
      let holdingPeriod = '-';
      if (firstBuy && lastSell) {
        const years = (new Date(lastSell.date) - new Date(firstBuy.date)) / (365.25 * 24 * 60 * 60 * 1000);
        holdingPeriod = years < 1 ? (years * 12).toFixed(1) + ' mths' : years.toFixed(1) + ' yrs';
      }
      printWindow.document.write('<h1>' + escapeHtml(fund.name) + (fund.code ? ' (' + escapeHtml(fund.code) + ')' : '') + '</h1>');
      printWindow.document.write('<p>Category: ' + escapeHtml(fund.category) + ' | Currency: ' + escapeHtml(fund.currency) + ' | Status: <strong>Closed</strong> | Generated: ' + new Date().toLocaleDateString() + '</p>');
      printWindow.document.write('<div class="stats">');
      printWindow.document.write(statCardHtml('Total Invested', formatCurrency(invested, fund.currency)));
      printWindow.document.write(statCardHtml('Total Redeemed', formatCurrency(redeemed, fund.currency)));
      printWindow.document.write(statCardHtml('Dividends', formatCurrency(divCheque + divReinvest, fund.currency)));
      printWindow.document.write(statCardHtml('Realised P/L', (realisedPL >= 0 ? '+' : '') + formatCurrency(realisedPL, fund.currency), realisedPL));
      printWindow.document.write(statCardHtml('Return %', returnPct.toFixed(2) + '%', returnPct));
      printWindow.document.write(statCardHtml('Holding Period', holdingPeriod));
      printWindow.document.write('</div>');
      printWindow.document.write('<h2>Transaction History</h2>');
      printWindow.document.write(txHistoryTableHtml(fundTx, fund.currency));
      finishPrintWindow(printWindow);
    });
  });
}

// ==================== REAL ESTATE ====================
let reViewMode = loadViewMode('utt-re-view', 'card');
let reOwnerFilter = loadViewMode('utt-re-owner-filter', 'All');
let reCashflowPropertyFilter = loadViewMode('utt-re-cashflow-property-filter', 'All');
let reLoanPropertyFilter = loadViewMode('utt-re-loan-property-filter', 'All');
let currentRePropertyId = null;

// Formats the time elapsed since a manually-entered holding start date as a
// friendly "Xy Ym" (or "Ym" / "Xy") string. Returns null if no date is set.
function formatHoldingPeriod(startDate) {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  if (isNaN(start.getTime())) return null;
  const now = new Date();
  if (start > now) return null;
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  const parts = [];
  if (years > 0) parts.push(years + (years === 1 ? ' year' : ' years'));
  if (months > 0 || years === 0) parts.push(months + (months === 1 ? ' month' : ' months'));
  return parts.join(' ');
}

// Computes a property's mortgage/redraw/equity/cashflow metrics fresh from its
// opening balances + ledger history every time — never a stored/mutated
// balance field. This matches how KWSP/Amanah/FD already compute their
// balances in this app, and it means editing or deleting any ledger entry
// just changes what gets summed next render; there's no separate "reverse
// the old effect" step to get wrong.
function calcRePropertyMetrics(property, loanTx, cashflowTx) {
  const propLoanTx = loanTx.filter(t => t.propertyId === property.id);
  const propCashTx = cashflowTx.filter(t => t.propertyId === property.id);

  let mortgage = parseFloat(property.openingMortgage || 0);
  let redraw = parseFloat(property.openingRedraw || 0);
  let totalInterestPaid = 0, totalServiceFeesPaid = 0;

  propLoanTx.forEach(t => {
    const principal = parseFloat(t.principal || 0);
    const redrawAmt = parseFloat(t.redrawAmount || 0);
    if (t.action === 'REPAYMENT') {
      // Flexi-loan: any repayment reduces the mortgage balance and becomes
      // available to redraw again later.
      mortgage -= principal;
      redraw += principal;
    } else if (t.action === 'BANK_CHARGES') {
      // Bank charges accrue onto the outstanding balance (same as any real
      // loan account statement): balance = loan drawn + charges - repaid.
      const interest = parseFloat(t.interest || 0);
      const fee = parseFloat(t.serviceFee || 0);
      mortgage += interest + fee;
      totalInterestPaid += interest;
      totalServiceFeesPaid += fee;
    } else if (t.action === 'INITIAL_LOAN') {
      mortgage += principal;
    } else if (t.action === 'REDRAW_WITHDRAW') {
      mortgage += redrawAmt;
      redraw -= redrawAmt;
    } else if (t.action === 'REDRAW_DEPOSIT') {
      // Legacy action kept only so older entries (from before this action type
      // was retired) still compute correctly — no longer creatable from the UI.
      mortgage -= redrawAmt;
      redraw += redrawAmt;
    }
  });
  // Not floored at 0 here: a flexi-loan can go into surplus (repaid more than
  // drawn), and that surplus is real — it should reduce equity's debt side
  // and show up as a surplus rather than being silently clamped away.
  const computedRedraw = Math.max(0, redraw);

  // If the user has manually entered a current redraw amount (from their bank
  // statement), that overrides the calculated running total — the real
  // redraw limit reduces over time in ways simple repayment math can't track.
  const hasManualRedraw = property.redrawManualAmount !== null && property.redrawManualAmount !== undefined && property.redrawManualAmount !== '';
  redraw = hasManualRedraw ? parseFloat(property.redrawManualAmount) : computedRedraw;

  const income = propCashTx.filter(t => t.type === 'INCOME').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const expense = propCashTx.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const netCashflow = income - expense;
  const value = parseFloat(property.value || 0);
  const equity = value - mortgage;
  const grossYield = value > 0 ? (parseFloat(property.monthlyRent || 0) * 12 / value * 100) : 0;
  const financingCost = totalInterestPaid + totalServiceFeesPaid;

  return { mortgage, redraw, equity, income, expense, netCashflow, grossYield, financingCost, totalInterestPaid, totalServiceFeesPaid, redrawIsManual: hasManualRedraw, redrawAsOf: hasManualRedraw ? property.redrawManualDate : null };
}

async function renderRealEstateAll() {
  await renderReOwnerFilterOptions();
  await renderReCashflowPropertyFilterOptions();
  await renderReLoanPropertyFilterOptions();
  await renderReDashboard();
  await renderReProperties();
  await renderReCashflowLedger();
  await renderReLoanLedger();
}

async function renderReOwnerFilterOptions() {
  const select = document.getElementById('re-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (reOwnerFilter === 'All' || members.some(m => String(m.id) === String(reOwnerFilter))) ? reOwnerFilter : 'All';
}
function setReOwnerFilter(owner) {
  reOwnerFilter = owner;
  saveViewMode('utt-re-owner-filter', owner);
  renderReDashboard();
  renderReProperties();
}
function setReView(mode) {
  reViewMode = mode;
  saveViewMode('utt-re-view', mode);
  document.getElementById('re-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('re-view-list-btn').classList.toggle('active', mode === 'list');
  renderReProperties();
}

async function renderReCashflowPropertyFilterOptions() {
  const select = document.getElementById('re-cashflow-property-filter');
  if (!select) return;
  const properties = await encGetAll('realEstateProperties');
  select.innerHTML = '<option value="All">🏠 All Properties</option>' + properties.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.value = (reCashflowPropertyFilter === 'All' || properties.some(p => String(p.id) === String(reCashflowPropertyFilter))) ? reCashflowPropertyFilter : 'All';
}
function setReCashflowPropertyFilter(val) {
  reCashflowPropertyFilter = val;
  saveViewMode('utt-re-cashflow-property-filter', val);
  renderReCashflowLedger();
}
async function renderReLoanPropertyFilterOptions() {
  const select = document.getElementById('re-loan-property-filter');
  if (!select) return;
  const properties = await encGetAll('realEstateProperties');
  select.innerHTML = '<option value="All">🏠 All Properties</option>' + properties.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.value = (reLoanPropertyFilter === 'All' || properties.some(p => String(p.id) === String(reLoanPropertyFilter))) ? reLoanPropertyFilter : 'All';
}
function setReLoanPropertyFilter(val) {
  reLoanPropertyFilter = val;
  saveViewMode('utt-re-loan-property-filter', val);
  renderReLoanLedger();
}

async function renderReDashboard() {
  let properties = await encGetAll('realEstateProperties');
  const loanTx = await encGetAll('realEstateLoanTx');
  const cashflowTx = await encGetAll('realEstateTx');
  if (reOwnerFilter !== 'All') { const oid = parseInt(reOwnerFilter); properties = properties.filter(p => (p.ownerIds || []).includes(oid)); }

  let totalValue = 0, totalMortgage = 0, totalRedraw = 0, totalFinancingCost = 0;
  properties.forEach(p => {
    const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
    totalValue += toBase(p.value, p.currency);
    totalMortgage += toBase(m.mortgage, p.currency);
    if (m.redrawIsManual) totalRedraw += toBase(m.redraw, p.currency);
    totalFinancingCost += toBase(m.financingCost, p.currency);
  });
  const netEquity = totalValue - totalMortgage;

  document.getElementById('re-portfolio-value').textContent = formatCurrency(totalValue);
  document.getElementById('re-property-count').textContent = properties.length + ' propert' + (properties.length === 1 ? 'y' : 'ies');
  document.getElementById('re-total-mortgage').textContent = formatCurrency(totalMortgage);
  document.getElementById('re-net-equity').textContent = formatCurrency(netEquity);
  document.getElementById('re-financing-cost').textContent = formatCurrency(totalFinancingCost);
  document.getElementById('re-available-redraw').textContent = formatCurrency(totalRedraw);
}

async function renderReProperties() {
  let properties = await encGetAll('realEstateProperties');
  const loanTx = await encGetAll('realEstateLoanTx');
  const cashflowTx = await encGetAll('realEstateTx');
  const membersById = await membersByIdMap();
  if (reOwnerFilter !== 'All') { const oid = parseInt(reOwnerFilter); properties = properties.filter(p => (p.ownerIds || []).includes(oid)); }
  properties.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const grid = document.getElementById('re-property-grid');
  const empty = document.getElementById('re-empty');
  if (properties.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (reViewMode === 'list') {
    grid.className = '';
    grid.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Name</th><th>Owner</th><th>Type</th><th>Status</th><th>Value</th><th>Mortgage</th><th>Equity</th><th>Actions</th></tr></thead>
      <tbody>` + properties.map(p => {
      const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
      return `<tr>
        <td><a href="#" data-action="showRePropertyDetail" data-prevent="1" data-arg="${p.id}" style="color:#667eea;text-decoration:none;cursor:pointer;font-weight:600;">${escapeHtml(p.name)}</a></td>
        <td>${ownerBadgeHtml(p.ownerIds, membersById)}</td>
        <td>${escapeHtml(p.type || '')}</td>
        <td>${escapeHtml(p.status || '')}</td>
        <td>${formatCurrency(p.value, p.currency)}</td>
        <td>${formatDebtAmount(m.mortgage, p.currency)}</td>
        <td>${formatCurrency(m.equity, p.currency)}</td>
        <td><div class="tx-actions">
          <button class="icon-btn" title="Edit" data-action="openPropertyModal" data-arg="${p.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteReProperty" data-arg="${p.id}">🗑️</button>
        </div></td>
      </tr>`;
    }).join('') + `</tbody></table></div>`;
    return;
  }

  grid.className = 'fund-grid';
  grid.innerHTML = properties.map(p => {
    const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
    return `<div class="fund-card">
      <div class="actions">
        <button class="icon-btn" title="Edit" data-action="openPropertyModal" data-stop="1" data-arg="${p.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteReProperty" data-stop="1" data-arg="${p.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name"><a href="#" data-action="showRePropertyDetail" data-prevent="1" data-arg="${p.id}" style="color:#2d3748;text-decoration:none;cursor:pointer;">${escapeHtml(p.name)}</a></div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${escapeHtml(p.type || '')} · ${escapeHtml(p.status || '')} · ${escapeHtml(p.currency || getBaseCurrency())}</div>
          <div style="margin-top: 6px;">${ownerBadgeHtml(p.ownerIds, membersById)}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Value</div><div class="stat-value">${formatCurrency(p.value, p.currency)}</div></div>
        <div class="stat"><div class="stat-label">Mortgage</div><div class="stat-value">${formatDebtAmount(m.mortgage, p.currency)}</div></div>
        <div class="stat"><div class="stat-label">Equity</div><div class="stat-value positive">${formatCurrency(m.equity, p.currency)}</div></div>
        <div class="stat"><div class="stat-label">Monthly Rent</div><div class="stat-value">${formatCurrency(p.monthlyRent, p.currency)}</div></div>
        <div class="stat"><div class="stat-label">Holding Period</div><div class="stat-value">${formatHoldingPeriod(p.holdingStartDate) || '—'}</div></div>
      </div>
    </div>`;
  }).join('');
}

// Badge shown under the date in the compact Bank Loan & Redraw ledger, and the
// "amount breakdown" cell that replaces the old one-column-per-amount-type
// layout — only the field(s) relevant to that entry's action are listed.
const RE_LOAN_BADGES = {
  REPAYMENT: { label: 'REPAYMENT', cls: 'repayment' },
  BANK_CHARGES: { label: 'CHARGES', cls: 'charges' },
  INITIAL_LOAN: { label: 'INITIAL', cls: 'initial' },
  REDRAW_WITHDRAW: { label: 'REDRAW', cls: 'redraw' },
  REDRAW_DEPOSIT: { label: 'REDRAW', cls: 'redraw' }
};
function reLoanBadgeHtml(action) {
  const b = RE_LOAN_BADGES[action] || { label: action, cls: 'initial' };
  return `<span class="re-date-badge ${b.cls}">${escapeHtml(b.label)}</span>`;
}
function reLoanBreakdownParts(t, cur) {
  const items = [];
  const push = (label, valueHtml) => items.push({ label, valueHtml });
  if (t.action === 'REPAYMENT') {
    push('Repayment', formatCurrency(t.principal, cur));
  } else if (t.action === 'INITIAL_LOAN') {
    push('Loan Amount', formatCurrencyNeg(t.principal, cur));
  } else if (t.action === 'BANK_CHARGES') {
    if (parseFloat(t.interest || 0) !== 0) push('Interest', formatCurrencyNeg(t.interest, cur));
    if (parseFloat(t.serviceFee || 0) !== 0) push('Service Fee', formatCurrencyNeg(t.serviceFee, cur));
    if (!items.length) push('Interest', '-');
  } else if (t.action === 'REDRAW_WITHDRAW') {
    push('Redraw Amount', formatCurrencyNeg(t.redrawAmount, cur));
  } else if (t.action === 'REDRAW_DEPOSIT') {
    push('Redraw Deposit', formatCurrency(t.redrawAmount, cur));
  }
  return items;
}
// Item-labels column: what the entry is (Repayment, Interest, Service Fee...),
// plus the note (if any) underneath.
function reLoanItemColumnHtml(t, cur) {
  const items = reLoanBreakdownParts(t, cur);
  let html = items.map(i => `<div class="re-item-line">${escapeHtml(i.label)}</div>`).join('');
  if (t.notes) html += `<div style="font-size:12px;color:#a0aec0;font-style:italic;margin-top:3px;">📝 ${escapeHtml(t.notes)}</div>`;
  return html;
}
// Amount column: the value(s) for each item above, kept in the same row order
// so they line up with their labels in the adjacent column.
function reLoanAmountColumnHtml(t, cur) {
  const items = reLoanBreakdownParts(t, cur);
  return items.map(i => `<div class="re-amount-line">${i.valueHtml}</div>`).join('');
}

async function renderReCashflowLedger() {
  let tx = await encGetAll('realEstateTx');
  const properties = await encGetAll('realEstateProperties');
  const propsById = {}; properties.forEach(p => propsById[p.id] = p);
  if (reCashflowPropertyFilter !== 'All') { const pid = parseInt(reCashflowPropertyFilter); tx = tx.filter(t => t.propertyId === pid); }
  tx.sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('re-cashflow-body').innerHTML = tx.map(t => {
    const p = propsById[t.propertyId];
    return `<tr>
      <td><div style="font-weight:600;">${escapeHtml(t.date)}</div><span class="re-date-badge ${t.type === 'INCOME' ? 'income' : 'expense'}">${t.type === 'INCOME' ? 'INCOME' : 'EXPENSE'}</span></td>
      <td>${p ? escapeHtml(p.name) : '(deleted)'}</td>
      <td>${escapeHtml(t.category) || ''}</td>
      <td style="color:${t.type === 'INCOME' ? '#48bb78' : '#f56565'};font-weight:600;">${t.type === 'INCOME' ? '+' : '-'}${formatCurrency(t.amount, p ? p.currency : undefined)}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="openReTxModal" data-arg="${t.propertyId}" data-arg2="${t.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteReTx" data-arg="${t.id}">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function renderReLoanLedger() {
  let tx = await encGetAll('realEstateLoanTx');
  const properties = await encGetAll('realEstateProperties');
  const propsById = {}; properties.forEach(p => propsById[p.id] = p);
  if (reLoanPropertyFilter !== 'All') { const pid = parseInt(reLoanPropertyFilter); tx = tx.filter(t => t.propertyId === pid); }
  tx.sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('re-loan-body').innerHTML = tx.map(t => {
    const p = propsById[t.propertyId];
    const cur = p ? p.currency : undefined;
    return `<tr>
      <td><div style="font-weight:600;">${escapeHtml(t.date)}</div>${reLoanBadgeHtml(t.action)}</td>
      <td>${p ? escapeHtml(p.name) : '(deleted)'}</td>
      <td>${reLoanItemColumnHtml(t, cur)}</td>
      <td>${reLoanAmountColumnHtml(t, cur)}</td>
      <td><div class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="openReLoanTxModal" data-arg="${t.propertyId}" data-arg2="${t.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteReLoanTx" data-arg="${t.id}">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

// ---- Purchase breakdown row helpers (property add/edit modal) ----
// Each row carries its own rowId + loanTxId in the DOM (not user-editable
// form fields) so saveReProperty() can tell "this Bank Loan row is already
// synced to the ledger" from "this is a new row", instead of re-creating a
// duplicate ledger tranche every time the property is saved.
function addRePurchaseRow(date = '', category = 'Deposit', particular = '', amount = '', rowId = null, loanTxId = null) {
  const tbody = document.getElementById('rePurchaseBreakdownBody');
  rowId = rowId || (Date.now() + Math.random().toString(36).substring(2, 7));
  const tr = document.createElement('tr');
  tr.id = `re-pb-row-${rowId}`;
  tr.dataset.rowId = rowId;
  tr.dataset.loanTxId = loanTxId || '';
  const inputStyle = 'width:100%;padding:6px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;';
  tr.innerHTML = `
    <td style="padding:4px;"><input type="date" value="${escapeHtml(date)}" class="re-pb-date" style="${inputStyle}"></td>
    <td style="padding:4px;">
      <select class="re-pb-category" data-action="recalculateRePurchaseTotal" style="${inputStyle}">
        <option value="Deposit" ${category === 'Deposit' ? 'selected' : ''}>Deposit</option>
        <option value="Bank Loan" ${category === 'Bank Loan' ? 'selected' : ''}>Bank Loan</option>
        <option value="Credit Note" ${category === 'Credit Note' ? 'selected' : ''}>Credit Note (-)</option>
        <option value="Others" ${category === 'Others' ? 'selected' : ''}>Others</option>
      </select>
    </td>
    <td style="padding:4px;"><input type="text" value="${escapeHtml(particular) || ''}" placeholder="e.g. Deposit / Rebate" class="re-pb-particular" style="${inputStyle}"></td>
    <td style="padding:4px;"><input type="number" step="0.01" value="${escapeHtml(String(amount))}" data-action="recalculateRePurchaseTotal" placeholder="0.00" class="re-pb-amount" style="${inputStyle}text-align:right;"></td>
    <td style="padding:4px;text-align:center;"><button type="button" data-action="removeRePurchaseRow" data-arg="re-pb-row-${rowId}" class="icon-btn" title="Remove">🗑️</button></td>
  `;
  tbody.appendChild(tr);
  recalculateRePurchaseTotal();
}

async function removeRePurchaseRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) {
    const loanTxId = row.dataset.loanTxId ? parseInt(row.dataset.loanTxId) : null;
    if (loanTxId) {
      if (confirm("This row is linked to a Bank Loan ledger entry. Remove that ledger entry too?")) {
        await db.realEstateLoanTx.delete(loanTxId);
      }
    }
    row.remove();
  }
  recalculateRePurchaseTotal();
}

function reCalcTotalFromBreakdown(breakdown) {
  let total = 0;
  breakdown.forEach(item => {
    if (item.category === 'Credit Note') total -= item.amount;
    else total += item.amount;
  });
  return Math.max(0, total);
}

function getRePurchaseBreakdownData() {
  const rows = document.querySelectorAll('#rePurchaseBreakdownBody tr');
  const items = [];
  rows.forEach(r => {
    const date = r.querySelector('.re-pb-date').value;
    const category = r.querySelector('.re-pb-category').value;
    const particular = r.querySelector('.re-pb-particular').value;
    const amount = parseFloat(r.querySelector('.re-pb-amount').value || 0);
    const id = r.dataset.rowId;
    const loanTxId = r.dataset.loanTxId ? parseInt(r.dataset.loanTxId) : null;
    if (particular || amount > 0) items.push({ id, date, category, particular, amount, loanTxId });
  });
  return items;
}

function recalculateRePurchaseTotal() {
  const breakdown = getRePurchaseBreakdownData();
  const value = reCalcTotalFromBreakdown(breakdown);
  const bankLoanSum = breakdown.filter(i => i.category === 'Bank Loan').reduce((s, i) => s + i.amount, 0);
  const currencyEl = document.getElementById('rePropCurrency');
  document.getElementById('rePropValueDisplay').textContent = formatCurrency(value, currencyEl ? currencyEl.value : undefined);
  const idField = document.getElementById('rePropId');
  if (bankLoanSum > 0 && idField && !idField.value) {
    // NOTE: Opening Mortgage Balance is intentionally NOT auto-filled here.
    // Bank Loan rows sync to the loan ledger as their own drawdown tranches
    // (see saveReProperty), which already feed into the computed mortgage
    // balance — auto-filling this field too would double-count them.
    document.getElementById('rePropOriginalLoan').value = bankLoanSum.toFixed(2);
  }
}

// ---- Property CRUD ----
async function openPropertyModal(propId) {
  document.getElementById('rePropertyModalTitle').textContent = propId ? 'Edit Property' : 'Add Property';
  document.getElementById('rePropId').value = propId || '';
  document.getElementById('rePurchaseBreakdownBody').innerHTML = '';

  if (propId) {
    const p = await encGet('realEstateProperties', propId);
    document.getElementById('rePropName').value = p.name || '';
    document.getElementById('rePropCurrency').value = p.currency || getBaseCurrency();
    document.getElementById('rePropType').value = p.type || 'Residential';
    document.getElementById('rePropStatus').value = p.status || 'Rented';
    document.getElementById('rePropHoldingStart').value = p.holdingStartDate || '';
    await renderOwnerCheckboxes('rePropOwnersList', p.ownerIds || []);
    if (p.purchaseBreakdown && p.purchaseBreakdown.length > 0) {
      p.purchaseBreakdown.forEach(item => addRePurchaseRow(item.date, item.category || 'Deposit', item.particular, item.amount, item.id, item.loanTxId));
    } else {
      addRePurchaseRow('', 'Deposit', 'Purchase Price', p.value || '');
    }
    document.getElementById('rePropBankName').value = p.bankName || '';
    document.getElementById('rePropOriginalLoan').value = p.originalLoan || '';
    document.getElementById('rePropMortgage').value = p.openingMortgage || 0;
    document.getElementById('rePropRedraw').value = p.openingRedraw || 0;
    document.getElementById('rePropRedrawManual').value = (p.redrawManualAmount !== null && p.redrawManualAmount !== undefined) ? p.redrawManualAmount : '';
    document.getElementById('rePropRedrawManualDate').value = p.redrawManualDate || '';
    document.getElementById('rePropMonthlyRent').value = p.monthlyRent || '';
  } else {
    document.getElementById('rePropName').value = '';
    document.getElementById('rePropCurrency').value = getBaseCurrency();
    document.getElementById('rePropType').value = 'Residential';
    document.getElementById('rePropStatus').value = 'Rented';
    document.getElementById('rePropHoldingStart').value = '';
    await renderOwnerCheckboxes('rePropOwnersList', []);
    const today = new Date().toISOString().split('T')[0];
    addRePurchaseRow(today, 'Deposit', 'Initial Deposit', '');
    addRePurchaseRow(today, 'Bank Loan', 'Bank Loan Tranche', '');
    document.getElementById('rePropBankName').value = '';
    document.getElementById('rePropOriginalLoan').value = '';
    document.getElementById('rePropMortgage').value = 0;
    document.getElementById('rePropRedraw').value = 0;
    document.getElementById('rePropRedrawManual').value = '';
    document.getElementById('rePropRedrawManualDate').value = '';
    document.getElementById('rePropMonthlyRent').value = 0;
  }
  recalculateRePurchaseTotal();
  document.getElementById('rePropertyModal').classList.add('active');
}
function closeRePropertyModal() { document.getElementById('rePropertyModal').classList.remove('active'); }

async function saveReProperty() {
  const idStr = document.getElementById('rePropId').value;
  const breakdown = getRePurchaseBreakdownData();
  const value = reCalcTotalFromBreakdown(breakdown);

  const data = {
    name: document.getElementById('rePropName').value,
    currency: document.getElementById('rePropCurrency').value,
    type: document.getElementById('rePropType').value,
    status: document.getElementById('rePropStatus').value,
    ownerIds: getCheckedOwnerIds('rePropOwnersList'),
    holdingStartDate: document.getElementById('rePropHoldingStart').value || null,
    value: value,
    purchaseBreakdown: breakdown,
    bankName: document.getElementById('rePropBankName').value || '',
    originalLoan: parseFloat(document.getElementById('rePropOriginalLoan').value || 0),
    openingMortgage: parseFloat(document.getElementById('rePropMortgage').value || 0),
    openingRedraw: parseFloat(document.getElementById('rePropRedraw').value || 0),
    redrawManualAmount: document.getElementById('rePropRedrawManual').value !== '' ? parseFloat(document.getElementById('rePropRedrawManual').value) : null,
    redrawManualDate: document.getElementById('rePropRedrawManualDate').value || null,
    monthlyRent: parseFloat(document.getElementById('rePropMonthlyRent').value || 0)
  };

  if (!data.name) { showToast('Please fill in the property name'); return; }

  let propId;
  if (idStr) {
    propId = parseInt(idStr);
    await encUpdate('realEstateProperties', propId, data);
  } else {
    data.createdAt = new Date();
    propId = await encAdd('realEstateProperties', data);
  }

  // Sync Bank Loan breakdown rows to the loan ledger. Each row already
  // carries its own loanTxId once synced, so re-saving the property — e.g.
  // just to fix the name — updates that same ledger entry instead of
  // creating a duplicate tranche every time.
  for (const item of breakdown) {
    const isBankLoan = item.category === 'Bank Loan' && item.amount > 0;
    if (isBankLoan && !item.loanTxId) {
      item.loanTxId = await encAdd('realEstateLoanTx', {
        propertyId: propId,
        action: 'INITIAL_LOAN',
        principal: item.amount,
        interest: 0,
        serviceFee: 0,
        date: item.date || new Date().toISOString().split('T')[0],
        createdAt: new Date()
      });
    } else if (isBankLoan && item.loanTxId) {
      const rec = await encGet('realEstateLoanTx', item.loanTxId);
      if (rec) await encUpdate('realEstateLoanTx', item.loanTxId, { principal: item.amount, date: item.date || rec.date });
    } else if (!isBankLoan && item.loanTxId) {
      // Row was previously a synced Bank Loan tranche but its category
      // changed — remove the now-stale ledger entry.
      await db.realEstateLoanTx.delete(item.loanTxId);
      item.loanTxId = null;
    }
  }

  // Persist the (possibly newly-assigned) loanTxId links back onto the
  // breakdown rows so future saves recognize them as already synced.
  await encUpdate('realEstateProperties', propId, { purchaseBreakdown: breakdown });

  closeRePropertyModal();
  showToast(idStr ? 'Property updated!' : 'Property added!');
  await renderRealEstateAll();
}

async function deleteReProperty(id) {
  if (!confirm('Delete this property? This will also delete its rental cashflow and loan ledger entries.')) return;
  await db.realEstateProperties.delete(id);
  await db.realEstateTx.where('propertyId').equals(id).delete();
  await db.realEstateLoanTx.where('propertyId').equals(id).delete();
  closeRePropertyDetailModal();
  showToast('Property deleted');
  await renderRealEstateAll();
}

async function showRePropertyDetail(id) {
  currentRePropertyId = id;
  const p = await encGet('realEstateProperties', id);
  if (!p) { showToast('This property has been deleted'); return; }
  const loanTx = await encGetAll('realEstateLoanTx');
  const cashflowTx = await encGetAll('realEstateTx');
  const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
  const membersById = await membersByIdMap();

  document.getElementById('reDetailTitle').textContent = p.name;
  document.getElementById('reDetailOwner').innerHTML = ownerBadgeHtml(p.ownerIds, membersById);
  document.getElementById('red-value').textContent = formatCurrency(p.value, p.currency);
  document.getElementById('red-mortgage').innerHTML = formatDebtAmount(m.mortgage, p.currency);
  document.getElementById('red-equity').textContent = formatCurrency(m.equity, p.currency);
  document.getElementById('red-redraw').innerHTML = formatCurrency(m.redrawIsManual ? m.redraw : 0, p.currency) + (m.redrawIsManual && m.redrawAsOf ? `<div style="font-size:11px;color:#a0aec0;font-weight:400;margin-top:2px;">as of ${escapeHtml(m.redrawAsOf)}</div>` : '');
  document.getElementById('red-holding').textContent = formatHoldingPeriod(p.holdingStartDate) || '—';
  document.getElementById('red-rent').textContent = formatCurrency(p.monthlyRent, p.currency);
  document.getElementById('red-yield').textContent = m.grossYield.toFixed(2) + '%';
  document.getElementById('red-netcashflow').textContent = formatCurrency(m.netCashflow, p.currency);
  document.getElementById('red-financing').textContent = formatCurrency(m.financingCost, p.currency);
  document.getElementById('red-meta').textContent = [p.type, p.status, p.bankName ? ('Lender: ' + p.bankName) : ''].filter(Boolean).join(' · ');

  const breakdown = p.purchaseBreakdown || [];
  document.getElementById('red-breakdown-body').innerHTML = breakdown.map(item => `<tr>
    <td>${escapeHtml(item.date || '')}</td><td>${escapeHtml(item.category || '')}</td><td>${escapeHtml(item.particular || '')}</td><td>${item.category === 'Credit Note' ? formatCurrencyNeg(item.amount, p.currency) : formatCurrency(item.amount, p.currency)}</td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No breakdown recorded</td></tr>';

  const propCashTx = cashflowTx.filter(t => t.propertyId === id).sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('red-cashflow-body').innerHTML = propCashTx.map(t => `<tr>
    <td><div style="font-weight:600;">${escapeHtml(t.date)}</div><span class="re-date-badge ${t.type === 'INCOME' ? 'income' : 'expense'}">${t.type === 'INCOME' ? 'INCOME' : 'EXPENSE'}</span></td><td>${escapeHtml(t.category) || ''}</td>
    <td style="color:${t.type === 'INCOME' ? '#48bb78' : '#f56565'};font-weight:600;">${t.type === 'INCOME' ? '+' : '-'}${formatCurrency(t.amount, p.currency)}</td>
    <td><div class="tx-actions"><button class="icon-btn" title="Edit" data-action="openReTxModal" data-arg="${id}" data-arg2="${t.id}">✏️</button><button class="icon-btn" title="Delete" data-action="deleteReTx" data-arg="${t.id}">🗑️</button></div></td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No entries yet</td></tr>';

  const propLoanTx = loanTx.filter(t => t.propertyId === id).sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('red-loan-body').innerHTML = propLoanTx.map(t => `<tr>
    <td><div style="font-weight:600;">${escapeHtml(t.date)}</div>${reLoanBadgeHtml(t.action)}</td>
    <td>${reLoanItemColumnHtml(t, p.currency)}</td>
    <td>${reLoanAmountColumnHtml(t, p.currency)}</td>
    <td><div class="tx-actions"><button class="icon-btn" title="Edit" data-action="openReLoanTxModal" data-arg="${id}" data-arg2="${t.id}">✏️</button><button class="icon-btn" title="Delete" data-action="deleteReLoanTx" data-arg="${t.id}">🗑️</button></div></td>
  </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#a0aec0;">No entries yet</td></tr>';

  document.getElementById('rePropertyDetailModal').classList.add('active');
}
function closeRePropertyDetailModal() { document.getElementById('rePropertyDetailModal').classList.remove('active'); }
function editPropertyFromDetail() { closeRePropertyDetailModal(); openPropertyModal(currentRePropertyId); }
function deletePropertyFromDetail() { deleteReProperty(currentRePropertyId); }

function openRePrintOptionsModal() {
  document.getElementById('rePrintBreakdown').checked = true;
  document.getElementById('rePrintCashflow').checked = true;
  document.getElementById('rePrintLoan').checked = true;
  document.getElementById('rePrintOptionsModal').classList.add('active');
}
function closeRePrintOptionsModal() { document.getElementById('rePrintOptionsModal').classList.remove('active'); }
function confirmRePrintReport() {
  const sections = {
    breakdown: document.getElementById('rePrintBreakdown').checked,
    cashflow: document.getElementById('rePrintCashflow').checked,
    loan: document.getElementById('rePrintLoan').checked
  };
  if (!sections.breakdown && !sections.cashflow && !sections.loan) { showToast('Select at least one section to print'); return; }
  closeRePrintOptionsModal();
  printRePropertyReport(currentRePropertyId, sections);
}

async function printRePropertyReport(id, sections) {
  sections = sections || { breakdown: true, cashflow: true, loan: true };
  if (!id) return;
  const p = await encGet('realEstateProperties', id);
  if (!p) return;
  const loanTx = await encGetAll('realEstateLoanTx');
  const cashflowTx = await encGetAll('realEstateTx');
  const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
  const cur = p.currency;

  const extraStyle = '.holdings-table{table-layout:fixed;}' +
    '.holdings-table td{word-wrap:break-word;overflow-wrap:break-word;white-space:normal;line-height:1.3;}' +
    '.holdings-table td.nowrap{white-space:nowrap;}' +
    '.re-date-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.3px;margin-top:3px;}' +
    '.re-date-badge.income,.re-date-badge.repayment{background:#c6f6d5;color:#22543d;}' +
    '.re-date-badge.expense,.re-date-badge.charges{background:#fed7d7;color:#742a2a;}' +
    '.re-date-badge.initial{background:#bee3f8;color:#2a4365;}' +
    '.re-date-badge.redraw{background:#e9d8fd;color:#44337a;}' +
    '.re-item-line{color:#718096;}' +
    '.re-amount-line{text-align:right;}';
  const printWindow = openReportWindow('Property — ' + p.name, extraStyle);
  printWindow.document.write('<h1>' + escapeHtml(p.name) + '</h1>');
  printWindow.document.write('<p>' + [escapeHtml(p.type), escapeHtml(p.status), p.bankName ? ('Lender: ' + escapeHtml(p.bankName)) : ''].filter(Boolean).join(' · ') + ' | Generated: ' + new Date().toLocaleDateString() + '</p>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Purchase Cost', formatCurrency(p.value, cur)));
  printWindow.document.write(statCardHtml('Mortgage Balance', formatDebtAmount(m.mortgage, cur)));
  printWindow.document.write(statCardHtml('Net Equity', formatCurrency(m.equity, cur)));
  printWindow.document.write(statCardHtml('Available Redraw', formatCurrency(m.redrawIsManual ? m.redraw : 0, cur) + (m.redrawIsManual && m.redrawAsOf ? ' (as of ' + escapeHtml(m.redrawAsOf) + ')' : '')));
  printWindow.document.write(statCardHtml('Monthly Rent', formatCurrency(p.monthlyRent, cur)));
  printWindow.document.write(statCardHtml('Gross Yield', m.grossYield.toFixed(2) + '%'));
  printWindow.document.write(statCardHtml('Net Rental Cashflow', formatCurrency(m.netCashflow, cur), m.netCashflow));
  printWindow.document.write(statCardHtml('Financing Cost', formatCurrency(m.financingCost, cur)));
  printWindow.document.write('</div>');

  const breakdown = p.purchaseBreakdown || [];
  if (sections.breakdown) {
    printWindow.document.write('<h2>Initial Purchase Breakdown</h2>');
    if (breakdown.length === 0) {
      printWindow.document.write('<p style="color:#a0aec0;">No breakdown recorded.</p>');
    } else {
      let html = '<table><thead><tr><th>Date</th><th>Type</th><th>Particular</th><th>Amount</th></tr></thead><tbody>';
      breakdown.forEach(item => {
        html += '<tr><td>' + escapeHtml(item.date || '') + '</td><td>' + escapeHtml(item.category || '') + '</td><td>' + escapeHtml(item.particular || '') + '</td><td>' + (item.category === 'Credit Note' ? formatCurrencyNeg(item.amount, cur) : formatCurrency(item.amount, cur)) + '</td></tr>';
      });
      html += '</tbody></table>';
      printWindow.document.write(html);
    }
  }

  const propCashTx = cashflowTx.filter(t => t.propertyId === id).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (sections.cashflow) {
    printWindow.document.write('<h2>Rental Cashflow</h2>');
    if (propCashTx.length === 0) {
      printWindow.document.write('<p style="color:#a0aec0;">No entries yet.</p>');
    } else {
      let html = '<table><thead><tr><th>Date</th><th>Category</th><th>Amount</th></tr></thead><tbody>';
      propCashTx.forEach(t => {
        html += '<tr><td class="nowrap">' + escapeHtml(t.date) + '<br>' + `<span class="re-date-badge ${t.type === 'INCOME' ? 'income' : 'expense'}">${t.type === 'INCOME' ? 'INCOME' : 'EXPENSE'}</span>` + '</td><td>' + (escapeHtml(t.category) || '') + '</td><td>' + (t.type === 'INCOME' ? '+' : '-') + formatCurrency(t.amount, cur) + '</td></tr>';
      });
      html += '</tbody></table>';
      printWindow.document.write(html);
    }
  }

  const propLoanTx = loanTx.filter(t => t.propertyId === id).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (sections.loan) {
    printWindow.document.write('<h2>Bank Loan &amp; Redraw Activity</h2>');
    if (propLoanTx.length === 0) {
      printWindow.document.write('<p style="color:#a0aec0;">No entries yet.</p>');
    } else {
      let html = '<table class="holdings-table"><thead><tr><th style="width:110px;">Date</th><th>Item</th><th style="width:140px;text-align:right;">Amount</th></tr></thead><tbody>';
      propLoanTx.forEach(t => {
        html += '<tr><td class="nowrap">' + escapeHtml(t.date) + '<br>' + reLoanBadgeHtml(t.action) + '</td>' +
          '<td>' + reLoanItemColumnHtml(t, cur) + '</td>' +
          '<td>' + reLoanAmountColumnHtml(t, cur) + '</td></tr>';
      });
      html += '</tbody></table>';
      printWindow.document.write(html);
    }
  }

  finishPrintWindow(printWindow);
}

// ---- Rental cashflow ledger modal ----
async function openReTxModal(propId, txId) {
  document.getElementById('reTxId').value = txId || '';
  const properties = await encGetAll('realEstateProperties');
  const select = document.getElementById('reTxPropertyId');
  select.innerHTML = properties.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (txId) {
    const t = await encGet('realEstateTx', txId);
    select.value = t.propertyId;
    document.getElementById('reTxType').value = t.type;
    updateReTxCategories();
    document.getElementById('reTxCategory').value = t.category || '';
    document.getElementById('reTxAmount').value = t.amount;
    document.getElementById('reTxDate').value = t.date;
  } else {
    if (propId) select.value = propId;
    document.getElementById('reTxType').value = 'INCOME';
    updateReTxCategories();
    document.getElementById('reTxAmount').value = '';
    document.getElementById('reTxDate').value = new Date().toISOString().split('T')[0];
  }
  document.getElementById('reTxModal').classList.add('active');
}
function closeReTxModal() { document.getElementById('reTxModal').classList.remove('active'); }

function updateReTxCategories() {
  const type = document.getElementById('reTxType').value;
  const catSelect = document.getElementById('reTxCategory');
  const categories = type === 'INCOME'
    ? ['Rental Payment', 'Parking Fee', 'Security Deposit', 'Other Income']
    : ['Professional Fees / Lawyer Fees', 'Postage & Admin', 'Mortgage Interest', 'Property Tax', 'Maintenance & Repairs', 'Insurance', 'HOA / Management Fees'];
  catSelect.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');
}

async function saveReTx() {
  const idStr = document.getElementById('reTxId').value;
  const data = {
    propertyId: parseInt(document.getElementById('reTxPropertyId').value),
    type: document.getElementById('reTxType').value,
    category: document.getElementById('reTxCategory').value,
    amount: parseFloat(document.getElementById('reTxAmount').value || 0),
    date: document.getElementById('reTxDate').value
  };
  if (!data.propertyId || !data.date) { showToast('Please select a property and date'); return; }
  if (idStr) {
    await encUpdate('realEstateTx', parseInt(idStr), data);
    showToast('Entry updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('realEstateTx', data);
    showToast('Entry added!');
  }
  closeReTxModal();
  await renderRealEstateAll();
  if (currentRePropertyId) await showRePropertyDetail(currentRePropertyId);
}

async function deleteReTx(id) {
  if (!confirm('Delete this cashflow entry?')) return;
  await db.realEstateTx.delete(id);
  showToast('Entry deleted');
  await renderRealEstateAll();
  if (currentRePropertyId) await showRePropertyDetail(currentRePropertyId);
}

// ---- Loan / redraw ledger modal ----
async function openReLoanTxModal(propId, txId) {
  document.getElementById('reLoanTxId').value = txId || '';
  const properties = await encGetAll('realEstateProperties');
  const select = document.getElementById('reLoanTxPropertyId');
  select.innerHTML = properties.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (txId) {
    const t = await encGet('realEstateLoanTx', txId);
    select.value = t.propertyId;
    document.getElementById('reLoanTxAction').value = t.action || 'REPAYMENT';
    toggleReLoanFields();
    if (t.action === 'REPAYMENT' || t.action === 'INITIAL_LOAN') {
      document.getElementById('reLoanTxPrincipal').value = t.principal || '';
    } else if (t.action === 'BANK_CHARGES') {
      document.getElementById('reLoanTxInterest').value = t.interest || '';
      document.getElementById('reLoanTxServiceFee').value = t.serviceFee || '';
    } else {
      document.getElementById('reLoanTxRedrawAmount').value = t.redrawAmount || '';
    }
    document.getElementById('reLoanTxDate').value = t.date || '';
    document.getElementById('reLoanTxNotes').value = t.notes || '';
  } else {
    if (propId) select.value = propId;
    document.getElementById('reLoanTxAction').value = 'REPAYMENT';
    toggleReLoanFields();
    document.getElementById('reLoanTxPrincipal').value = '';
    document.getElementById('reLoanTxInterest').value = '';
    document.getElementById('reLoanTxServiceFee').value = '';
    document.getElementById('reLoanTxRedrawAmount').value = '';
    document.getElementById('reLoanTxDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('reLoanTxNotes').value = '';
  }
  document.getElementById('reLoanTxModal').classList.add('active');
}
function closeReLoanTxModal() { document.getElementById('reLoanTxModal').classList.remove('active'); }

function toggleReLoanFields() {
  const action = document.getElementById('reLoanTxAction').value;
  document.getElementById('reRepaymentFields').classList.toggle('hidden', !(action === 'REPAYMENT' || action === 'INITIAL_LOAN'));
  document.getElementById('reBankChargesFields').classList.toggle('hidden', action !== 'BANK_CHARGES');
  document.getElementById('reRedrawFields').classList.toggle('hidden', action !== 'REDRAW_WITHDRAW');
  document.getElementById('reLoanAmountLabel').textContent = action === 'INITIAL_LOAN' ? 'Loan Amount (Initial Tranche)' : 'Repayment Amount';
}

async function saveReLoanTx() {
  const idStr = document.getElementById('reLoanTxId').value;
  const action = document.getElementById('reLoanTxAction').value;
  const data = {
    propertyId: parseInt(document.getElementById('reLoanTxPropertyId').value),
    action: action,
    date: document.getElementById('reLoanTxDate').value,
    notes: document.getElementById('reLoanTxNotes').value || ''
  };
  if (action === 'REPAYMENT' || action === 'INITIAL_LOAN') {
    data.principal = parseFloat(document.getElementById('reLoanTxPrincipal').value || 0);
  } else if (action === 'BANK_CHARGES') {
    data.interest = parseFloat(document.getElementById('reLoanTxInterest').value || 0);
    data.serviceFee = parseFloat(document.getElementById('reLoanTxServiceFee').value || 0);
  } else {
    data.redrawAmount = parseFloat(document.getElementById('reLoanTxRedrawAmount').value || 0);
  }
  if (!data.propertyId || !data.date) { showToast('Please select a property and date'); return; }
  if (idStr) {
    await encUpdate('realEstateLoanTx', parseInt(idStr), data);
    showToast('Entry updated!');
  } else {
    data.createdAt = new Date();
    await encAdd('realEstateLoanTx', data);
    showToast('Entry added!');
  }
  closeReLoanTxModal();
  await renderRealEstateAll();
  if (currentRePropertyId) await showRePropertyDetail(currentRePropertyId);
}

async function deleteReLoanTx(id) {
  if (!confirm('Delete this loan/redraw entry?')) return;
  await db.realEstateLoanTx.delete(id);
  showToast('Entry deleted');
  await renderRealEstateAll();
  if (currentRePropertyId) await showRePropertyDetail(currentRePropertyId);
}

// One-time cleanup utility: repeated edits of a property before the row-level
// sync tracking existed could create duplicate "Initial Bank Loan Tranche"
// ledger entries. This scans for entries sharing the same property/date/amount
// and removes the extras, keeping the earliest one — nothing is ever deleted
// without the count being confirmed first.
async function cleanupDuplicateReLoanEntries() {
  const all = await encGetAll('realEstateLoanTx');
  const groups = {};
  all.forEach(t => {
    if (t.action !== 'INITIAL_LOAN') return;
    const key = `${t.propertyId}|${t.date}|${parseFloat(t.principal || 0)}`;
    (groups[key] = groups[key] || []).push(t);
  });
  const toDelete = [];
  Object.values(groups).forEach(list => {
    if (list.length > 1) {
      list.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      toDelete.push(...list.slice(1));
    }
  });
  if (toDelete.length === 0) { showToast('No duplicate entries found'); return; }
  if (!confirm(`Found ${toDelete.length} duplicate Initial Bank Loan Tranche entr${toDelete.length === 1 ? 'y' : 'ies'} (same property, date & amount). Remove the extras and keep the earliest one?`)) return;
  for (const t of toDelete) await db.realEstateLoanTx.delete(t.id);
  showToast(`Removed ${toDelete.length} duplicate entr${toDelete.length === 1 ? 'y' : 'ies'}`);
  await renderRealEstateAll();
}

// ==================== FOREIGN CURRENCY MODULE ====================
// Physical cash held in foreign currencies. Valuation rate comes from the
// app's shared exchange-rate settings (getRate/getBaseCurrency, same as
// every other module) rather than a separate rate list, so setting a rate
// once in Currency Settings applies everywhere.
const FX_CURRENCIES = ['SGD', 'BND', 'USD', 'CNY', 'HKD', 'TWD', 'JPY', 'KRW', 'THB'];
let fxViewMode = loadViewMode('utt-fx-view', 'card');
let fxOwnerFilter = loadViewMode('utt-fx-owner-filter', 'All');
let fxSelectedFilterCurrency = null;
let fxAllocationChartInstance = null;

function setFxView(mode) {
  fxViewMode = mode;
  saveViewMode('utt-fx-view', mode);
  document.getElementById('fx-view-card-btn').classList.toggle('active', mode === 'card');
  document.getElementById('fx-view-list-btn').classList.toggle('active', mode === 'list');
  document.getElementById('fx-holdings-card-container').style.display = mode === 'card' ? 'grid' : 'none';
  document.getElementById('fx-holdings-table-container').style.display = mode === 'list' ? 'block' : 'none';
}

function fxFilterLedger(code) {
  fxSelectedFilterCurrency = (fxSelectedFilterCurrency === code) ? null : code;
  renderFxAll();
}

async function renderFxOwnerFilterOptions() {
  const select = document.getElementById('fx-owner-filter');
  if (!select) return;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Owners</option>' + members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  select.value = (fxOwnerFilter === 'All' || members.some(m => String(m.id) === String(fxOwnerFilter))) ? fxOwnerFilter : 'All';
}
function setFxOwnerFilter(owner) {
  fxOwnerFilter = owner;
  saveViewMode('utt-fx-owner-filter', owner);
  renderFxAll();
}

async function fxCalculateHoldings() {
  let txs = await encGetAll('fxTransactions');
  if (fxOwnerFilter !== 'All') {
    const oid = parseInt(fxOwnerFilter);
    txs = txs.filter(t => (t.ownerIds || []).includes(oid));
  }
  const holdings = {};
  txs.forEach(tx => {
    if (!holdings[tx.currency]) holdings[tx.currency] = { amount: 0, totalCost: 0 };
    const h = holdings[tx.currency];
    if (tx.type === 'Buy' || tx.type === 'Gift') {
      h.amount += tx.amount;
      h.totalCost += tx.totalBase;
    } else if (tx.type === 'Sell') {
      const avg = h.amount > 0 ? h.totalCost / h.amount : 0;
      h.amount -= tx.amount;
      h.totalCost -= tx.amount * avg;
    }
  });
  Object.keys(holdings).forEach(code => {
    const h = holdings[code];
    h.avgRate = h.amount > 0 ? h.totalCost / h.amount : 0;
    h.marketRate = getRate(code);
    h.rateSet = hasRate(code);
    h.currentValue = h.amount * h.marketRate;
    h.pl = h.currentValue - h.totalCost;
    h.plPct = h.totalCost > 0 ? (h.pl / h.totalCost) * 100 : 0;
  });
  return { holdings, txs };
}

async function renderFxAll() {
  await renderFxOwnerFilterOptions();
  document.getElementById('fx-view-card-btn').classList.toggle('active', fxViewMode === 'card');
  document.getElementById('fx-view-list-btn').classList.toggle('active', fxViewMode === 'list');
  document.getElementById('fx-holdings-card-container').style.display = fxViewMode === 'card' ? 'grid' : 'none';
  document.getElementById('fx-holdings-table-container').style.display = fxViewMode === 'list' ? 'block' : 'none';

  const base = getBaseCurrency();
  const sym = currencySymbol(base);
  document.getElementById('fx-th-base').textContent = `Base Amount (${base})`;
  const { holdings, txs } = await fxCalculateHoldings();

  let portfolioVal = 0, portfolioCost = 0, activeCount = 0;
  const cardContainer = document.getElementById('fx-holdings-card-container');
  const tableBody = document.getElementById('fx-holdings-table-body');
  cardContainer.innerHTML = ''; tableBody.innerHTML = '';

  const codes = Object.keys(holdings).sort();
  codes.forEach(code => {
    const h = holdings[code];
    if (h.amount <= 0) return;
    activeCount++; portfolioVal += h.currentValue; portfolioCost += h.totalCost;

    const card = document.createElement('div');
    card.className = 'fund-card fx-currency-card' + (fxSelectedFilterCurrency === code ? ' selected' : '');
    card.onclick = () => openFxCurrencyDetail(code);
    card.innerHTML = `
      <div class="fx-head">
        <div class="fx-title">${currencyFlag(code)} ${code}</div>
        <button class="icon-btn" title="Add transaction" data-action="openFxTxModal" data-stop="1" data-arg="Buy" data-arg2="${code}">➕</button>
      </div>
      <div style="font-size:16px;font-weight:bold;color:#1a202c;">${h.amount.toLocaleString()} <span style="font-size:11px;font-weight:normal;color:#718096;">${code}</span></div>
      <div class="fx-details">
        <div class="fx-detail-item"><div class="fx-label">Current Value</div><div class="fx-val">${formatCurrency(h.currentValue, base)}</div></div>
        <div class="fx-detail-item"><div class="fx-label">Total Cost</div><div class="fx-val">${formatCurrency(h.totalCost, base)}</div></div>
        <div class="fx-detail-item"><div class="fx-label">Avg Buy Rate</div><div class="fx-val">${h.avgRate.toFixed(4)}</div></div>
        <div class="fx-detail-item"><div class="fx-label">Market Rate</div><div class="fx-val">${h.rateSet ? h.marketRate.toFixed(4) : '—'}</div></div>
      </div>
      ${!h.rateSet ? `<div class="fx-rate-warning">⚠️ No rate set for ${code} — value shown as 0. Open Currency Settings.</div>` : `
      <div style="font-size:11px;display:flex;justify-content:space-between;border-top:1px solid #edf2f7;padding-top:4px;">
        <span style="color:#718096;">Unrealised P&amp;L:</span>
        <strong style="color:${h.pl >= 0 ? '#48bb78' : '#f56565'};">${h.pl >= 0 ? '+' : ''}${formatCurrency(h.pl, base)} (${h.plPct.toFixed(2)}%)</strong>
      </div>`}
    `;
    cardContainer.appendChild(card);

    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.onclick = () => openFxCurrencyDetail(code);
    tr.innerHTML = `
      <td><strong>${currencyFlag(code)} ${code}</strong></td>
      <td>${h.amount.toLocaleString()} ${code}</td>
      <td>${formatCurrency(h.currentValue, base)}</td>
      <td>${formatCurrency(h.totalCost, base)}</td>
      <td>${h.avgRate.toFixed(4)}</td>
      <td>${h.rateSet ? h.marketRate.toFixed(4) : '⚠️ not set'}</td>
      <td style="color:${h.pl >= 0 ? '#48bb78' : '#f56565'};font-weight:bold;">${h.pl >= 0 ? '+' : ''}${formatCurrency(h.pl, base)}</td>
      <td style="color:${h.pl >= 0 ? '#48bb78' : '#f56565'};font-weight:bold;">${h.plPct.toFixed(2)}%</td>
      <td><button class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" data-action="openFxTxModal" data-stop="1" data-arg="Buy" data-arg2="${code}">+ Tx</button></td>
    `;
    tableBody.appendChild(tr);
  });

  document.getElementById('fx-empty').classList.toggle('hidden', activeCount > 0);

  const totalPL = portfolioVal - portfolioCost;
  const totalReturn = portfolioCost > 0 ? (totalPL / portfolioCost) * 100 : 0;
  document.getElementById('fx-stat-total-val').textContent = formatCurrency(portfolioVal, base);
  document.getElementById('fx-stat-total-cost').textContent = formatCurrency(portfolioCost, base);
  document.getElementById('fx-stat-total-count').textContent = `${activeCount} currencies in hand`;
  document.getElementById('fx-stat-total-pl').textContent = `${totalPL >= 0 ? '+' : ''}${formatCurrency(totalPL, base)}`;
  document.getElementById('fx-stat-total-return').textContent = `${totalReturn.toFixed(2)}% total return`;

  fxRenderAllocationChart(holdings);
  const membersById = await membersByIdMap();
  fxRenderTransactions(txs, membersById);
}

function fxRenderAllocationChart(holdings) {
  const codes = Object.keys(holdings).filter(c => holdings[c].amount > 0 && holdings[c].currentValue > 0);
  const ctx = document.getElementById('fxAllocationChart');
  if (!ctx) return;
  if (fxAllocationChartInstance) fxAllocationChartInstance.destroy();
  if (codes.length === 0) return;
  fxAllocationChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: codes.map(c => `${currencyFlag(c)} ${c}`),
      datasets: [{ data: codes.map(c => holdings[c].currentValue), backgroundColor: ['#667eea','#48bb78','#ed8936','#4299e1','#f56565','#38b2ac','#ed64a6','#805ad5','#d69e2e'] }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } }, title: { display: true, text: 'Value by Currency' } } }
  });
}

function fxRenderTransactions(txs, membersById) {
  const tbody = document.getElementById('fx-tx-table-body');
  const badgeContainer = document.getElementById('fx-filter-badge-container');
  tbody.innerHTML = ''; badgeContainer.innerHTML = '';

  let filtered = txs;
  if (fxSelectedFilterCurrency) {
    filtered = txs.filter(t => t.currency === fxSelectedFilterCurrency);
    badgeContainer.innerHTML = `<span class="fx-badge">Filtered: ${currencyFlag(fxSelectedFilterCurrency)} ${fxSelectedFilterCurrency} <span style="cursor:pointer;" data-action="fxFilterLedger">✖</span></span>`;
  }

  const base = getBaseCurrency();
  filtered.sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(tx => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(tx.date)}</td>
      <td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:bold;${fxTxTypeBadgeStyle(tx.type)}">${escapeHtml(tx.type)}</span></td>
      <td>${currencyFlag(tx.currency)} ${escapeHtml(tx.currency)}</td>
      <td><strong>${tx.amount.toLocaleString()}</strong></td>
      <td>${tx.rate.toFixed(5)}</td>
      <td>${formatCurrency(tx.totalBase, base)}</td>
      <td>${ownerBadgeHtml(tx.ownerIds, membersById)}</td>
      <td>${escapeHtml(tx.notes || '-')}</td>
      <td>
        <button data-action="editFxTx" data-arg="${tx.id}" style="border:none;background:none;cursor:pointer;margin-right:8px;" title="Edit">✏️</button>
        <button data-action="deleteFxTx" data-arg="${tx.id}" style="border:none;background:none;cursor:pointer;color:#e53e3e;" title="Delete">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  if (filtered.length === 0) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#718096;padding:20px;">No transaction records found.</td></tr>`;
}

// Shared badge coloring for FX transaction types (Buy/Gift/Sell), used in both
// the main ledger table and the per-currency detail modal.
function fxTxTypeBadgeStyle(type) {
  if (type === 'Buy') return 'background:#c6f6d5;color:#22543d;';
  if (type === 'Gift') return 'background:#bee3f8;color:#2a4365;';
  return 'background:#fed7d7;color:#742a2a;'; // Sell
}

function fxPopulateCurrencySelect() {
  const base = getBaseCurrency();
  const sel = document.getElementById('fxTxCurrency');
  const options = FX_CURRENCIES.filter(c => c !== base);
  sel.innerHTML = options.map(c => `<option value="${c}">${currencyFlag(c)} ${c}</option>`).join('');
  fxUpdateTypeLabels();
}

// Gift transactions may have no known original cost, so the rate/total labels
// are phrased as optional in that case; Buy/Sell keep the standard wording.
function fxUpdateTypeLabels() {
  const base = getBaseCurrency();
  const type = document.getElementById('fxTxType').value;
  if (type === 'Gift') {
    document.getElementById('fxTxRateLabel').textContent = `Value Rate at Time of Gift (${base} per Foreign Unit, optional)`;
    document.getElementById('fxTxTotalLabel').textContent = `Total Base Value (${base}, optional — 0 if unknown)`;
  } else {
    document.getElementById('fxTxRateLabel').textContent = `Exchange Rate (${base} per Foreign Unit)`;
    document.getElementById('fxTxTotalLabel').textContent = `Total Base Cost / Received (${base})`;
  }
}

function fxCalcTxTotal() {
  const amount = parseFloat(document.getElementById('fxTxAmount').value) || 0;
  const rate = parseFloat(document.getElementById('fxTxRate').value) || 0;
  document.getElementById('fxTxTotalBase').value = (amount * rate).toFixed(2);
}
function fxCalcTxRate() {
  const amount = parseFloat(document.getElementById('fxTxAmount').value) || 0;
  const totalBase = parseFloat(document.getElementById('fxTxTotalBase').value) || 0;
  if (amount > 0) document.getElementById('fxTxRate').value = (totalBase / amount).toFixed(5);
}

// Fills the rate field with today's saved market rate for the selected currency
// (the same rate shown elsewhere as "Market Rate"), then recalculates the total.
// Works for Buy, Gift, and Sell/Spend — useful when you don't have an exact
// receipt rate and just want a reasonable base-currency estimate on record.
function fxUseMarketRate() {
  const currency = document.getElementById('fxTxCurrency').value;
  const statusEl = document.getElementById('fxTxStatus');
  if (!currency) return;
  if (!hasRate(currency)) {
    statusEl.textContent = `No market rate saved for ${currency} yet. Set one in Exchange Rates first.`;
    return;
  }
  statusEl.textContent = '';
  const rate = getRate(currency);
  document.getElementById('fxTxRate').value = rate.toFixed(5);
  fxCalcTxTotal();
}

function openFxTxModal(defaultType = 'Buy', defaultCurrency = null) {
  fxPopulateCurrencySelect();
  document.getElementById('fxTxId').value = '';
  document.getElementById('fxTxModalTitle').textContent = 'Add Cash Transaction';
  document.getElementById('fxTxType').value = defaultType;
  if (defaultCurrency) document.getElementById('fxTxCurrency').value = defaultCurrency;
  fxUpdateTypeLabels();
  document.getElementById('fxTxDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('fxTxAmount').value = '';
  document.getElementById('fxTxRate').value = '';
  document.getElementById('fxTxTotalBase').value = '';
  document.getElementById('fxTxNotes').value = '';
  document.getElementById('fxTxStatus').textContent = '';
  renderOwnerCheckboxes('fxTxOwnersList', []);
  document.getElementById('fxTxModal').classList.add('active');
}

async function editFxTx(id) {
  const tx = await encGet('fxTransactions', id);
  if (!tx) return;
  fxPopulateCurrencySelect();
  document.getElementById('fxTxId').value = tx.id;
  document.getElementById('fxTxModalTitle').textContent = 'Edit Cash Transaction';
  document.getElementById('fxTxType').value = tx.type;
  document.getElementById('fxTxCurrency').value = tx.currency;
  fxUpdateTypeLabels();
  document.getElementById('fxTxDate').value = tx.date;
  document.getElementById('fxTxAmount').value = tx.amount;
  document.getElementById('fxTxRate').value = tx.rate;
  document.getElementById('fxTxTotalBase').value = tx.totalBase;
  document.getElementById('fxTxNotes').value = tx.notes || '';
  document.getElementById('fxTxStatus').textContent = '';
  await renderOwnerCheckboxes('fxTxOwnersList', tx.ownerIds || []);
  document.getElementById('fxTxModal').classList.add('active');
}

function closeFxTxModal() { document.getElementById('fxTxModal').classList.remove('active'); }

async function saveFxTransaction() {
  const statusEl = document.getElementById('fxTxStatus');
  statusEl.textContent = '';
  const txId = document.getElementById('fxTxId').value;
  const type = document.getElementById('fxTxType').value;
  const currency = document.getElementById('fxTxCurrency').value;
  const date = document.getElementById('fxTxDate').value;
  const amount = parseFloat(document.getElementById('fxTxAmount').value) || 0;
  const rate = parseFloat(document.getElementById('fxTxRate').value) || 0;
  const totalBase = parseFloat(document.getElementById('fxTxTotalBase').value) || (amount * rate);
  const notes = document.getElementById('fxTxNotes').value;

  if (!amount || amount <= 0) { statusEl.textContent = 'Please enter a valid foreign currency amount.'; return; }
  if (!date) { statusEl.textContent = 'Please pick a date.'; return; }

  // A Sell can't exceed current holdings for that currency.
  if (type === 'Sell') {
    const { holdings } = await fxCalculateHoldings();
    let held = (holdings[currency] || { amount: 0 }).amount;
    if (txId) {
      const original = await encGet('fxTransactions', parseInt(txId));
      if (original && original.currency === currency && original.type === 'Sell') held += original.amount;
    }
    if (amount > held + 0.0000001) {
      statusEl.textContent = `Cannot spend ${amount.toLocaleString()} ${currency} — only ${held.toLocaleString()} ${currency} on hand.`;
      return;
    }
  }

  const record = { type, currency, date, amount, rate, totalBase, notes, ownerIds: getCheckedOwnerIds('fxTxOwnersList') };
  if (txId) {
    await encUpdate('fxTransactions', parseInt(txId), record);
    showToast('Transaction updated!');
  } else {
    record.createdAt = new Date();
    await encAdd('fxTransactions', record);
    showToast('Transaction added!');
  }
  closeFxTxModal();
  await renderFxAll();
  if (currentFxCode) await renderFxCurrencyDetail(currentFxCode);
}

// One-time import of data from the old standalone (pre-merge) Foreign
// Currency Tracker file, if that data is still sitting in this browser's
// localStorage and this table is still empty.
async function fxMigrateLegacyLocalStorageData() {
  try {
    const already = await db.fxTransactions.count();
    if (already > 0) return;
    const legacy = JSON.parse(localStorage.getItem('fxc_transactions') || 'null');
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const converted = legacy.map(t => ({
      type: t.type, currency: t.currency, date: t.date, amount: t.amount,
      rate: t.rate, totalBase: t.totalBase, notes: t.notes || '', createdAt: new Date()
    }));
    await encBulkAdd('fxTransactions', converted);
    showToast(`Migrated ${converted.length} foreign currency record(s) from the old tracker`);
  } catch (e) { console.error('FX legacy migration skipped:', e); }
}

async function deleteFxTx(id) {
  if (!confirm('Delete this cash transaction record?')) return;
  await db.fxTransactions.delete(id);
  await renderFxAll();
  if (currentFxCode) await renderFxCurrencyDetail(currentFxCode);
  showToast('Transaction deleted');
}

// ==================== FX CURRENCY DETAIL PAGE ====================
let currentFxCode = null;

async function openFxCurrencyDetail(code) {
  currentFxCode = code;
  await renderFxCurrencyDetail(code);
  document.getElementById('fxCurrencyDetailModal').classList.add('active');
}

function closeFxCurrencyDetailModal() {
  document.getElementById('fxCurrencyDetailModal').classList.remove('active');
  currentFxCode = null;
}

// Detail page always shows every transaction/owner for this currency, regardless
// of the owner filter selected on the main FX page.
async function renderFxCurrencyDetail(code) {
  const base = getBaseCurrency();
  const allTxs = await encGetAll('fxTransactions');
  const txs = allTxs.filter(t => t.currency === code);

  let amount = 0, totalCost = 0;
  txs.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(tx => {
    if (tx.type === 'Buy' || tx.type === 'Gift') {
      amount += tx.amount;
      totalCost += tx.totalBase;
    } else if (tx.type === 'Sell') {
      const avg = amount > 0 ? totalCost / amount : 0;
      amount -= tx.amount;
      totalCost -= tx.amount * avg;
    }
  });
  const avgRate = amount > 0 ? totalCost / amount : 0;
  const marketRate = getRate(code);
  const rateSet = hasRate(code);
  const currentValue = amount * marketRate;
  const pl = currentValue - totalCost;
  const plPct = totalCost > 0 ? (pl / totalCost) * 100 : 0;

  document.getElementById('fxDetailTitle').textContent = `${currencyFlag(code)} ${code}`;
  document.getElementById('fxd-amount').textContent = `${amount.toLocaleString()} ${code}`;
  document.getElementById('fxd-value').textContent = formatCurrency(currentValue, base);
  document.getElementById('fxd-cost').textContent = formatCurrency(totalCost, base);
  document.getElementById('fxd-avgrate').textContent = avgRate.toFixed(4);
  document.getElementById('fxd-marketrate').textContent = rateSet ? marketRate.toFixed(4) : 'Not set';
  const plEl = document.getElementById('fxd-pl');
  plEl.textContent = `${pl >= 0 ? '+' : ''}${formatCurrency(pl, base)}`;
  plEl.style.color = pl >= 0 ? '#48bb78' : '#f56565';
  document.getElementById('fxd-return').textContent = `${plPct.toFixed(2)}%`;

  const membersById = await membersByIdMap();
  const tbody = document.getElementById('fxd-tx-table');
  const sorted = txs.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#a0aec0;padding:20px;">No transactions yet</td></tr>';
  } else {
    tbody.innerHTML = sorted.map(tx => `
      <tr>
        <td>${escapeHtml(tx.date)}</td>
        <td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:bold;${fxTxTypeBadgeStyle(tx.type)}">${escapeHtml(tx.type)}</span></td>
        <td><strong>${tx.amount.toLocaleString()}</strong></td>
        <td>${tx.rate.toFixed(5)}</td>
        <td>${formatCurrency(tx.totalBase, base)}</td>
        <td>${ownerBadgeHtml(tx.ownerIds, membersById)}</td>
        <td>${escapeHtml(tx.notes || '-')}</td>
        <td>
          <button data-action="editFxTx" data-arg="${tx.id}" style="border:none;background:none;cursor:pointer;margin-right:8px;" title="Edit">✏️</button>
          <button data-action="deleteFxTx" data-arg="${tx.id}" style="border:none;background:none;cursor:pointer;color:#e53e3e;" title="Delete">🗑️</button>
        </td>
      </tr>
    `).join('');
  }
}

// ==================== FX PRINT REPORTS ====================
async function printFxReport(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const extraStyle = '@page { size: auto; margin: 15mm; }' +
    '@media print { @page { size: landscape; } }' +
    'body{padding:20px;font-size:11pt;max-width:100%;margin:0;}' +
    'table{font-size:9pt;}' +
    'th,td{padding:6px 8px;}';
  const reportTitle = 'Foreign Currency Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, extraStyle);
  const base = getBaseCurrency();
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency: ' + base + (ownerName ? ' &nbsp;|&nbsp; Owner: ' + ownerName : '') + '</div>');

  let txs = await encGetAll('fxTransactions');
  if (ownerFilter !== 'All') {
    const oid = parseInt(ownerFilter);
    txs = txs.filter(t => (t.ownerIds || []).includes(oid));
  }
  if (txs.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No foreign currency records found for this owner.</p>');
    finishPrintWindow(printWindow);
    return;
  }

  const holdings = {};
  txs.forEach(tx => {
    if (!holdings[tx.currency]) holdings[tx.currency] = { amount: 0, totalCost: 0 };
    const h = holdings[tx.currency];
    if (tx.type === 'Buy' || tx.type === 'Gift') { h.amount += tx.amount; h.totalCost += tx.totalBase; }
    else if (tx.type === 'Sell') { const avg = h.amount > 0 ? h.totalCost / h.amount : 0; h.amount -= tx.amount; h.totalCost -= tx.amount * avg; }
  });

  let portfolioVal = 0, portfolioCost = 0, activeCount = 0;
  let holdingsHtml = '<table><thead><tr><th>Currency</th><th>Cash Amount</th><th>Current Value</th><th>Total Cost</th><th>Avg Buy Rate</th><th>Market Rate</th><th>Unrealised P&amp;L</th><th>Return (%)</th></tr></thead><tbody>';
  Object.keys(holdings).sort().forEach(code => {
    const h = holdings[code];
    if (h.amount <= 0.0000001) return;
    activeCount++;
    const avgRate = h.totalCost / h.amount;
    const marketRate = getRate(code);
    const rateSet = hasRate(code);
    const currentValue = h.amount * marketRate;
    const pl = currentValue - h.totalCost;
    const plPct = h.totalCost > 0 ? (pl / h.totalCost) * 100 : 0;
    portfolioVal += currentValue; portfolioCost += h.totalCost;
    holdingsHtml += '<tr><td>' + currencyFlag(code) + ' ' + code + '</td><td class="nowrap">' + h.amount.toLocaleString() + ' ' + code + '</td><td class="nowrap">' + formatCurrency(currentValue, base) + '</td><td class="nowrap">' + formatCurrency(h.totalCost, base) + '</td><td class="nowrap">' + avgRate.toFixed(4) + '</td><td class="nowrap">' + (rateSet ? marketRate.toFixed(4) : 'not set') + '</td><td class="nowrap">' + formatCurrency(pl, base) + '</td><td class="nowrap">' + plPct.toFixed(2) + '%</td></tr>';
  });
  holdingsHtml += '</tbody></table>';

  const totalPL = portfolioVal - portfolioCost;

  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Total Portfolio Value', formatCurrency(portfolioVal, base)));
  printWindow.document.write(statCardHtml('Total Cost Spent', formatCurrency(portfolioCost, base)));
  printWindow.document.write(statCardHtml('Unrealised P&L', formatCurrency(totalPL, base), totalPL));
  printWindow.document.write(statCardHtml('Currencies Held', activeCount));
  printWindow.document.write('</div>');

  printWindow.document.write('<h2>Holdings by Currency</h2>');
  printWindow.document.write(holdingsHtml);

  printWindow.document.write('<h2>Transaction Ledger</h2>');
  let txHtml = '<table><thead><tr><th>Date</th><th>Type</th><th>Currency</th><th>Foreign Amount</th><th>Rate</th><th>Base Amount</th><th>Notes</th></tr></thead><tbody>';
  txs.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(tx => {
    txHtml += '<tr><td class="nowrap">' + escapeHtml(tx.date) + '</td><td class="nowrap">' + escapeHtml(tx.type) + '</td><td class="nowrap">' + currencyFlag(tx.currency) + ' ' + escapeHtml(tx.currency) + '</td><td class="nowrap">' + tx.amount.toLocaleString() + '</td><td class="nowrap">' + tx.rate.toFixed(5) + '</td><td class="nowrap">' + formatCurrency(tx.totalBase, base) + '</td><td>' + (escapeHtml(tx.notes) || '-') + '</td></tr>';
  });
  txHtml += '</tbody></table>';
  printWindow.document.write(txHtml);

  finishPrintWindow(printWindow);
}

async function printFxSingleReport(code) {
  if (!code) return;
  const base = getBaseCurrency();
  const allTxs = await encGetAll('fxTransactions');
  const txs = allTxs.filter(t => t.currency === code).sort((a, b) => new Date(b.date) - new Date(a.date));

  let amount = 0, totalCost = 0;
  txs.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(tx => {
    if (tx.type === 'Buy' || tx.type === 'Gift') { amount += tx.amount; totalCost += tx.totalBase; }
    else if (tx.type === 'Sell') { const avg = amount > 0 ? totalCost / amount : 0; amount -= tx.amount; totalCost -= tx.amount * avg; }
  });
  const avgRate = amount > 0 ? totalCost / amount : 0;
  const marketRate = getRate(code);
  const rateSet = hasRate(code);
  const currentValue = amount * marketRate;
  const pl = currentValue - totalCost;

  const printWindow = openReportWindow('Foreign Currency — ' + code, '');
  printWindow.document.write('<h1>' + currencyFlag(code) + ' ' + code + '</h1>');
  printWindow.document.write('<p>Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' | Base currency: ' + base + '</p>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Cash Amount', amount.toLocaleString() + ' ' + code));
  printWindow.document.write(statCardHtml('Current Value', formatCurrency(currentValue, base)));
  printWindow.document.write(statCardHtml('Total Cost', formatCurrency(totalCost, base)));
  printWindow.document.write(statCardHtml('Avg Buy Rate', avgRate.toFixed(4)));
  printWindow.document.write(statCardHtml('Market Rate', rateSet ? marketRate.toFixed(4) : 'Not set'));
  printWindow.document.write(statCardHtml('Unrealised P&L', formatCurrency(pl, base), pl));
  printWindow.document.write('</div>');
  printWindow.document.write('<h2>Transaction History</h2>');
  if (txs.length === 0) {
    printWindow.document.write('<p style="color:#a0aec0;">No transactions yet.</p>');
  } else {
    let html = '<table><thead><tr><th>Date</th><th>Type</th><th>Foreign Amount</th><th>Rate</th><th>Base Amount</th><th>Notes</th></tr></thead><tbody>';
    txs.forEach(tx => {
      html += '<tr><td>' + escapeHtml(tx.date) + '</td><td>' + escapeHtml(tx.type) + '</td><td>' + tx.amount.toLocaleString() + '</td><td>' + tx.rate.toFixed(5) + '</td><td>' + formatCurrency(tx.totalBase, base) + '</td><td>' + (escapeHtml(tx.notes) || '-') + '</td></tr>';
    });
    html += '</tbody></table>';
    printWindow.document.write(html);
  }
  finishPrintWindow(printWindow);
}

// ==================== MY WEALTH DASHBOARD ====================
let wealthOwnerFilter = loadViewMode('utt-wealth-owner-filter', 'All');

const WEALTH_MODULE_META = {
  unittrust: { label: '📊 Unit Trust' },
  amanah: { label: '🏦 Amanah Saham' },
  kwsp: { label: '🏦 KWSP' },
  fd: { label: '🏦 Fixed Deposit' },
  realestate: { label: '🏠 Real Estate' },
  fx: { label: '💵 Foreign Currency' }
};
// Everything except Real Estate — grouped together as "Financial Assets" so that
// Financial Assets + Real Estate = Total Net Worth throughout the wealth dashboard.
const WEALTH_FINANCIAL_KEYS = ['amanah', 'kwsp', 'fd', 'unittrust', 'fx'];
function wealthFinancialTotal(byModule) {
  return WEALTH_FINANCIAL_KEYS.reduce((sum, k) => sum + (byModule[k] || 0), 0);
}

async function renderWealthOwnerFilterOptions() {
  const select = document.getElementById('wealth-owner-filter');
  if (!select) return;
  const members = await getMembers();
  const showJoint = members.length > 1;
  select.innerHTML = '<option value="All">👥 All Owners</option>' +
    (showJoint ? '<option value="joint">👫 Joint</option>' : '') +
    members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  const validValues = ['All'].concat(showJoint ? ['joint'] : []).concat(members.map(m => String(m.id)));
  select.value = validValues.includes(String(wealthOwnerFilter)) ? wealthOwnerFilter : 'All';
}
function setWealthOwnerFilter(owner) {
  wealthOwnerFilter = owner;
  saveViewMode('utt-wealth-owner-filter', owner);
  renderWealthAll();
}

// Computes net worth totals in base currency, optionally filtered to one owner.
// FD and Real Estate have no live market P&L concept here (FD is fixed, property value
// is manually entered), so "invested/P&L" only tracks Unit Trust, Amanah Saham, KWSP, FX.
// mode:
//  'inclusive' (default) — holding counts in full for owner filter, and for anyone who
//     co-owns it. This is the convention used by the top owner-filter dropdown, matching
//     every other module in the app.
//  'exclusive' — holding only counts if ownerFilter is its SOLE owner (used for the
//     per-member row in "Breakdown by Owner", so single-owner and joint holdings never
//     get counted twice).
//  'joint' — holding only counts if it has more than one owner (used for the "Joint" row
//     in "Breakdown by Owner" and the "Joint" option in the top filter); ownerFilter is
//     ignored in this mode.
//  'joint-with' — holding only counts if it has more than one owner AND ownerFilter is
//     one of them (used for the "Joint (with X)" row so it tallies with the "inclusive"
//     total shown when X is selected in the top filter: inclusive(X) = exclusive(X) +
//     joint-with(X), each holding counted exactly once).
async function computeWealthSummary(ownerFilter, mode) {
  mode = mode || 'inclusive';
  const oid = (ownerFilter && ownerFilter !== 'All') ? parseInt(ownerFilter) : null;
  const owns = (ownerIds) => {
    const ids = ownerIds || [];
    if (mode === 'joint') return ids.length > 1;
    if (mode === 'joint-with') return ids.length > 1 && ids.includes(oid);
    if (mode === 'exclusive') return ids.length === 1 && ids[0] === oid;
    return !oid || ids.includes(oid);
  };

  const funds = await encGetAll('funds');
  const fundTx = await encGetAll('transactions');
  let unittrustValue = 0, unittrustInvested = 0;
  funds.filter(f => owns(f.ownerIds) && isFundActive(f, fundTx)).forEach(f => {
    const m = calcFundMetrics(f, fundTx);
    unittrustValue += toBase(m.currentValue, f.currency);
    unittrustInvested += toBase(m.invested, f.currency);
  });

  const aFunds = await encGetAll('amanahFunds');
  const aTx = await encGetAll('amanahTransactions');
  let amanahValue = 0, amanahInvested = 0;
  aFunds.filter(f => owns(f.ownerIds) && isAmanahFundActive(f, aTx)).forEach(f => {
    const m = calcAmanahMetrics(f, aTx);
    amanahValue += toBase(m.currentValue, f.currency);
    amanahInvested += toBase(m.invested, f.currency);
  });

  const kAccts = await encGetAll('kwspAccounts');
  const kTx = await encGetAll('kwspTransactions');
  let kwspValue = 0, kwspInvested = 0;
  kAccts.filter(a => owns(a.ownerIds)).forEach(a => {
    const m = calcKwspMetrics(a, kTx);
    kwspValue += toBase(m.balance, a.currency);
    kwspInvested += toBase(m.totalContributions, a.currency);
  });

  const deposits = await encGetAll('fixedDeposits');
  let fdValue = 0;
  deposits.filter(d => d.status === 'Active' && owns(d.ownerIds)).forEach(d => {
    fdValue += toBase(d.principal, d.currency);
  });

  const properties = await encGetAll('realEstateProperties');
  const loanTx = await encGetAll('realEstateLoanTx');
  const cashflowTx = await encGetAll('realEstateTx');
  let realestateValue = 0;
  properties.filter(p => owns(p.ownerIds)).forEach(p => {
    const m = calcRePropertyMetrics(p, loanTx, cashflowTx);
    realestateValue += toBase(m.equity, p.currency); // net equity: property value minus mortgage
  });

  const fxTxs = await encGetAll('fxTransactions');
  // Always run through owns() — previously this short-circuited to "all transactions" whenever
  // oid was null, which incorrectly happened for 'joint' mode too (its oid is null since the
  // filter value passed in is 'All'), so a solely-owned FX holding was wrongly counted as Joint.
  const fxFiltered = fxTxs.filter(t => owns(t.ownerIds));
  const fxHoldings = {};
  fxFiltered.forEach(tx => {
    if (!fxHoldings[tx.currency]) fxHoldings[tx.currency] = { amount: 0, totalCost: 0 };
    const h = fxHoldings[tx.currency];
    if (tx.type === 'Buy' || tx.type === 'Gift') { h.amount += tx.amount; h.totalCost += tx.totalBase; }
    else if (tx.type === 'Sell') { const avg = h.amount > 0 ? h.totalCost / h.amount : 0; h.amount -= tx.amount; h.totalCost -= tx.amount * avg; }
  });
  let fxValue = 0, fxInvested = 0;
  Object.keys(fxHoldings).forEach(code => {
    const h = fxHoldings[code];
    if (h.amount <= 0.0000001) return;
    fxValue += h.amount * getRate(code);
    fxInvested += h.totalCost;
  });

  const byModule = { unittrust: unittrustValue, amanah: amanahValue, kwsp: kwspValue, fd: fdValue, realestate: realestateValue, fx: fxValue };
  const total = Object.values(byModule).reduce((a, b) => a + b, 0);
  const investedTracked = unittrustInvested + amanahInvested + kwspInvested + fxInvested;
  const valueTracked = unittrustValue + amanahValue + kwspValue + fxValue;
  const pl = valueTracked - investedTracked;

  return { byModule, total, investedTracked, pl };
}

// Builds the rows for "Breakdown by Owner". Always tallies exactly with whatever
// "Breakdown by Module" / the top stat cards show for the same filterValue:
//  'All' (default)  — every member's exclusive row + one "Joint" row → sums to the
//                      grand total (inclusive('All') summary).
//  'joint'          — a single "Joint" row → equals the joint-only summary.
//  a member id      — just that member's exclusive (solely-owned) row, matching the
//                      exclusive-only summary now shown in the top cards for that member;
//                      their joint holdings live under the 'Joint' filter instead.
async function computeWealthByOwner(filterValue) {
  filterValue = filterValue || 'All';
  const members = await getMembers();
  const rows = [];

  if (filterValue === 'All') {
    // "All Owners" view: plain member rows + one combined "Joint" row — no per-member
    // Joint sub-row here, since that would just repeat what the "Joint" row already shows.
    for (const m of members) {
      const s = await computeWealthSummary(String(m.id), 'exclusive');
      rows.push({ id: m.id, name: m.name, isJoint: false, total: s.total, financial: wealthFinancialTotal(s.byModule), realestate: s.byModule.realestate || 0 });
    }
    if (members.length > 1) {
      const js = await computeWealthSummary('All', 'joint');
      if (js.total > 0.005) {
        rows.push({ id: 'joint', name: 'Joint', isJoint: true, total: js.total, financial: wealthFinancialTotal(js.byModule), realestate: js.byModule.realestate || 0 });
      }
    }
  } else if (filterValue === 'joint') {
    const js = await computeWealthSummary('All', 'joint');
    rows.push({ id: 'joint', name: 'Joint', isJoint: true, total: js.total, financial: wealthFinancialTotal(js.byModule), realestate: js.byModule.realestate || 0 });
  } else {
    // A specific member is selected: show their solely-owned row AND a "Joint" sub-row
    // with their share of what they co-own, so nothing about that member is left out.
    const member = members.find(m => String(m.id) === String(filterValue));
    if (member) {
      const exS = await computeWealthSummary(String(member.id), 'exclusive');
      const jw = await computeWealthSummary(String(member.id), 'joint-with');
      rows.push({
        id: member.id, name: member.name, isJoint: false, total: exS.total, financial: wealthFinancialTotal(exS.byModule), realestate: exS.byModule.realestate || 0,
        hasJoint: jw.total > 0.005, jointFinancial: wealthFinancialTotal(jw.byModule), jointRealestate: jw.byModule.realestate || 0, jointTotal: jw.total
      });
    }
  }
  return rows;
}

async function renderWealthAll() {
  await renderWealthOwnerFilterOptions();
  try { await renderFdMaturedNoticeInto('wealth-fd-matured-notice', wealthOwnerFilter); } catch (e) { console.error('renderFdMaturedNoticeInto (wealth) failed:', e); }
  // 'All' → everything combined. 'joint' → joint-only holdings. A specific member →
  // that member's SOLE holdings only; anything they co-own lives under the 'Joint' filter
  // instead, so a member's total never silently includes joint funds.
  const summary = wealthOwnerFilter === 'joint' ? await computeWealthSummary('All', 'joint')
    : wealthOwnerFilter === 'All' ? await computeWealthSummary('All')
    : await computeWealthSummary(wealthOwnerFilter, 'exclusive');

  document.getElementById('wealth-stat-total').textContent = formatCurrency(summary.total);
  const activeModules = Object.values(summary.byModule).filter(v => Math.abs(v) > 0.005).length;
  document.getElementById('wealth-stat-modules').textContent = activeModules + ' module' + (activeModules !== 1 ? 's' : '') + ' with holdings';
  document.getElementById('wealth-stat-financial').textContent = formatCurrency(wealthFinancialTotal(summary.byModule));
  document.getElementById('wealth-stat-realestate').textContent = formatCurrency(summary.byModule.realestate || 0);

  const tbody = document.getElementById('wealth-module-table-body');
  const rows = Object.keys(WEALTH_MODULE_META).map(k => ({ label: WEALTH_MODULE_META[k].label, value: summary.byModule[k] || 0 }))
    .filter(r => Math.abs(r.value) > 0.005)
    .sort((a, b) => b.value - a.value);
  tbody.innerHTML = rows.length === 0 ? '<tr><td colspan="3" style="color:#a0aec0;">No holdings recorded yet.</td></tr>' :
    rows.map(r => `<tr><td>${escapeHtml(r.label)}</td><td>${formatCurrency(r.value)}</td><td>${summary.total > 0 ? (r.value / summary.total * 100).toFixed(1) : '0.0'}%</td></tr>`).join('');

  const members = await getMembers();
  const ownerWrap = document.getElementById('wealth-owner-breakdown-wrap');
  if (members.length === 0) {
    ownerWrap.style.display = 'none';
  } else {
    ownerWrap.style.display = '';
    // Same filterValue as the module breakdown above, so the two tables' totals always tally.
    const ownerRows = (await computeWealthByOwner(wealthOwnerFilter)).sort((a, b) => b.total - a.total);
    document.getElementById('wealth-owner-table-body').innerHTML = ownerRows.map(r => {
      const badge = r.isJoint
        ? `<span style="display:inline-block;background:#66668018;color:#666680;border:1px solid #66668040;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;">👫 ${escapeHtml(r.name)}</span>`
        : ownerBadgeHtml([r.id], { [r.id]: { name: r.name } });
      let rowHtml = `<tr><td>${badge}</td><td>${formatCurrency(r.financial)}</td><td>${formatCurrency(r.realestate)}</td><td>${formatCurrency(r.total)}</td><td>${summary.total > 0 ? (r.total / summary.total * 100).toFixed(1) : '0.0'}%</td></tr>`;
      // Sub-row: this member's share of joint holdings, same 4 columns as above — shown for
      // reference only (it's already folded into the combined "Joint" row, so it isn't summed again).
      if (r.hasJoint) {
        const jointBadge = `<span style="display:inline-block;background:#66668018;color:#666680;border:1px solid #66668040;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;">👫 Joint</span>`;
        rowHtml += `<tr style="background:#fafbfc;"><td style="padding-left:28px;">${jointBadge}</td><td style="color:#718096;">${formatCurrency(r.jointFinancial)}</td><td style="color:#718096;">${formatCurrency(r.jointRealestate)}</td><td style="color:#718096;">${formatCurrency(r.jointTotal)}</td><td style="color:#718096;">${summary.total > 0 ? (r.jointTotal / summary.total * 100).toFixed(1) : '0.0'}%</td></tr>`;
      }
      return rowHtml;
    }).join('');
  }

  renderWealthAllocationChart(summary.byModule);
}

function renderWealthAllocationChart(byModule) {
  const ctx = document.getElementById('wealthAllocationChart');
  if (!ctx) return;
  if (charts.wealthAllocation) charts.wealthAllocation.destroy();
  const entries = Object.keys(WEALTH_MODULE_META).map(k => ({ label: WEALTH_MODULE_META[k].label, value: byModule[k] || 0 })).filter(e => e.value > 0.005);
  if (entries.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';
  charts.wealthAllocation = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e.label), datasets: [{ data: entries.map(e => e.value), backgroundColor: ['#667eea', '#48bb78', '#4299e1', '#ed8936', '#f56565', '#9f7aea'] }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (c) => { const t = c.dataset.data.reduce((a, b) => a + b, 0); const pct = t > 0 ? ((c.raw / t) * 100).toFixed(1) : '0.0'; return c.label + ': ' + formatCurrency(c.raw) + ' (' + pct + '%)'; } } }
      }
    }
  });
}

// ==================== WEALTH PRINT REPORT ====================
async function printWealthReport(ownerFilter) {
  ownerFilter = ownerFilter || 'All';
  let ownerName = null;
  if (ownerFilter === 'joint') {
    ownerName = 'Joint';
  } else if (ownerFilter !== 'All') {
    const member = await encGet('members', parseInt(ownerFilter));
    ownerName = member ? member.name : 'Unknown';
  }
  const base = getBaseCurrency();
  const summary = ownerFilter === 'joint' ? await computeWealthSummary('All', 'joint')
    : ownerFilter === 'All' ? await computeWealthSummary('All')
    : await computeWealthSummary(ownerFilter, 'exclusive');
  const reportTitle = 'My Wealth Report' + (ownerName ? ' — ' + ownerName : '');
  const printWindow = openReportWindow(reportTitle, '');
  printWindow.document.write('<h1>' + reportTitle + '</h1>');
  printWindow.document.write('<div class="subtitle">Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ' &nbsp;|&nbsp; Base currency: ' + base + '</div>');
  printWindow.document.write('<div class="stats">');
  printWindow.document.write(statCardHtml('Total Net Worth', formatCurrency(summary.total)));
  printWindow.document.write(statCardHtml('Financial Assets', formatCurrency(wealthFinancialTotal(summary.byModule))));
  printWindow.document.write(statCardHtml('Real Estate', formatCurrency(summary.byModule.realestate || 0)));
  printWindow.document.write('</div>');
  printWindow.document.write('<h2>Breakdown by Module</h2>');
  let html = '<table><thead><tr><th>Module</th><th>Value</th><th>% of Net Worth</th></tr></thead><tbody>';
  Object.keys(WEALTH_MODULE_META).forEach(k => {
    const v = summary.byModule[k] || 0;
    if (Math.abs(v) < 0.005) return;
    html += '<tr><td>' + WEALTH_MODULE_META[k].label + '</td><td>' + formatCurrency(v) + '</td><td>' + (summary.total > 0 ? (v / summary.total * 100).toFixed(1) : '0.0') + '%</td></tr>';
  });
  html += '</tbody></table>';
  printWindow.document.write(html);
  // Same filterValue as above, so this table's totals always tally with "Breakdown by Module".
  const ownerRows = (await computeWealthByOwner(ownerFilter)).sort((a, b) => b.total - a.total);
  if (ownerRows.length > 0) {
    printWindow.document.write('<h2>Breakdown by Owner</h2>');
    let ownerHtml = '<table><thead><tr><th>Owner</th><th>Financial Assets</th><th>Real Estate</th><th>Total Net Worth</th><th>% of Net Worth</th></tr></thead><tbody>';
    ownerRows.forEach(r => {
      ownerHtml += '<tr><td>' + escapeHtml(r.name) + '</td><td>' + formatCurrency(r.financial) + '</td><td>' + formatCurrency(r.realestate) + '</td><td>' + formatCurrency(r.total) + '</td><td>' + (summary.total > 0 ? (r.total / summary.total * 100).toFixed(1) : '0.0') + '%</td></tr>';
    });
    ownerHtml += '</tbody></table>';
    printWindow.document.write(ownerHtml);
  }
  finishPrintWindow(printWindow);
}

// ==================== INCOME FORECAST ====================
// A pure "what-if" projection tool. Reads current balances/rents from the
// real modules only as starting suggestions — every value on a saved
// forecast is its own snapshot the user can override, and nothing here ever
// writes back to funds/accounts/properties.
let forecastRowSeq = 0;

function forecastScopeMatches(ownerIds, scope) {
  if (!scope || scope === 'All') return true;
  if (scope === 'Joint') return (ownerIds || []).length > 1;
  const mid = parseInt(scope);
  return (ownerIds || []).includes(mid);
}

async function getForecastFundSources(sourceType) {
  if (sourceType === 'unittrust') {
    const funds = await encGetAll('funds');
    const transactions = await encGetAll('transactions');
    return funds.map(f => {
      const m = calcFundMetrics(f, transactions);
      return { id: f.id, label: f.name + (f.code ? ' (' + f.code + ')' : ''), amount: m.currentValue, currency: f.currency, ownerIds: f.ownerIds || [], rateHint: null };
    });
  }
  if (sourceType === 'amanah') {
    const funds = await encGetAll('amanahFunds');
    const transactions = await encGetAll('amanahTransactions');
    return funds.map(f => {
      const m = calcAmanahMetrics(f, transactions);
      return { id: f.id, label: f.name + (f.code ? ' (' + f.code + ')' : ''), amount: m.currentValue, currency: f.currency, ownerIds: f.ownerIds || [], rateHint: null };
    });
  }
  if (sourceType === 'kwsp') {
    const accounts = await encGetAll('kwspAccounts');
    const transactions = await encGetAll('kwspTransactions');
    return accounts.map(a => {
      const m = calcKwspMetrics(a, transactions);
      return { id: a.id, label: a.name, amount: m.balance, currency: a.currency, ownerIds: a.ownerIds || [], rateHint: null };
    });
  }
  if (sourceType === 'fd') {
    const deposits = await encGetAll('fixedDeposits');
    return deposits.filter(fd => fd.status === 'Active').map(fd => ({
      id: fd.id, label: fd.bankName + (fd.maturityDate ? ' (matures ' + fd.maturityDate + ')' : ''),
      amount: parseFloat(fd.principal) || 0, currency: fd.currency, ownerIds: fd.ownerIds || [], rateHint: parseFloat(fd.interestRate) || 0
    }));
  }
  return [];
}

async function getForecastRentedProperties() {
  const properties = await encGetAll('realEstateProperties');
  return properties.filter(p => p.status === 'Rented').map(p => ({
    id: p.id, label: p.name, monthlyRent: parseFloat(p.monthlyRent) || 0, currency: p.currency, ownerIds: p.ownerIds || []
  }));
}

async function renderForecastScopeOptions() {
  const select = document.getElementById('forecastMemberScope');
  const current = select.value;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Members</option><option value="Joint">👫 Joint Only</option>' +
    members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  const stillValid = Array.from(select.options).some(o => o.value === current);
  select.value = stillValid ? current : 'All';
}

// Aggregates every fund/account of a given source type that matches the
// current scope into a single total (converted to base currency, since a
// "group all funds" total can span multiple original currencies). For Fixed
// Deposit, also returns a scope-weighted-average interest rate as a
// starting suggestion — still fully editable by the user.
async function computeForecastFundAggregate(sourceType, scope) {
  const sources = await getForecastFundSources(sourceType);
  const filtered = sources.filter(s => forecastScopeMatches(s.ownerIds, scope));
  let totalBase = 0, weightedRateNum = 0;
  filtered.forEach(s => {
    const baseAmt = toBase(s.amount, s.currency);
    totalBase += baseAmt;
    if (s.rateHint != null) weightedRateNum += baseAmt * s.rateHint;
  });
  const avgRate = (totalBase > 0 && filtered.some(s => s.rateHint != null)) ? (weightedRateNum / totalBase) : null;
  return { amount: totalBase, currency: getBaseCurrency(), rateHint: avgRate, count: filtered.length };
}

async function populateForecastPropertyOptions(rowId) {
  const tr = document.getElementById('fprow-' + rowId);
  if (!tr) return;
  const scope = document.getElementById('forecastMemberScope').value;
  const properties = await getForecastRentedProperties();
  const filtered = properties.filter(p => forecastScopeMatches(p.ownerIds, scope));
  const select = tr.querySelector('.fp-property');
  select.innerHTML = filtered.length === 0
    ? '<option value="">No rented properties in scope</option>'
    : filtered.map(p => `<option value="${p.id}" data-rent="${p.monthlyRent}" data-currency="${p.currency}">${escapeHtml(p.label)}</option>`).join('');
}

// Re-pulls the grouped total for a fund row's source type under the current
// scope, and fills it in (still editable afterwards).
async function refreshForecastFundRow(rowId) {
  const tr = document.getElementById('ffrow-' + rowId);
  if (!tr) return;
  const sourceType = tr.querySelector('.ff-source').value;
  const scope = document.getElementById('forecastMemberScope').value;
  const agg = await computeForecastFundAggregate(sourceType, scope);
  tr.querySelector('.ff-amount').value = agg.amount.toFixed(2);
  tr.dataset.currency = agg.currency;
  if (agg.rateHint != null) tr.querySelector('.ff-rate').value = agg.rateHint.toFixed(2);
  const countEl = tr.querySelector('.ff-count');
  if (countEl) countEl.textContent = agg.count === 0 ? 'No funds in scope' : (agg.count + ' fund' + (agg.count === 1 ? '' : 's') + ' grouped');
  recalcForecastTotals();
}

async function onForecastFundSourceChange(rowId) {
  await refreshForecastFundRow(rowId);
}

function onForecastPropertyChange(rowId) {
  const tr = document.getElementById('fprow-' + rowId);
  const opt = tr.querySelector('.fp-property').selectedOptions[0];
  if (opt && opt.dataset.rent !== undefined) {
    tr.querySelector('.fp-rent').value = parseFloat(opt.dataset.rent).toFixed(2);
    tr.dataset.currency = opt.dataset.currency || getBaseCurrency();
  }
  recalcForecastTotals();
}

// Scope changed after rows already exist — re-group every fund row's total
// under the new scope, and re-filter each property row's picker (tagging an
// out-of-scope pick rather than silently dropping it).
async function onForecastScopeChange() {
  for (const tr of Array.from(document.querySelectorAll('#forecastFundBody tr'))) {
    const rowId = tr.id.replace('ffrow-', '');
    await refreshForecastFundRow(rowId);
  }
  for (const tr of Array.from(document.querySelectorAll('#forecastPropertyBody tr'))) {
    const rowId = tr.id.replace('fprow-', '');
    const select = tr.querySelector('.fp-property');
    const currentVal = select.value, currentLabel = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
    await populateForecastPropertyOptions(rowId);
    if (currentVal && !Array.from(select.options).some(o => o.value === currentVal)) {
      const opt = document.createElement('option');
      opt.value = currentVal; opt.textContent = currentLabel + ' (out of scope)';
      select.appendChild(opt);
    }
    select.value = currentVal;
  }
}

async function addForecastFundRow(data) {
  const id = ++forecastRowSeq;
  const tr = document.createElement('tr');
  tr.id = 'ffrow-' + id;
  tr.innerHTML = `
    <td><select class="ff-source" data-action="onForecastFundSourceChange" data-arg="${id}">
      <option value="unittrust">Unit Trust</option>
      <option value="amanah">Amanah Saham</option>
      <option value="kwsp">KWSP</option>
      <option value="fd">Fixed Deposit</option>
    </select>
    <div class="ff-count" style="font-size:11px;color:#a0aec0;margin-top:2px;"></div></td>
    <td><input type="number" class="ff-amount" step="0.01" data-action="recalcForecastTotals" style="width:120px;text-align:right;"></td>
    <td><input type="number" class="ff-rate" step="0.01" placeholder="0.00" data-action="recalcForecastTotals" style="width:80px;text-align:right;"></td>
    <td class="ff-yearly" style="text-align:right;font-weight:600;">$0.00</td>
    <td><button type="button" class="icon-btn" title="Remove" data-action="removeRowRecalc">🗑️</button></td>`;
  document.getElementById('forecastFundBody').appendChild(tr);
  if (data) {
    tr.querySelector('.ff-source').value = data.sourceType || 'unittrust';
    tr.dataset.currency = data.currency || getBaseCurrency();
    tr.querySelector('.ff-amount').value = data.amount != null ? data.amount : '';
    tr.querySelector('.ff-rate').value = data.ratePct != null ? data.ratePct : '';
    // Still refresh the "N funds grouped" label under the current scope, without overwriting the saved amount/rate.
    const scope = document.getElementById('forecastMemberScope').value;
    const agg = await computeForecastFundAggregate(tr.querySelector('.ff-source').value, scope);
    const countEl = tr.querySelector('.ff-count');
    if (countEl) countEl.textContent = agg.count === 0 ? 'No funds in scope' : (agg.count + ' fund' + (agg.count === 1 ? '' : 's') + ' grouped');
    recalcForecastTotals();
  } else {
    await refreshForecastFundRow(id);
  }
  return id;
}

async function addForecastPropertyRow(data) {
  const id = ++forecastRowSeq;
  const tr = document.createElement('tr');
  tr.id = 'fprow-' + id;
  tr.innerHTML = `
    <td><select class="fp-property" data-action="onForecastPropertyChange" data-arg="${id}"></select></td>
    <td><input type="number" class="fp-rent" step="0.01" data-action="recalcForecastTotals" style="width:120px;text-align:right;"></td>
    <td class="fp-yearly" style="text-align:right;font-weight:600;">$0.00</td>
    <td><button type="button" class="icon-btn" title="Remove" data-action="removeRowRecalc">🗑️</button></td>`;
  document.getElementById('forecastPropertyBody').appendChild(tr);
  await populateForecastPropertyOptions(id);
  if (data) {
    const select = tr.querySelector('.fp-property');
    if (data.propertyId != null && !Array.from(select.options).some(o => o.value === String(data.propertyId))) {
      const opt = document.createElement('option');
      opt.value = data.propertyId; opt.textContent = (data.label || 'Unknown') + ' (no longer Rented / out of scope)';
      select.appendChild(opt);
    }
    if (data.propertyId != null) select.value = data.propertyId;
    tr.dataset.currency = data.currency || getBaseCurrency();
    tr.querySelector('.fp-rent').value = data.monthlyRent != null ? data.monthlyRent : '';
  } else {
    onForecastPropertyChange(id);
  }
  recalcForecastTotals();
  return id;
}

function recalcForecastTotals() {
  let totalYearlyBase = 0;
  document.querySelectorAll('#forecastFundBody tr').forEach(tr => {
    const amount = parseFloat(tr.querySelector('.ff-amount').value) || 0;
    const rate = parseFloat(tr.querySelector('.ff-rate').value) || 0;
    const currency = tr.dataset.currency || getBaseCurrency();
    const yearly = amount * rate / 100;
    tr.querySelector('.ff-yearly').textContent = formatCurrency(yearly, currency);
    totalYearlyBase += toBase(yearly, currency);
  });
  document.querySelectorAll('#forecastPropertyBody tr').forEach(tr => {
    const rent = parseFloat(tr.querySelector('.fp-rent').value) || 0;
    const currency = tr.dataset.currency || getBaseCurrency();
    const yearly = rent * 12;
    tr.querySelector('.fp-yearly').textContent = formatCurrency(yearly, currency);
    totalYearlyBase += toBase(yearly, currency);
  });
  const totalYearlyEl = document.getElementById('forecastTotalYearly');
  const totalMonthlyEl = document.getElementById('forecastTotalMonthly');
  if (totalYearlyEl) totalYearlyEl.textContent = formatCurrency(totalYearlyBase);
  if (totalMonthlyEl) totalMonthlyEl.textContent = formatCurrency(totalYearlyBase / 12);
  return totalYearlyBase;
}

async function openForecastModal(id) {
  document.getElementById('forecastModalTitle').textContent = id ? 'Edit Forecast' : 'New Forecast';
  document.getElementById('forecastId').value = id || '';
  document.getElementById('forecastFundBody').innerHTML = '';
  document.getElementById('forecastPropertyBody').innerHTML = '';
  document.getElementById('forecastName').value = '';
  document.getElementById('forecastMemberScope').innerHTML = '<option value="All">👥 All Members</option>';
  await renderForecastScopeOptions();

  if (id) {
    const f = await encGet('incomeForecasts', id);
    if (!f) { showToast('This forecast has been deleted'); return; }
    document.getElementById('forecastName').value = f.name || '';
    const scopeSelect = document.getElementById('forecastMemberScope');
    const hasScope = Array.from(scopeSelect.options).some(o => o.value === String(f.memberScope));
    scopeSelect.value = hasScope ? f.memberScope : 'All';
    for (const line of (f.lines || [])) {
      await addForecastFundRow(line);
    }
    for (const line of (f.propertyLines || [])) {
      await addForecastPropertyRow(line);
    }
  }
  recalcForecastTotals();
  document.getElementById('forecastModal').classList.add('active');
}

function closeForecastModal() { document.getElementById('forecastModal').classList.remove('active'); }

async function saveForecast() {
  const idStr = document.getElementById('forecastId').value;
  const name = document.getElementById('forecastName').value.trim();
  if (!name) { showToast('Please enter a forecast name'); return; }
  const memberScope = document.getElementById('forecastMemberScope').value;

  const lines = Array.from(document.querySelectorAll('#forecastFundBody tr')).map(tr => {
    return {
      sourceType: tr.querySelector('.ff-source').value,
      amount: parseFloat(tr.querySelector('.ff-amount').value) || 0,
      currency: tr.dataset.currency || getBaseCurrency(),
      ratePct: parseFloat(tr.querySelector('.ff-rate').value) || 0
    };
  });

  const propertyLines = Array.from(document.querySelectorAll('#forecastPropertyBody tr')).map(tr => {
    const select = tr.querySelector('.fp-property');
    const opt = select.selectedOptions[0];
    return {
      propertyId: select.value ? parseInt(select.value) : null,
      label: opt ? opt.textContent : '',
      monthlyRent: parseFloat(tr.querySelector('.fp-rent').value) || 0,
      currency: tr.dataset.currency || getBaseCurrency()
    };
  }).filter(l => l.propertyId !== null);

  const totalYearlyBase = recalcForecastTotals();
  const data = { name, memberScope, lines, propertyLines, totalYearlyBase, totalMonthlyBase: totalYearlyBase / 12 };

  if (idStr) {
    await encUpdate('incomeForecasts', parseInt(idStr), data);
  } else {
    data.createdAt = new Date();
    await encAdd('incomeForecasts', data);
  }
  closeForecastModal();
  showToast(idStr ? 'Forecast updated!' : 'Forecast saved!');
  renderForecastList();
}

async function deleteForecast(id) {
  if (!confirm('Delete this forecast?')) return;
  await db.incomeForecasts.delete(id);
  showToast('Forecast deleted');
  renderForecastList();
}

async function renderForecastList() {
  const forecasts = await encGetAll('incomeForecasts');
  const membersById = await membersByIdMap();
  const grid = document.getElementById('forecast-grid');
  const empty = document.getElementById('forecast-empty');
  if (forecasts.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = forecasts.map(f => {
    let scopeLabel = '👥 All Members';
    if (f.memberScope === 'Joint') scopeLabel = '👫 Joint Only';
    else if (f.memberScope && f.memberScope !== 'All') {
      const m = membersById[parseInt(f.memberScope)];
      scopeLabel = m ? ('👤 ' + m.name) : '👥 All Members';
    }
    const fundCount = (f.lines || []).length;
    const propCount = (f.propertyLines || []).length;
    return `<div class="fund-card">
      <div class="actions">
        <button class="icon-btn" title="Edit" data-action="openForecastModal" data-stop="1" data-arg="${f.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteForecast" data-stop="1" data-arg="${f.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name"><a href="#" data-action="openForecastModal" data-prevent="1" data-arg="${f.id}" style="color:#2d3748;text-decoration:none;cursor:pointer;">${escapeHtml(f.name)}</a></div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${scopeLabel} · ${fundCount} fund${fundCount === 1 ? '' : 's'} · ${propCount} propert${propCount === 1 ? 'y' : 'ies'}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Yearly Income</div><div class="stat-value positive">${formatCurrency(f.totalYearlyBase || 0)}</div></div>
        <div class="stat"><div class="stat-label">Monthly Income</div><div class="stat-value">${formatCurrency(f.totalMonthlyBase || 0)}</div></div>
      </div>
    </div>`;
  }).join('');
}

// ==================== MULTI-YEAR PLANNER ====================
// A full staged cashflow simulator, its own top-level module. Supports
// multiple named "plans" (e.g. one per household member) via mypPlans —
// every top-level entity (accounts, income items, expense items, baselines,
// actuals) carries a planId, so switching plans swaps the whole planner's
// data set. Child rows (rules, ranges, baseline values) are scoped
// transitively through their parent's id, so they don't need their own
// planId.
let mypForecastData = [];
let mypForecastFundsList = [];
let mypExpenseRangeSeq = 0;
let currentMypPlanId = null;

async function mypInitPlanner() {
  // Each step runs independently — a problem in one (e.g. a bad record)
  // should never prevent the Saved Forecasts cards from still rendering.
  try { await mypEnsureDefaultPlanAndLoad(); } catch (e) { console.error('mypEnsureDefaultPlanAndLoad failed:', e); }
  try { await mypRenderAll(); } catch (e) { console.error('mypRenderAll failed:', e); }
  try { await mypLoadOrClearForecastForCurrentPlan(); } catch (e) { console.error('mypLoadOrClearForecastForCurrentPlan failed:', e); }
  try { await mypRenderForecastCards(); } catch (e) { console.error('mypRenderForecastCards failed:', e); }
}

// Runs once per session before the planner is used. If no plan exists yet
// (first time after this feature shipped), creates a "My Plan" and migrates
// any pre-existing unscoped records into it, so nothing already set up is
// lost. Otherwise restores whichever plan was last selected.
async function mypEnsureDefaultPlanAndLoad() {
  let plans = await encGetAll('mypPlans');
  if (plans.length === 0) {
    const newId = await encAdd('mypPlans', { name: 'My Plan', createdAt: new Date() });
    for (const table of ['mypFunds', 'mypIncomeCategories', 'mypExpenseCategories', 'mypBaselines', 'mypActuals']) {
      const rows = await db[table].toArray();
      for (const r of rows) {
        if (r.planId == null) await encUpdate(table, r.id, { planId: newId });
      }
    }
    plans = await encGetAll('mypPlans');
  }
  let savedId = null;
  try { savedId = parseInt(localStorage.getItem('utt-current-myp-plan')); } catch (e) { /* ignore */ }
  currentMypPlanId = plans.some(p => p.id === savedId) ? savedId : plans[0].id;
  mypRenderPlanSelect(plans);
}

function mypRenderPlanSelect(plans) {
  const select = document.getElementById('mypPlanSelect');
  select.innerHTML = plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  select.value = currentMypPlanId;
}

// If the current plan has a saved forecast, restore it into view (so
// switching plans never leaves you staring at a blank Forecast tab).
// Otherwise clears the forecast display since it belongs to a different plan.
async function mypLoadOrClearForecastForCurrentPlan() {
  const saved = (await encGetAll('mypSavedForecasts')).find(s => s.planId === currentMypPlanId);
  if (saved) {
    mypForecastData = saved.tableData;
    mypForecastFundsList = saved.fundsList;
    document.getElementById('mypStartYear').value = saved.startYear;
    document.getElementById('mypEndYear').value = saved.endYear;
    mypRenderForecastOutputs(saved.summary, saved.fundsList, saved.tableData, saved.tableData.map(d => d.year));
    await mypRenderBaselineComparisonTable();
  } else {
    mypForecastData = [];
    mypForecastFundsList = [];
    document.getElementById('mypSummaryCards').innerHTML = '';
    document.getElementById('mypSnapshotYear').innerHTML = '';
    document.getElementById('mypSnapshotCards').innerHTML = '';
    document.getElementById('mypForecastTableHead').innerHTML = '';
    document.getElementById('mypForecastTableBody').innerHTML = '';
    if (charts.mypForecast) { charts.mypForecast.destroy(); charts.mypForecast = null; }
    document.getElementById('mypBaselineTableHead').innerHTML = '';
    document.getElementById('mypBaselineTableBody').innerHTML = '<tr><td style="text-align:center;color:#718096;padding:20px;">Generate a forecast on the Forecast sub-tab first</td></tr>';
  }
}

// Switching plans swaps in that plan's accounts/income/expense (via
// mypRenderAll) and restores that plan's last saved forecast if it has one —
// so moving between members never loses what was already generated.
async function mypSwitchPlan(id) {
  currentMypPlanId = parseInt(id);
  try { localStorage.setItem('utt-current-myp-plan', currentMypPlanId); } catch (e) { /* ignore */ }
  await mypRenderAll();
  await mypLoadOrClearForecastForCurrentPlan();
  await mypRenderForecastCards();
}

async function mypCreatePlan() {
  const name = prompt('Name this new plan (e.g. "Spouse" or "Joint Retirement"):');
  if (!name || !name.trim()) return;
  const newId = await encAdd('mypPlans', { name: name.trim(), createdAt: new Date() });
  mypRenderPlanSelect(await encGetAll('mypPlans'));
  await mypSwitchPlan(newId);
  showToast('Plan created!');
}

async function mypRenamePlan() {
  const plan = await encGet('mypPlans', currentMypPlanId);
  if (!plan) return;
  const name = prompt('Rename plan:', plan.name);
  if (!name || !name.trim()) return;
  await encUpdate('mypPlans', currentMypPlanId, { name: name.trim() });
  mypRenderPlanSelect(await encGetAll('mypPlans'));
  showToast('Plan renamed!');
}

async function mypDeletePlan() {
  const plans = await encGetAll('mypPlans');
  if (plans.length <= 1) { showToast("Can't delete your only plan"); return; }
  const plan = plans.find(p => p.id === currentMypPlanId);
  if (!plan) return;
  if (!confirm(`Delete plan "${plan.name}" and everything in it (accounts, rules, income, expenses, baselines)? This can't be undone.`)) return;

  const funds = await db.mypFunds.where('planId').equals(currentMypPlanId).toArray();
  for (const f of funds) {
    const rules = await db.mypFundRules.where('fundId').equals(f.id).toArray();
    for (const r of rules) await db.mypFundRules.delete(r.id);
    await db.mypFunds.delete(f.id);
  }
  const incomeCats = await db.mypIncomeCategories.where('planId').equals(currentMypPlanId).toArray();
  for (const c of incomeCats) {
    const ranges = await db.mypIncomeRanges.where('categoryId').equals(c.id).toArray();
    for (const r of ranges) await db.mypIncomeRanges.delete(r.id);
    await db.mypIncomeCategories.delete(c.id);
  }
  const expenseCats = await db.mypExpenseCategories.where('planId').equals(currentMypPlanId).toArray();
  for (const c of expenseCats) {
    const ranges = await db.mypExpenseRanges.where('categoryId').equals(c.id).toArray();
    for (const r of ranges) await db.mypExpenseRanges.delete(r.id);
    await db.mypExpenseCategories.delete(c.id);
  }
  const baselines = await db.mypBaselines.where('planId').equals(currentMypPlanId).toArray();
  for (const b of baselines) {
    const values = await db.mypBaselineValues.where('baselineId').equals(b.id).toArray();
    for (const v of values) await db.mypBaselineValues.delete(v.id);
    await db.mypBaselines.delete(b.id);
  }
  const actuals = await db.mypActuals.where('planId').equals(currentMypPlanId).toArray();
  for (const a of actuals) await db.mypActuals.delete(a.id);
  const savedForecasts = await db.mypSavedForecasts.where('planId').equals(currentMypPlanId).toArray();
  for (const s of savedForecasts) await db.mypSavedForecasts.delete(s.id);
  await db.mypPlans.delete(currentMypPlanId);

  showToast('Plan deleted');
  const remaining = await encGetAll('mypPlans');
  currentMypPlanId = remaining[0].id;
  try { localStorage.setItem('utt-current-myp-plan', currentMypPlanId); } catch (e) { /* ignore */ }
  mypRenderPlanSelect(remaining);
  await mypSwitchPlan(currentMypPlanId);
}

function switchPlannerTab(tab) {
  document.getElementById('planner-tab-setup-btn').classList.toggle('active', tab === 'setup');
  document.getElementById('planner-tab-forecast-btn').classList.toggle('active', tab === 'forecast');
  document.getElementById('planner-tab-baseline-btn').classList.toggle('active', tab === 'baseline');
  document.getElementById('plannerSetupView').classList.toggle('hidden', tab !== 'setup');
  document.getElementById('plannerForecastView').classList.toggle('hidden', tab !== 'forecast');
  document.getElementById('plannerBaselineView').classList.toggle('hidden', tab !== 'baseline');
  if (tab === 'setup') mypRenderAll();
  else if (tab === 'baseline') mypRenderBaselineComparisonTable();
}

async function mypRenderAll() {
  await mypLoadFunds();
  await mypLoadRules();
  await mypLoadIncome();
  await mypLoadExpense();
}

// ---------- Accounts ----------
function mypSourceLabel(source) {
  return { unittrust: 'Unit Trust', amanah: 'Amanah Saham', kwsp: 'KWSP', fd: 'Fixed Deposit' }[source] || (source || 'Unknown');
}

async function mypScopeLabelText(scope) {
  if (scope === 'Joint') return 'Joint';
  if (!scope || scope === 'All') return 'All Members';
  const members = await getMembers();
  const m = members.find(mm => String(mm.id) === String(scope));
  return m ? m.name : 'All Members';
}

async function mypLoadFunds() {
  const funds = (await encGetAll('mypFunds')).filter(f => f.planId === currentMypPlanId);
  const container = document.getElementById('mypFundsList');
  if (!funds.length) { container.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No accounts yet.</p>'; return; }
  container.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Account</th><th>Source</th><th style="text-align:right;">Amount</th><th style="text-align:right;">Return %</th><th></th></tr></thead><tbody>` +
    funds.map(f => `<tr>
      <td><b>${escapeHtml(f.name)}</b></td>
      <td>${mypSourceLabel(f.type)}</td>
      <td style="text-align:right;">${formatCurrency(f.initialAmount)}</td>
      <td style="text-align:right;">${parseFloat(f.returnRate || 0).toFixed(2)}%</td>
      <td class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="openMypFundModal" data-arg="${f.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteMypFund" data-arg="${f.id}">🗑️</button>
      </td>
    </tr>`).join('') + '</tbody></table></div>';
}

async function mypPopulateFundScopeOptions() {
  const select = document.getElementById('mypFundScope');
  const current = select.value;
  const members = await getMembers();
  select.innerHTML = '<option value="All">👥 All Members</option><option value="Joint">👫 Joint Only</option>' +
    members.map(m => `<option value="${m.id}">👤 ${escapeHtml(m.name)}</option>`).join('');
  const stillValid = Array.from(select.options).some(o => o.value === current);
  select.value = stillValid ? current : 'All';
}

// Re-pulls the grouped total (and, for FD, a suggested rate) for the
// currently picked scope + source, same aggregation used by Quick Forecasts.
// Only auto-suggests the account name while adding a brand new account —
// editing an existing account never overwrites a name you already set.
async function mypOnFundScopeSourceChange() {
  const scope = document.getElementById('mypFundScope').value;
  const source = document.getElementById('mypFundSource').value;
  const agg = await computeForecastFundAggregate(source, scope);
  document.getElementById('mypFundInitial').value = agg.amount.toFixed(2);
  if (agg.rateHint != null) document.getElementById('mypFundReturn').value = agg.rateHint.toFixed(2);
  const countEl = document.getElementById('mypFundCount');
  countEl.textContent = agg.count === 0 ? 'No funds in scope' : (agg.count + ' fund' + (agg.count === 1 ? '' : 's') + ' grouped');
  if (!document.getElementById('mypFundId').value) {
    document.getElementById('mypFundName').value = mypSourceLabel(source) + ' (' + (await mypScopeLabelText(scope)) + ')';
  }
}

async function openMypFundModal(id) {
  document.getElementById('mypFundModalTitle').textContent = id ? 'Edit Account' : 'Add Account';
  document.getElementById('mypFundId').value = id || '';
  await mypPopulateFundScopeOptions();
  if (id) {
    const f = await encGet('mypFunds', id);
    if (!f) return;
    document.getElementById('mypFundScope').value = 'All';
    document.getElementById('mypFundSource').value = f.type || 'unittrust';
    document.getElementById('mypFundName').value = f.name || '';
    document.getElementById('mypFundInitial').value = f.initialAmount != null ? f.initialAmount : '';
    document.getElementById('mypFundReturn').value = f.returnRate != null ? f.returnRate : '';
    document.getElementById('mypFundCount').textContent = '';
  } else {
    document.getElementById('mypFundScope').value = 'All';
    document.getElementById('mypFundSource').value = 'unittrust';
    document.getElementById('mypFundName').value = '';
    await mypOnFundScopeSourceChange();
  }
  document.getElementById('mypFundModal').classList.add('active');
}
function closeMypFundModal() { document.getElementById('mypFundModal').classList.remove('active'); }

async function saveMypFund() {
  const idStr = document.getElementById('mypFundId').value;
  const name = document.getElementById('mypFundName').value.trim();
  if (!name) { showToast('Please enter an account name'); return; }
  const data = {
    name,
    type: document.getElementById('mypFundSource').value,
    initialAmount: parseFloat(document.getElementById('mypFundInitial').value) || 0,
    returnRate: parseFloat(document.getElementById('mypFundReturn').value) || 0
  };
  if (idStr) {
    await encUpdate('mypFunds', parseInt(idStr), data);
  } else {
    data.planId = currentMypPlanId;
    await encAdd('mypFunds', data);
  }
  closeMypFundModal();
  showToast('Account saved!');
  await mypLoadFunds();
  await mypLoadRules();
}

async function deleteMypFund(id) {
  if (!confirm('Delete this account? Its staged rules will also be removed.')) return;
  await db.mypFunds.delete(id);
  const rules = await db.mypFundRules.where('fundId').equals(id).toArray();
  for (const r of rules) await db.mypFundRules.delete(r.id);
  showToast('Account deleted');
  await mypLoadFunds();
  await mypLoadRules();
}

// ---------- Staged Allocation Rules ----------
async function mypLoadRules() {
  const funds = (await encGetAll('mypFunds')).filter(f => f.planId === currentMypPlanId);
  const fundIds = new Set(funds.map(f => f.id));
  const rules = (await encGetAll('mypFundRules')).filter(r => fundIds.has(r.fundId));
  const fundsById = {}; funds.forEach(f => fundsById[f.id] = f.name);
  const container = document.getElementById('mypRulesList');
  if (!rules.length) { container.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No staged rules yet.</p>'; return; }
  container.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Year Range</th><th>Account</th><th style="text-align:right;">Priority</th><th style="text-align:right;">Allocation %</th><th></th></tr></thead><tbody>` +
    rules.map(r => `<tr>
      <td><b>${r.startYear} – ${r.endYear}</b></td>
      <td>${fundsById[r.fundId] || 'Unknown account'}</td>
      <td style="text-align:right;">${r.priority}</td>
      <td style="text-align:right;">${r.allocationPct}%</td>
      <td class="tx-actions">
        <button class="icon-btn" title="Edit" data-action="openMypRuleModal" data-arg="${r.id}">✏️</button>
        <button class="icon-btn" title="Delete" data-action="deleteMypRule" data-arg="${r.id}">🗑️</button>
      </td>
    </tr>`).join('') + '</tbody></table></div>';
}

async function openMypRuleModal(id) {
  document.getElementById('mypRuleModalTitle').textContent = id ? 'Edit Staged Rule' : 'Add Staged Rule';
  document.getElementById('mypRuleId').value = id || '';
  const funds = (await encGetAll('mypFunds')).filter(f => f.planId === currentMypPlanId);
  const select = document.getElementById('mypRuleFundId');
  if (funds.length === 0) {
    select.innerHTML = '<option value="">Add an account first</option>';
  } else {
    select.innerHTML = funds.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  }
  if (id) {
    const r = await encGet('mypFundRules', id);
    if (r) {
      select.value = r.fundId;
      document.getElementById('mypRuleStart').value = r.startYear;
      document.getElementById('mypRuleEnd').value = r.endYear;
      document.getElementById('mypRulePriority').value = r.priority;
      document.getElementById('mypRuleAlloc').value = r.allocationPct;
    }
  } else {
    document.getElementById('mypRuleStart').value = '';
    document.getElementById('mypRuleEnd').value = '';
    document.getElementById('mypRulePriority').value = 1;
    document.getElementById('mypRuleAlloc').value = '';
  }
  document.getElementById('mypRuleModal').classList.add('active');
}
function closeMypRuleModal() { document.getElementById('mypRuleModal').classList.remove('active'); }

async function saveMypRule() {
  const idStr = document.getElementById('mypRuleId').value;
  const fundId = parseInt(document.getElementById('mypRuleFundId').value);
  if (!fundId) { showToast('Please add an account first'); return; }
  const data = {
    fundId,
    startYear: parseInt(document.getElementById('mypRuleStart').value) || 0,
    endYear: parseInt(document.getElementById('mypRuleEnd').value) || 0,
    priority: parseInt(document.getElementById('mypRulePriority').value) || 1,
    allocationPct: parseFloat(document.getElementById('mypRuleAlloc').value) || 0
  };
  if (idStr) await encUpdate('mypFundRules', parseInt(idStr), data);
  else await encAdd('mypFundRules', data);
  closeMypRuleModal();
  showToast('Rule saved!');
  await mypLoadRules();
}

async function deleteMypRule(id) {
  if (!confirm('Delete this staged rule?')) return;
  await db.mypFundRules.delete(id);
  showToast('Rule deleted');
  await mypLoadRules();
}

// ---------- Income Timeline (fully manual, mirrors Expense Budget) ----------
async function mypLoadIncome() {
  const cats = (await encGetAll('mypIncomeCategories')).filter(c => c.planId === currentMypPlanId);
  const allRanges = await encGetAll('mypIncomeRanges');
  const container = document.getElementById('mypIncomeList');
  if (!cats.length) { container.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No income items yet.</p>'; return; }
  container.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Item</th><th>Year Ranges &amp; Amounts</th><th></th></tr></thead><tbody>` +
    cats.map(c => {
      const ranges = allRanges.filter(r => r.categoryId === c.id);
      const rText = ranges.map(r => `${r.startYear}–${r.endYear}: ${formatCurrency(r.amount)}/yr`).join('<br>') || '<span style="color:#a0aec0;">No ranges</span>';
      return `<tr>
        <td><b>${escapeHtml(c.name)}</b></td>
        <td style="font-size:12px;">${rText}</td>
        <td class="tx-actions">
          <button class="icon-btn" title="Edit" data-action="openMypIncomeModal" data-arg="${c.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteMypIncome" data-arg="${c.id}">🗑️</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table></div>';
}

function mypAddIncomeRangeRow(startVal, endVal, amtVal) {
  const id = ++mypExpenseRangeSeq;
  const row = document.createElement('div');
  row.className = 'form-row';
  row.id = 'myprow-' + id;
  row.style.cssText = 'grid-template-columns: 1fr 1fr 1fr auto; align-items: end; gap: 10px;';
  row.innerHTML = `
    <div class="form-group" style="margin-bottom:10px;"><label>Start Year</label><input type="number" class="mir-start" value="${startVal != null ? startVal : ''}"></div>
    <div class="form-group" style="margin-bottom:10px;"><label>End Year</label><input type="number" class="mir-end" value="${endVal != null ? endVal : ''}"></div>
    <div class="form-group" style="margin-bottom:10px;"><label>Amount / yr</label><input type="number" class="mir-amt" step="0.01" value="${amtVal != null ? amtVal : ''}"></div>
    <button type="button" class="icon-btn" title="Remove" style="margin-bottom:10px;" data-action="removeMyprow" data-arg="${id}">🗑️</button>`;
  document.getElementById('mypIncomeRangesContainer').appendChild(row);
}

async function openMypIncomeModal(id) {
  document.getElementById('mypIncomeModalTitle').textContent = id ? 'Edit Income Item' : 'Add Income Item';
  document.getElementById('mypIncomeId').value = id || '';
  document.getElementById('mypIncomeRangesContainer').innerHTML = '';
  if (id) {
    const c = await encGet('mypIncomeCategories', id);
    if (!c) return;
    document.getElementById('mypIncomeName').value = c.name || '';
    const ranges = (await encGetAll('mypIncomeRanges')).filter(r => r.categoryId === id);
    if (ranges.length) ranges.forEach(r => mypAddIncomeRangeRow(r.startYear, r.endYear, r.amount));
    else mypAddIncomeRangeRow();
  } else {
    document.getElementById('mypIncomeName').value = '';
    mypAddIncomeRangeRow();
  }
  document.getElementById('mypIncomeModal').classList.add('active');
}
function closeMypIncomeModal() { document.getElementById('mypIncomeModal').classList.remove('active'); }

async function saveMypIncome() {
  const idStr = document.getElementById('mypIncomeId').value;
  const name = document.getElementById('mypIncomeName').value.trim();
  if (!name) { showToast('Please enter a name'); return; }
  let categoryId;
  if (idStr) {
    categoryId = parseInt(idStr);
    await encUpdate('mypIncomeCategories', categoryId, { name });
    const existing = (await db.mypIncomeRanges.where('categoryId').equals(categoryId).toArray());
    for (const r of existing) await db.mypIncomeRanges.delete(r.id);
  } else {
    categoryId = await encAdd('mypIncomeCategories', { name, planId: currentMypPlanId });
  }
  for (const row of document.querySelectorAll('#mypIncomeRangesContainer .form-row')) {
    const startYear = parseInt(row.querySelector('.mir-start').value);
    const endYear = parseInt(row.querySelector('.mir-end').value);
    const amount = parseFloat(row.querySelector('.mir-amt').value) || 0;
    if (startYear && endYear) await encAdd('mypIncomeRanges', { categoryId, startYear, endYear, amount });
  }
  closeMypIncomeModal();
  showToast('Income item saved!');
  await mypLoadIncome();
}

async function deleteMypIncome(id) {
  if (!confirm('Delete this income item and its year ranges?')) return;
  await db.mypIncomeCategories.delete(id);
  const ranges = await db.mypIncomeRanges.where('categoryId').equals(id).toArray();
  for (const r of ranges) await db.mypIncomeRanges.delete(r.id);
  showToast('Income item deleted');
  await mypLoadIncome();
}

// ---------- Expense Budget ----------
async function mypLoadExpense() {
  const cats = (await encGetAll('mypExpenseCategories')).filter(c => c.planId === currentMypPlanId);
  const allRanges = await encGetAll('mypExpenseRanges');
  const container = document.getElementById('mypExpenseList');
  if (!cats.length) { container.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No expense items yet.</p>'; return; }
  container.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Item</th><th>Year Ranges &amp; Amounts</th><th></th></tr></thead><tbody>` +
    cats.map(c => {
      const ranges = allRanges.filter(r => r.categoryId === c.id);
      const rText = ranges.map(r => `${r.startYear}–${r.endYear}: ${formatCurrency(r.amount)}/yr`).join('<br>') || '<span style="color:#a0aec0;">No ranges</span>';
      return `<tr>
        <td><b>${escapeHtml(c.name)}</b></td>
        <td style="font-size:12px;">${rText}</td>
        <td class="tx-actions">
          <button class="icon-btn" title="Edit" data-action="openMypExpenseModal" data-arg="${c.id}">✏️</button>
          <button class="icon-btn" title="Delete" data-action="deleteMypExpense" data-arg="${c.id}">🗑️</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table></div>';
}

function mypAddExpenseRangeRow(startVal, endVal, amtVal) {
  const id = ++mypExpenseRangeSeq;
  const row = document.createElement('div');
  row.className = 'form-row';
  row.id = 'myprow-' + id;
  row.style.cssText = 'grid-template-columns: 1fr 1fr 1fr auto; align-items: end; gap: 10px;';
  row.innerHTML = `
    <div class="form-group" style="margin-bottom:10px;"><label>Start Year</label><input type="number" class="mer-start" value="${startVal != null ? startVal : ''}"></div>
    <div class="form-group" style="margin-bottom:10px;"><label>End Year</label><input type="number" class="mer-end" value="${endVal != null ? endVal : ''}"></div>
    <div class="form-group" style="margin-bottom:10px;"><label>Amount / yr</label><input type="number" class="mer-amt" step="0.01" value="${amtVal != null ? amtVal : ''}"></div>
    <button type="button" class="icon-btn" title="Remove" style="margin-bottom:10px;" data-action="removeMyprow" data-arg="${id}">🗑️</button>`;
  document.getElementById('mypExpenseRangesContainer').appendChild(row);
}

async function openMypExpenseModal(id) {
  document.getElementById('mypExpenseModalTitle').textContent = id ? 'Edit Expense Item' : 'Add Expense Item';
  document.getElementById('mypExpenseId').value = id || '';
  document.getElementById('mypExpenseRangesContainer').innerHTML = '';
  if (id) {
    const c = await encGet('mypExpenseCategories', id);
    if (!c) return;
    document.getElementById('mypExpenseName').value = c.name || '';
    const ranges = (await encGetAll('mypExpenseRanges')).filter(r => r.categoryId === id);
    if (ranges.length) ranges.forEach(r => mypAddExpenseRangeRow(r.startYear, r.endYear, r.amount));
    else mypAddExpenseRangeRow();
  } else {
    document.getElementById('mypExpenseName').value = '';
    mypAddExpenseRangeRow();
  }
  document.getElementById('mypExpenseModal').classList.add('active');
}
function closeMypExpenseModal() { document.getElementById('mypExpenseModal').classList.remove('active'); }

async function saveMypExpense() {
  const idStr = document.getElementById('mypExpenseId').value;
  const name = document.getElementById('mypExpenseName').value.trim();
  if (!name) { showToast('Please enter a name'); return; }
  let categoryId;
  if (idStr) {
    categoryId = parseInt(idStr);
    await encUpdate('mypExpenseCategories', categoryId, { name });
    const existing = (await db.mypExpenseRanges.where('categoryId').equals(categoryId).toArray());
    for (const r of existing) await db.mypExpenseRanges.delete(r.id);
  } else {
    categoryId = await encAdd('mypExpenseCategories', { name, planId: currentMypPlanId });
  }
  for (const row of document.querySelectorAll('#mypExpenseRangesContainer .form-row')) {
    const startYear = parseInt(row.querySelector('.mer-start').value);
    const endYear = parseInt(row.querySelector('.mer-end').value);
    const amount = parseFloat(row.querySelector('.mer-amt').value) || 0;
    if (startYear && endYear) await encAdd('mypExpenseRanges', { categoryId, startYear, endYear, amount });
  }
  closeMypExpenseModal();
  showToast('Expense item saved!');
  await mypLoadExpense();
}

async function deleteMypExpense(id) {
  if (!confirm('Delete this expense item and its year ranges?')) return;
  await db.mypExpenseCategories.delete(id);
  const ranges = await db.mypExpenseRanges.where('categoryId').equals(id).toArray();
  for (const r of ranges) await db.mypExpenseRanges.delete(r.id);
  showToast('Expense item deleted');
  await mypLoadExpense();
}

// ---------- Forecast Engine ----------
async function mypRunForecast() {
  const startYear = parseInt(document.getElementById('mypStartYear').value);
  const endYear = parseInt(document.getElementById('mypEndYear').value);
  if (!startYear || !endYear || endYear < startYear) { showToast('Please enter a valid year range'); return; }

  const funds = (await encGetAll('mypFunds')).filter(f => f.planId === currentMypPlanId);
  const allRules = await encGetAll('mypFundRules');
  const incomeCats = (await encGetAll('mypIncomeCategories')).filter(c => c.planId === currentMypPlanId);
  const allIncomeRanges = await encGetAll('mypIncomeRanges');
  const expenseCats = (await encGetAll('mypExpenseCategories')).filter(c => c.planId === currentMypPlanId);
  const allExpenseRanges = await encGetAll('mypExpenseRanges');

  let currentBalances = {};
  funds.forEach(f => currentBalances[f.id] = parseFloat(f.initialAmount) || 0);

  const years = [], tableData = [];
  const summary = { totalIncome: 0, totalExpense: 0, totalInterest: 0 };

  for (let year = startYear; year <= endYear; year++) {
    years.push(year);

    const yearRules = funds.map(f => {
      const rule = allRules.find(r => r.fundId === f.id && year >= r.startYear && year <= r.endYear);
      return {
        id: f.id, name: f.name, returnRate: parseFloat(f.returnRate) || 0,
        allocationPct: rule ? (parseFloat(rule.allocationPct) || 0) : 0,
        priority: rule ? parseInt(rule.priority) : 99
      };
    });
    const totalAlloc = yearRules.reduce((s, r) => s + r.allocationPct, 0);
    const allocWeights = {};
    yearRules.forEach(r => allocWeights[r.id] = totalAlloc > 0 ? (r.allocationPct / totalAlloc) : (funds.length ? 1 / funds.length : 0));
    const sortedForDeficit = [...yearRules].sort((a, b) => a.priority - b.priority);

    let yearIncome = 0, yearExpense = 0;
    const incomeDetail = [], expenseDetail = [];
    incomeCats.forEach(c => {
      allIncomeRanges.filter(r => r.categoryId === c.id).forEach(r => {
        if (year >= r.startYear && year <= r.endYear) {
          const amt = parseFloat(r.amount) || 0;
          yearIncome += amt;
          if (amt) incomeDetail.push(`${escapeHtml(c.name)}: ${formatCurrency(amt)}`);
        }
      });
    });
    expenseCats.forEach(c => {
      allExpenseRanges.filter(r => r.categoryId === c.id).forEach(r => {
        if (year >= r.startYear && year <= r.endYear) {
          const amt = parseFloat(r.amount) || 0;
          yearExpense += amt;
          if (amt) expenseDetail.push(`${escapeHtml(c.name)}: ${formatCurrency(amt)}`);
        }
      });
    });

    const surplus = yearIncome - yearExpense;
    const fundFlows = [];
    if (surplus >= 0) {
      yearRules.forEach(f => {
        const add = surplus * allocWeights[f.id];
        currentBalances[f.id] += add;
        if (add > 0) fundFlows.push(`${escapeHtml(f.name)}: +${formatCurrency(add)}`);
      });
    } else {
      let deficit = Math.abs(surplus);
      for (const f of sortedForDeficit) {
        if (deficit <= 0) break;
        const avail = currentBalances[f.id];
        const deduct = Math.min(avail, deficit);
        currentBalances[f.id] -= deduct;
        deficit -= deduct;
        if (deduct > 0) fundFlows.push(`${escapeHtml(f.name)}: -${formatCurrency(deduct)} (P${f.priority})`);
      }
    }

    let yearInterest = 0;
    yearRules.forEach(f => {
      const interest = currentBalances[f.id] * (f.returnRate / 100);
      currentBalances[f.id] += interest;
      yearInterest += interest;
    });

    const totalAllFunds = funds.reduce((t, f) => t + (currentBalances[f.id] || 0), 0);
    summary.totalIncome += yearIncome;
    summary.totalExpense += yearExpense;
    summary.totalInterest += yearInterest;

    tableData.push({ year, income: yearIncome, expense: yearExpense, balance: surplus, interest: yearInterest, fundBalances: { ...currentBalances }, totalAllFunds, fundFlows, incomeDetail, expenseDetail });
  }

  mypForecastData = tableData;
  mypForecastFundsList = funds;

  mypRenderForecastOutputs(summary, funds, tableData, years);
  await mypSaveForecastSnapshot(startYear, endYear, summary, tableData, funds);
  await mypRenderBaselineComparisonTable();
}

// Renders summary cards, the year snapshot dropdown, the chart, and the
// year-by-year table from a forecast result — shared by a fresh run
// (mypRunForecast) and loading a previously saved snapshot (mypLoadSavedForecast).
function mypRenderForecastOutputs(summary, funds, tableData, years) {
  document.getElementById('mypSummaryCards').innerHTML = `
    <div class="stat-card"><h3>Total Income</h3><div class="value">${formatCurrency(summary.totalIncome)}</div></div>
    <div class="stat-card"><h3>Total Expense</h3><div class="value">${formatCurrency(summary.totalExpense)}</div></div>
    <div class="stat-card"><h3>Total Interest / Return</h3><div class="value">${formatCurrency(summary.totalInterest)}</div></div>
    <div class="stat-card"><h3>Net Surplus</h3><div class="value">${formatCurrency(summary.totalIncome - summary.totalExpense)}</div></div>`;

  const yearSelect = document.getElementById('mypSnapshotYear');
  yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  mypUpdateYearSnapshot();

  if (charts.mypForecast) charts.mypForecast.destroy();
  charts.mypForecast = new Chart(document.getElementById('mypForecastChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: 'Income', data: tableData.map(d => d.income), backgroundColor: 'rgba(72,187,120,0.7)' },
        { label: 'Expense', data: tableData.map(d => d.expense), backgroundColor: 'rgba(245,101,101,0.7)' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  let th = '<tr><th>Year</th><th>Income</th><th>Expense</th><th>Net</th><th>Interest</th>';
  funds.forEach(f => th += `<th>${escapeHtml(f.name)}</th>`);
  th += '<th style="color:#3182ce;">Total All Accounts</th><th>Flows</th></tr>';
  document.getElementById('mypForecastTableHead').innerHTML = th;
  document.getElementById('mypForecastTableBody').innerHTML = tableData.map(d => `
    <tr>
      <td><b>${d.year}</b></td>
      <td style="color:#48bb78;">${formatCurrency(d.income)}${d.incomeDetail.length ? `<div style="font-size:11px;color:#a0aec0;font-weight:400;margin-top:2px;">${d.incomeDetail.join('<br>')}</div>` : ''}</td>
      <td style="color:#f56565;">${formatCurrency(d.expense)}${d.expenseDetail.length ? `<div style="font-size:11px;color:#a0aec0;font-weight:400;margin-top:2px;">${d.expenseDetail.join('<br>')}</div>` : ''}</td>
      <td style="color:${d.balance >= 0 ? '#48bb78' : '#f56565'};">${formatCurrency(d.balance)}</td>
      <td style="color:#dd6b20;">+${formatCurrency(d.interest)}</td>
      ${funds.map(f => `<td>${formatCurrency(d.fundBalances[f.id])}</td>`).join('')}
      <td style="font-weight:700;color:#3182ce;">${formatCurrency(d.totalAllFunds)}</td>
      <td style="font-size:11px;">${d.fundFlows.join('<br>')}</td>
    </tr>`).join('');
}

// ---------- Saved Forecast Snapshots (one per plan, click-to-view card) ----------
async function mypSaveForecastSnapshot(startYear, endYear, summary, tableData, funds) {
  const existing = (await db.mypSavedForecasts.where('planId').equals(currentMypPlanId).toArray())[0];
  const data = {
    planId: currentMypPlanId, startYear, endYear, summary,
    tableData, fundsList: funds.map(f => ({ id: f.id, name: f.name })),
    generatedAt: new Date().toISOString()
  };
  if (existing) await encUpdate('mypSavedForecasts', existing.id, data);
  else await encAdd('mypSavedForecasts', data);
  await mypRenderForecastCards();
}

async function mypRenderForecastCards() {
  const saved = await encGetAll('mypSavedForecasts');
  const plans = await encGetAll('mypPlans');
  const plansById = {}; plans.forEach(p => plansById[p.id] = p.name);
  const grid = document.getElementById('mypSavedForecastGrid');
  const empty = document.getElementById('mypSavedForecastEmpty');
  if (!saved.length) { grid.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  grid.innerHTML = saved.map(s => {
    const net = (s.summary.totalIncome || 0) - (s.summary.totalExpense || 0);
    const genDate = s.generatedAt ? new Date(s.generatedAt).toLocaleDateString() : '';
    return `<div class="fund-card" style="cursor:pointer;${s.planId === currentMypPlanId ? 'border-color:#667eea;' : ''}" data-action="mypLoadSavedForecast" data-arg="${s.id}">
      <div class="actions">
        <button class="icon-btn" title="Delete this saved forecast" data-action="mypDeleteSavedForecast" data-stop="1" data-arg="${s.id}">🗑️</button>
      </div>
      <div class="fund-header">
        <div>
          <div class="fund-name">${escapeHtml(plansById[s.planId] || 'Unknown plan')}${s.planId === currentMypPlanId ? ' <span style="font-size:11px;color:#667eea;font-weight:600;">(current)</span>' : ''}</div>
          <div style="font-size: 12px; color: #718096; margin-top: 4px;">${s.startYear} – ${s.endYear} · generated ${genDate}</div>
        </div>
      </div>
      <div class="fund-stats">
        <div class="stat"><div class="stat-label">Net Surplus</div><div class="stat-value ${net >= 0 ? 'positive' : ''}" style="${net < 0 ? 'color:#f56565;' : ''}">${formatCurrency(net)}</div></div>
        <div class="stat"><div class="stat-label">Total Interest</div><div class="stat-value">${formatCurrency(s.summary.totalInterest || 0)}</div></div>
      </div>
    </div>`;
  }).join('');
}

async function mypLoadSavedForecast(id) {
  const rec = await encGet('mypSavedForecasts', id);
  if (!rec) { showToast('This saved forecast no longer exists'); return; }
  if (rec.planId !== currentMypPlanId) {
    currentMypPlanId = rec.planId;
    try { localStorage.setItem('utt-current-myp-plan', currentMypPlanId); } catch (e) { /* ignore */ }
    const select = document.getElementById('mypPlanSelect');
    if (Array.from(select.options).some(o => o.value === String(currentMypPlanId))) select.value = currentMypPlanId;
    await mypRenderAll();
  }
  mypForecastData = rec.tableData;
  mypForecastFundsList = rec.fundsList;
  document.getElementById('mypStartYear').value = rec.startYear;
  document.getElementById('mypEndYear').value = rec.endYear;
  const years = rec.tableData.map(d => d.year);
  mypRenderForecastOutputs(rec.summary, rec.fundsList, rec.tableData, years);
  await mypRenderBaselineComparisonTable();
  await mypRenderForecastCards();
  switchPlannerTab('forecast');
}

async function mypDeleteSavedForecast(id) {
  if (!confirm('Delete this saved forecast? You can always generate a new one.')) return;
  await db.mypSavedForecasts.delete(id);
  showToast('Saved forecast deleted');
  await mypRenderForecastCards();
}


function mypUpdateYearSnapshot() {
  const yearSelect = document.getElementById('mypSnapshotYear');
  const selectedYear = parseInt(yearSelect.value);
  const dataRow = mypForecastData.find(d => d.year === selectedYear);
  const container = document.getElementById('mypSnapshotCards');
  if (!dataRow) { container.innerHTML = '<p style="color:#a0aec0;font-size:13px;">No data for this year — generate a forecast first.</p>'; return; }
  let html = `<div class="stat-card" style="background: linear-gradient(135deg, #3182ce 0%, #2b6cb0 100%);"><h3>${selectedYear} Total All Accounts</h3><div class="value">${formatCurrency(dataRow.totalAllFunds)}</div></div>`;
  mypForecastFundsList.forEach(f => {
    const bal = dataRow.fundBalances[f.id] || 0;
    html += `<div class="stat-card"><h3>${escapeHtml(f.name)}</h3><div class="value">${formatCurrency(bal)}</div></div>`;
  });
  container.innerHTML = html;
}

// ---------- Baseline vs. Actual ----------
// Shared by the full table render and the single-row update below, so both
// always agree on how Variance $ / Variance % are computed and styled.
function mypVarianceCellsHtml(actualVal, lastBaselineVal) {
  if (actualVal !== '' && actualVal != null) {
    const diff = actualVal - lastBaselineVal;
    const pct = lastBaselineVal !== 0 ? ((diff / lastBaselineVal) * 100).toFixed(1) : '0.0';
    const color = diff > 0 ? '#48bb78' : (diff < 0 ? '#f56565' : '#718096');
    const sign = diff > 0 ? '+' : '';
    return `<td style="text-align:right;color:${color};font-weight:600;">${sign}${formatCurrency(diff)}</td><td style="text-align:right;color:${color};font-weight:600;">${sign}${pct}%</td>`;
  }
  return '<td style="text-align:right;color:#a0aec0;">—</td><td style="text-align:right;color:#a0aec0;">—</td>';
}

async function mypRenderBaselineComparisonTable() {
  if (!mypForecastData.length) return;
  const baselines = (await encGetAll('mypBaselines')).filter(b => b.planId === currentMypPlanId);
  const baselineValues = await encGetAll('mypBaselineValues');
  const actuals = (await encGetAll('mypActuals')).filter(a => a.planId === currentMypPlanId);

  const actualsByYear = {}; actuals.forEach(a => actualsByYear[a.year] = a);
  const baselineValMap = {};
  baselineValues.forEach(bv => {
    if (!baselineValMap[bv.baselineId]) baselineValMap[bv.baselineId] = {};
    baselineValMap[bv.baselineId][bv.year] = bv.amount;
  });

  const headerRow = document.getElementById('mypBaselineTableHead');
  let headHtml = '<th style="text-align:center;">Year</th><th style="text-align:center;color:#dd6b20;">Live Forecast</th>';
  baselines.forEach(b => {
    headHtml += `<th style="text-align:center;color:#3182ce;">${escapeHtml(b.name)} <button class="icon-btn" title="Delete baseline column" data-action="mypDeleteBaseline" data-arg="${b.id}">✕</button></th>`;
  });
  headHtml += '<th style="text-align:center;color:#48bb78;">Actual (EOY)</th><th style="text-align:right;">Variance $</th><th style="text-align:right;">Variance %</th>';
  headerRow.innerHTML = headHtml;

  const tbody = document.getElementById('mypBaselineTableBody');
  tbody.innerHTML = mypForecastData.map(row => {
    const yr = row.year;
    const liveVal = row.totalAllFunds;
    const actualRow = actualsByYear[yr];
    const actualVal = actualRow ? actualRow.amount : '';
    let lastBaselineVal = liveVal;
    let cols = `<td style="text-align:center;"><b>${yr}</b></td><td style="text-align:center;color:#dd6b20;font-weight:600;">${formatCurrency(liveVal)}</td>`;
    baselines.forEach(b => {
      const val = (baselineValMap[b.id] && baselineValMap[b.id][yr] != null) ? baselineValMap[b.id][yr] : 0;
      lastBaselineVal = val;
      cols += `<td style="text-align:center;color:#3182ce;font-weight:600;">${formatCurrency(val)}</td>`;
    });
    cols += `<td style="text-align:center;">$ <input type="number" class="myp-actual-input" style="width:120px;text-align:right;" value="${actualVal}" placeholder="Enter actual" autocomplete="off" data-action="mypSaveActualResult" data-arg="${yr}"></td>`;
    cols += mypVarianceCellsHtml(actualVal, lastBaselineVal);
    return `<tr data-year="${yr}" data-baseline="${lastBaselineVal}">${cols}</tr>`;
  }).join('');
}

async function mypFreezeBaseline() {
  if (!mypForecastData.length) { showToast('Generate a forecast first'); return; }
  const count = (await encGetAll('mypBaselines')).filter(b => b.planId === currentMypPlanId).length;
  const defaultName = `Baseline ${count + 1} (${new Date().toLocaleDateString()})`;
  const colName = prompt('Name this baseline column:', defaultName);
  if (!colName) return;
  const baselineId = await encAdd('mypBaselines', { name: colName, planId: currentMypPlanId });
  for (const d of mypForecastData) {
    await encAdd('mypBaselineValues', { baselineId, year: d.year, amount: d.totalAllFunds });
  }
  showToast('Baseline frozen!');
  await mypRenderBaselineComparisonTable();
}

async function mypDeleteBaseline(id) {
  if (!confirm('Delete this frozen baseline column?')) return;
  await db.mypBaselines.delete(id);
  const values = await db.mypBaselineValues.where('baselineId').equals(id).toArray();
  for (const v of values) await db.mypBaselineValues.delete(v.id);
  showToast('Baseline deleted');
  await mypRenderBaselineComparisonTable();
}

async function mypSaveActualResult(year, val) {
  const existing = (await db.mypActuals.where('year').equals(year).toArray()).find(a => a.planId === currentMypPlanId);
  if (val === '' || val === null) {
    if (existing) await db.mypActuals.delete(existing.id);
  } else {
    const amount = parseFloat(val) || 0;
    if (existing) await encUpdate('mypActuals', existing.id, { year, amount });
    else await encAdd('mypActuals', { year, amount, planId: currentMypPlanId });
  }
  // Previously this called mypRenderBaselineComparisonTable(), which rebuilds
  // the ENTIRE tbody (every row's <input>, all years) on every save. That
  // save fires on 'change' (blur) — so the moment you clicked/tabbed from
  // one year's "Actual (EOY)" box into the next one to keep entering data,
  // the blur on the first box triggered this async save, which then replaced
  // the whole table (including the box you'd just focused) with fresh DOM
  // out from under you. The new box was never focused, so anything you typed
  // next appeared to do nothing — only the very first row you touched ever
  // "took". Updating just this row's Variance cells in place, without
  // touching any <input>, fixes that: focus is never disturbed, so you can
  // tab/click through every year and keep typing normally.
  const row = document.querySelector(`#mypBaselineTableBody tr[data-year="${year}"]`);
  if (!row) { await mypRenderBaselineComparisonTable(); return; } // fallback if row isn't there for some reason
  const lastBaselineVal = parseFloat(row.dataset.baseline) || 0;
  const actualVal = (val === '' || val === null) ? '' : (parseFloat(val) || 0);
  const cells = row.querySelectorAll('td');
  const varianceHtml = mypVarianceCellsHtml(actualVal, lastBaselineVal);
  const tmp = document.createElement('tr');
  tmp.innerHTML = varianceHtml;
  const newCells = Array.from(tmp.children);
  if (cells.length >= 2 && newCells.length === 2) {
    row.replaceChild(newCells[0], cells[cells.length - 2]);
    row.replaceChild(newCells[1], cells[cells.length - 1]);
  }
}

// ---------- PWA: Service Worker registration ----------
// Registers the offline cache once the page has loaded. Safe to no-op
// in environments without SW support (e.g. some in-app browsers) or
// when served from file:// (SW requires http/https, so it's skipped).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// ---------------------------------------------------------------------
// Event delegation dispatcher
// ---------------------------------------------------------------------
// Replaces the ~330 inline onclick/onchange/oninput/onkeydown attributes
// that used to live throughout index.html and this file. Every rendered
// element now carries a plain data-action="name" attribute (plus, where
// needed, data-arg / data-arg2 / data-stop / data-prevent) instead of
// executable inline JS. Because data-* attribute values are only ever
// read as text via .dataset — never passed to eval() or new Function() —
// this closes the CSP gap: script-src-attr no longer needs 'unsafe-inline',
// so even if a future escaping bug let attacker-controlled markup (e.g. an
// <img onerror=...> payload) reach innerHTML, the browser has nothing to
// execute — data-action values are inert strings looked up in the ACTIONS
// table below, not code.
// Whitelist for the "Print Summary" owner-picker modal (openPrintOwnerModal /
// closeAndPrint below). Report buttons carry a data-report-type attribute (one
// of the keys below, always set by this app's own static markup — see
// index.html's "Print Report" buttons and printFns in openPrintOwnerModal),
// which is looked up here rather than doing a window[name] dynamic lookup —
// so there's no path from an arbitrary/attacker-influenced string to calling
// an arbitrary global function, even in principle.
const PRINT_REPORT_FUNCTIONS = {
  unittrust: (arg) => printPortfolioSummary(arg),
  amanah: (arg) => printAmanahReport(arg),
  kwsp: (arg) => printKwspReport(arg),
  fd: (arg) => printFdReport(arg),
  fx: (arg) => printFxReport(arg),
};

const ACTIONS = {
  addForecastFundRow: () => addForecastFundRow(),
  addForecastPropertyRow: () => addForecastPropertyRow(),
  addMember: () => addMember(),
  addRePurchaseRow: () => addRePurchaseRow(),
  attemptUnlock: () => attemptUnlock(),
  autoCalcTx: (el) => autoCalcTx(el.dataset.arg),
  calcAmanahTxAmount: (el) => calcAmanahTxAmount(el.dataset.arg),
  calcFdMaturityFromTenure: () => calcFdMaturityFromTenure(),
  cleanupDuplicateReLoanEntries: () => cleanupDuplicateReLoanEntries(),
  closeAmanahFundDetailModal: () => closeAmanahFundDetailModal(),
  closeAmanahFundModal: () => closeAmanahFundModal(),
  closeAmanahTxModal: () => closeAmanahTxModal(),
  closeAttachmentViewer: () => closeAttachmentViewer(),
  closeClosedFundModal: () => closeClosedFundModal(),
  closeCurrencyModal: () => closeCurrencyModal(),
  closeEncryptionModal: () => closeEncryptionModal(),
  closeExportModal: () => closeExportModal(),
  closeFdDetailModal: () => closeFdDetailModal(),
  closeFdInterestPayoutModal: () => closeFdInterestPayoutModal(),
  closeFdModal: () => closeFdModal(),
  closeForecastModal: () => closeForecastModal(),
  closeFundModal: () => closeFundModal(),
  closeFxCurrencyDetailModal: () => closeFxCurrencyDetailModal(),
  closeFxTxModal: () => closeFxTxModal(),
  closeImportPasscodeModal: () => closeImportPasscodeModal(),
  closeKwspAccountDetailModal: () => closeKwspAccountDetailModal(),
  closeKwspAccountModal: () => closeKwspAccountModal(),
  closeKwspTxModal: () => closeKwspTxModal(),
  closeMembersModal: () => closeMembersModal(),
  closeMypExpenseModal: () => closeMypExpenseModal(),
  closeMypFundModal: () => closeMypFundModal(),
  closeMypIncomeModal: () => closeMypIncomeModal(),
  closeMypRuleModal: () => closeMypRuleModal(),
  closePrintOwnerModal: () => closePrintOwnerModal(),
  closeProcessMaturityModal: () => closeProcessMaturityModal(),
  closeReLoanTxModal: () => closeReLoanTxModal(),
  closeRePrintOptionsModal: () => closeRePrintOptionsModal(),
  closeRePropertyDetailModal: () => closeRePropertyDetailModal(),
  closeRePropertyModal: () => closeRePropertyModal(),
  closeReTxModal: () => closeReTxModal(),
  closeTxModal: () => closeTxModal(),
  confirmExport: () => confirmExport(),
  confirmImportPasscode: () => confirmImportPasscode(),
  confirmProcessMaturity: () => confirmProcessMaturity(),
  confirmRePrintReport: () => confirmRePrintReport(),
  deleteAmanahFund: (el) => deleteAmanahFund(Number(el.dataset.arg)),
  deleteAmanahFundFromDetail: () => deleteAmanahFundFromDetail(),
  deleteAmanahTx: (el) => deleteAmanahTx(Number(el.dataset.arg)),
  deleteClosedFundFromModal: () => deleteClosedFundFromModal(),
  deleteCurrentFund: () => deleteCurrentFund(),
  deleteFd: (el) => deleteFd(Number(el.dataset.arg)),
  deleteFdFromDetail: () => deleteFdFromDetail(),
  deleteFdInterestPayout: (el) => deleteFdInterestPayout(Number(el.dataset.arg)),
  deleteForecast: (el) => deleteForecast(Number(el.dataset.arg)),
  deleteFund: (el) => deleteFund(Number(el.dataset.arg)),
  deleteFxTx: (el) => deleteFxTx(Number(el.dataset.arg)),
  deleteKwspAccount: (el) => deleteKwspAccount(Number(el.dataset.arg)),
  deleteKwspAccountFromDetail: () => deleteKwspAccountFromDetail(),
  deleteKwspTx: (el) => deleteKwspTx(Number(el.dataset.arg)),
  deleteMypExpense: (el) => deleteMypExpense(Number(el.dataset.arg)),
  deleteMypFund: (el) => deleteMypFund(Number(el.dataset.arg)),
  deleteMypIncome: (el) => deleteMypIncome(Number(el.dataset.arg)),
  deleteMypRule: (el) => deleteMypRule(Number(el.dataset.arg)),
  deletePropertyFromDetail: () => deletePropertyFromDetail(),
  deleteReLoanTx: (el) => deleteReLoanTx(Number(el.dataset.arg)),
  deleteReProperty: (el) => deleteReProperty(Number(el.dataset.arg)),
  deleteReTx: (el) => deleteReTx(Number(el.dataset.arg)),
  deleteTransaction: (el) => deleteTransaction(Number(el.dataset.arg)),
  dismissEncryptionNudge: () => dismissEncryptionNudge(),
  editAmanahFundFromDetail: () => editAmanahFundFromDetail(),
  enableEncryptionFromNudge: () => enableEncryptionFromNudge(),
  editAmanahTx: (el) => editAmanahTx(Number(el.dataset.arg)),
  editClosedFundFromModal: () => editClosedFundFromModal(),
  editFdFromDetail: () => editFdFromDetail(),
  editFxTx: (el) => editFxTx(Number(el.dataset.arg)),
  editKwspAccountFromDetail: () => editKwspAccountFromDetail(),
  editKwspTx: (el) => editKwspTx(Number(el.dataset.arg)),
  editPropertyFromDetail: () => editPropertyFromDetail(),
  editTransaction: (el) => editTransaction(Number(el.dataset.arg)),
  fetchLiveRates: () => fetchLiveRates(),
  filterAmanahLedgerByScheme: (el) => filterAmanahLedgerByScheme(Number(el.dataset.arg)),
  filterKwspLedgerByAccount: (el) => filterKwspLedgerByAccount(Number(el.dataset.arg)),
  fxCalcTxRate: () => fxCalcTxRate(),
  fxCalcTxTotal: () => fxCalcTxTotal(),
  fxFilterLedger: () => fxFilterLedger(null),
  fxUpdateTypeLabels: () => fxUpdateTypeLabels(),
  fxUseMarketRate: () => fxUseMarketRate(),
  handleFdAttachmentSelect: (el, e) => handleFdAttachmentSelect(e),
  lockNow: () => lockNow(),
  mypAddExpenseRangeRow: () => mypAddExpenseRangeRow(),
  mypAddIncomeRangeRow: () => mypAddIncomeRangeRow(),
  mypCreatePlan: () => mypCreatePlan(),
  mypDeleteBaseline: (el) => mypDeleteBaseline(Number(el.dataset.arg)),
  mypDeletePlan: () => mypDeletePlan(),
  mypDeleteSavedForecast: (el) => mypDeleteSavedForecast(Number(el.dataset.arg)),
  mypFreezeBaseline: () => mypFreezeBaseline(),
  mypLoadSavedForecast: (el) => mypLoadSavedForecast(Number(el.dataset.arg)),
  mypOnFundScopeSourceChange: () => mypOnFundScopeSourceChange(),
  mypRenamePlan: () => mypRenamePlan(),
  mypRunForecast: () => mypRunForecast(),
  mypSaveActualResult: (el) => mypSaveActualResult(Number(el.dataset.arg), el.value),
  mypSwitchPlan: (el) => mypSwitchPlan(el.value),
  mypUpdateYearSnapshot: () => mypUpdateYearSnapshot(),
  onAmanahTxFundChange: () => onAmanahTxFundChange(),
  onAmanahTxTypeChange: () => onAmanahTxTypeChange(),
  onExportEncryptToggleChange: () => onExportEncryptToggleChange(),
  onForecastFundSourceChange: (el) => onForecastFundSourceChange(Number(el.dataset.arg)),
  onForecastPropertyChange: (el) => onForecastPropertyChange(Number(el.dataset.arg)),
  onForecastScopeChange: () => onForecastScopeChange(),
  onPmActionChange: () => onPmActionChange(),
  onPmInterestChange: () => onPmInterestChange(),
  onTxTypeChange: () => onTxTypeChange(),
  openAmanahFundModal: (el) => openAmanahFundModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openCurrencyModal: () => openCurrencyModal(),
  openEncryptionModal: () => openEncryptionModal(),
  openExportModal: () => openExportModal(),
  openFdModal: (el) => openFdModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openForecastModal: (el) => openForecastModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openFundModal: (el) => openFundModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openFxTxModal: (el) => openFxTxModal(el.dataset.arg, el.dataset.arg2),
  openKwspAccountModal: (el) => openKwspAccountModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openMembersModal: () => openMembersModal(),
  openMypExpenseModal: (el) => openMypExpenseModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openMypFundModal: (el) => openMypFundModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openMypIncomeModal: (el) => openMypIncomeModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openMypRuleModal: (el) => openMypRuleModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openPrintOwnerModal: (el) => openPrintOwnerModal(el.dataset.arg),
  openProcessMaturityModal: (el) => openProcessMaturityModal(Number(el.dataset.arg)),
  openPropertyModal: (el) => openPropertyModal(el.dataset.arg !== undefined ? Number(el.dataset.arg) : undefined),
  openReLoanTxModal: (el) => openReLoanTxModal(Number(el.dataset.arg), Number(el.dataset.arg2)),
  openRePrintOptionsModal: () => openRePrintOptionsModal(),
  openReTxModal: (el) => openReTxModal(Number(el.dataset.arg), Number(el.dataset.arg2)),
  openTxModal: () => openTxModal(),
  openTxModalForCurrentFund: () => openTxModalForCurrentFund(),
  printClosedFundReport: () => printClosedFundReport(),
  printFundReport: () => printFundReport(),
  printWealthReport: (el) => printWealthReport(el.dataset.arg),
  recalcForecastTotals: () => recalcForecastTotals(),
  recalculateRePurchaseTotal: () => recalculateRePurchaseTotal(),
  removeRePurchaseRow: (el) => removeRePurchaseRow(el.dataset.arg),
  renameMember: (el) => renameMember(Number(el.dataset.arg), el.value),
  saveAmanahFund: () => saveAmanahFund(),
  saveAmanahTx: () => saveAmanahTx(),
  saveCurrencySettings: () => saveCurrencySettings(),
  saveFd: () => saveFd(),
  saveFdInterestPayout: () => saveFdInterestPayout(),
  saveForecast: () => saveForecast(),
  saveFund: () => saveFund(),
  saveFxTransaction: () => saveFxTransaction(),
  saveKwspAccount: () => saveKwspAccount(),
  saveKwspTx: () => saveKwspTx(),
  saveMypExpense: () => saveMypExpense(),
  saveMypFund: () => saveMypFund(),
  saveMypIncome: () => saveMypIncome(),
  saveMypRule: () => saveMypRule(),
  saveReLoanTx: () => saveReLoanTx(),
  saveReProperty: () => saveReProperty(),
  saveReTx: () => saveReTx(),
  saveTransaction: () => saveTransaction(),
  setAmanahLedgerSchemeFilter: (el) => setAmanahLedgerSchemeFilter(el.value),
  setAmanahOwnerFilter: (el) => setAmanahOwnerFilter(el.value),
  setAmanahView: (el) => setAmanahView(el.dataset.arg),
  setClosedOwnerFilter: (el) => setClosedOwnerFilter(el.value),
  setClosedView: (el) => setClosedView(el.dataset.arg),
  setDashOwnerFilter: (el) => setDashOwnerFilter(el.value),
  setFdOwnerFilter: (el) => setFdOwnerFilter(el.value),
  setFdView: (el) => setFdView(el.dataset.arg),
  setFundsOwnerFilter: (el) => setFundsOwnerFilter(el.value),
  setFundsView: (el) => setFundsView(el.dataset.arg),
  setFxOwnerFilter: (el) => setFxOwnerFilter(el.value),
  setFxView: (el) => setFxView(el.dataset.arg),
  setKwspLedgerAccountFilter: (el) => setKwspLedgerAccountFilter(el.value),
  setKwspOwnerFilter: (el) => setKwspOwnerFilter(el.value),
  setKwspView: (el) => setKwspView(el.dataset.arg),
  setNavView: (el) => setNavView(el.dataset.arg),
  setReCashflowPropertyFilter: (el) => setReCashflowPropertyFilter(el.value),
  setReLoanPropertyFilter: (el) => setReLoanPropertyFilter(el.value),
  setReOwnerFilter: (el) => setReOwnerFilter(el.value),
  setReView: (el) => setReView(el.dataset.arg),
  setWealthOwnerFilter: (el) => setWealthOwnerFilter(el.value),
  showAmanahFundDetail: (el) => showAmanahFundDetail(Number(el.dataset.arg)),
  showClosedFundDetail: (el) => showClosedFundDetail(Number(el.dataset.arg)),
  showFdDetail: (el) => showFdDetail(Number(el.dataset.arg)),
  showFundDetail: (el) => showFundDetail(Number(el.dataset.arg)),
  showFundsList: () => showFundsList(),
  showKwspAccountDetail: (el) => showKwspAccountDetail(Number(el.dataset.arg)),
  showRePropertyDetail: (el) => showRePropertyDetail(Number(el.dataset.arg)),
  submitDisableEncryption: () => submitDisableEncryption(),
  submitEnableEncryption: () => submitEnableEncryption(),
  switchModule: (el) => switchModule(el.dataset.arg),
  switchPlannerTab: (el) => switchPlannerTab(el.dataset.arg),
  switchTab: (el) => switchTab(el.dataset.arg),
  toggleReLoanFields: () => toggleReLoanFields(),
  updateAllNav: () => updateAllNav(),
  updateReTxCategories: () => updateReTxCategories(),  // --- Special/composite actions (multi-statement or global-state-dependent
  //     calls that came from static index.html buttons or dynamic composites) ---
  editCurrentFund: () => openFundModal(currentFundId),
  addFxTxCurrent: () => openFxTxModal('Buy', currentFxCode),
  printFxCurrent: () => printFxSingleReport(currentFxCode),
  addReTxCurrent: () => openReTxModal(currentRePropertyId),
  addReLoanTxCurrent: () => openReLoanTxModal(currentRePropertyId),
  openFdPayoutCurrent: () => openFdInterestPayoutModal(currentFdId),
  processMaturityCurrent: () => openProcessMaturityModal(currentFdId),
  printFdCurrent: () => printFdSingleReport(currentFdId),
  addKwspTxCurrentAndClose: () => { openKwspTxModal(currentKwspAccountId); closeKwspAccountDetailModal(); },
  printKwspCurrent: () => printKwspAccountReport(currentKwspAccountId),
  addAmanahTxCurrentAndClose: () => { openAmanahTxModal(currentAmanahFundId); closeAmanahFundDetailModal(); },
  printAmanahCurrent: () => printAmanahFundReport(currentAmanahFundId),
  addKwspTxFiltered: () => openKwspTxModal(kwspLedgerAccountFilter !== 'All' ? parseInt(kwspLedgerAccountFilter) : undefined),
  addAmanahTxFiltered: () => openAmanahTxModal(amanahLedgerSchemeFilter !== 'All' ? parseInt(amanahLedgerSchemeFilter) : undefined),
  addReTxFiltered: () => openReTxModal(reCashflowPropertyFilter !== 'All' ? parseInt(reCashflowPropertyFilter) : undefined),
  addReLoanTxFiltered: () => openReLoanTxModal(reLoanPropertyFilter !== 'All' ? parseInt(reLoanPropertyFilter) : undefined),
  importDataFile: (el) => importData(el),
  triggerImportFile: () => document.getElementById('importFile').click(),
  removeRowRecalc: (el) => { el.closest('tr').remove(); recalcForecastTotals(); },
  removeMyprow: (el) => { const row = document.getElementById('myprow-' + el.dataset.arg); if (row) row.remove(); },
  closeAndPrint: (el) => {
    closePrintOwnerModal();
    const fn = PRINT_REPORT_FUNCTIONS[el.dataset.reportType];
    if (typeof fn === 'function') fn(el.dataset.arg);
  },
  deleteMember: (el) => deleteMember(Number(el.dataset.arg), el.dataset.arg2),
  removeFdExistingAttachment: (el) => removeFdExistingAttachment(Number(el.dataset.arg)),
  removeFdPendingAttachment: (el) => removeFdPendingAttachment(Number(el.dataset.arg)),
  openFdAttachment: (el) => openFdAttachment(Number(el.dataset.arg), Number(el.dataset.arg2)),
  toggleCheckedDelayed: (el) => {
    setTimeout(() => el.classList.toggle('checked', el.querySelector('input').checked), 0);
  },
};

function dispatchAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = ACTIONS[el.dataset.action];
  if (!handler) return;
  if (el.dataset.stop === '1') e.stopPropagation();
  if (el.dataset.prevent === '1') e.preventDefault();
  handler(el, e);
}

// Actions that were originally wired to oninput= (fire on every keystroke,
// for live recalculation as you type). Everything else that carries
// data-action was originally onclick=/onchange= only, which fire on click
// or on blur/Enter/selection-change — NOT on every keystroke. Without this
// whitelist, a plain 'input' listener would re-invoke e.g. mypSaveActualResult
// on every keystroke; that function saves to IndexedDB and re-renders the
// whole table, which replaces the <input> DOM node mid-type and makes it
// impossible to type more than one character into it.
const INPUT_LIVE_ACTIONS = new Set([
  'autoCalcTx', 'calcAmanahTxAmount', 'calcFdMaturityFromTenure',
  'fxCalcTxRate', 'fxCalcTxTotal', 'onPmInterestChange',
  'recalcForecastTotals', 'recalculateRePurchaseTotal',
]);

function dispatchInputAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !INPUT_LIVE_ACTIONS.has(el.dataset.action)) return;
  dispatchAction(e);
}

document.addEventListener('click', dispatchAction);
document.addEventListener('change', dispatchAction);
document.addEventListener('input', dispatchInputAction);

// Enter-key shortcuts (previously onkeydown="if(event.key==='Enter') ...")
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter-action]');
  if (!el) return;
  const action = el.dataset.enterAction;
  if (action === 'attemptUnlock') attemptUnlock();
  else if (action === 'confirmImportPasscode') confirmImportPasscode();
});
