/**
 * K2: what the knowledge base has read. One row per email, file version, chat stretch or
 * calendar day, so each is read once and nothing is skipped when a run stops half way:
 *
 *   pending   → found, not read yet
 *   extracted → read; its notes (cleaned plain text) wait to be merged into the file
 *   merged    → its notes are in the file (the notes are dropped then)
 *   empty     → read, nothing worth keeping
 *   failed    → could not be read after a few tries
 *
 * No email, document or chat text is stored here: only ids, dates and the cleaned notes.
 */
import type { Store } from '../store.js';
import type { ModelSection } from './file.js';

export type ItemKind = 'sent' | 'mail' | 'file' | 'chat' | 'calendar';
export type ItemState = 'pending' | 'extracted' | 'merged' | 'empty' | 'failed';
export type Phase = 'backfill' | 'hourly';

export interface ExtractedNote {
  section: ModelSection;
  text: string;
}

export interface Item {
  key: string;
  kind: ItemKind;
  /** Mail id (INBOX:37), file path, or '' for chat and calendar. */
  ref: string;
  /** When the email was sent, the file changed, or the stretch began. */
  at: number;
  phase: Phase;
  state: ItemState;
  notes: ExtractedNote[];
  attempts: number;
}

interface Row {
  key: string;
  kind: ItemKind;
  ref: string;
  at: number;
  phase: Phase;
  state: ItemState;
  notes: string | null;
  attempts: number;
}

const toItem = (r: Row): Item => ({ ...r, notes: r.notes ? (JSON.parse(r.notes) as ExtractedNote[]) : [] });

/** Sent mail first (the user's own words say most), then mail, files, chat and the calendar. */
const KIND_ORDER = "CASE kind WHEN 'sent' THEN 0 WHEN 'mail' THEN 1 WHEN 'file' THEN 2 WHEN 'chat' THEN 3 ELSE 4 END";

export interface Progress {
  phase: Phase | null;
  mail: { done: number; total: number };
  files: { done: number; total: number };
  waiting: number;
}

export class KnowledgeLedger {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  /** Adds items not seen before; returns how many were new. */
  add(items: { key: string; kind: ItemKind; ref: string; at: number; phase: Phase }[], now: number): number {
    const insert = this.db.prepare("INSERT OR IGNORE INTO knowledge_items (key, kind, ref, at, phase, state, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)");
    let added = 0;
    this.db.transaction(() => {
      for (const i of items) added += insert.run(i.key, i.kind, i.ref, i.at, i.phase, now).changes;
    })();
    return added;
  }

  has(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM knowledge_items WHERE key = ?').get(key);
  }

  pending(limit: number): Item[] {
    return (this.db.prepare(`SELECT * FROM knowledge_items WHERE state = 'pending' ORDER BY ${KIND_ORDER}, at DESC LIMIT ?`).all(limit) as Row[]).map(toItem);
  }

  extracted(limit: number): Item[] {
    return (this.db.prepare("SELECT * FROM knowledge_items WHERE state = 'extracted' ORDER BY at DESC LIMIT ?").all(limit) as Row[]).map(toItem);
  }

  setExtracted(key: string, notes: ExtractedNote[], now: number): void {
    this.db
      .prepare('UPDATE knowledge_items SET state = ?, notes = ?, updated_at = ? WHERE key = ?')
      .run(notes.length ? 'extracted' : 'empty', notes.length ? JSON.stringify(notes) : null, now, key);
  }

  /** One more failed try; `failed` after `maxAttempts`. */
  setFailed(key: string, now: number, maxAttempts: number): void {
    this.db
      .prepare("UPDATE knowledge_items SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END, updated_at = ? WHERE key = ?")
      .run(maxAttempts, now, key);
  }

  setMerged(keys: string[], now: number): void {
    const update = this.db.prepare("UPDATE knowledge_items SET state = 'merged', notes = NULL, updated_at = ? WHERE key = ?");
    this.db.transaction(() => {
      for (const k of keys) update.run(now, k);
    })();
  }

  /** Anything of the first pass still to read. */
  backfillPending(): boolean {
    return !!this.db.prepare("SELECT 1 FROM knowledge_items WHERE phase = 'backfill' AND state = 'pending' LIMIT 1").get();
  }

  /** Anything of the first pass still to read or merge. */
  backfillOpen(): boolean {
    return !!this.db.prepare("SELECT 1 FROM knowledge_items WHERE phase = 'backfill' AND state IN ('pending', 'extracted') LIMIT 1").get();
  }

  progress(): Progress {
    const count = (kinds: string, done: boolean) =>
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE kind IN (${kinds})${done ? " AND state NOT IN ('pending')" : ''}`)
          .get() as { n: number }
      ).n;
    const waiting = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE state IN ('pending', 'extracted')").get() as { n: number }).n;
    return {
      phase: this.backfillOpen() ? 'backfill' : waiting ? 'hourly' : null,
      mail: { done: count("'sent', 'mail'", true), total: count("'sent', 'mail'", false) },
      files: { done: count("'file'", true), total: count("'file'", false) },
      waiting,
    };
  }
}
