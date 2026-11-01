/**
 * L1: the morning review. Once a day, after `review.at`, code lists big files in the allowed
 * folders that haven't been opened or changed for a long time, and windows that have been
 * open but unused for hours. The local model picks which to suggest and says why in a few
 * words; without it, code picks the biggest. One card shows them, each row with buttons.
 *
 * Every button is the user's own click, checked against the row's hash: Move to Trash (files,
 * when turned on) only if the file is still inside the folders and exactly as it was; Close
 * (windows) only if it is still the same window, and only the way its close button would;
 * Keep, so it isn't suggested again. Paths and window addresses stay in core (cleanup_cards),
 * the model never sees them as anything it can act on, and every click is audited.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AssistantConfig, ChatItem, CleanupApp, CleanupFile } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { FileCatalog } from '../files/catalog.js';
import type { FileRoots } from '../files/roots.js';
import { localDate } from '../memory/nightly.js';
import { ModelError } from '../model.js';
import type { Store } from '../store.js';
import { bytesText, type ProcessInfo, treeRss } from './resources.js';
import { moveToTrash } from './trash.js';
import type { WindowTracker } from './windows.js';
import { type AppCandidate, type FileCandidate, type LocalModel, reviewPicks } from './worker.js';

type CleanupItem = Extract<ChatItem, { kind: 'cleanup' }>;

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A kept window's program isn't suggested again for this long. */
const KEEP_APP_MS = 7 * DAY;
const MAX_FILE_CANDIDATES = 20;
const MAX_APP_CANDIDATES = 15;

interface FileSpec {
  n: number;
  path: string;
  bytes: number;
  mtimeMs: number;
}
interface AppSpec {
  n: number;
  address: string;
  className: string;
  pid: number;
}
interface CardSpec {
  files: FileSpec[];
  apps: AppSpec[];
}

export interface ReviewOptions {
  config: AssistantConfig['review'];
  timeZone: string;
  store: Store;
  audit: AuditLog;
  /** Null without [models.local]: code picks and words the suggestions. */
  model: LocalModel | null;
  isPaused: () => boolean;
  /** Files come from the F2 index; without it the review only looks at windows. */
  roots?: FileRoots | undefined;
  catalog?: Pick<FileCatalog, 'largest'> | undefined;
  /** Windows come from Hyprland; without it the review only looks at files. */
  windows?: Pick<WindowTracker, 'poll' | 'close'> | undefined;
  processes: () => Promise<ProcessInfo[]>;
  trashDir: string;
  post: (item: ChatItem) => void;
  patch: (item: ChatItem) => void;
  /** After a file went to the Trash, so the index drops it. */
  onTrashed?: () => void;
  now?: () => number;
  newId?: () => string;
}

export type ReviewOutcome = 'not_due' | 'done_already' | 'paused' | 'nothing' | 'posted';

const rowHash = (parts: (string | number)[]) => createHash('sha256').update(parts.join('\n')).digest('hex');

export function fileRowHash(f: Omit<FileSpec, 'n'>): string {
  return rowHash(['file', f.path, f.bytes, f.mtimeMs]);
}

export function appRowHash(a: Omit<AppSpec, 'n'>): string {
  return rowHash(['app', a.address, a.className, a.pid]);
}

export function ago(ms: number): string {
  const d = Math.floor(ms / DAY);
  if (d >= 60) return `${Math.floor(d / 30)} months`;
  if (d >= 2) return `${d} days`;
  const h = Math.max(1, Math.floor(ms / HOUR));
  return h >= 24 ? '1 day' : `${h} hour${h === 1 ? '' : 's'}`;
}

function minutesOfDay(at: number, timeZone: string): number {
  const [h = 0, m = 0] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at)).split(':').map(Number);
  return h * 60 + m;
}

export class MorningReview {
  private running = false;
  private readonly now: () => number;

  constructor(private readonly o: ReviewOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Posts today's review if it is due. The timer calls it every few minutes. */
  async runIfDue(): Promise<ReviewOutcome> {
    const c = this.o.config;
    if (!c.enabled) return 'not_due';
    const now = this.now();
    const [h = 0, m = 0] = c.at.split(':').map(Number);
    if (minutesOfDay(now, this.o.timeZone) < h * 60 + m) return 'not_due';
    const today = localDate(now, this.o.timeZone);
    if (this.o.store.getSetting('review.last') === today || this.running) return 'done_already';
    // Paused means no model calls; the review waits for /resume rather than going out without it.
    if (this.o.isPaused()) return 'paused';
    const outcome = await this.run();
    this.o.store.setSetting('review.last', today);
    return outcome;
  }

  /** Builds and posts a review now (also /checkup). */
  async run(): Promise<'nothing' | 'posted'> {
    if (this.running) return 'nothing';
    this.running = true;
    try {
      return await this.build();
    } finally {
      this.running = false;
    }
  }

  private kept(key: string, since = 0): boolean {
    const r = this.o.store.db.prepare('SELECT at FROM cleanup_keep WHERE key = ?').get(key) as { at: number } | undefined;
    return !!r && r.at >= since;
  }

  private async fileCandidates(): Promise<(FileSpec & FileCandidate & { name: string; folder: string; lastUsedText: string })[]> {
    const { roots, catalog } = this.o;
    if (!roots || !catalog) return [];
    const c = this.o.config;
    const now = this.now();
    const out = [];
    for (const f of catalog.largest(c.minFileMb * 1024 * 1024, MAX_FILE_CANDIDATES * 3)) {
      if (out.length >= MAX_FILE_CANDIDATES) break;
      // Still inside the folders, not hidden, and a file: the index may be behind the disk.
      const entry = await roots.resolve(f.path, 'file').catch(() => null);
      if (!entry || entry.path !== f.path) continue;
      const st = await stat(f.path).catch(() => null);
      if (!st) continue;
      // "Opened or changed", from access times the index saw apart from its own reads (relatime
      // moves an access time at most daily); without that, the last change.
      const lastUsed = Math.max(f.usedMs ?? 0, st.mtimeMs);
      if (now - lastUsed < c.unusedDays * DAY) continue;
      if (this.kept(`file:${f.path}:${st.size}`)) continue;
      const display = roots.display(f.path);
      const lastUsedText = `not used for ${ago(now - lastUsed)}`;
      out.push({
        n: out.length + 1,
        id: `f${out.length + 1}`,
        path: f.path,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        display,
        name: entry.name,
        folder: roots.display(f.folder),
        size: bytesText(st.size),
        lastUsed: lastUsedText,
        lastUsedText,
      });
    }
    return out;
  }

  private async appCandidates(): Promise<(AppSpec & AppCandidate & { rss: number })[]> {
    const w = this.o.windows;
    if (!w) return [];
    const now = this.now();
    const open = await w.poll().catch(() => []);
    const procs = await this.o.processes().catch(() => []);
    return open
      .filter((x) => now - x.lastUsedAt >= this.o.config.idleAppHours * HOUR && !this.kept(`app:${x.className}`, now - KEEP_APP_MS))
      .map((x) => ({ x, rss: x.pid > 0 ? treeRss(x.pid, procs) : 0 }))
      .sort((a, b) => b.rss - a.rss)
      .slice(0, MAX_APP_CANDIDATES)
      .map(({ x, rss }, i) => ({
        n: i + 1,
        id: `a${i + 1}`,
        address: x.address,
        className: x.className,
        pid: x.pid,
        name: x.className,
        title: x.title,
        memory: rss ? `${bytesText(rss)} of memory` : 'memory unknown',
        idle: `not used for ${ago(now - x.lastUsedAt)}`,
        rss,
      }));
  }

  private async build(): Promise<'nothing' | 'posted'> {
    const c = this.o.config;
    const files = c.maxFiles > 0 ? await this.fileCandidates() : [];
    const apps = c.maxApps > 0 ? await this.appCandidates() : [];
    if (!files.length && !apps.length) {
      this.o.audit.append({ kind: 'assistant', event: 'review', files: 0, apps: 0 });
      return 'nothing';
    }
    let by: CleanupItem['by'] = 'code';
    let intro = '';
    let fileReasons = new Map<string, string>();
    let appReasons = new Map<string, string>();
    if (this.o.model) {
      try {
        const picks = await reviewPicks(this.o.model, files, apps, { files: c.maxFiles, apps: c.maxApps });
        ({ intro } = picks);
        fileReasons = picks.files;
        appReasons = picks.apps;
        by = 'local';
      } catch (err) {
        this.o.audit.append({ kind: 'assistant', event: 'review_model_failed', error: err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200) });
      }
    }
    if (by === 'code') {
      // Biggest files first, windows using the most memory first (they are already sorted).
      for (const f of files.slice(0, c.maxFiles)) fileReasons.set(f.id, `Big and ${f.lastUsedText}.`);
      for (const a of apps.slice(0, c.maxApps)) appReasons.set(a.id, `Open but ${a.idle}.`);
    }
    const pickedFiles = files.filter((f) => fileReasons.has(f.id));
    const pickedApps = apps.filter((a) => appReasons.has(a.id));
    this.o.audit.append({ kind: 'assistant', event: 'review', by, candidates: { files: files.length, apps: apps.length }, picked: { files: pickedFiles.length, apps: pickedApps.length } });
    if (!pickedFiles.length && !pickedApps.length) return 'nothing';

    const freed = pickedFiles.reduce((a, f) => a + f.bytes, 0);
    const item: CleanupItem = {
      kind: 'cleanup',
      id: this.o.newId?.() ?? randomUUID(),
      intro: intro || (pickedFiles.length ? `A little tidying could free ${bytesText(freed)} today.` : 'A few windows have been open a while without being used.'),
      by,
      files: pickedFiles.map((f, i): CleanupFile => ({
        n: i + 1,
        name: f.name,
        folder: f.folder,
        size: f.size,
        lastUsed: f.lastUsedText,
        reason: fileReasons.get(f.id)!,
        hash: fileRowHash(f),
        state: 'pending',
      })),
      apps: pickedApps.map((a, i): CleanupApp => ({
        n: i + 1,
        name: a.name,
        title: a.title,
        memory: a.memory,
        idle: a.idle,
        reason: appReasons.get(a.id)!,
        hash: appRowHash(a),
        state: 'pending',
      })),
      trash: c.trashButton,
      at: this.now(),
    };
    const spec: CardSpec = {
      files: pickedFiles.map((f, i) => ({ n: i + 1, path: f.path, bytes: f.bytes, mtimeMs: f.mtimeMs })),
      apps: pickedApps.map((a, i) => ({ n: i + 1, address: a.address, className: a.className, pid: a.pid })),
    };
    this.o.store.db.prepare('INSERT INTO cleanup_cards (id, spec, created_at) VALUES (?, ?, ?)').run(item.id, JSON.stringify(spec), item.at);
    this.o.post(item);
    return 'posted';
  }

  /**
   * A click on one row. Only reached from the UI; checks the row's hash and state, and that the
   * file or window is still the one the card showed, before anything happens.
   */
  async act(id: string, list: 'file' | 'app', n: number, action: 'trash' | 'close' | 'keep', hash: string): Promise<void> {
    const item = this.o.store.getItem(id);
    if (item?.kind !== 'cleanup') return;
    const specRow = this.o.store.db.prepare('SELECT spec FROM cleanup_cards WHERE id = ?').get(id) as { spec: string } | undefined;
    if (!specRow) return;
    const spec = JSON.parse(specRow.spec) as CardSpec;
    if (list === 'file') {
      const row = item.files.find((r) => r.n === n);
      const s = spec.files.find((r) => r.n === n);
      if (!row || !s || row.hash !== hash || fileRowHash(s) !== hash || (row.state !== 'pending' && row.state !== 'failed')) return;
      if (action === 'close' || (action === 'trash' && !item.trash)) return;
      this.audit(id, list, n, action, 'clicked');
      if (action === 'keep') {
        this.o.store.db.prepare('INSERT INTO cleanup_keep (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at').run(`file:${s.path}:${s.bytes}`, this.now());
        return this.setFile(item, n, { state: 'kept', result: "Kept. I won't suggest it again unless it changes." });
      }
      this.setFile(item, n, { state: 'running' });
      try {
        const entry = await this.o.roots?.resolve(s.path, 'file');
        if (!entry || entry.path !== s.path || entry.bytes !== s.bytes || entry.mtimeMs !== s.mtimeMs) {
          this.audit(id, list, n, action, 'changed');
          return this.setFile(this.current(id), n, { state: 'failed', result: 'It changed or moved since the card was made, so I left it alone.' });
        }
        await moveToTrash(s.path, { dir: this.o.trashDir, timeZone: this.o.timeZone, now: this.now() });
        this.audit(id, list, n, action, 'done');
        this.o.onTrashed?.();
        return this.setFile(this.current(id), n, { state: 'trashed', result: 'Moved to the Trash. You can restore it from the Trash in the file manager.' });
      } catch (err) {
        this.audit(id, list, n, action, 'failed');
        return this.setFile(this.current(id), n, { state: 'failed', result: `I couldn't move it to the Trash: ${(err as Error).message.slice(0, 200)}` });
      }
    }
    const row = item.apps.find((r) => r.n === n);
    const s = spec.apps.find((r) => r.n === n);
    if (!row || !s || row.hash !== hash || appRowHash(s) !== hash || (row.state !== 'pending' && row.state !== 'failed')) return;
    if (action === 'trash') return;
    this.audit(id, list, n, action, 'clicked');
    if (action === 'keep') {
      this.o.store.db.prepare('INSERT INTO cleanup_keep (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at').run(`app:${s.className}`, this.now());
      return this.setApp(item, n, { state: 'kept', result: "Kept open. I won't suggest it for a week." });
    }
    const w = this.o.windows;
    if (!w) return;
    this.setApp(item, n, { state: 'running' });
    try {
      const r = await w.close(s);
      this.audit(id, list, n, action, r);
      this.setApp(this.current(id), n, r === 'closed' ? { state: 'closed', result: 'Asked it to close. If it has unsaved work, it will ask you first.' } : { state: 'closed', result: 'It was already closed.' });
    } catch (err) {
      this.audit(id, list, n, action, 'failed');
      this.setApp(this.current(id), n, { state: 'failed', result: `I couldn't close it: ${(err as Error).message.slice(0, 200)}` });
    }
  }

  private current(id: string): CleanupItem {
    const item = this.o.store.getItem(id);
    if (item?.kind !== 'cleanup') throw new Error('cleanup card vanished');
    return item;
  }

  private setFile(item: CleanupItem, n: number, patch: Pick<CleanupFile, 'state'> & { result?: string }): void {
    const next: CleanupItem = { ...item, files: item.files.map((r) => (r.n === n ? { ...r, ...patch, ...(patch.result ? {} : { result: undefined }) } : r)).map(stripUndefined) };
    this.o.store.saveItem(next);
    this.o.patch(next);
  }

  private setApp(item: CleanupItem, n: number, patch: Pick<CleanupApp, 'state'> & { result?: string }): void {
    const next: CleanupItem = { ...item, apps: item.apps.map((r) => (r.n === n ? { ...r, ...patch, ...(patch.result ? {} : { result: undefined }) } : r)).map(stripUndefined) };
    this.o.store.saveItem(next);
    this.o.patch(next);
  }

  private audit(id: string, list: string, n: number, action: string, outcome: string): void {
    // Row numbers only: file paths and window titles stay out of the audit log.
    this.o.audit.append({ kind: 'assistant', event: 'cleanup_click', itemId: id, list, n, action, outcome });
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
