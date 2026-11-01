/**
 * Which files and folders the chat may touch (F1): only those inside the configured folders,
 * found by their real path (so a link leading out is refused), never hidden ones. A path from
 * the model is never used as given: it is resolved here first. Listings don't follow links.
 * New names are checked here too, so a name can't climb out of its folder or hide a file.
 */
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class FilePathError extends Error {}

/** What a file is, decided by its first bytes (and, for Office files and text, its name too). */
export type FileKind = 'folder' | 'pdf' | 'image' | 'word' | 'sheet' | 'text' | 'other';

export interface FileEntry {
  /** Real path on disk, inside a root. */
  path: string;
  /** `~/Documents/x.pdf` under the home folder, the full path otherwise. */
  display: string;
  name: string;
  isDir: boolean;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
}

const LIST_DEPTH = 6;
const LIST_MAX_ENTRIES = 5000;
export const MAX_NAME_CHARS = 200;
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.log', '.json']);

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
};
const insideOrAt = (root: string, p: string) => p === root || inside(root, p);
const hiddenBelow = (root: string, p: string) => p !== root && relative(root, p).split(sep).some((part) => part.startsWith('.'));

export interface FileRootsOptions {
  roots: string[];
  home?: string;
}

export class FileRoots {
  readonly home: string;
  private readonly roots: string[];

  constructor(o: FileRootsOptions) {
    this.home = o.home ?? homedir();
    this.roots = [...new Set(o.roots.map((r) => this.expand(r)).filter((r): r is string => r !== null && isAbsolute(r)))];
  }

  expand(p: string): string | null {
    if (p === '~') return this.home;
    if (p.startsWith('~/')) return join(this.home, p.slice(2));
    return isAbsolute(p) ? resolve(p) : null;
  }

  display(p: string): string {
    return p === this.home ? '~' : inside(this.home, p) ? `~/${relative(this.home, p)}` : p;
  }

  async realRoots(): Promise<string[]> {
    const out: string[] = [];
    for (const r of this.roots) {
      const real = await realpath(r).catch(() => null);
      if (real && (await lstat(real)).isDirectory()) out.push(real);
    }
    return [...new Set(out)];
  }

  rootsText(): string {
    return this.roots.map((r) => this.display(r)).join(', ');
  }

  /**
   * A file or folder from the chat: absolute, `~/…`, or relative to one of the folders.
   * Throws FilePathError with a message the model can pass on.
   */
  async resolve(input: string, want: 'file' | 'dir' | 'any' = 'any'): Promise<FileEntry> {
    const raw = input.trim();
    if (!raw || raw.includes('\0') || raw.length > 1000) throw new FilePathError('that is not a path');
    const roots = await this.realRoots();
    if (!roots.length) throw new FilePathError(`none of the folders (${this.rootsText()}) exist on this computer`);
    const expanded = this.expand(raw);
    const candidates = expanded ? [expanded] : this.roots.map((r) => join(r, raw));
    let real: string | null = null;
    for (const c of candidates) {
      real = await realpath(c).catch(() => null);
      if (real) break;
    }
    if (!real) throw new FilePathError(`there is no ${want === 'dir' ? 'folder' : 'file'} ${raw}. Call files_list to find it`);
    const root = roots.find((r) => insideOrAt(r, real));
    if (!root) throw new FilePathError(`only files in ${this.rootsText()} can be used`);
    if (hiddenBelow(root, real)) throw new FilePathError('hidden files and folders are left alone');
    const st = await lstat(real);
    if (want === 'file' && !st.isFile()) throw new FilePathError(`${basename(real)} is not a file`);
    if (want === 'dir' && !st.isDirectory()) throw new FilePathError(`${basename(real)} is not a folder`);
    if (!st.isFile() && !st.isDirectory()) throw new FilePathError(`${basename(real)} is not a file or folder`);
    return { path: real, display: this.display(real), name: basename(real), isDir: st.isDirectory(), bytes: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
  }

  /** The folder an attachment's Save button saves to by default: `saveTo` if it is allowed, else the first folder. */
  async defaultSaveFolder(saveTo: string): Promise<string | null> {
    const p = await this.resolve(saveTo, 'dir').catch(() => null);
    return p?.path ?? (await this.realRoots())[0] ?? null;
  }

  /**
   * Entries of one folder (no query), or files whose path contains the query anywhere below
   * the folder (or below every folder). Links are not followed and hidden entries are skipped.
   */
  async list(folder: string | null, query = ''): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const q = query.trim().toLowerCase();
    const starts = folder ? [folder] : await this.realRoots();
    const entries: FileEntry[] = [];
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
        const isDir = e.isDirectory();
        if (!isDir && !e.isFile()) continue;
        const match = !q || this.display(p).toLowerCase().includes(q);
        if (match) {
          const st = await lstat(p).catch(() => null);
          if (st) entries.push({ path: p, display: this.display(p), name: e.name, isDir, bytes: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
        }
        if (isDir && q && depth < LIST_DEPTH) await walk(p, depth + 1);
      }
    };
    for (const s of starts) {
      if (seen > LIST_MAX_ENTRIES) break;
      await walk(s, 1);
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? b.mtimeMs - a.mtimeMs : a.isDir ? -1 : 1));
    return { entries, truncated };
  }
}

/**
 * A file or folder name as given, checked: one name (no folder parts), no leading dot, no
 * control characters, not too long. Throws FilePathError for the model.
 */
export function checkFileName(input: string): string {
  const name = input.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') throw new FilePathError('give a name made of letters, numbers and spaces');
  if (/[/\\]/.test(name)) throw new FilePathError('a name cannot contain / or \\; give the folder separately');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new FilePathError('that name has control characters in it');
  if (name.startsWith('.')) throw new FilePathError('names starting with a dot are hidden files; pick another name');
  if (name.length > MAX_NAME_CHARS) throw new FilePathError(`keep names under ${MAX_NAME_CHARS} characters`);
  return name;
}

/** A name for a saved file that isn't taken in `dir`: `name.pdf`, then `name (2).pdf`… */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length) || 'file';
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
    if (!(await exists(p))) return p;
  }
  throw new FilePathError('there are too many files with that name already');
}

export async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

/** The parent folder of a path (for rename checks). */
export const folderOf = (p: string) => dirname(p);

/** What a file is, by its first bytes and name. */
export async function kindOf(entry: Pick<FileEntry, 'path' | 'name' | 'isDir'>): Promise<FileKind> {
  if (entry.isDir) return 'folder';
  const fh = await open(entry.path, 'r').catch(() => null);
  if (!fh) return 'other';
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    return kindOfBytes(buf.subarray(0, bytesRead), entry.name);
  } finally {
    await fh.close();
  }
}

export function kindOfBytes(b: Buffer, name: string): FileKind {
  const ext = extname(name).toLowerCase();
  if (b.includes('%PDF-')) return 'pdf';
  const sig = (s: number[]) => s.every((x, i) => b[i] === x);
  if (sig([0x89, 0x50, 0x4e, 0x47]) || sig([0xff, 0xd8, 0xff]) || b.subarray(0, 4).toString('latin1') === 'GIF8' || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')) return 'image';
  if (sig([0x50, 0x4b, 0x03, 0x04])) return ext === '.docx' ? 'word' : ext === '.xlsx' ? 'sheet' : 'other';
  if (TEXT_EXT.has(ext) && !b.includes(0)) return 'text';
  return 'other';
}

export const KIND_TEXT: Record<FileKind, string> = { folder: 'folder', pdf: 'PDF', image: 'picture', word: 'Word', sheet: 'Excel', text: 'text', other: 'file' };
