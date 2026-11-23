/**
 * Profiles: the people the user deals with, as records, so mail, Google Contacts and Signal name
 * the same person. Each person page (`knowledge/people/<slug>.md`, `profile.ts`) is written by
 * code from these records plus the facts about them.
 *
 * Who gets a profile is decided by code, never by a model and never by a stranger:
 * - someone the user wrote an email to (their own Sent mail: To and Cc),
 * - someone the user wrote to on Signal (a one-to-one chat with a message of theirs),
 * - a person page the reading already made (a fact named them).
 * Mail *received* from someone only adds to an existing person's conversations, so a stranger,
 * a newsletter or a forged sender can never make a page by writing in.
 *
 * Keys are plain and checked: an address that passes CONTACT_EMAIL, a number of digits with an
 * optional "+", or a Signal chat id that passes SIGNAL_CHAT_ID. Names are outside text (a
 * sender picks their own display name), cleaned to one plain line, and are only ever a title.
 * Conversations are kept from headers only: when, which way, and the subject line (plain text,
 * shown as outside text); never mail or message bodies.
 *
 * Google Contacts is only asked by address or number, and a contact is only taken when it has
 * the same address or number: a contact is never matched by name. Only saved contacts give a
 * name and organisation ("saved in your contacts as …"); Gmail's other contacts are named by
 * senders, so they only say Gmail keeps them.
 *
 * Nothing here deletes, renames or merges a page. Two addresses with the same name are one
 * person (pages are named by name), which is what the wiki already does.
 */
import { SIGNAL_CHAT_ID } from '@aios/shared';
import { CONTACT_EMAIL, CONTACT_PHONE, type Contact, type ContactsApi } from '../contacts/google.js';
import type { Store } from '../store.js';
import { cleanNote } from './file.js';
import { TITLE_CHARS, pageId } from './wiki.js';

export type KeyKind = 'email' | 'phone' | 'signal';
export type PersonWhy = 'wrote' | 'signal' | 'page';
export type EventSource = 'mail' | 'signal';
/** in: they wrote; out: the user wrote; both: a Signal day with messages each way. */
export type EventDir = 'in' | 'out' | 'both';

export const SUBJECT_CHARS = 120;
/** A sent email to more people than this is a mailing, not a conversation with each. */
export const MAX_RECIPIENTS = 10;
/** How long a Contacts answer is trusted before asking again. */
export const CONTACT_RECHECK_MS = 30 * 86_400_000;

export interface PersonKey {
  kind: KeyKind;
  value: string;
}

export interface Person {
  /** The wiki page id, "people/ana-lopez". */
  id: string;
  name: string;
  why: PersonWhy;
  /** Saved Google contact ("people/c123"), or "other" for one Gmail keeps; null: not found or not asked. */
  contact: string | null;
  contactName: string | null;
  organization: string | null;
  contactChecked: number | null;
  firstAt: number;
  lastAt: number;
  keys: PersonKey[];
}

export interface PersonEvent {
  source: EventSource;
  ref: string;
  at: number;
  dir: EventDir;
  /** Mail: the subject line (outside text, plain). Signal: empty. */
  subject: string;
  /** Signal: messages that day; mail: 1. */
  n: number;
  /** Signal: of `n`, the user's own. */
  mine: number;
}

interface PersonRow {
  id: string;
  name: string;
  why: PersonWhy;
  contact: string | null;
  contact_name: string | null;
  organization: string | null;
  contact_checked: number | null;
  first_at: number;
  last_at: number;
}

/** The address, lowercased, or null when it isn't a plain address. */
export function emailKey(address: string | null | undefined): string | null {
  const a = (address ?? '').trim();
  return CONTACT_EMAIL.test(a) ? a.toLowerCase() : null;
}

/** "+90 (555) 123-4567" → "+905551234567"; null when it isn't a number. */
export function phoneKey(number: string | null | undefined): string | null {
  const n = (number ?? '').trim();
  if (!CONTACT_PHONE.test(n)) return null;
  const digits = n.replace(/[^0-9+]/g, '').replace(/(?!^)\+/g, '');
  return /^\+?\d{6,15}$/.test(digits) ? digits : null;
}

export const signalKey = (chat: string): string | null => (SIGNAL_CHAT_ID.test(chat) && !chat.startsWith('g:') ? chat.toLowerCase() : null);

/** A name as a title: one plain line; an address is never a name. */
export function personName(name: string | null | undefined): string {
  const n = cleanNote(name ?? '', TITLE_CHARS).replace(/^["']+|["']+$/g, '').trim();
  return n && !n.includes('@') ? n : '';
}

const keyOf = (kind: KeyKind, value: string): PersonKey | null => {
  const v = kind === 'email' ? emailKey(value) : kind === 'phone' ? phoneKey(value) : signalKey(value);
  return v ? { kind, value: v } : null;
};

export interface MailSeen {
  /** The ledger key, "mail:<Message-ID>". */
  key: string;
  sent: boolean;
  from: { name: string; address: string } | null;
  to: { name: string; address: string }[];
  subject: string;
  at: number;
}

export interface SignalChatSeen {
  chat: string;
  kind: 'person' | 'group';
  name: string;
}

export interface SignalMessageSeen {
  ts: number;
  mine: boolean;
}

export class KnowledgePeople {
  /** The user's own addresses and numbers, never a person. */
  private readonly own: Set<string>;

  constructor(
    private readonly store: Store,
    own: { addresses?: string[]; numbers?: string[] } = {},
    private readonly timeZone = 'UTC',
  ) {
    this.own = new Set([...(own.addresses ?? []).map(emailKey), ...(own.numbers ?? []).map(phoneKey)].filter((v): v is string => !!v));
  }

  private get db() {
    return this.store.db;
  }

  private day(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  }

  // ── Records ──

  byKey(kind: KeyKind, value: string): string | null {
    const k = keyOf(kind, value);
    if (!k) return null;
    return (this.db.prepare('SELECT person FROM knowledge_person_keys WHERE kind = ? AND value = ?').get(k.kind, k.value) as { person: string } | undefined)?.person ?? null;
  }

  get(id: string): Person | null {
    const r = this.db.prepare('SELECT * FROM knowledge_people WHERE id = ?').get(id) as PersonRow | undefined;
    if (!r) return null;
    const keys = this.db.prepare('SELECT kind, value FROM knowledge_person_keys WHERE person = ? ORDER BY kind, value').all(id) as PersonKey[];
    return {
      id: r.id,
      name: r.name,
      why: r.why,
      contact: r.contact,
      contactName: r.contact_name,
      organization: r.organization,
      contactChecked: r.contact_checked,
      firstAt: r.first_at,
      lastAt: r.last_at,
      keys,
    };
  }

  ids(): string[] {
    return (this.db.prepare('SELECT id FROM knowledge_people ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  }

  /** The person's conversations, newest first. */
  events(id: string, limit = 10): PersonEvent[] {
    return this.db.prepare('SELECT source, ref, at, dir, subject, n, mine FROM knowledge_person_events WHERE person = ? ORDER BY at DESC LIMIT ?').all(id, limit) as PersonEvent[];
  }

  /** Totals for the profile: emails each way, Signal messages each way. */
  totals(id: string): { mailIn: number; mailOut: number; signal: number; signalMine: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN source = 'mail' AND dir = 'in' THEN 1 END), 0) AS mailIn,
                COALESCE(SUM(CASE WHEN source = 'mail' AND dir = 'out' THEN 1 END), 0) AS mailOut,
                COALESCE(SUM(CASE WHEN source = 'signal' THEN n END), 0) AS signal,
                COALESCE(SUM(CASE WHEN source = 'signal' THEN mine END), 0) AS signalMine
         FROM knowledge_person_events WHERE person = ?`,
      )
      .get(id) as { mailIn: number; mailOut: number; signal: number; signalMine: number };
    return r;
  }

  /** Ids whose profile should be written again, and clears the mark. */
  takeChanged(): string[] {
    const ids = (this.db.prepare('SELECT id FROM knowledge_people WHERE changed = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    this.db.prepare('UPDATE knowledge_people SET changed = 0 WHERE changed = 1').run();
    return ids;
  }

  /**
   * The person these keys name, made when `create` and none of the keys is known yet. Keys
   * of the user's own are left out. Null when there is no usable key or name.
   */
  ensure(name: string, keys: PersonKey[], why: PersonWhy, at: number, create: boolean): string | null {
    const ks = keys.flatMap((k) => {
      const c = keyOf(k.kind, k.value);
      return c && !this.own.has(c.value) ? [c] : [];
    });
    if (!ks.length) return null;
    const find = this.db.prepare('SELECT person FROM knowledge_person_keys WHERE kind = ? AND value = ?');
    let id = ks.map((k) => (find.get(k.kind, k.value) as { person: string } | undefined)?.person).find(Boolean) ?? null;
    if (!id) {
      if (!create) return null;
      const title = personName(name) || ks.find((k) => k.kind === 'email')?.value || ks[0]!.value;
      id = pageId('person', title);
      if (!id) return null;
      this.db
        .prepare('INSERT INTO knowledge_people (id, name, why, first_at, last_at, changed) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET changed = 1')
        .run(id, cleanNote(title, TITLE_CHARS), why, at, at);
    }
    // A key already naming someone else stays theirs: nothing is moved between people.
    const add = this.db.prepare('INSERT OR IGNORE INTO knowledge_person_keys (kind, value, person) VALUES (?, ?, ?)');
    for (const k of ks) add.run(k.kind, k.value, id);
    return id;
  }

  /** A page the reading made: a person record with no keys, so it gets a profile too. */
  ensurePage(id: string, title: string, at: number): void {
    this.db
      .prepare("INSERT INTO knowledge_people (id, name, why, first_at, last_at, changed) VALUES (?, ?, 'page', ?, ?, 1) ON CONFLICT(id) DO NOTHING")
      .run(id, cleanNote(title, TITLE_CHARS) || id, at, at);
  }

  private addEvent(person: string, e: PersonEvent): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO knowledge_person_events (person, source, ref, at, dir, subject, n, mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(person, source, ref) DO UPDATE SET n = excluded.n, mine = excluded.mine, dir = excluded.dir, at = MAX(at, excluded.at)
         WHERE n <> excluded.n OR mine <> excluded.mine`,
      )
      .run(person, e.source, e.ref, e.at, e.dir, cleanNote(e.subject, SUBJECT_CHARS), e.n, e.mine);
    if (r.changes) {
      this.db
        .prepare('UPDATE knowledge_people SET first_at = MIN(first_at, ?), last_at = MAX(last_at, ?), changed = 1 WHERE id = ?')
        .run(e.at, e.at, person);
    }
    return r.changes > 0;
  }

  // ── Sources ──

  /**
   * One email, from its headers only. Sent: each recipient (up to MAX_RECIPIENTS; a larger
   * mailing is nobody's conversation) becomes a person. Received: only a person already known
   * by the sender's address gets it.
   */
  noteMail(m: MailSeen): number {
    let n = 0;
    if (m.sent) {
      const to = m.to.filter((a) => emailKey(a.address) && !this.own.has(emailKey(a.address)!));
      if (!to.length || to.length > MAX_RECIPIENTS) return 0;
      for (const a of to) {
        const id = this.ensure(a.name, [{ kind: 'email', value: a.address }], 'wrote', m.at, true);
        if (id && this.addEvent(id, { source: 'mail', ref: m.key, at: m.at, dir: 'out', subject: m.subject, n: 1, mine: 1 })) n++;
      }
      return n;
    }
    const id = m.from ? this.ensure(m.from.name, [{ kind: 'email', value: m.from.address }], 'wrote', m.at, false) : null;
    return id && this.addEvent(id, { source: 'mail', ref: m.key, at: m.at, dir: 'in', subject: m.subject, n: 1, mine: 0 }) ? 1 : 0;
  }

  /**
   * One Signal chat with one person. It makes a person only when the user wrote in it; each day
   * with messages is one conversation (counts only, no text).
   */
  noteSignal(chat: SignalChatSeen, messages: SignalMessageSeen[], extraKeys: PersonKey[] = [], contactName = ''): string | null {
    if (chat.kind !== 'person' || !signalKey(chat.chat) || !messages.length) return null;
    const keys: PersonKey[] = [{ kind: 'signal', value: chat.chat }, ...(chat.chat.startsWith('+') ? [{ kind: 'phone' as const, value: chat.chat }] : []), ...extraKeys];
    const wrote = messages.some((m) => m.mine);
    const first = Math.min(...messages.map((m) => m.ts));
    const id = this.ensure(contactName || chat.name, keys, 'signal', first, wrote);
    if (!id) return null;
    const days = new Map<string, { at: number; n: number; mine: number }>();
    for (const m of messages) {
      const d = this.day(m.ts);
      const had = days.get(d) ?? { at: 0, n: 0, mine: 0 };
      days.set(d, { at: Math.max(had.at, m.ts), n: had.n + 1, mine: had.mine + (m.mine ? 1 : 0) });
    }
    for (const [d, v] of days) {
      this.addEvent(id, { source: 'signal', ref: `signal:${d}`, at: v.at, dir: v.mine === 0 ? 'in' : v.mine === v.n ? 'out' : 'both', subject: '', n: v.n, mine: v.mine });
    }
    return id;
  }

  // ── Google Contacts ──

  /** People to look up in Contacts: never asked, or asked over a month ago; those with keys only. */
  contactsDue(limit: number, now: number): string[] {
    if (limit <= 0) return [];
    return (
      this.db
        .prepare(
          `SELECT p.id FROM knowledge_people p WHERE (p.contact_checked IS NULL OR p.contact_checked < ?)
             AND EXISTS (SELECT 1 FROM knowledge_person_keys k WHERE k.person = p.id AND k.kind IN ('email', 'phone'))
           ORDER BY p.contact_checked IS NOT NULL, p.last_at DESC LIMIT ?`,
        )
        .all(now - CONTACT_RECHECK_MS, limit) as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * The contact for this person among Contacts' answers: only one sharing an address or
   * number with them. A saved contact wins over one Gmail keeps.
   */
  static match(p: Pick<Person, 'keys'>, found: Contact[]): Contact | null {
    const emails = new Set(p.keys.filter((k) => k.kind === 'email').map((k) => k.value));
    const phones = new Set(p.keys.filter((k) => k.kind === 'phone').map((k) => k.value));
    const same = (c: Contact) => c.emails.some((e) => emails.has(emailKey(e.address) ?? '')) || c.phones.some((n) => phones.has(phoneKey(n.number) ?? ''));
    return found.find((c) => c.source === 'saved' && same(c)) ?? found.find((c) => same(c)) ?? null;
  }

  /** Stores what Contacts said (or that it had nothing), and the contact's other addresses and numbers. */
  setContact(id: string, c: Contact | null, now: number): void {
    const p = this.get(id);
    if (!p) return;
    const saved = c?.source === 'saved';
    const name = saved ? personName(c.name) || null : null;
    const org = saved ? cleanNote(c.organization, TITLE_CHARS) || null : null;
    const contact = c ? (saved ? c.id : 'other') : null;
    const changed = contact !== p.contact || name !== p.contactName || org !== p.organization;
    this.db
      .prepare('UPDATE knowledge_people SET contact = ?, contact_name = ?, organization = ?, contact_checked = ?, changed = changed OR ? WHERE id = ?')
      .run(contact, name, org, now, changed ? 1 : 0, id);
    if (c) {
      const keys: PersonKey[] = [...c.emails.map((e) => ({ kind: 'email' as const, value: e.address })), ...c.phones.map((n) => ({ kind: 'phone' as const, value: n.number }))];
      const add = this.db.prepare('INSERT OR IGNORE INTO knowledge_person_keys (kind, value, person) VALUES (?, ?, ?)');
      for (const k of keys.slice(0, 10)) {
        const v = keyOf(k.kind, k.value);
        if (v && !this.own.has(v.value)) add.run(v.kind, v.value, id);
      }
    }
  }

  /** Asks Contacts about up to `limit` people, by their address or number. Stops at the first error. */
  async lookUpContacts(api: ContactsApi, limit: number, now: number): Promise<{ asked: number; found: number; error?: string }> {
    let asked = 0;
    let found = 0;
    for (const id of this.contactsDue(limit, now)) {
      const p = this.get(id);
      if (!p) continue;
      const query = p.keys.find((k) => k.kind === 'email')?.value ?? p.keys.find((k) => k.kind === 'phone')?.value;
      if (!query) continue;
      try {
        const c = KnowledgePeople.match(p, await api.search(query, 5, AbortSignal.timeout(15_000)));
        this.setContact(id, c, now);
        asked++;
        if (c) found++;
      } catch (err) {
        return { asked, found, error: ((err as Error).name || 'error').slice(0, 40) };
      }
    }
    return { asked, found };
  }
}
