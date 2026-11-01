/**
 * The file index (F2): one row per file in the allowed folders with its facts (type, size,
 * dates, pages, sheets, title), an AI summary and keywords, and the user's own tags, plus a
 * full-text index over them for files_search. It is a cache of what is on disk: the scanner
 * keeps it current and /reindex rebuilds it; only tags exist nowhere else.
 *
 * Summaries are model text written from files that can come from anyone, so whatever the
 * index returns is still untrusted: files_search wraps it like the files themselves.
 */
import type { Store } from '../store.js';
import type { FileKind } from './roots.js';

export interface FileFacts {
  title?: string | undefined;
  author?: string | undefined;
  pages?: number | undefined;
  sheets?: string[] | undefined;
  width?: number | undefined;
  height?: number | undefined;
  words?: number | undefined;
}

export interface IndexedFile {
  path: string;
  name: string;
  folder: string;
  kind: FileKind;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
  facts: FileFacts | null;
  summary: string | null;
  keywords: string[];
  tags: string[];
}

export type StepState = 'pending' | 'done' | 'failed' | 'skipped';

interface Row {
  path: string;
  name: string;
  folder: string;
  kind: string;
  bytes: number;
  mtime_ms: number;
  birthtime_ms: number;
  facts: string | null;
  facts_state: StepState;
  summary: string | null;
  keywords: string | null;
  summary_state: StepState;
  summary_attempts: number;
  tags: string;
  seen_at: number;
}

export interface SeenFile {
  path: string;
  name: string;
  folder: string;
  kind: FileKind;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface SearchQuery {
  query?: string | undefined;
  kinds?: FileKind[] | undefined;
  /** Only files under this real folder path. */
  folder?: string | undefined;
  modifiedAfter?: number | undefined;
  modifiedBefore?: number | undefined;
  limit?: number | undefined;
}

export interface CatalogStats {
  files: number;
  factsPending: number;
  summaryPending: number;
  summarized: number;
}

/** Words of a query, for FTS5: letters and digits only, so nothing in it is FTS syntax. */
export function queryWords(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 0))].slice(0, 8);
}

const splitList = (s: string | null) => (s ? s.split('\n').filter(Boolean) : []);

export class FileCatalog {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  private row(path: string): Row | null {
    return (this.db.prepare('SELECT * FROM file_index WHERE path = ?').get(path) as Row | undefined) ?? null;
  }

  private file(r: Row): IndexedFile {
    return {
      path: r.path,
      name: r.name,
      folder: r.folder,
      kind: r.kind as FileKind,
      bytes: r.bytes,
      mtimeMs: r.mtime_ms,
      birthtimeMs: r.birthtime_ms,
      facts: r.facts ? (JSON.parse(r.facts) as FileFacts) : null,
      summary: r.summary,
      keywords: splitList(r.keywords),
      tags: splitList(r.tags),
    };
  }

  get(path: string): IndexedFile | null {
    const r = this.row(path);
    return r ? this.file(r) : null;
  }

  /** Brings a file's full-text row in line with its index row. */
  private syncFts(path: string): void {
    this.db.prepare('DELETE FROM file_fts WHERE path = ?').run(path);
    const r = this.row(path);
    if (!r) return;
    const f = this.file(r);
    const details = [f.kind, f.facts?.author, ...(f.facts?.sheets ?? [])].filter(Boolean).join(' ');
    this.db
      .prepare('INSERT INTO file_fts (path, name, folder, title, keywords, tags, summary, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.path, f.name, f.folder, f.facts?.title ?? '', f.keywords.join(' '), f.tags.join(' '), f.summary ?? '', details);
  }

  /**
   * A file the scanner saw. New and changed files (by size and modification time) need their
   * facts and summary again; tags stay.
   */
  seen(f: SeenFile, now: number): 'new' | 'changed' | 'same' {
    const r = this.row(f.path);
    if (r && r.bytes === f.bytes && r.mtime_ms === f.mtimeMs) {
      this.db.prepare('UPDATE file_index SET seen_at = ? WHERE path = ?').run(now, f.path);
      return 'same';
    }
    this.db
      .prepare(
        `INSERT INTO file_index (path, name, folder, kind, bytes, mtime_ms, birthtime_ms, facts, facts_state, summary, keywords, summary_state, summary_attempts, seen_at)
         VALUES (@path, @name, @folder, @kind, @bytes, @mtimeMs, @birthtimeMs, NULL, 'pending', NULL, NULL, 'pending', 0, @now)
         ON CONFLICT(path) DO UPDATE SET name = @name, folder = @folder, kind = @kind, bytes = @bytes, mtime_ms = @mtimeMs, birthtime_ms = @birthtimeMs,
           facts = NULL, facts_state = 'pending', summary = NULL, keywords = NULL, summary_state = 'pending', summary_attempts = 0, seen_at = @now`,
      )
      .run({ ...f, now });
    this.syncFts(f.path);
    return r ? 'changed' : 'new';
  }

  /** Files gone from disk: rows not seen by a scan that started at `scanStart`. */
  dropUnseen(scanStart: number): string[] {
    const gone = (this.db.prepare('SELECT path FROM file_index WHERE seen_at < ?').all(scanStart) as { path: string }[]).map((r) => r.path);
    this.removeAll(gone);
    return gone;
  }

  remove(path: string): void {
    this.removeAll([path]);
  }

  private removeAll(paths: string[]): void {
    const del = this.db.prepare('DELETE FROM file_index WHERE path = ?');
    const delFts = this.db.prepare('DELETE FROM file_fts WHERE path = ?');
    this.db.transaction(() => {
      for (const p of paths) {
        del.run(p);
        delFts.run(p);
      }
    })();
  }

  /** A rename keeps what is known about the file, its tags included. */
  move(from: string, to: SeenFile, now: number): boolean {
    const r = this.row(from);
    if (!r || this.row(to.path)) return false;
    this.db
      .prepare('UPDATE file_index SET path = ?, name = ?, folder = ?, kind = ?, bytes = ?, mtime_ms = ?, birthtime_ms = ?, seen_at = ? WHERE path = ?')
      .run(to.path, to.name, to.folder, to.kind, to.bytes, to.mtimeMs, to.birthtimeMs, now, from);
    this.db.prepare('DELETE FROM file_fts WHERE path = ?').run(from);
    this.syncFts(to.path);
    return true;
  }

  /**
   * A file moved outside the chat: the scan found it under a new path (now a new row) and
   * the old row unseen. The new row takes over what was known, tags included.
   */
  adopt(from: string, to: string): boolean {
    const r = this.row(from);
    if (!r || !this.row(to)) return false;
    this.db
      .prepare('UPDATE file_index SET facts = ?, facts_state = ?, summary = ?, keywords = ?, summary_state = ?, summary_attempts = ?, tags = ? WHERE path = ?')
      .run(r.facts, r.facts_state, r.summary, r.keywords, r.summary_state, r.summary_attempts, r.tags, to);
    this.remove(from);
    this.syncFts(to);
    return true;
  }

  /** Rows that disappeared in this scan, to match against new rows as moves. */
  unseen(scanStart: number): IndexedFile[] {
    return (this.db.prepare('SELECT * FROM file_index WHERE seen_at < ?').all(scanStart) as Row[]).map((r) => this.file(r));
  }

  needingFacts(limit: number): IndexedFile[] {
    return (this.db.prepare("SELECT * FROM file_index WHERE facts_state = 'pending' ORDER BY mtime_ms DESC LIMIT ?").all(limit) as Row[]).map((r) => this.file(r));
  }

  needingSummary(limit: number): IndexedFile[] {
    return (this.db.prepare("SELECT * FROM file_index WHERE facts_state = 'done' AND summary_state = 'pending' ORDER BY mtime_ms DESC LIMIT ?").all(limit) as Row[]).map((r) =>
      this.file(r),
    );
  }

  /** Stored only if the file is still the one the facts were read from. */
  setFacts(f: Pick<IndexedFile, 'path' | 'bytes' | 'mtimeMs'>, kind: FileKind, facts: FileFacts | null, state: 'done' | 'failed'): boolean {
    const r = this.db
      .prepare('UPDATE file_index SET kind = ?, facts = ?, facts_state = ? WHERE path = ? AND bytes = ? AND mtime_ms = ?')
      .run(kind, facts ? JSON.stringify(facts) : null, state, f.path, f.bytes, f.mtimeMs);
    if (r.changes !== 1) return false;
    this.syncFts(f.path);
    return true;
  }

  setSummary(f: Pick<IndexedFile, 'path' | 'bytes' | 'mtimeMs'>, s: { summary: string; keywords: string[] } | null, state: 'done' | 'failed' | 'skipped' | 'pending'): boolean {
    const r = this.db
      .prepare(
        `UPDATE file_index SET summary = COALESCE(?, summary), keywords = COALESCE(?, keywords), summary_state = ?,
           summary_attempts = summary_attempts + ? WHERE path = ? AND bytes = ? AND mtime_ms = ?`,
      )
      .run(s?.summary ?? null, s ? s.keywords.join('\n') : null, state, state === 'failed' || state === 'pending' ? 1 : 0, f.path, f.bytes, f.mtimeMs);
    if (r.changes !== 1) return false;
    this.syncFts(f.path);
    return true;
  }

  attempts(path: string): number {
    return this.row(path)?.summary_attempts ?? 0;
  }

  setTags(path: string, tags: string[]): boolean {
    const r = this.db.prepare('UPDATE file_index SET tags = ? WHERE path = ?').run(tags.join('\n'), path);
    if (r.changes !== 1) return false;
    this.syncFts(path);
    return true;
  }

  /** /reindex: read every file's facts again and retry failed summaries; summaries of unchanged files stay. */
  resetForReindex(): void {
    this.db.prepare("UPDATE file_index SET facts_state = 'pending'").run();
    this.db.prepare("UPDATE file_index SET summary_state = 'pending', summary_attempts = 0 WHERE summary_state = 'failed'").run();
  }

  stats(): CatalogStats {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: n('SELECT COUNT(*) AS n FROM file_index'),
      factsPending: n("SELECT COUNT(*) AS n FROM file_index WHERE facts_state = 'pending'"),
      summaryPending: n("SELECT COUNT(*) AS n FROM file_index WHERE summary_state = 'pending'"),
      summarized: n("SELECT COUNT(*) AS n FROM file_index WHERE summary_state = 'done'"),
    };
  }

  /**
   * Files matching all the words (as word prefixes) in their name, folder, title, keywords,
   * tags, summary or details, best first; or, with no words, the newest files matching the
   * filters. When all the words together find nothing, any of them will do.
   */
  search(q: SearchQuery): { files: IndexedFile[]; loose: boolean } {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.kinds?.length) {
      where.push(`i.kind IN (${q.kinds.map(() => '?').join(',')})`);
      params.push(...q.kinds);
    }
    if (q.folder) {
      const prefix = q.folder.endsWith('/') ? q.folder : `${q.folder}/`;
      where.push('substr(i.path, 1, ?) = ?');
      params.push(prefix.length, prefix);
    }
    if (q.modifiedAfter !== undefined) {
      where.push('i.mtime_ms >= ?');
      params.push(q.modifiedAfter);
    }
    if (q.modifiedBefore !== undefined) {
      where.push('i.mtime_ms < ?');
      params.push(q.modifiedBefore);
    }
    const words = queryWords(q.query ?? '');
    if (!words.length) {
      const rows = this.db.prepare(`SELECT i.* FROM file_index i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.mtime_ms DESC LIMIT ?`).all(...params, limit) as Row[];
      return { files: rows.map((r) => this.file(r)), loose: false };
    }
    const run = (match: string) =>
      this.db
        .prepare(
          `SELECT i.* FROM file_fts f JOIN file_index i ON i.path = f.path WHERE file_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
           ORDER BY bm25(file_fts, 0, 10, 2, 6, 4, 8, 2, 3), i.mtime_ms DESC LIMIT ?`,
        )
        .all(match, ...params, limit) as Row[];
    const terms = words.map((w) => `"${w}"*`);
    const all = run(terms.join(' AND '));
    if (all.length || words.length === 1) return { files: all.map((r) => this.file(r)), loose: false };
    return { files: run(terms.join(' OR ')).map((r) => this.file(r)), loose: true };
  }
}
