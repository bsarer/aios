/**
 * Email attachments (S2): PDF, plain text and images. Everything about an attachment is
 * untrusted: its name, its declared type and its bytes. What it is gets decided by its
 * first bytes, never by the name or the type the sender wrote.
 *
 * The model can read the text of a PDF or text attachment (mail_attachment_read), which
 * is sanitize()d and wrapped like an email body. The user can open any of the three kinds
 * in a viewer in the chat (mail_attachment_show and the /attachments route); the model
 * never sees an image.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { type FileRoots, freeName } from '../files/roots.js';
import type { Store } from '../store.js';
import { cleanName } from '../system/controls.js';
import type { AttachmentPart, MailClient } from './imap.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Text handed to the model from one attachment, after extraction. */
export const MAX_ATTACHMENT_CHARS = 12_000;
const PDF_MAX_PAGES = 50;
const PDF_TIMEOUT_MS = 10_000;

export type AttachmentKind = 'pdf' | 'text' | 'image';

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown']);
const TEXT_EXT = new Set(['txt', 'csv', 'md', 'log']);

const extOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** What the sender says it is. Only used to list and describe it; bytes decide (sniff). SVG is never an image here. */
export function declaredKind(a: Pick<AttachmentPart, 'name' | 'type'>): AttachmentKind | null {
  const ext = extOf(a.name);
  if (a.type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (Object.values(IMAGE_EXT).includes(a.type === 'image/jpg' ? 'image/jpeg' : a.type) || ext in IMAGE_EXT) return 'image';
  if (TEXT_TYPES.has(a.type) || TEXT_EXT.has(ext)) return 'text';
  return null;
}

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/**
 * What the bytes are, and the only MIME type the file is ever served with. A PDF, PNG, JPEG,
 * GIF or WebP by its signature; text only when it was declared as text and has no NUL bytes.
 * Anything else (SVG, HTML, archives, executables) is null and is never opened.
 */
export function sniff(bytes: Buffer, declared: AttachmentKind | null): { kind: AttachmentKind; mime: string } | null {
  // PDF readers accept the header anywhere in the first 1024 bytes.
  if (bytes.subarray(0, 1024).includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (declared === 'text' && !bytes.subarray(0, 64 * 1024).includes(0)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  return null;
}

const KIND_WORD: Record<AttachmentKind, string> = { pdf: 'PDF', text: 'text', image: 'image' };

export function sizeText(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line per attachment for mail_read, numbered as mail_attachment_read and _show take them. */
export function listAttachments(list: AttachmentPart[]): string {
  return list
    .map((a, i) => {
      const k = declaredKind(a);
      // Server sizes are transfer-encoded; 3/4 is close enough for base64.
      const approx = a.size === null ? null : Math.round(a.size * 0.75);
      return `${i + 1}. ${a.name} (${k ? `${KIND_WORD[k]}, ${sizeText(approx)}` : `${sizeText(approx)}, can't be opened here but can be saved`})`;
    })
    .join('\n');
}

export class AttachmentError extends Error {}

/**
 * Text of a PDF, from a worker thread with a memory cap and a time limit, so a hostile
 * PDF can neither hang nor exhaust the service. pdf.js never runs scripts in a PDF.
 */
export function extractPdfText(bytes: Buffer, opts: { signal?: AbortSignal; timeoutMs?: number; maxPages?: number } = {}): Promise<{ text: string; pages: number; readPages: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-text-worker.mjs', import.meta.url), {
      workerData: { data: new Uint8Array(bytes), maxPages: opts.maxPages ?? PDF_MAX_PAGES, maxChars: MAX_ATTACHMENT_CHARS * 2 },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(new AttachmentError('reading the PDF was stopped')));
    const timer = setTimeout(() => finish(() => reject(new AttachmentError('the PDF took too long to read'))), opts.timeoutMs ?? PDF_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m: { ok: true; text: string; pages: number; readPages: number } | { ok: false; error: string }) =>
      finish(() => (m.ok ? resolve({ text: m.text, pages: m.pages, readPages: m.readPages }) : reject(new AttachmentError(m.error)))),
    );
    worker.once('error', () => finish(() => reject(new AttachmentError("the PDF couldn't be read"))));
    worker.once('exit', () => finish(() => reject(new AttachmentError("the PDF couldn't be read"))));
  });
}

type AttachmentItem = Extract<ChatItem, { kind: 'attachment' }>;

export interface AttachmentFilesOptions {
  store: Store;
  mail: Pick<MailClient, 'attachment'>;
  audit: AuditLog;
  post: (item: ChatItem) => void;
  /** F1: patch a card in the chat after its Save click. */
  patch?: (item: ChatItem) => void;
  /** F1: the allowed folders, for Save buttons and for showing files from disk. Without it, neither. */
  roots?: FileRoots;
  /** F1: where Save saves unless another folder is picked (`[files] saveTo`). */
  saveTo?: string;
  /** F1: told about each file the Save click wrote (the F2 index). */
  onSaved?: (path: string, source: { mailId: string; n: number }) => void;
  clock?: () => number;
}

/** F1: the most an attachment's Save click writes. */
export const MAX_SAVE_BYTES = 50 * 1024 * 1024;

export type AttachmentSaveResult = 'saved' | 'refused' | 'failed';

/**
 * Attachment cards in the chat and the files behind them. A card's id is random and is the
 * only way to fetch its file, so the /attachments route serves exactly the attachments the
 * chat has shown, and nothing else from the mailbox. F1: a card can also stand for a file on
 * disk (file_show), and an email attachment's card has a Save button.
 */
export class AttachmentFiles {
  private readonly clock: () => number;

  constructor(private readonly o: AttachmentFilesOptions) {
    this.clock = o.clock ?? Date.now;
  }

  /** The folders a Save button offers: the default first, then the other allowed folders. */
  private async saveFolders(): Promise<string[]> {
    if (!this.o.roots) return [];
    const first = await this.o.roots.defaultSaveFolder(this.o.saveTo ?? '~/Downloads');
    const all = await this.o.roots.realRoots();
    return [...new Set([...(first ? [first] : []), ...all])].map((p) => this.o.roots!.display(p));
  }

  /** Post a card with an Open button (for PDFs, text and pictures) and a Save button (F1). Downloads nothing. */
  async show(mailId: string, n: number, info: AttachmentPart): Promise<AttachmentItem> {
    const folders = await this.saveFolders();
    const item: AttachmentItem = {
      kind: 'attachment',
      id: `att-${randomUUID()}`,
      name: cleanName(info.name) || 'attachment',
      fileKind: declaredKind(info) ?? 'other',
      mailId,
      n,
      ...(folders.length ? { folders } : {}),
      at: this.clock(),
    };
    this.o.post(item);
    return item;
  }

  /** F1: a card that opens a PDF, text file or picture from disk in the same viewer. */
  showFile(file: { path: string; name: string }, fileKind: AttachmentKind): AttachmentItem {
    const item: AttachmentItem = { kind: 'attachment', id: `att-${randomUUID()}`, name: cleanName(file.name) || 'file', fileKind, path: file.path, at: this.clock() };
    this.o.post(item);
    return item;
  }

  /** The bytes behind a card, checked again by their signature. Null when there is no such card or file. */
  async file(itemId: string): Promise<{ bytes: Buffer; mime: string } | { error: string } | null> {
    const item = this.o.store.getItem(itemId);
    if (!item || item.kind !== 'attachment' || item.fileKind === 'other') return null;
    if (item.path !== undefined) return this.diskFile(item as AttachmentItem & { path: string; fileKind: AttachmentKind });
    if (item.mailId === undefined || item.n === undefined) return null;
    const log = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'mail', event: 'attachment_opened', itemId, mailId: item.mailId, n: item.n, ...entry });
    const got = await this.o.mail.attachment(item.mailId, item.n, MAX_ATTACHMENT_BYTES).catch((err: unknown) => {
      log({ ok: false, error: (err as Error).message });
      throw err;
    });
    if (!got) {
      log({ ok: false, error: 'not found' });
      return null;
    }
    if (got.bytes === 'too_large') {
      log({ ok: false, error: 'too large' });
      return { error: `It is larger than ${sizeText(MAX_ATTACHMENT_BYTES)}, so it can't be opened here.` };
    }
    const s = sniff(got.bytes, declaredKind(got.info));
    if (!s || s.kind !== item.fileKind) {
      log({ ok: false, error: 'content does not match a PDF, text or image', bytes: got.bytes.length });
      return { error: "This file isn't really a PDF, text file or picture, so it won't be opened." };
    }
    log({ ok: true, fileKind: s.kind, mime: s.mime, bytes: got.bytes.length });
    return { bytes: got.bytes, mime: s.mime };
  }

  /** F1: a file from disk, resolved inside the allowed folders again on every open. */
  private async diskFile(item: AttachmentItem & { path: string; fileKind: AttachmentKind }): Promise<{ bytes: Buffer; mime: string } | { error: string } | null> {
    const log = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'files', event: 'file_opened', itemId: item.id, path: item.path, ...entry });
    if (!this.o.roots) return null;
    const f = await this.o.roots.resolve(item.path, 'file').catch(() => null);
    if (!f || f.path !== item.path) {
      log({ ok: false, error: 'no longer there' });
      return null;
    }
    if (f.bytes > MAX_ATTACHMENT_BYTES) return { error: `It is larger than ${sizeText(MAX_ATTACHMENT_BYTES)}, so it can't be opened here.` };
    const bytes = await readFile(f.path);
    const s = sniff(bytes, declaredKind({ name: f.name, type: '' }));
    if (!s || s.kind !== item.fileKind) {
      log({ ok: false, error: 'content does not match' });
      return { error: "This file isn't really a PDF, text file or picture, so it won't be opened." };
    }
    log({ ok: true, fileKind: s.kind, bytes: bytes.length });
    return { bytes, mime: s.mime };
  }

  /**
   * F1: the Save click on an email attachment's card. The user's own click (not a model call),
   * so it works while the email is on screen. Fetches the bytes again, writes them into the
   * folder the card offered under a free name, and never replaces a file.
   */
  async save(itemId: string, folderIndex: number): Promise<AttachmentSaveResult> {
    const item = this.o.store.getItem(itemId);
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: 'attachment_save', tier: 'write', via: 'click', itemId, ...entry });
    if (!item || item.kind !== 'attachment' || item.mailId === undefined || item.n === undefined || !this.o.roots) {
      audit({ decision: 'denied', reason: 'not an email attachment card' });
      return 'refused';
    }
    const display = item.folders?.[folderIndex];
    const folder = display ? await this.o.roots.resolve(display, 'dir').catch(() => null) : null;
    if (!folder) {
      audit({ decision: 'denied', reason: 'that folder is not offered or no longer allowed' });
      return 'refused';
    }
    const done = (patch: Partial<AttachmentItem>) => {
      const updated = { ...item, ...patch } as AttachmentItem;
      this.o.store.saveItem(updated);
      this.o.patch?.(updated);
    };
    try {
      const got = await this.o.mail.attachment(item.mailId, item.n, MAX_SAVE_BYTES);
      if (!got) throw new AttachmentError('that attachment is no longer in your mailbox');
      if (got.bytes === 'too_large') throw new AttachmentError(`it is larger than ${sizeText(MAX_SAVE_BYTES)}`);
      const name = safeFileName(got.info.name.replace(/[\p{Cc}\p{Cf}]/gu, '') || item.name);
      // A free name, then an exclusive write: if the name is taken in between, try the next one.
      let target = '';
      for (let i = 0; i < 5; i++) {
        target = await freeName(folder.path, name);
        try {
          await writeFile(target, got.bytes, { flag: 'wx', mode: 0o644 });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i === 4) throw err;
        }
      }
      const shown = this.o.roots.display(target);
      audit({ decision: 'approved', ok: true, mailId: item.mailId, n: item.n, path: target, bytes: got.bytes.length });
      done({ saved: shown });
      this.o.onSaved?.(target, { mailId: item.mailId, n: item.n });
      return 'saved';
    } catch (err) {
      audit({ decision: 'approved', ok: false, error: (err as Error).message });
      done({ saved: `Didn't save: ${(err as Error).message}` });
      return 'failed';
    }
  }
}

/** A sender's file name as a safe name on disk: no folder parts, no leading dot. */
function safeFileName(name: string): string {
  const n = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 200);
  return n || 'attachment';
}
