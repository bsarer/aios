/**
 * The file index (F2): one row per file in the allowed folders with its facts (type, size,
 * dates, pages, sheets, title), an AI summary and keywords, and the user's own tags, plus a
 * full-text index over them for files_search. It is a cache of what is on disk: the scanner
 * keeps it current and /reindex rebuilds it; only tags exist nowhere else.
 *
 * Summaries are model text written from files that can come from anyone, so whatever the
 * index returns is still untrusted: files_search wraps it like the files themselves.
 *
 * F3: the full-text row also holds the file's text (`body`, stored only there), and
 * `file_vectors` one meaning vector per file from the local embedding model, kept in memory
 * too for search by meaning.
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
  /**
   * L1: when the file was last opened or changed, as far as access times tell, not counting the
   * indexer's own read (which moves the access time too). Null for rows from before L1.
   */
  usedMs: number | null;
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
  used_ms: number | null;
  read_at: number | null;
  vector_state: StepState;
}

export interface SeenFile {
  path: string;
  name: string;
  folder: string;
  kind: FileKind;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
  /** L1: the access time the scan saw. */
  atimeMs?: number | undefined;
}

/** An access time this soon after the indexer read the file is the indexer's own. */
const OWN_READ_MS = 60_000;

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
  /** F3: files with a meaning vector, and waiting for one. */
  embedded: number;
  vectorPending: number;
}

/** F3: where a file matched a search, for the "why it matched" line. */
export interface SearchHit {
  /** Fields that held the words: name, folder, title, keywords, tags, description, details, text. */
  fields: string[];
  /** A few words of the file's text around the match (file text: untrusted, plain text only). */
  snippet?: string | undefined;
}

/** F3: the best matches by meaning, with their cosine similarity. */
export interface VectorMatch {
  path: string;
  score: number;
}

const FTS_FIELDS = ['name', 'folder', 'title', 'keywords', 'tags', 'description', 'details', 'text'] as const;
const BODY_COL = 8;
// Snippet markers: control characters that sanitize() never lets through from a file.
const HIT_START = '\u0002';
const HIT_END = '\u0003';

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Words of a query, for FTS5: letters and digits only, so nothing in it is FTS syntax. */
export function queryWords(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 0))].slice(0, 8);
}

const splitList = (s: string | null) => (s ? s.split('\n').filter(Boolean) : []);

export class FileCatalog {
  /** F3: vectors by path for the model in use, loaded on the first search by meaning. */
  private vectors: { model: string; byPath: Map<string, Float32Array> } | null = null;

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
      usedMs: r.used_ms ?? null,
    };
  }

  get(path: string): IndexedFile | null {
    const r = this.row(path);
    return r ? this.file(r) : null;
  }

  /** F3: the text kept for whole-text search ('' when none). */
  body(path: string, maxChars?: number): string {
    const r = (maxChars
      ? this.db.prepare('SELECT substr(body, 1, ?) AS body FROM file_fts WHERE path = ?').get(maxChars, path)
      : this.db.prepare('SELECT body FROM file_fts WHERE path = ?').get(path)) as { body: string } | undefined;
    return r?.body ?? '';
  }

  /**
   * Brings a file's full-text row in line with its index row. Its text (F3) stays as it was
   * unless `body` is given (null clears it).
   */
  private syncFts(path: string, body?: string | null): void {
    const text = body === undefined ? this.body(path) : (body ?? '');
    this.db.prepare('DELETE FROM file_fts WHERE path = ?').run(path);
    const r = this.row(path);
    if (!r) return;
    const f = this.file(r);
    const details = [f.kind, f.facts?.author, ...(f.facts?.sheets ?? [])].filter(Boolean).join(' ');
    this.db
      .prepare('INSERT INTO file_fts (path, name, folder, title, keywords, tags, summary, details, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.path, f.name, f.folder, f.facts?.title ?? '', f.keywords.join(' '), f.tags.join(' '), f.summary ?? '', details, text);
  }

  private dropVector(path: string): void {
    this.db.prepare('DELETE FROM file_vectors WHERE path = ?').run(path);
    this.vectors?.byPath.delete(path);
  }

  /**
   * A file the scanner saw. New and changed files (by size and modification time) need their
   * facts and summary again; tags stay.
   */
  seen(f: SeenFile, now: number): 'new' | 'changed' | 'same' {
    const r = this.row(f.path);
    if (r && r.bytes === f.bytes && r.mtime_ms === f.mtimeMs) {
      // Opened since: an access time well after the indexer's own read of it.
      const opened = f.atimeMs !== undefined && f.atimeMs > (r.used_ms ?? 0) && (r.read_at === null || f.atimeMs > r.read_at + OWN_READ_MS);
      this.db.prepare(`UPDATE file_index SET seen_at = ?${opened ? ', used_ms = ?' : ''} WHERE path = ?`).run(...(opened ? [now, f.atimeMs, f.path] : [now, f.path]));
      return 'same';
    }
    this.db
      .prepare(
        `INSERT INTO file_index (path, name, folder, kind, bytes, mtime_ms, birthtime_ms, facts, facts_state, summary, keywords, summary_state, summary_attempts, seen_at, used_ms, read_at, vector_state)
         VALUES (@path, @name, @folder, @kind, @bytes, @mtimeMs, @birthtimeMs, NULL, 'pending', NULL, NULL, 'pending', 0, @now, @usedMs, NULL, 'pending')
         ON CONFLICT(path) DO UPDATE SET name = @name, folder = @folder, kind = @kind, bytes = @bytes, mtime_ms = @mtimeMs, birthtime_ms = @birthtimeMs,
           facts = NULL, facts_state = 'pending', summary = NULL, keywords = NULL, summary_state = 'pending', summary_attempts = 0, seen_at = @now, used_ms = @usedMs, read_at = NULL,
           vector_state = 'pending'`,
      )
      .run({ path: f.path, name: f.name, folder: f.folder, kind: f.kind, bytes: f.bytes, mtimeMs: f.mtimeMs, birthtimeMs: f.birthtimeMs, now, usedMs: Math.max(f.atimeMs ?? 0, f.mtimeMs) });
    // What was read from the old contents (text, meaning) no longer holds.
    this.syncFts(f.path, null);
    this.dropVector(f.path);
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
    const delVec = this.db.prepare('DELETE FROM file_vectors WHERE path = ?');
    this.db.transaction(() => {
      for (const p of paths) {
        del.run(p);
        delFts.run(p);
        delVec.run(p);
        this.vectors?.byPath.delete(p);
      }
    })();
  }

  /** A rename keeps what is known about the file, its tags included. */
  move(from: string, to: SeenFile, now: number): boolean {
    const r = this.row(from);
    if (!r || this.row(to.path)) return false;
    const body = this.body(from);
    this.db
      .prepare('UPDATE file_index SET path = ?, name = ?, folder = ?, kind = ?, bytes = ?, mtime_ms = ?, birthtime_ms = ?, seen_at = ? WHERE path = ?')
      .run(to.path, to.name, to.folder, to.kind, to.bytes, to.mtimeMs, to.birthtimeMs, now, from);
    this.db.prepare('DELETE FROM file_fts WHERE path = ?').run(from);
    this.syncFts(to.path, body);
    this.moveVector(from, to.path);
    // The new name is part of what the vector was made from.
    this.db.prepare("UPDATE file_index SET vector_state = 'pending' WHERE path = ?").run(to.path);
    return true;
  }

  /**
   * A file moved outside the chat: the scan found it under a new path (now a new row) and
   * the old row unseen. The new row takes over what was known, tags included.
   */
  adopt(from: string, to: string): boolean {
    const r = this.row(from);
    if (!r || !this.row(to)) return false;
    const body = this.body(from);
    this.db
      .prepare('UPDATE file_index SET facts = ?, facts_state = ?, summary = ?, keywords = ?, summary_state = ?, summary_attempts = ?, tags = ? WHERE path = ?')
      .run(r.facts, r.facts_state, r.summary, r.keywords, r.summary_state, r.summary_attempts, r.tags, to);
    this.dropVector(to);
    this.moveVector(from, to);
    this.remove(from);
    this.syncFts(to, body);
    return true;
  }

  private moveVector(from: string, to: string): void {
    this.db.prepare('UPDATE file_vectors SET path = ? WHERE path = ?').run(to, from);
    const v = this.vectors?.byPath.get(from);
    if (v) {
      this.vectors!.byPath.delete(from);
      this.vectors!.byPath.set(to, v);
    }
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

  /** Stored only if the file is still the one the facts were read from. F3: with its text, for whole-text search. */
  setFacts(f: Pick<IndexedFile, 'path' | 'bytes' | 'mtimeMs'>, kind: FileKind, facts: FileFacts | null, state: 'done' | 'failed', text: string | null = null): boolean {
    const r = this.db
      .prepare("UPDATE file_index SET kind = ?, facts = ?, facts_state = ?, read_at = ?, vector_state = 'pending' WHERE path = ? AND bytes = ? AND mtime_ms = ?")
      .run(kind, facts ? JSON.stringify(facts) : null, state, Date.now(), f.path, f.bytes, f.mtimeMs);
    if (r.changes !== 1) return false;
    this.syncFts(f.path, text);
    return true;
  }

  setSummary(f: Pick<IndexedFile, 'path' | 'bytes' | 'mtimeMs'>, s: { summary: string; keywords: string[] } | null, state: 'done' | 'failed' | 'skipped' | 'pending'): boolean {
    const r = this.db
      .prepare(
        `UPDATE file_index SET summary = COALESCE(?, summary), keywords = COALESCE(?, keywords), summary_state = ?,
           summary_attempts = summary_attempts + ?, vector_state = CASE WHEN ? THEN 'pending' ELSE vector_state END WHERE path = ? AND bytes = ? AND mtime_ms = ?`,
      )
      .run(s?.summary ?? null, s ? s.keywords.join('\n') : null, state, state === 'failed' || state === 'pending' ? 1 : 0, s ? 1 : 0, f.path, f.bytes, f.mtimeMs);
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

  // ── F3: meaning vectors ──

  /** Files whose facts are read and whose vector is missing or out of date, newest first. */
  needingVector(limit: number): IndexedFile[] {
    return (this.db.prepare("SELECT * FROM file_index WHERE facts_state != 'pending' AND vector_state = 'pending' ORDER BY mtime_ms DESC LIMIT ?").all(limit) as Row[]).map((r) =>
      this.file(r),
    );
  }

  /** Stored only if the file is still the one it was made from; null marks it as failed. */
  setVector(f: Pick<IndexedFile, 'path' | 'bytes' | 'mtimeMs'>, model: string, vec: Float32Array | null): boolean {
    const r = this.db
      .prepare('UPDATE file_index SET vector_state = ? WHERE path = ? AND bytes = ? AND mtime_ms = ?')
      .run(vec ? 'done' : 'failed', f.path, f.bytes, f.mtimeMs);
    if (r.changes !== 1) return false;
    if (vec) {
      this.db.prepare('INSERT INTO file_vectors (path, model, vec) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET model = excluded.model, vec = excluded.vec').run(f.path, model, toBlob(vec));
      if (this.vectors?.model === model) this.vectors.byPath.set(f.path, vec);
    } else this.dropVector(f.path);
    return true;
  }

  /** Vectors made by another model can't be compared with this one's: those files are embedded again. */
  useEmbeddingModel(model: string): number {
    const stale = this.db.prepare('SELECT path FROM file_vectors WHERE model != ?').all(model) as { path: string }[];
    this.db.transaction(() => {
      for (const { path } of stale) {
        this.db.prepare('DELETE FROM file_vectors WHERE path = ?').run(path);
        this.db.prepare("UPDATE file_index SET vector_state = 'pending' WHERE path = ?").run(path);
      }
      // Rows marked done whose vector is gone (an older database) are embedded again too.
      this.db.prepare("UPDATE file_index SET vector_state = 'pending' WHERE vector_state = 'done' AND path NOT IN (SELECT path FROM file_vectors)").run();
    })();
    if (this.vectors?.model !== model) this.vectors = null;
    return stale.length;
  }

  private loadVectors(model: string): Map<string, Float32Array> {
    if (this.vectors?.model === model) return this.vectors.byPath;
    const byPath = new Map<string, Float32Array>();
    for (const r of this.db.prepare('SELECT path, vec FROM file_vectors WHERE model = ?').all(model) as { path: string; vec: Buffer }[]) byPath.set(r.path, fromBlob(r.vec));
    this.vectors = { model, byPath };
    return byPath;
  }

  /**
   * The files closest in meaning to `query` (a unit vector), best first: at least `minScore`
   * cosine and within `spread` of the best one, so unrelated files don't fill the list. The
   * same filters as search.
   */
  nearest(query: Float32Array, model: string, q: SearchQuery & { minScore: number; spread?: number }): VectorMatch[] {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const vectors = this.loadVectors(model);
    const scored: VectorMatch[] = [];
    for (const [path, v] of vectors) {
      if (v.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * query[i]!;
      if (dot >= q.minScore) scored.push({ path, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    const spread = q.spread ?? 0.15;
    const { where, params } = this.filters(q);
    const keep = where.length ? this.db.prepare(`SELECT 1 FROM file_index i WHERE i.path = ? AND ${where.join(' AND ')}`) : null;
    const out: VectorMatch[] = [];
    for (const m of scored) {
      if (m.score < best - spread || out.length >= limit) break;
      if (!keep || keep.get(m.path, ...params)) out.push(m);
    }
    return out;
  }

  /** /reindex: read every file's facts again and retry failed summaries; summaries of unchanged files stay. */
  resetForReindex(): void {
    this.db.prepare("UPDATE file_index SET facts_state = 'pending'").run();
    this.db.prepare("UPDATE file_index SET summary_state = 'pending', summary_attempts = 0 WHERE summary_state = 'failed'").run();
  }

  /** L1: the biggest files, at least `minBytes`, biggest first. */
  largest(minBytes: number, limit: number): IndexedFile[] {
    return (this.db.prepare("SELECT * FROM file_index WHERE bytes >= ? AND kind != 'folder' ORDER BY bytes DESC LIMIT ?").all(minBytes, limit) as Row[]).map((r) => this.file(r));
  }

  /**
   * K2: documents whose facts (and text, when they have any) have been read, changed or read
   * since `since`, newest first: PDFs, Word, Excel and text files.
   */
  readableSince(since: number, limit: number): IndexedFile[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM file_index WHERE facts_state = 'done' AND kind IN ('pdf', 'word', 'sheet', 'text') AND (mtime_ms >= ? OR read_at >= ?) ORDER BY mtime_ms DESC LIMIT ?",
        )
        .all(since, since, limit) as Row[]
    ).map((r) => this.file(r));
  }

  /** K1: files with a description that were changed or read since `since`, newest first. */
  describedSince(since: number, limit: number): IndexedFile[] {
    return (
      this.db
        .prepare("SELECT * FROM file_index WHERE summary_state = 'done' AND kind != 'folder' AND (mtime_ms >= ? OR read_at >= ?) ORDER BY mtime_ms DESC LIMIT ?")
        .all(since, since, limit) as Row[]
    ).map((r) => this.file(r));
  }

  stats(): CatalogStats {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: n('SELECT COUNT(*) AS n FROM file_index'),
      factsPending: n("SELECT COUNT(*) AS n FROM file_index WHERE facts_state = 'pending'"),
      summaryPending: n("SELECT COUNT(*) AS n FROM file_index WHERE summary_state = 'pending'"),
      summarized: n("SELECT COUNT(*) AS n FROM file_index WHERE summary_state = 'done'"),
      embedded: n('SELECT COUNT(*) AS n FROM file_vectors'),
      vectorPending: n("SELECT COUNT(*) AS n FROM file_index WHERE vector_state = 'pending'"),
    };
  }

  private filters(q: SearchQuery): { where: string[]; params: unknown[] } {
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
    return { where, params };
  }

  /**
   * Files matching all the words (as word prefixes) in their name, folder, title, keywords,
   * tags, summary, details or (F3) text, best first; or, with no words, the newest files
   * matching the filters. When all the words together find nothing, any of them will do.
   * F3: `hits` says where each file matched, with a few words of its text around the match.
   */
  search(q: SearchQuery): { files: IndexedFile[]; loose: boolean; hits: Map<string, SearchHit> } {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const { where, params } = this.filters(q);
    const hits = new Map<string, SearchHit>();
    const words = queryWords(q.query ?? '');
    if (!words.length) {
      const rows = this.db.prepare(`SELECT i.* FROM file_index i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.mtime_ms DESC LIMIT ?`).all(...params, limit) as Row[];
      return { files: rows.map((r) => this.file(r)), loose: false, hits };
    }
    type HitRow = Row & { h_name: string; h_folder: string; h_title: string; h_keywords: string; h_tags: string; h_summary: string; h_details: string; h_body: string };
    const mark = (col: number) => `highlight(file_fts, ${col}, '${HIT_START}', '${HIT_END}')`;
    const run = (match: string) =>
      this.db
        .prepare(
          `SELECT i.*, ${[1, 2, 3, 4, 5, 6, 7].map((c, n) => `instr(${mark(c)}, '${HIT_START}') AS h_${['name', 'folder', 'title', 'keywords', 'tags', 'summary', 'details'][n]}`).join(', ')},
             snippet(file_fts, ${BODY_COL}, '${HIT_START}', '${HIT_END}', '…', 14) AS h_body
           FROM file_fts f JOIN file_index i ON i.path = f.path WHERE file_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
           ORDER BY bm25(file_fts, 0, 10, 2, 6, 4, 8, 2, 3, 1), i.mtime_ms DESC LIMIT ?`,
        )
        .all(match, ...params, limit) as HitRow[];
    const terms = words.map((w) => `"${w}"*`);
    let rows = run(terms.join(' AND '));
    let loose = false;
    if (!rows.length && words.length > 1) {
      rows = run(terms.join(' OR '));
      loose = true;
    }
    for (const r of rows) {
      const flags = [r.h_name, r.h_folder, r.h_title, r.h_keywords, r.h_tags, r.h_summary, r.h_details].map((x) => Number(x) > 0);
      const inBody = r.h_body.includes(HIT_START);
      const fields = FTS_FIELDS.filter((_f, n) => (n < flags.length ? flags[n] : inBody));
      const snippet = inBody ? r.h_body.replaceAll(HIT_START, '').replaceAll(HIT_END, '').replace(/\s+/g, ' ').trim() : undefined;
      hits.set(r.path, { fields, ...(snippet ? { snippet } : {}) });
    }
    return { files: rows.map((r) => this.file(r)), loose, hits };
  }

  /** F3: rows by path, in the order given; paths no longer indexed are left out. */
  getMany(paths: string[]): IndexedFile[] {
    return paths.flatMap((p) => {
      const f = this.get(p);
      return f ? [f] : [];
    });
  }
}
