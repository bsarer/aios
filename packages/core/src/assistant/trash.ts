/**
 * L1: Move to Trash, following the freedesktop.org Trash specification (1.0), so the file
 * shows up in the file manager's Trash with its original place and can be restored.
 * Only into the home trash ($XDG_DATA_HOME/Trash), so only files on the home drive: another
 * drive would need a copy, and a half-finished copy is how files get lost.
 *
 * Nothing is ever overwritten: the .trashinfo file is created exclusively first, and the
 * file is moved with a hard link to a name that must not exist, then the old name removed.
 */
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

export class TrashError extends Error {}

export function trashDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Trash');
}

/** The spec's Path: absolute, percent-encoded like a URL path. */
export function trashInfoPath(abs: string): string {
  return abs
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function localStamp(at: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((a, x) => (x.type === 'literal' ? a : { ...a, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Moves one regular file into the Trash. Returns the name it has there. */
export async function moveToTrash(path: string, o: { dir: string; timeZone: string; now?: number }): Promise<string> {
  const st = await lstat(path);
  if (!st.isFile()) throw new TrashError('only files can be moved to the Trash from here');
  const files = join(o.dir, 'files');
  const info = join(o.dir, 'info');
  await mkdir(files, { recursive: true, mode: 0o700 });
  await mkdir(info, { recursive: true, mode: 0o700 });
  const dirSt = await lstat(files);
  if (dirSt.dev !== st.dev) throw new TrashError('it is on another drive than your home folder; delete it in the file manager instead');

  const name = basename(path);
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const text = `[Trash Info]\nPath=${trashInfoPath(path)}\nDeletionDate=${localStamp(o.now ?? Date.now(), o.timeZone)}\n`;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const infoPath = join(info, `${candidate}.trashinfo`);
    let fh;
    try {
      fh = await open(infoPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    try {
      await link(path, join(files, candidate));
    } catch (err) {
      await unlink(infoPath).catch(() => undefined);
      // A file left in Trash/files without its info: try the next name.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') throw new TrashError('it is on another drive than your home folder; delete it in the file manager instead');
      throw err;
    }
    await unlink(path);
    return candidate;
  }
  throw new TrashError('the Trash has too many files with this name');
}
