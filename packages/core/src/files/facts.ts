/**
 * Facts about one file for the index (F2): what it is (by its first bytes), pages, sheets,
 * picture size, word count, and a title and author where the file states them; plus a short
 * excerpt for the summary worker. Nothing here runs or opens a file in an app: PDFs go
 * through the pdf.js worker (no scripts), Word and Excel files through the D1 command-line
 * reads, and Office properties through a small ZIP reader with a size limit.
 *
 * Every string taken from a file is untrusted. Facts are stored as given and wrapped when
 * shown; the excerpt only ever reaches the model inside <untrusted source="document">.
 */
import { open, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import type { DocEngine } from '../docs/engine.js';
import { extractPdfText, MAX_ATTACHMENT_BYTES } from '../mail/attachments.js';
import type { FileFacts } from './catalog.js';
import { type FileKind, kindOfBytes } from './roots.js';

/** Characters of a file's text handed to the summary worker. */
export const EXCERPT_CHARS = 3000;
const MAX_TEXT_READ = 256 * 1024;
const MAX_PROP_CHARS = 300;
const PDF_PAGES_FOR_FACTS = 5;

export interface FileReading {
  kind: FileKind;
  facts: FileFacts;
  /** Text for the summary worker; null when there is none (pictures, other files, no text). */
  excerpt: string | null;
}

export interface FactReaderOptions {
  /** D1's engine, when Word and Excel files are on. */
  engine?: Pick<DocEngine, 'wordText' | 'sheetNames' | 'sheetRange'> | undefined;
  pdfText?: typeof extractPdfText;
}

const clip = (s: string | undefined, n = MAX_PROP_CHARS) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : undefined;
};
const countWords = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

async function head(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export class FactReader {
  private readonly pdfText: typeof extractPdfText;

  constructor(private readonly o: FactReaderOptions = {}) {
    this.pdfText = o.pdfText ?? extractPdfText;
  }

  async read(f: { path: string; name: string; bytes: number }, signal?: AbortSignal): Promise<FileReading> {
    const first = await head(f.path, 1024);
    const kind = kindOfBytes(first, f.name);
    const tooBig = f.bytes > MAX_ATTACHMENT_BYTES * 2;
    switch (kind) {
      case 'text': {
        const text = (await head(f.path, MAX_TEXT_READ)).toString('utf8');
        const heading = /\.md$/i.test(f.name) ? text.match(/^#\s+(.+)$/m)?.[1] : undefined;
        return { kind, facts: { title: clip(heading), words: countWords(text) }, excerpt: text.slice(0, EXCERPT_CHARS) || null };
      }
      case 'pdf': {
        if (tooBig) return { kind, facts: {}, excerpt: null };
        const bytes = await readFile(f.path);
        const info = pdfInfo(bytes);
        const pdf = await this.pdfText(bytes, { ...(signal ? { signal } : {}), maxPages: PDF_PAGES_FOR_FACTS });
        return { kind, facts: { ...info, pages: pdf.pages, words: pdf.readPages === pdf.pages ? countWords(pdf.text) : undefined }, excerpt: pdf.text.trim() ? pdf.text.slice(0, EXCERPT_CHARS) : null };
      }
      case 'word': {
        if (tooBig) return { kind, facts: {}, excerpt: null };
        const props = officeProps(await readFile(f.path));
        const text = this.o.engine ? await this.o.engine.wordText(f.path, signal) : '';
        return { kind, facts: { ...props, ...(text ? { words: countWords(text) } : {}) }, excerpt: text.trim() ? text.slice(0, EXCERPT_CHARS) : null };
      }
      case 'sheet': {
        if (tooBig) return { kind, facts: {}, excerpt: null };
        const props = officeProps(await readFile(f.path));
        if (!this.o.engine) return { kind, facts: props, excerpt: null };
        const sheets = (await this.o.engine.sheetNames(f.path, signal)).slice(0, 30).map((s) => s.slice(0, 100));
        const grid = await this.o.engine.sheetRange(f.path, { range: 'A1:H30', ...(sheets[0] ? { sheet: sheets[0] } : {}), signal });
        const table = grid.rows.map((r) => r.join(' | ')).join('\n');
        const excerpt = `Sheets: ${sheets.join(', ')}\nFirst rows of ${sheets[0] ?? 'the first sheet'}:\n${table}`.slice(0, EXCERPT_CHARS);
        return { kind, facts: { ...props, sheets }, excerpt };
      }
      case 'image':
        return { kind, facts: imageSize(await head(f.path, 64 * 1024)), excerpt: null };
      default:
        return { kind, facts: {}, excerpt: null };
    }
  }
}

/** Title and Author from a PDF's info dictionary, when written as plain strings. */
export function pdfInfo(bytes: Buffer): Pick<FileFacts, 'title' | 'author'> {
  const tail = bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString('latin1');
  const headText = bytes.subarray(0, 64 * 1024).toString('latin1');
  const find = (key: string) => {
    const re = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)]){1,400})\\)`);
    const m = tail.match(re) ?? headText.match(re);
    if (!m?.[1]) return undefined;
    const raw = m[1].replace(/\\([nrtbf()\\])/g, (_x, c: string) => ({ n: ' ', r: ' ', t: ' ', b: '', f: '' } as Record<string, string>)[c] ?? c);
    // UTF-16 strings start with a byte-order mark; anything else is read as Latin-1.
    if (raw.startsWith('þÿ')) return clip(Buffer.from(raw.slice(2), 'latin1').swap16().toString('utf16le'));
    return clip(raw);
  };
  return { title: find('Title'), author: find('Author') };
}

/** dc:title and dc:creator from an Office file's docProps/core.xml. */
export function officeProps(zip: Buffer): Pick<FileFacts, 'title' | 'author'> {
  const xml = zipEntry(zip, 'docProps/core.xml', 256 * 1024)?.toString('utf8');
  if (!xml) return {};
  const tag = (name: string) => {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]{1,2000})</${name}>`));
    return clip(m?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  };
  return { title: tag('dc:title'), author: tag('dc:creator') };
}

/** One entry of a ZIP file, read through its central directory; null when absent or odd. */
export function zipEntry(zip: Buffer, name: string, maxBytes: number): Buffer | null {
  const from = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= from; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (data.length !== size) return null;
      try {
        if (method === 0) return data.length <= maxBytes ? data : null;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch {
        return null;
      }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Width and height of a PNG, GIF or JPEG from its first bytes. */
export function imageSize(b: Buffer): Pick<FileFacts, 'width' | 'height'> {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.subarray(0, 4).toString('latin1') === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return {};
      const marker = b[p + 1]!;
      const len = b.readUInt16BE(p + 2);
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      p += 2 + len;
    }
  }
  return {};
}
