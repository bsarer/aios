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
 *
 * K3: each item has a priority (0 first): the user's sent mail, then mail they replied to,
 * starred or Important mail, then mail from people they write to, then other mail, files,
 * chat and the calendar. The signals behind it (who the user writes to, what they replied to)
 * are kept only as hashes.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../store.js';
import type { ModelSection } from './file.js';
import type { PageKind } from './wiki.js';

export type ItemKind = 'sent' | 'mail' | 'file' | 'chat' | 'calendar';
export type ItemState = 'pending' | 'extracted' | 'merged' | 'empty' | 'failed';
/** backfill: the first pass's window; hourly: new since then; older (K3): mail before the window. */
export type Phase = 'backfill' | 'hourly' | 'older';

/** K5: a fact code checked against the item: its exact quote, and whether that is the user's own words. */
export interface CheckedFact {
  text: string;
  basis: 'stated' | 'observed';
  quote: string;
  byUser: boolean;
  /** The relationship to the user it names ("sister"), only from the user's own words. */
  relation: string | null;
}

export interface ExtractedNote extends CheckedFact {
  section: ModelSection;
}

/** K4: what one item says about one person, project or organisation, for its wiki page. */
export interface ExtractedPage {
  kind: PageKind;
  name: string;
  facts: CheckedFact[];
  links: { kind: PageKind; name: string }[];
}

/** K5: where an item's words came from, for each fact's evidence: written by code from headers. */
export interface ItemSource {
  /** Hashed sender, file or "user": two items from one origin don't confirm each other. */
  origin: string;
  /** A short plain line: "email from Selin Arslan: Your book". */
  label: string;
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
  /** K4: facts for wiki pages. */
  pages: ExtractedPage[];
  /** K5: where the item's words came from; null for items read before K5. */
  source: ItemSource | null;
  attempts: number;
  priority: number;
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
  priority: number;
}

/**
 * Notes are stored as { notes, pages, source } (K5). Before K5 they were a list (K2) or
 * { notes, pages } (K4) with no quotes: those are left out, and K5's first run reads the item again.
 */
const toItem = (r: Row): Item => {
  const v = r.notes ? (JSON.parse(r.notes) as unknown) : null;
  const k5 = !!v && typeof v === 'object' && !Array.isArray(v) && 'source' in v;
  const s = k5 ? (v as { notes: ExtractedNote[]; pages: ExtractedPage[]; source: ItemSource }) : null;
  return { ...r, notes: s?.notes ?? [], pages: s?.pages ?? [], source: s?.source ?? null };
};

/** Priorities (0 first). Sent mail first: the user's own words say most. */
export const PRIORITY = { sent: 0, replied: 1, contact: 2, mail: 3, file: 4, chat: 5, calendar: 6 } as const;
const KIND_PRIORITY: Record<ItemKind, number> = { sent: PRIORITY.sent, mail: PRIORITY.mail, file: PRIORITY.file, chat: PRIORITY.chat, calendar: PRIORITY.calendar };

export type SignalKind = 'contact' | 'replied' | 'thread';
const hash = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 32);

export interface Progress {
  phase: Phase | null;
  mail: { done: number; total: number };
  files: { done: number; total: number };
  /** K3: mail from before the first pass's window. Also counted in `mail`. */
  older: { done: number; total: number };
  waiting: number;
}

export class KnowledgeLedger {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  /** Adds items not seen before; returns how many were new. */
  add(items: { key: string; kind: ItemKind; ref: string; at: number; phase: Phase; priority?: number }[], now: number): number {
    const insert = this.db.prepare("INSERT OR IGNORE INTO knowledge_items (key, kind, ref, at, phase, state, updated_at, priority) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)");
    let added = 0;
    this.db.transaction(() => {
      for (const i of items) added += insert.run(i.key, i.kind, i.ref, i.at, i.phase, now, i.priority ?? KIND_PRIORITY[i.kind]).changes;
    })();
    return added;
  }

  /** Moves a waiting item up to `priority` (never down). */
  raise(key: string, priority: number): void {
    this.db.prepare("UPDATE knowledge_items SET priority = ? WHERE key = ? AND state = 'pending' AND priority > ?").run(priority, key, priority);
  }

  // ── K3: signals, as hashes ──

  /** Counts one more of `value` (an address, Message-ID or thread id). */
  signal(kind: SignalKind, value: string): void {
    if (!value.trim()) return;
    this.db.prepare('INSERT INTO knowledge_signals (kind, value, n) VALUES (?, ?, 1) ON CONFLICT(kind, value) DO UPDATE SET n = n + 1').run(kind, hash(value));
  }

  signalCount(kind: SignalKind, value: string | null | undefined): number {
    if (!value?.trim()) return 0;
    return (this.db.prepare('SELECT n FROM knowledge_signals WHERE kind = ? AND value = ?').get(kind, hash(value)) as { n: number } | undefined)?.n ?? 0;
  }

  /** K3: a new mailbox: mail still waiting came from the old one, so it is never read. */
  dropWaitingMail(now: number): number {
    return this.db.prepare("UPDATE knowledge_items SET state = 'empty', notes = NULL, updated_at = ? WHERE kind IN ('sent', 'mail') AND state = 'pending'").run(now).changes;
  }

  /** `mailYears`: waiting mail dated before `cutoff` is not read. Returns how many were dropped. */
  dropMailBefore(cutoff: number, now: number): number {
    return this.db.prepare("UPDATE knowledge_items SET state = 'empty', notes = NULL, updated_at = ? WHERE kind IN ('sent', 'mail') AND state = 'pending' AND at < ?").run(now, cutoff).changes;
  }

  pendingCount(phase: Phase): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE phase = ? AND state = 'pending'").get(phase) as { n: number }).n;
  }

  has(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM knowledge_items WHERE key = ?').get(key);
  }

  /** Waiting items of these phases, highest priority first, newest first within one. */
  pending(limit: number, phases: readonly Phase[] = ['backfill', 'hourly', 'older']): Item[] {
    if (!phases.length || limit <= 0) return [];
    const marks = phases.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM knowledge_items WHERE state = 'pending' AND phase IN (${marks}) ORDER BY priority, at DESC LIMIT ?`).all(...phases, limit) as Row[]).map(toItem);
  }

  /** K5: waiting items of these kinds only (the user's own words go to the cloud model). */
  pendingOfKinds(limit: number, kinds: readonly ItemKind[], phases: readonly Phase[]): Item[] {
    if (!kinds.length || !phases.length || limit <= 0) return [];
    const k = kinds.map(() => '?').join(', ');
    const p = phases.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM knowledge_items WHERE state = 'pending' AND kind IN (${k}) AND phase IN (${p}) ORDER BY priority, at DESC LIMIT ?`).all(...kinds, ...phases, limit) as Row[]).map(toItem);
  }

  extracted(limit: number): Item[] {
    return (this.db.prepare("SELECT * FROM knowledge_items WHERE state = 'extracted' ORDER BY at DESC LIMIT ?").all(limit) as Row[]).map(toItem);
  }

  setExtracted(key: string, notes: ExtractedNote[], now: number, pages: ExtractedPage[] = [], source: ItemSource = { origin: '', label: '' }): void {
    const any = notes.length > 0 || pages.length > 0;
    this.db
      .prepare('UPDATE knowledge_items SET state = ?, notes = ?, updated_at = ? WHERE key = ?')
      .run(any ? 'extracted' : 'empty', any ? JSON.stringify({ notes, pages, source }) : null, now, key);
  }

  /**
   * K5: reads items again under the new rules: those read since `since` (newest first, at most
   * `limit`), and any read before K5 whose notes still wait. The calendar is read fresh each day anyway.
   */
  requeueSince(since: number, limit: number, now: number): number {
    return this.db.transaction(() => {
      const waiting = this.db.prepare("UPDATE knowledge_items SET state = 'pending', notes = NULL, attempts = 0, updated_at = ? WHERE state = 'extracted'").run(now).changes;
      const keys = (
        this.db.prepare("SELECT key FROM knowledge_items WHERE state IN ('merged', 'empty') AND kind != 'calendar' AND at >= ? ORDER BY at DESC LIMIT ?").all(since, limit) as { key: string }[]
      ).map((r) => r.key);
      const again = this.db.prepare("UPDATE knowledge_items SET state = 'pending', phase = 'hourly', notes = NULL, attempts = 0, updated_at = ? WHERE key = ?");
      for (const k of keys) again.run(now, k);
      return waiting + keys.length;
    })();
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
    const count = (kinds: string, done: boolean, older = false) =>
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE kind IN (${kinds})${done ? " AND state NOT IN ('pending')" : ''}${older ? " AND phase = 'older'" : ''}`)
          .get() as { n: number }
      ).n;
    const waiting = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE state IN ('pending', 'extracted')").get() as { n: number }).n;
    return {
      phase: this.backfillOpen() ? 'backfill' : waiting ? 'hourly' : null,
      mail: { done: count("'sent', 'mail'", true), total: count("'sent', 'mail'", false) },
      files: { done: count("'file'", true), total: count("'file'", false) },
      older: { done: count("'sent', 'mail'", true, true), total: count("'sent', 'mail'", false, true) },
      waiting,
    };
  }
}
