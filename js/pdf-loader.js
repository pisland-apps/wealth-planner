// pdf.js loader
// ------------------------------------------------------------
// pdfjs-dist dropped its UMD/global "pdf.min.js" build starting at v4.0 — as of
// v4.9.155 it ships ES modules only (pdf.min.mjs / pdf.worker.min.mjs). The rest
// of this app's scripts (app.js, back-nav.js) are classic scripts relying on
// document-order global execution, so rather than converting the whole app to
// ES modules (which would silently stop attaching its top-level functions to
// `window`, breaking the data-action dispatcher's window[...] lookups), this
// file stays a classic script and pulls pdf.js in via a dynamic import().
//
// window.pdfjsLibReady is the promise consumers must await before first use
// (see the `isPdf` branch of openAttachmentViewer in js/app.js). This avoids
// any race between page load and a user opening a PDF attachment — by the time
// a user has clicked into the app and opened an attachment, this same-origin,
// already-cached-by-the-service-worker import has long since resolved.
//
// Matching worker build for the version above — must stay in sync if the
// version is ever bumped. Vendored locally at ./lib/pdf.worker.min.mjs
// (pdfjs-dist 4.9.155, fixes CVE-2024-4367) — same-origin, no CDN. pdf.js
// internally instantiates this worker with `{ type: 'module' }`, so no extra
// wiring is needed here beyond pointing workerSrc at it.
window.pdfjsLibReady = (async () => {
  try {
    const pdfjsLib = await import('../lib/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';
    window.pdfjsLib = pdfjsLib;
    return pdfjsLib;
  } catch (err) {
    console.error('Failed to load pdf.js — PDF preview will be unavailable.', err);
    throw err;
  }
})();
