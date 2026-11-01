/**
 * Keeps the file index current (F2). A scan walks the allowed folders (no links followed,
 * hidden files skipped, a limit on how many files) comparing size and modification time
 * with the index; it runs at start, a few seconds after the folders change (fs.watch), after
 * the chat's own file changes, every half hour, and on /reindex. Then one file at a time,
 * newest first, its facts are read and, while today's summary allowance and the daily cost
 * cap last, the no-tools worker describes it.
 */
import { type FSWatcher, watch } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ModelRole } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { ModelError } from '../model.js';
import { type Store, startOfDay } from '../store.js';
import type { CatalogStats, FileCatalog, IndexedFile, SeenFile } from './catalog.js';
import type { FactReader, FileReading } from './facts.js';
import type { FileRoots, FileKind } from './roots.js';
import { type SummaryModel, summarizeFile } from './summarizer.js';

const SCAN_DEPTH = 10;
const RESCAN_MS = 30 * 60_000;
const DEBOUNCE_MS = 3000;
const BATCH = 20;
const MAX_SUMMARY_ATTEMPTS = 3;
/** After the model refuses (paused, cost cap, no key), wait this long before asking again. */
const MODEL_BACKOFF_MS = 30 * 60_000;

const EXT_KIND: Record<string, FileKind> = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.docx': 'word',
  '.xlsx': 'sheet',
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'text',
  '.log': 'text',
  '.json': 'text',
};

/** A first guess from the name; the facts step replaces it with what the bytes say. */
export function kindByName(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && EXT_KIND[name.slice(dot).toLowerCase()]) || 'other';
}

export interface FileIndexerOptions {
  roots: Pick<FileRoots, 'realRoots' | 'display'>;
  catalog: FileCatalog;
  facts: Pick<FactReader, 'read'>;
  /** The summary worker's model; without it, files get facts only. */
  model?: SummaryModel | undefined;
  /** L1: 'local' when file summaries run on the local model. Default 'triage'. */
  summaryRole?: ModelRole | undefined;
  store: Store;
  audit: AuditLog;
  timeZone: string;
  summariesPerDay: number;
  maxFiles: number;
  /** Watch the folders for changes (off in tests). */
  watch?: boolean;
  clock?: () => number;
}

export interface IndexStatus extends CatalogStats {
  scanning: boolean;
  summariesToday: number;
  summariesPerDay: number;
  truncated: boolean;
}

export class FileIndexer {
  private readonly clock: () => number;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private working: Promise<void> | null = null;
  private modelBlockedUntil = 0;
  private truncated = false;
  private lastScan = 0;
  private stopped = false;

  constructor(private readonly o: FileIndexerOptions) {
    this.clock = o.clock ?? Date.now;
  }

  async start(): Promise<void> {
    await this.scan();
    if (this.o.watch !== false) {
      for (const root of await this.o.roots.realRoots()) {
        try {
          const w = watch(root, { recursive: true, persistent: false }, () => this.soon());
          w.on('error', () => w.close());
          this.watchers.push(w);
        } catch {
          // No recursive watching here: the half-hourly scan still catches up.
        }
      }
    }
    this.interval = setInterval(() => void this.scan(), RESCAN_MS);
    this.interval.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }

  /** A scan a few seconds from now; changes in a burst share one. */
  soon(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(), DEBOUNCE_MS);
    this.timer.unref();
  }

  /** The chat renamed a file: keep what is known about it (tags included) under the new name. */
  async renamed(from: string, to: string): Promise<void> {
    const st = await lstat(to).catch(() => null);
    if (st?.isFile()) this.o.catalog.move(from, this.seenFile(to, st), this.clock());
    this.soon();
  }

  private seenFile(path: string, st: { size: number; mtimeMs: number; birthtimeMs: number; atimeMs?: number }): SeenFile {
    const name = basename(path);
    return { path, name, folder: this.o.roots.display(dirname(path)), kind: kindByName(name), bytes: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, atimeMs: st.atimeMs };
  }

  /** Walks the folders; concurrent calls share a scan and one more follows if asked meanwhile. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    // .finally() runs after the assignment even when the work finishes at once.
    const p = this.scanLoop().finally(() => {
      if (this.scanning === p) this.scanning = null;
      void this.work();
    });
    this.scanning = p;
    return p;
  }

  private async scanLoop(): Promise<void> {
    do {
      this.rescan = false;
      await this.scanOnce();
    } while (this.rescan && !this.stopped);
  }

  private async scanOnce(): Promise<void> {
    // Each scan's mark is later than the last one's, even within one millisecond.
    const started = (this.lastScan = Math.max(this.clock(), this.lastScan + 1));
    const t0 = Date.now();
    const c = { files: 0, new: 0, changed: 0, moved: 0, gone: 0 };
    const fresh: SeenFile[] = [];
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const handle = await opendir(dir).catch(() => null);
      if (!handle) return;
      for await (const e of handle) {
        if (this.stopped) return;
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < SCAN_DEPTH) await walk(p, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        if (c.files >= this.o.maxFiles) {
          truncated = true;
          return;
        }
        const st = await lstat(p).catch(() => null);
        if (!st?.isFile()) continue;
        c.files++;
        const f = this.seenFile(p, st);
        const how = this.o.catalog.seen(f, started);
        if (how === 'new') {
          c.new++;
          fresh.push(f);
        } else if (how === 'changed') c.changed++;
      }
    };
    const roots = await this.o.roots.realRoots();
    for (const r of roots) await walk(r, 1);
    if (this.stopped) return;
    // A file that vanished while one of the same size and time appeared was moved outside the chat.
    // With the file limit reached, unseen rows may just be beyond it: they stay.
    if (!truncated) {
      for (const u of this.o.catalog.unseen(started)) {
        const twins = fresh.filter((f) => f.bytes === u.bytes && f.mtimeMs === u.mtimeMs);
        if (twins.length === 1 && this.o.catalog.adopt(u.path, twins[0]!.path)) {
          c.moved++;
          fresh.splice(fresh.indexOf(twins[0]!), 1);
        }
      }
      c.gone = this.o.catalog.dropUnseen(started).length;
    }
    this.truncated = truncated;
    if (c.new || c.changed || c.moved || c.gone || truncated) this.o.audit.append({ kind: 'files', event: 'indexed', ...c, truncated, ms: Date.now() - t0 });
  }

  private summariesToday(): { key: string; n: number } {
    const key = `file_summaries:${startOfDay(this.clock(), this.o.timeZone)}`;
    return { key, n: Number(this.o.store.getSetting(key) ?? 0) };
  }

  private mayDescribe(): boolean {
    return !!this.o.model && this.clock() >= this.modelBlockedUntil && this.summariesToday().n < this.o.summariesPerDay;
  }

  /** Reads facts and writes summaries until nothing is left that may be done now. */
  work(): Promise<void> {
    if (this.working) return this.working;
    const p = this.workLoop().finally(() => {
      if (this.working === p) this.working = null;
    });
    this.working = p;
    return p;
  }

  private async workLoop(): Promise<void> {
    while (!this.stopped) {
      const batch = [...this.o.catalog.needingFacts(BATCH), ...(this.mayDescribe() ? this.o.catalog.needingSummary(BATCH) : [])];
      if (!batch.length) return;
      for (const f of batch) {
        if (this.stopped) return;
        await this.one(f);
      }
    }
  }

  private async one(f: IndexedFile): Promise<void> {
    let reading: FileReading;
    try {
      reading = await this.o.facts.read(f);
    } catch (err) {
      this.o.catalog.setFacts(f, f.kind, null, 'failed');
      this.o.catalog.setSummary(f, null, 'skipped');
      this.o.audit.append({ kind: 'files', event: 'facts_failed', path: f.path, error: (err as Error).message.slice(0, 200) });
      return;
    }
    this.o.catalog.setFacts(f, reading.kind, reading.facts, 'done');
    const current = this.o.catalog.get(f.path);
    if (!current || current.summary) return;
    if (!reading.excerpt) {
      this.o.catalog.setSummary(f, null, 'skipped');
      return;
    }
    if (!this.mayDescribe()) return;
    const day = this.summariesToday();
    this.o.store.setSetting(day.key, String(day.n + 1));
    try {
      const s = await summarizeFile(this.o.model!, { display: this.o.roots.display(f.path), kind: reading.kind, facts: reading.facts, excerpt: reading.excerpt }, this.o.summaryRole);
      this.o.catalog.setSummary(f, s, 'done');
      this.o.audit.append({ kind: 'files', event: 'summarized', path: f.path, keywords: s.keywords.length });
    } catch (err) {
      if (err instanceof ModelError && ['paused', 'cost_cap', 'key_missing', 'auth', 'credits', 'forbidden', 'rate_limited', 'timeout', 'unavailable', 'network', 'aborted'].includes(err.kind)) {
        // Not the file's fault: try it again later, without counting it.
        this.o.store.setSetting(day.key, String(day.n));
        this.modelBlockedUntil = this.clock() + (['rate_limited', 'timeout', 'unavailable', 'network'].includes(err.kind) ? 60_000 : MODEL_BACKOFF_MS);
        return;
      }
      const giveUp = this.o.catalog.attempts(f.path) + 1 >= MAX_SUMMARY_ATTEMPTS;
      this.o.catalog.setSummary(f, null, giveUp ? 'failed' : 'pending');
      this.o.audit.append({ kind: 'files', event: 'summary_failed', path: f.path, error: (err as Error).message.slice(0, 200) });
    }
  }

  /** /reindex: facts again for every file, failed summaries retried, then a full scan. */
  async reindex(): Promise<void> {
    this.o.catalog.resetForReindex();
    this.modelBlockedUntil = 0;
    await this.scan();
  }

  status(): IndexStatus {
    return { ...this.o.catalog.stats(), scanning: !!this.scanning || !!this.working, summariesToday: this.summariesToday().n, summariesPerDay: this.o.summariesPerDay, truncated: this.truncated };
  }
}

/** One line for /reindex. */
export function indexStatusText(s: IndexStatus): string {
  const read = s.files - s.factsPending;
  return [
    `${s.files} file${s.files === 1 ? '' : 's'} in the index, ${read} read${s.factsPending ? `, ${s.factsPending} still to read` : ''}.`,
    `${s.summarized} described${s.summaryPending ? `, ${s.summaryPending} waiting` : ''}; ${s.summariesToday} of ${s.summariesPerDay} descriptions used today.`,
    s.truncated ? 'The folders hold more files than [files] maxIndexedFiles; the rest are left out.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
