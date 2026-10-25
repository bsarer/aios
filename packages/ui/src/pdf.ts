/**
 * Draws a PDF attachment onto canvases with pdf.js, in a web worker. Loaded only when a
 * PDF is opened. No text, link or form layer is added, so nothing in the PDF can be
 * clicked, and pdf.js never runs scripts embedded in a PDF.
 */
// The legacy build: the modern one relies on JavaScript newer than some Chromium releases
// still in use (Map.prototype.getOrInsertComputed, for one).
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 100;

export async function renderPdf(data: ArrayBuffer, into: HTMLElement, signal: AbortSignal): Promise<{ pages: number; shown: number }> {
  const task = getDocument({ data: new Uint8Array(data), enableXfa: false });
  signal.addEventListener('abort', () => void task.destroy(), { once: true });
  const doc = await task.promise;
  const shown = Math.min(doc.numPages, MAX_PAGES);
  const width = into.clientWidth || 800;
  for (let p = 1; p <= shown && !signal.aborted; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    canvas.dataset.page = String(p);
    canvas.className = 'mx-auto mb-4 block rounded bg-white shadow';
    into.appendChild(canvas);
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
  }
  return { pages: doc.numPages, shown };
}
