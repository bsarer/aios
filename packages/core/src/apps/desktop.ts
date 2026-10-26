/**
 * Installed apps (S3), read from XDG desktop entries: the same .desktop files Omarchy's
 * app launcher lists, including the web apps and TUIs Omarchy installs as entries.
 *
 * Only the [Desktop Entry] group is read, and only the fields needed to list an app. The
 * Exec line is never read: apps start by their desktop id through gtk-launch (launcher.ts),
 * so nothing here ever becomes a command line.
 *
 * Lookup follows the Desktop Entry spec: $XDG_DATA_HOME/applications first, then each of
 * $XDG_DATA_DIRS; the first file with a given id wins, so a user's own copy with
 * NoDisplay or Hidden hides the system one.
 */
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { cleanName } from '../system/controls.js';

export interface DesktopApp {
  /** Desktop file id, e.g. "firefox.desktop" or "org.gnome.Nautilus.desktop". */
  id: string;
  name: string;
  comment: string;
  keywords: string[];
  categories: string[];
  /** Runs in a terminal (Omarchy's TUIs). */
  terminal: boolean;
}

/** Ids gtk-launch is ever handed. Anything else is skipped, so an id can't look like an option. */
export const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.desktop$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 2000;
const MAX_DEPTH = 3;

export function applicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? '';
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [dataHome, ...dataDirs].filter((d) => isAbsolute(d)).map((d) => join(d, 'applications'));
}

function unescape(v: string): string {
  return v.replace(/\\([sntr\\])/g, (_, c: string) => ({ s: ' ', n: ' ', t: ' ', r: '', '\\': '\\' })[c] ?? '');
}

function list(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/(?<!\\);/)
    .map((x) => unescape(x.replace(/\\;/g, ';')).trim())
    .filter(Boolean);
}

/** The unlocalized keys of the [Desktop Entry] group. */
export function parseDesktopEntry(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const m = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (m && !keys.has(m[1]!)) keys.set(m[1]!, m[2]!);
  }
  return keys;
}

const isTrue = (v: string | undefined) => v?.trim() === 'true';

export async function onPath(cmd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = isAbsolute(cmd) ? [cmd] : (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, cmd));
  for (const c of candidates) {
    if (await access(c, constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * The app an entry describes, or null when it should not be listed: not an application,
 * NoDisplay or Hidden, not meant for this desktop, or its TryExec program is missing.
 */
export async function appFromEntry(id: string, text: string, opts: { desktops: string[]; env: NodeJS.ProcessEnv }): Promise<DesktopApp | null> {
  const k = parseDesktopEntry(text);
  if (k.get('Type') !== 'Application' || isTrue(k.get('NoDisplay')) || isTrue(k.get('Hidden'))) return null;
  const only = list(k.get('OnlyShowIn'));
  if (only.length && !only.some((d) => opts.desktops.includes(d.toLowerCase()))) return null;
  if (list(k.get('NotShowIn')).some((d) => opts.desktops.includes(d.toLowerCase()))) return null;
  const tryExec = k.get('TryExec');
  if (tryExec && !(await onPath(unescape(tryExec), opts.env))) return null;
  const name = cleanName(unescape(k.get('Name') ?? ''));
  if (!name) return null;
  return {
    id,
    name,
    comment: cleanName(unescape(k.get('Comment') ?? k.get('GenericName') ?? '')).slice(0, 64),
    keywords: list(k.get('Keywords')).map(cleanName).filter(Boolean).slice(0, 12),
    categories: list(k.get('Categories')).map(cleanName).filter(Boolean).slice(0, 8),
    terminal: isTrue(k.get('Terminal')),
  };
}

async function desktopFiles(dir: string): Promise<{ id: string; path: string }[]> {
  const out: { id: string; path: string }[] = [];
  const walk = async (d: string, depth: number) => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(p, depth + 1);
      else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.desktop')) out.push({ id: relative(dir, p).split(sep).join('-'), path: p });
    }
  };
  await walk(dir, 0);
  return out;
}

/** Installed apps, sorted by name. Unreadable files and directories are skipped. */
export async function scanApps(opts: { dirs?: string[]; env?: NodeJS.ProcessEnv } = {}): Promise<DesktopApp[]> {
  const env = opts.env ?? process.env;
  const desktops = (env.XDG_CURRENT_DESKTOP ?? 'Hyprland').split(':').map((d) => d.toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  const apps: DesktopApp[] = [];
  for (const dir of opts.dirs ?? applicationDirs(env)) {
    for (const f of await desktopFiles(dir)) {
      // The first directory to have an id decides it, even when that copy hides the app.
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      if (!DESKTOP_ID.test(f.id)) continue;
      const size = await stat(f.path).then((s) => (s.isFile() ? s.size : -1), () => -1);
      if (size < 0 || size > MAX_FILE_BYTES) continue;
      const text = await readFile(f.path, 'utf8').catch(() => null);
      if (text === null) continue;
      const app = await appFromEntry(f.id, text, { desktops, env });
      if (app) apps.push(app);
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The id as the model sees it: without ".desktop". */
export const shortId = (id: string) => id.replace(/\.desktop$/, '');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The one app the model means, by id (with or without .desktop) or by exact name, ignoring
 * case. Several apps with the same name is an ambiguity the model has to resolve by id.
 */
export function findApp(apps: DesktopApp[], want: string): DesktopApp | DesktopApp[] | null {
  const w = norm(want);
  const byId = apps.find((a) => a.id.toLowerCase() === w || shortId(a.id).toLowerCase() === w);
  if (byId) return byId;
  const byName = apps.filter((a) => norm(a.name) === w);
  if (byName.length === 1) return byName[0]!;
  return byName.length ? byName : null;
}

/** Apps whose name, id, description, keywords or categories contain every word of the query. */
export function searchApps(apps: DesktopApp[], query: string): DesktopApp[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return apps;
  return apps.filter((a) => {
    const hay = norm([a.name, shortId(a.id), a.comment, ...a.keywords, ...a.categories].join(' '));
    return words.every((w) => hay.includes(w));
  });
}
