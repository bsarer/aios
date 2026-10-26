// Worker thread for extractPdfText() in attachments.ts: pulls the text out of one PDF.
// Plain JavaScript so it runs as is under tsx and vitest. The parent caps its memory and
// time and terminates it when done. pdf.js never runs scripts embedded in a PDF.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** @type {{ data: Uint8Array; maxPages: number; maxChars: number }} */
const { data, maxPages, maxChars } = workerData;

try {
  const task = getDocument({ data, verbosity: 0, useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: false });
  const doc = await task.promise;
  const parts = [];
  let chars = 0;
  let readPages = 0;
  for (let p = 1; p <= Math.min(doc.numPages, maxPages) && chars < maxChars; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
    }
    page.cleanup();
    parts.push(doc.numPages > 1 ? `[page ${p}]\n${text.trim()}` : text.trim());
    chars += text.length;
    readPages = p;
  }
  await task.destroy();
  parentPort.postMessage({ ok: true, text: parts.join('\n\n'), pages: doc.numPages, readPages });
} catch (err) {
  const name = err && typeof err === 'object' && 'name' in err ? err.name : '';
  const error =
    name === 'PasswordException' ? 'the PDF is protected by a password' : name === 'InvalidPDFException' ? "the file isn't a valid PDF" : "the PDF couldn't be read";
  parentPort.postMessage({ ok: false, error });
}
