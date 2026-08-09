/*
 * Wealth Planner — in-app back-button handling
 * ------------------------------------------------------------
 * Problem: on mobile/tablet, the hardware/gesture "back" button closes
 * the whole app (or PWA), because this is a single-page app that never
 * pushes any browser history entries. There is nothing for "back" to
 * step back through, so the browser/OS treats it as "leave the page".
 *
 * Fix: every time the app opens something that visually covers/replaces
 * what was there before — a modal, the attachment/PDF viewer, or a
 * tab/module switch away from the dashboard — we push one history
 * entry. The back button then fires a `popstate` event instead of
 * leaving the app, and we use that event to undo exactly one of those
 * steps (close the top-most modal, or go back to the previous
 * tab/module). Only once there is nothing left to undo does back fall
 * through to the browser/OS default (leaving the app), which is the
 * expected behavior at the "root" screen.
 *
 * This file deliberately does NOT touch any of the existing open-modal or
 * close-modal functions in app.js. It observes the same `.active` class toggle on
 * `.modal-overlay` elements and `.section` elements that those
 * functions already use, so it keeps working automatically if new
 * modals/sections are added later, as long as they follow the same
 * `id="fooModal"` / `function closeFooModal()` convention.
 *
 * Must load AFTER app.js (so the close* functions below already exist)
 * and does not need to wait for DOMContentLoaded (the elements it looks
 * up already exist in the HTML above this <script> tag, and it needs to
 * start observing before initApp() runs switchModule(currentModule)).
 */
(function () {
  'use strict';

  // id -> close function, auto-covers every "<id>Modal" element that has a
  // matching closeXxxModal()/closeAttachmentViewer() function in app.js.
  // (unlockOverlay is intentionally NOT here — the back button must not be
  // able to dismiss the passcode lock screen.)
  const CLOSE_FN = {
    encryptionModal: typeof closeEncryptionModal === 'function' ? closeEncryptionModal : null,
    fundModal: typeof closeFundModal === 'function' ? closeFundModal : null,
    currencyModal: typeof closeCurrencyModal === 'function' ? closeCurrencyModal : null,
    membersModal: typeof closeMembersModal === 'function' ? closeMembersModal : null,
    printOwnerModal: typeof closePrintOwnerModal === 'function' ? closePrintOwnerModal : null,
    txModal: typeof closeTxModal === 'function' ? closeTxModal : null,
    closedFundModal: typeof closeClosedFundModal === 'function' ? closeClosedFundModal : null,
    exportModal: typeof closeExportModal === 'function' ? closeExportModal : null,
    importPasscodeModal: typeof closeImportPasscodeModal === 'function' ? closeImportPasscodeModal : null,
    amanahFundModal: typeof closeAmanahFundModal === 'function' ? closeAmanahFundModal : null,
    amanahFundDetailModal: typeof closeAmanahFundDetailModal === 'function' ? closeAmanahFundDetailModal : null,
    amanahTxModal: typeof closeAmanahTxModal === 'function' ? closeAmanahTxModal : null,
    kwspAccountModal: typeof closeKwspAccountModal === 'function' ? closeKwspAccountModal : null,
    kwspAccountDetailModal: typeof closeKwspAccountDetailModal === 'function' ? closeKwspAccountDetailModal : null,
    kwspTxModal: typeof closeKwspTxModal === 'function' ? closeKwspTxModal : null,
    attachmentViewerModal: typeof closeAttachmentViewer === 'function' ? closeAttachmentViewer : null,
    fdModal: typeof closeFdModal === 'function' ? closeFdModal : null,
    fdDetailModal: typeof closeFdDetailModal === 'function' ? closeFdDetailModal : null,
    fdInterestPayoutModal: typeof closeFdInterestPayoutModal === 'function' ? closeFdInterestPayoutModal : null,
    processMaturityModal: typeof closeProcessMaturityModal === 'function' ? closeProcessMaturityModal : null,
    rePropertyModal: typeof closeRePropertyModal === 'function' ? closeRePropertyModal : null,
    rePropertyDetailModal: typeof closeRePropertyDetailModal === 'function' ? closeRePropertyDetailModal : null,
    rePrintOptionsModal: typeof closeRePrintOptionsModal === 'function' ? closeRePrintOptionsModal : null,
    reTxModal: typeof closeReTxModal === 'function' ? closeReTxModal : null,
    reLoanTxModal: typeof closeReLoanTxModal === 'function' ? closeReLoanTxModal : null,
    fxTxModal: typeof closeFxTxModal === 'function' ? closeFxTxModal : null,
    fxCurrencyDetailModal: typeof closeFxCurrencyDetailModal === 'function' ? closeFxCurrencyDetailModal : null,
    forecastModal: typeof closeForecastModal === 'function' ? closeForecastModal : null,
    mypFundModal: typeof closeMypFundModal === 'function' ? closeMypFundModal : null,
    mypRuleModal: typeof closeMypRuleModal === 'function' ? closeMypRuleModal : null,
    mypIncomeModal: typeof closeMypIncomeModal === 'function' ? closeMypIncomeModal : null,
    mypExpenseModal: typeof closeMypExpenseModal === 'function' ? closeMypExpenseModal : null
  };

  // Top-level "screens" (dashboard/funds/transactions/closed live inside the
  // Unit Trust module; the rest are the other modules). Exactly one of these
  // is ever active at a time. 'dashboard' is the app's home/root screen.
  const UNITTRUST_TABS = ['dashboard', 'funds', 'transactions', 'closed'];
  const SECTION_IDS = UNITTRUST_TABS.concat(['wealth', 'amanah', 'kwsp', 'fd', 'realestate', 'fx', 'forecast', 'planner']);

  // Stack of undoable steps, one entry per pushed history state.
  const navStack = [];
  // True while we are running an undo() triggered by the back button itself,
  // so the resulting DOM change isn't mistaken for a fresh user action.
  let closingViaPopstate = false;
  // True while we are calling history.back() ourselves to silently discard a
  // stale entry (e.g. a modal was closed via Save/Cancel, not the back
  // button) — the popstate that results from it should be ignored.
  let programmaticBack = false;
  // True while navigateToSection() is applying a restore, so the section
  // change it causes isn't mistaken for a fresh user navigation.
  let restoringSection = false;
  // The section that's active right now, established lazily by the first
  // section activation we observe (whatever the app opens to, including a
  // remembered non-default module) rather than assumed to be 'dashboard'.
  let prevSectionId = null;

  function pushNav(entry) {
    navStack.push(entry);
    history.pushState({ wpBackNav: navStack.length }, '');
  }

  function navigateToSection(id) {
    restoringSection = true;
    try {
      if (UNITTRUST_TABS.indexOf(id) !== -1) {
        if (typeof currentModule !== 'undefined' && currentModule !== 'unittrust' && typeof switchModule === 'function') {
          switchModule('unittrust');
        }
        if (typeof switchTab === 'function') switchTab(id);
      } else if (typeof switchModule === 'function') {
        switchModule(id);
      }
    } finally {
      // Reset after the MutationObserver microtask (queued the instant the
      // class attribute changed above) has had a chance to run and see the
      // flag still set — a synchronous reset here would clear it first.
      setTimeout(function () { restoringSection = false; }, 0);
    }
  }

  function onSectionChange(id) {
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('active')) return;
    if (prevSectionId === null) { prevSectionId = id; return; } // establishes root, nothing to undo yet
    if (id === prevSectionId) return;
    if (restoringSection) { prevSectionId = id; return; }
    const fromId = prevSectionId;
    pushNav({ undo: function () { navigateToSection(fromId); } });
    prevSectionId = id;
  }

  function onModalChange(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const closeFn = CLOSE_FN[id];
    if (!closeFn) return;
    const isActive = el.classList.contains('active');
    const idx = navStack.findIndex(function (e) { return e.modalId === id; });
    if (isActive) {
      if (idx === -1) {
        pushNav({ modalId: id, undo: function () { closeFn(); } });
      }
    } else if (idx !== -1 && !closingViaPopstate) {
      // Closed by app code (Save/Cancel/etc.), not by the back button —
      // discard the now-stale history entry so a later back press doesn't
      // need an extra press to make progress.
      navStack.splice(idx, 1);
      programmaticBack = true;
      history.back();
    }
  }

  window.addEventListener('popstate', function () {
    if (programmaticBack) { programmaticBack = false; return; }
    if (navStack.length === 0) return; // nothing tracked — let the app exit as normal
    const entry = navStack.pop();
    closingViaPopstate = true;
    try {
      entry.undo();
    } catch (err) {
      console.error('back-nav undo failed:', err);
    }
    setTimeout(function () { closingViaPopstate = false; }, 0);
  });

  SECTION_IDS.forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    new MutationObserver(function () { onSectionChange(id); })
      .observe(el, { attributes: true, attributeFilter: ['class'] });
  });

  Object.keys(CLOSE_FN).forEach(function (id) {
    const el = document.getElementById(id);
    if (!el || !CLOSE_FN[id]) return;
    new MutationObserver(function () { onModalChange(id); })
      .observe(el, { attributes: true, attributeFilter: ['class'] });
  });
})();
