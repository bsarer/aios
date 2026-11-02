/**
 * Files attached to an outgoing email (M1). Only files inside `[files] roots` can be attached:
 * every path is resolved through FileRoots, so a link leading out, a hidden file or a path
 * outside the folders is refused. What is attached is fixed when the draft is made (path,
 * size and sha256 of the bytes); before a send or an edit the file is read again and must be
 * byte for byte the same, and the message is built from the bytes that were checked.
 */
import { open } from 'node:fs/promises';
import { FilePathError, type FileRoots, kindOfBytes } from '../files/roots.js';
import { sha256 } from './message.js';
import type { AttachmentContent } from './message.js';

/** At most this many files on one email. */
export const MAX_OUTGOING_FILES = 10;
/**
 * At most this many bytes of files on one email. Base64 makes them about a third bigger, and
 * common providers refuse messages over 25 MB, so 18 MB of files keeps the message under that.
 */
export const MAX_OUTGOING_BYTES = 18 * 1024 * 1024;

/** What a draft remembers about one attached file. Stored with the draft; never sent to the model. */
export interface OutgoingAttachment {
  /** Real path inside a root when the draft was made. */
  path: string;
  /** `~/Documents/lease.pdf`, shown on the card. */
  display: string;
  /** The file name the recipient sees. */
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** Written by code, shown on the card: e.g. a file attached while an email was in view. */
  warning?: string;
}

export class OutgoingFileError extends Error {}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The MIME type, from the first bytes (and, for Office files and text, the name), never from the name alone. */
export function contentTypeOf(head: Buffer, name: string): string {
  const kind = kindOfBytes(head, name);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'image') {
    if (head[0] === 0x89) return 'image/png';
    if (head[0] === 0xff) return 'image/jpeg';
    if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    return 'image/webp';
  }
  if (kind === 'word') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'sheet') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (kind === 'text') return 'text/plain';
  return 'application/octet-stream';
}

/** A file name as it goes into the message: no control characters, not too long. */
export function attachmentName(name: string): string {
  const clean = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'file').slice(0, 200);
}

export interface OutgoingFilesOptions {
  roots: FileRoots;
  maxFiles?: number;
  maxBytes?: number;
}

export class OutgoingFiles {
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(private readonly o: OutgoingFilesOptions) {
    this.maxFiles = o.maxFiles ?? MAX_OUTGOING_FILES;
    this.maxBytes = o.maxBytes ?? MAX_OUTGOING_BYTES;
  }

  /** Read one file inside the folders, at most `limit` bytes; null if it is bigger. */
  private async readCapped(path: string, limit: number): Promise<Buffer | null> {
    const fh = await open(path, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new OutgoingFileError('that is not a file');
      if (st.size > limit) return null;
      // Read one byte more than allowed, so a file that grew since the stat is caught.
      const buf = Buffer.alloc(Math.min(limit, st.size) + 1);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return got > limit ? null : buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  }

  /**
   * Files the model asked to attach, as paths from the chat. Throws OutgoingFileError (or
   * FilePathError) with a message the model can pass on.
   */
  async pick(paths: string[]): Promise<{ attachments: OutgoingAttachment[]; contents: AttachmentContent[] }> {
    if (paths.length > this.maxFiles) throw new OutgoingFileError(`attach at most ${this.maxFiles} files to one email`);
    const attachments: OutgoingAttachment[] = [];
    const contents: AttachmentContent[] = [];
    let total = 0;
    const seen = new Set<string>();
    for (const p of paths) {
      const entry = await this.o.roots.resolve(p, 'file');
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const content = await this.readCapped(entry.path, this.maxBytes - total);
      if (!content) throw new OutgoingFileError(`${entry.name} is too big: the files on one email can add up to ${kb(this.maxBytes)}`);
      total += content.length;
      const name = attachmentName(entry.name);
      const contentType = contentTypeOf(content.subarray(0, 1024), entry.name);
      attachments.push({ path: entry.path, display: entry.display, name, contentType, bytes: content.length, sha256: sha256(content) });
      contents.push({ name, contentType, content });
    }
    return { attachments, contents };
  }

  /**
   * The bytes to send for files picked earlier. Each must still be inside the folders and
   * exactly as it was when the draft was made; otherwise nothing is sent.
   */
  async load(attachments: OutgoingAttachment[]): Promise<AttachmentContent[]> {
    const out: AttachmentContent[] = [];
    for (const a of attachments) {
      const entry = await this.o.roots.resolve(a.path, 'file').catch((err: unknown) => {
        throw new OutgoingFileError(`${a.name} can't be attached any more (${err instanceof FilePathError ? err.message : 'it is gone'})`);
      });
      const content = entry.path === a.path ? await this.readCapped(entry.path, a.bytes).catch(() => null) : null;
      if (!content || content.length !== a.bytes || sha256(content) !== a.sha256) {
        throw new OutgoingFileError(`${a.name} changed after the draft was made. Ask for a new draft to send the file as it is now`);
      }
      out.push({ name: a.name, contentType: a.contentType, content });
    }
    return out;
  }

  /** Short size text for the card and the model. */
  static size = kb;
}
