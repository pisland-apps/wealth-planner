  // Matching worker build for the pdf.js version above — must stay in sync if the version is ever bumped.
  // Vendored locally at ./lib/pdf.worker.min.js (pdfjs-dist 3.11.174) — same-origin, no CDN.
  pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';
