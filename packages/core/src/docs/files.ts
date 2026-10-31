/**
 * Which Word and Excel files the chat may open (D1). Only regular .docx and .xlsx files
 * inside the configured folders, found by their real path (links followed), that start
 * like a ZIP package. Hidden files and folders are left out. A path from the model is
 * never used as given: it is resolved here first, and the resolved path is what the
 * WordCraft and GridCraft tools receive.
 */
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DocKind = 'word' | 'sheet';

export const MAX_DOC_BYTES = 50 * 1024 * 1024;
const EXT_KIND: Record<string, DocKind> = { '.docx': 'word', '.xlsx': 'sheet' };
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
/** Folder depth docs_list looks into below each root, and how many entries it reads at most. */
const LIST_DEPTH = 6;
const LIST_MAX_ENTRIES = 5000;

export class DocPathError extends Error {}

export interface DocFile {
  /** Real path on disk, inside a root. */
  path: string;
  /** How it is shown: `~/Documents/report.docx` when under the home folder. */
  display: string;
  name: string;
  kind: DocKind;
  bytes: number;
  mtimeMs: number;
}

export const kindOfName = (name: string): DocKind | null => EXT_KIND[extname(name).toLowerCase()] ?? null;

export const KIND_WORD: Record<DocKind, string> = { word: 'Word', sheet: 'Excel' };

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
};

const hiddenBelow = (root: string, p: string) => relative(root, p).split(sep).some((part) => part.startsWith('.'));

export interface DocFilesOptions {
  /** Folders from config, `~` allowed. */
  roots: string[];
  home?: string;
}

export class DocFiles {
  private readonly home: string;
  private readonly roots: string[];

  constructor(o: DocFilesOptions) {
    this.home = o.home ?? homedir();
    this.roots = o.roots.map((r) => this.expand(r)).filter((r): r is string => r !== null && isAbsolute(r));
  }

  private expand(p: string): string | null {
    if (p === '~') return this.home;
    if (p.startsWith('~/')) return join(this.home, p.slice(2));
    return isAbsolute(p) ? resolve(p) : null;
  }

  /** `~/Documents/x.docx` for paths under the home folder, the full path otherwise. */
  display(p: string): string {
    return inside(this.home, p) ? `~/${relative(this.home, p)}` : p;
  }

  /** The roots that exist, by their real paths. */
  async realRoots(): Promise<string[]> {
    const out: string[] = [];
    for (const r of this.roots) {
      const real = await realpath(r).catch(() => null);
      if (real && (await lstat(real)).isDirectory()) out.push(real);
    }
    return [...new Set(out)];
  }

  /** The folders as the user would write them, for messages. */
  rootsText(): string {
    return this.roots.map((r) => this.display(r)).join(', ');
  }

  /**
   * A path from the chat, checked: absolute, `~/…`, or relative to one of the folders.
   * Throws DocPathError with a message the model can pass on.
   */
  async resolve(input: string): Promise<DocFile> {
    const raw = input.trim();
    if (!raw || raw.includes('\0') || raw.length > 1000) throw new DocPathError('that is not a file path');
    const roots = await this.realRoots();
    if (!roots.length) throw new DocPathError(`none of the document folders (${this.rootsText()}) exist on this computer`);
    const expanded = this.expand(raw);
    const candidates = expanded ? [expanded] : this.roots.map((r) => join(r, raw));
    let real: string | null = null;
    for (const c of candidates) {
      real = await realpath(c).catch(() => null);
      if (real) break;
    }
    if (!real) throw new DocPathError(`there is no file ${raw}. Call docs_list to find it`);
    const root = roots.find((r) => inside(r, real));
    if (!root) throw new DocPathError(`only files in ${this.rootsText()} can be opened`);
    if (hiddenBelow(root, real)) throw new DocPathError('hidden files and folders are not opened');
    const kind = kindOfName(real);
    if (!kind) throw new DocPathError('only Word (.docx) and Excel (.xlsx) files can be opened');
    const st = await lstat(real);
    if (!st.isFile()) throw new DocPathError(`${basename(real)} is not a file`);
    if (st.size > MAX_DOC_BYTES) throw new DocPathError(`${basename(real)} is larger than ${MAX_DOC_BYTES / 1024 / 1024} MB, too large to open here`);
    if (!(await startsWithZip(real))) throw new DocPathError(`${basename(real)} is not really a ${kind === 'word' ? '.docx' : '.xlsx'} file, so it won't be opened`);
    return { path: real, display: this.display(real), name: basename(real), kind, bytes: st.size, mtimeMs: st.mtimeMs };
  }

  /**
   * Word and Excel files in the folders, newest first. Links are not followed and hidden
   * entries are skipped, so this lists only what resolve() would accept by name.
   */
  async list(query = ''): Promise<{ files: Omit<DocFile, 'path'>[]; truncated: boolean }> {
    const q = query.trim().toLowerCase();
    const files: Omit<DocFile, 'path'>[] = [];
    let seen = 0;
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const handle = await opendir(dir).catch(() => null);
      if (!handle) return;
      for await (const e of handle) {
        if (++seen > LIST_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < LIST_DEPTH) await walk(p, depth + 1);
          continue;
        }
        const kind = e.isFile() ? kindOfName(e.name) : null;
        if (!kind) continue;
        const display = this.display(p);
        if (q && !display.toLowerCase().includes(q)) continue;
        const st = await lstat(p).catch(() => null);
        if (!st) continue;
        files.push({ display, name: e.name, kind, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    };
    for (const r of await this.realRoots()) {
      if (seen > LIST_MAX_ENTRIES) break;
      await walk(r, 1);
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { files, truncated };
  }
}

async function startsWithZip(p: string): Promise<boolean> {
  const fh = await open(p, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && ZIP_SIGNATURE.every((b, i) => buf[i] === b);
  } finally {
    await fh.close();
  }
}
