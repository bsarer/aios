/**
 * K5: the knowledge base's facts, as linked records: each fact, the items it came from and the
 * exact quote from each. `about-me.md` and the wiki pages are written from these by code, so
 * every line can say where it came from (/knowledge why) and a wrong one can be taken out for
 * good (/knowledge wrong, or deleting the line from the file).
 *
 *   subject   a wiki page id ("people/ana-lopez"), or "me" for about-me.md's lines (with `section`)
 *   about     the page a "me" line is about ("people/ana-lopez" for "Ana Lopez: …"), so a
 *             person's lines can be found from their page
 *   basis     stated: in someone's words; observed: what happened; code: written by code from
 *             headers or the calendar; mine: the user typed it; legacy: written before K5, no quote
 *   state     known: the user's own words, or items from two different origins (two senders, a
 *             sender and a file…); unconfirmed: one origin, or legacy; wrong: the user said so.
 *             A wrong fact stays, so the same words (or the same relation for the same person)
 *             are never learned again.
 *
 * No model writes here directly: the crawler adds only what `evidence.ts` checked by code.
 */
import { createHash } from 'node:crypto';
import type { KnowledgeSource } from '@aios/shared';
import type { Store } from '../store.js';
import type { ItemKind } from './ledger.js';

export type FactState = 'unconfirmed' | 'known' | 'wrong';
export type FactBasis = 'stated' | 'observed' | 'code' | 'mine' | 'legacy';
export const ME = 'me';

export interface Evidence {
  /** The ledger item's key ("mail:<Message-ID>", "file:<path>:<mtime>", "chat:<from>-<to>", "calendar:<day>"). */
  itemKey: string;
  kind: ItemKind;
  /** The exact words from the item, checked by code to be in it. Outside text: show it as plain text only. */
  quote: string;
  /** The quote is the user's own words (their sent mail or their chat lines). */
  byUser: boolean;
  /** Who the words came from, hashed: two items from one sender are one origin. */
  origin: string;
  /** A short plain line written by code: "email from Selin Arslan, 2 Oct: Your book". */
  label: string;
  on?: string | undefined;
  at: number;
}

export interface Fact {
  id: number;
  subject: string;
  section: string;
  about: string | null;
  text: string;
  basis: FactBasis;
  state: FactState;
  /** The relationship to the user this fact names ("sister"), set by code; only from the user's own words. */
  relation: string | null;
  /** Where it was first learned: mail, calendar, files or chat. */
  source: KnowledgeSource;
  mine: boolean;
  /** In the file or page as it was last written (so a line the user deleted can be told apart). */
  shown: boolean;
  firstOn: string | null;
  lastOn: string | null;
  evidence: Evidence[];
}

export interface NewFact {
  subject: string;
  section?: string | undefined;
  about?: string | null | undefined;
  text: string;
  basis: Exclude<FactBasis, 'mine' | 'legacy'>;
  relation?: string | null | undefined;
  source: KnowledgeSource;
  on?: string | undefined;
  evidence?: Evidence | undefined;
}

export type AddResult = { id: number; added: boolean; state: FactState } | { blocked: true };

/** For comparing fact texts: letters and digits, lower case, single spaces. */
export const norm = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const originOf = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 24);

interface FactRow {
  id: number;
  subject: string;
  section: string;
  about: string | null;
  text: string;
  norm: string;
  basis: FactBasis;
  state: FactState;
  relation: string | null;
  source: KnowledgeSource;
  mine: number;
  shown: number;
  first_on: string | null;
  last_on: string | null;
}
interface EvidenceRow {
  fact_id: number;
  item_key: string;
  kind: ItemKind;
  quote: string;
  by_user: number;
  origin: string;
  label: string;
  on_day: string | null;
  at: number;
}

const toEvidence = (r: EvidenceRow): Evidence => ({ itemKey: r.item_key, kind: r.kind, quote: r.quote, byUser: !!r.by_user, origin: r.origin, label: r.label, ...(r.on_day ? { on: r.on_day } : {}), at: r.at });

/** Shown first: the user's own, then known, then unconfirmed; newest first within each. */
export function factOrder(a: Fact, b: Fact): number {
  const rank = (f: Fact) => (f.mine ? 0 : f.state === 'known' ? 1 : 2);
  return rank(a) - rank(b) || (b.lastOn ?? '0000').localeCompare(a.lastOn ?? '0000') || b.id - a.id;
}

export class KnowledgeFacts {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  private evidenceOf(ids: number[]): Map<number, Evidence[]> {
    const out = new Map<number, Evidence[]>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT * FROM knowledge_evidence WHERE fact_id IN (${part.map(() => '?').join(', ')}) ORDER BY at DESC`).all(...part) as EvidenceRow[];
      for (const r of rows) out.set(r.fact_id, [...(out.get(r.fact_id) ?? []), toEvidence(r)]);
    }
    return out;
  }

  private toFacts(rows: FactRow[]): Fact[] {
    const ev = this.evidenceOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      section: r.section,
      about: r.about,
      text: r.text,
      basis: r.basis,
      state: r.state,
      relation: r.relation,
      source: r.source,
      mine: !!r.mine,
      shown: !!r.shown,
      firstOn: r.first_on,
      lastOn: r.last_on,
      evidence: ev.get(r.id) ?? [],
    }));
  }

  get(id: number): Fact | null {
    const r = this.db.prepare('SELECT * FROM knowledge_facts WHERE id = ?').get(id) as FactRow | undefined;
    return r ? this.toFacts([r])[0]! : null;
  }

  /** A subject's facts (and, for a page, the "me" lines about it), not the wrong ones unless asked; shown order. */
  forSubject(subject: string, o: { wrong?: boolean } = {}): Fact[] {
    const rows = this.db.prepare(`SELECT * FROM knowledge_facts WHERE (subject = ? OR about = ?)${o.wrong ? '' : " AND state != 'wrong'"}`).all(subject, subject) as FactRow[];
    return this.toFacts(rows).sort(factOrder);
  }

  /** One subject's own facts (one section of "me"), not wrong, in shown order. */
  of(subject: string, section = ''): Fact[] {
    const rows = this.db.prepare("SELECT * FROM knowledge_facts WHERE subject = ? AND section = ? AND state != 'wrong'").all(subject, section) as FactRow[];
    return this.toFacts(rows).sort(factOrder);
  }

  /** Subjects with facts: every page id (by folder prefix, "people/") or all. */
  subjects(prefix = ''): string[] {
    return (this.db.prepare("SELECT DISTINCT subject FROM knowledge_facts WHERE subject LIKE ? AND state != 'wrong' ORDER BY subject").all(`${prefix.replace(/[%_]/g, '')}%`) as { subject: string }[]).map((r) => r.subject);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_facts WHERE state != 'wrong'").get() as { n: number }).n;
  }

  /** The user said it was wrong: these words, or this relation for this person. */
  blocked(subject: string, section: string, text: string, relation?: string | null, about?: string | null): boolean {
    if (this.db.prepare("SELECT 1 FROM knowledge_facts WHERE subject = ? AND section = ? AND norm = ? AND state = 'wrong'").get(subject, section, norm(text))) return true;
    if (!relation) return false;
    const who = about ?? subject;
    return !!this.db.prepare("SELECT 1 FROM knowledge_facts WHERE (subject = ? OR about = ?) AND relation = ? AND state = 'wrong'").get(who, who, relation);
  }

  /** Known: the user's own words, or two different origins. Mine and wrong never change here. */
  private restate(id: number, now: number): FactState {
    const f = this.db.prepare('SELECT state, mine FROM knowledge_facts WHERE id = ?').get(id) as { state: FactState; mine: number };
    if (f.state === 'wrong' || f.mine) return f.state;
    const ev = this.db.prepare('SELECT COUNT(DISTINCT origin) AS origins, MAX(by_user) AS mine FROM knowledge_evidence WHERE fact_id = ?').get(id) as { origins: number; mine: number | null };
    const state: FactState = ev.mine || ev.origins >= 2 ? 'known' : 'unconfirmed';
    if (state !== f.state) this.db.prepare('UPDATE knowledge_facts SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
    return state;
  }

  /**
   * Adds a checked fact, or one more item behind a fact already there. Never replaces another
   * fact: two notes about one person that disagree are both kept. Blocked when the user said it is wrong.
   */
  add(f: NewFact, now: number): AddResult {
    const section = f.section ?? '';
    if (this.blocked(f.subject, section, f.text, f.relation, f.about)) return { blocked: true };
    const n = norm(f.text);
    if (!n) return { blocked: true };
    return this.db.transaction((): AddResult => {
      const had = this.db.prepare('SELECT id, last_on, first_on FROM knowledge_facts WHERE subject = ? AND section = ? AND norm = ?').get(f.subject, section, n) as
        | { id: number; last_on: string | null; first_on: string | null }
        | undefined;
      let id: number;
      if (had) {
        id = had.id;
        const on = f.on ?? null;
        this.db
          .prepare('UPDATE knowledge_facts SET last_on = MAX(COALESCE(last_on, ?), COALESCE(?, last_on)), first_on = MIN(COALESCE(first_on, ?), COALESCE(?, first_on)), updated_at = ? WHERE id = ?')
          .run(on, on, on, on, now, id);
        // A legacy line found again with a quote is now based on that item.
        if (f.evidence) this.db.prepare("UPDATE knowledge_facts SET basis = ? WHERE id = ? AND basis = 'legacy'").run(f.basis, id);
      } else {
        const state: FactState = f.basis === 'code' ? 'known' : 'unconfirmed';
        id = Number(
          this.db
            .prepare('INSERT INTO knowledge_facts (subject, section, about, text, norm, basis, state, relation, source, first_on, last_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(f.subject, section, f.about ?? null, f.text, n, f.basis, state, f.relation ?? null, f.source, f.on ?? null, f.on ?? null, now, now).lastInsertRowid,
        );
      }
      if (f.evidence) {
        const e = f.evidence;
        this.db
          .prepare('INSERT OR IGNORE INTO knowledge_evidence (fact_id, item_key, kind, quote, by_user, origin, label, on_day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, e.itemKey, e.kind, e.quote, e.byUser ? 1 : 0, e.origin, e.label, e.on ?? null, e.at);
      }
      const state = f.basis === 'code' ? 'known' : this.restate(id, now);
      return { id, added: !had, state };
    })();
  }

  /** A line the user typed (in the file, on a page): known, never changed by Astra. */
  addMine(subject: string, section: string, text: string, now: number): number | null {
    const n = norm(text);
    if (!n) return null;
    const had = this.db.prepare('SELECT id FROM knowledge_facts WHERE subject = ? AND section = ? AND norm = ?').get(subject, section, n) as { id: number } | undefined;
    if (had) {
      this.db.prepare("UPDATE knowledge_facts SET mine = 1, state = 'known', basis = 'mine', updated_at = ? WHERE id = ?").run(now, had.id);
      return had.id;
    }
    return Number(
      this.db
        .prepare("INSERT INTO knowledge_facts (subject, section, text, norm, basis, state, mine, created_at, updated_at) VALUES (?, ?, ?, ?, 'mine', 'known', 1, ?, ?)")
        .run(subject, section, text, n, now, now).lastInsertRowid,
    );
  }

  /** K5's first run: a line written before facts had quotes. Unconfirmed until an item says it again. */
  addLegacy(subject: string, section: string, text: string, source: KnowledgeSource, on: string | undefined, about: string | null, now: number): void {
    const n = norm(text);
    if (!n) return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO knowledge_facts (subject, section, about, text, norm, basis, state, source, first_on, last_on, shown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'legacy', 'unconfirmed', ?, ?, ?, 1, ?, ?)",
      )
      .run(subject, section, about, text, n, source, on ?? null, on ?? null, now, now);
  }

  /** The user said this is wrong (their typed /knowledge wrong, or deleting the line). It stays, so it isn't learned again. */
  setWrong(id: number, now: number): Fact | null {
    this.db.prepare("UPDATE knowledge_facts SET state = 'wrong', mine = 0, shown = 0, updated_at = ? WHERE id = ?").run(now, id);
    return this.get(id);
  }

  /** Marks which of a subject's facts the file or page shows now. */
  setShown(subject: string, section: string, shown: number[]): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE knowledge_facts SET shown = 0 WHERE subject = ? AND section = ?').run(subject, section);
      const mark = this.db.prepare('UPDATE knowledge_facts SET shown = 1 WHERE id = ?');
      for (const id of shown) mark.run(id);
    })();
  }

  /**
   * Reconciles one list in the file or on a page with what was written there last time: a line
   * the user typed (no source after it) is theirs, and a line Astra wrote that is gone was
   * deleted by the user, so it is wrong. A line whose words the user changed is both.
   * Returns how many changed.
   */
  sync(subject: string, section: string, lines: { text: string; mine: boolean }[], now: number): number {
    const inFile = new Set(lines.map((l) => norm(l.text)));
    let changed = 0;
    for (const l of lines) {
      if (!l.mine) continue;
      const had = this.db.prepare('SELECT mine, state FROM knowledge_facts WHERE subject = ? AND section = ? AND norm = ?').get(subject, section, norm(l.text)) as { mine: number; state: FactState } | undefined;
      if (had?.mine) continue;
      if (this.addMine(subject, section, l.text, now)) changed++;
    }
    // A model line the user edited keeps its source tail but has new words: it is theirs now.
    const known = new Set((this.db.prepare('SELECT norm FROM knowledge_facts WHERE subject = ? AND section = ?').all(subject, section) as { norm: string }[]).map((r) => r.norm));
    for (const l of lines) if (!l.mine && !known.has(norm(l.text)) && this.addMine(subject, section, l.text, now)) changed++;
    const shown = this.db.prepare("SELECT id, norm FROM knowledge_facts WHERE subject = ? AND section = ? AND shown = 1 AND state != 'wrong'").all(subject, section) as { id: number; norm: string }[];
    for (const r of shown) {
      if (inFile.has(r.norm)) continue;
      this.setWrong(r.id, now);
      changed++;
    }
    return changed;
  }

  /** Facts whose words match, for /knowledge why: best match first. */
  search(query: string, limit = 8): Fact[] {
    const words = norm(query)
      .split(' ')
      .filter((w) => w.length >= 2)
      .slice(0, 12);
    if (!words.length) return [];
    const like = words.map(() => '(norm LIKE ? OR subject LIKE ?)').join(' OR ');
    const args = words.flatMap((w) => [`%${w.replace(/[%_]/g, '')}%`, `%${w.replace(/[%_]/g, '')}%`]);
    const rows = this.db.prepare(`SELECT * FROM knowledge_facts WHERE state != 'wrong' AND (${like}) LIMIT 400`).all(...args) as FactRow[];
    const score = (r: FactRow) => words.filter((w) => ` ${r.norm} `.includes(` ${w}`) || r.subject.includes(w)).length;
    return this.toFacts(rows.sort((a, b) => score(b) - score(a) || b.id - a.id).slice(0, limit));
  }
}
