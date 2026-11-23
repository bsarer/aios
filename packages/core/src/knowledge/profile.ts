/**
 * Profiles: a person's wiki page, written by code from their record (`people.ts`) and the
 * facts about them:
 *
 *   # Ana Lopez
 *   ## Who they are          from Google Contacts (saved contacts only) and the addresses and
 *                            numbers Astra has seen; written by code, never by a model
 *   ## How you know them     only relationships a known fact states, each with its quote; else
 *                            "Not stated": never guessed from a surname or how often you write
 *   ## Recent conversations  dates, which way, mail subjects (plain outside text), Signal counts
 *   ## Summary, ## Facts, ## Might not agree, ## Links, ## My notes   as on every wiki page
 *
 * The first three sections are written again each time, so the wiki's parser skips them and
 * nothing in them is ever read back as a fact. My notes, links and the summary are kept.
 */
import { utcToLocal } from '../calendar/time.js';
import { cleanNote, writeAtomic } from './file.js';
import type { ContactsApi } from '../contacts/google.js';
import { KnowledgePeople, type MailSeen, type Person, type PersonEvent, type PersonKey } from './people.js';
import { FACT_CHARS, type KnowledgeWiki, TITLE_CHARS, type WikiPage, renderPage } from './wiki.js';

export const RECENT_CONVERSATIONS = 8;
export const HOW_YOU_KNOW = 4;

/** What a profile needs of a fact (the facts records give more). */
export interface ProfileFact {
  text: string;
  state: 'unconfirmed' | 'known' | 'wrong';
  /** Set by code when the fact names a relationship ("sister", "manager"), only if its quote says it. */
  relation?: string | null | undefined;
  evidence: { quote: string; kind: string; on?: string | undefined }[];
}

export type FactsFor = (subject: string) => ProfileFact[];

const dateOf = (ms: number, tz: string) => utcToLocal(ms, tz).slice(0, 10);
const quoted = (q: string) => `"${cleanNote(q, 160).replace(/"/g, "'")}"`;

function whoLines(p: Person, tz: string): string[] {
  const out: string[] = [];
  if (p.contact && p.contact !== 'other') {
    const as = p.contactName && p.contactName !== p.name ? ` as ${p.contactName}` : '';
    out.push(`- In your Google Contacts${as}${p.organization ? `, at ${p.organization}` : ''}.`);
  } else if (p.contact === 'other') out.push('- Not a saved contact; Gmail keeps them because you emailed them.');
  else if (p.contactChecked) out.push('- Not in your Google Contacts.');
  const emails = p.keys.filter((k) => k.kind === 'email').map((k) => k.value);
  const phones = p.keys.filter((k) => k.kind === 'phone').map((k) => k.value);
  const signal = p.keys.some((k) => k.kind === 'signal');
  if (emails.length) out.push(`- Email: ${emails.slice(0, 4).join(', ')}`);
  if (phones.length) out.push(`- Phone: ${phones.slice(0, 3).join(', ')}`);
  if (signal) out.push('- On Signal with you.');
  if (p.why === 'page' && !p.keys.length) out.push("- Only mentioned in what Astra read; you haven't written to them.");
  else out.push(`- Since ${dateOf(p.firstAt, tz)}; last ${dateOf(p.lastAt, tz)}.`);
  return out;
}

/** Relationships stated by a known fact, each with the words that say it. */
export function howYouKnow(facts: ProfileFact[]): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (f.state !== 'known' || !f.relation) continue;
    const ev = f.evidence.find((e) => e.quote);
    if (!ev) continue;
    out.push(`- ${cleanNote(f.text, FACT_CHARS)}: ${quoted(ev.quote)} (${cleanNote(ev.kind, 20)}${ev.on ? `, ${ev.on}` : ''})`);
    if (out.length >= HOW_YOU_KNOW) break;
  }
  return out.length ? out : ['- Not stated in anything Astra has read. Astra never guesses this from a name or from how often you write; add it under My notes if you like.'];
}

function eventLine(e: PersonEvent, tz: string): string {
  const day = dateOf(e.at, tz);
  if (e.source === 'mail') {
    const subject = cleanNote(e.subject, 120);
    return `- ${day}, email ${e.dir === 'out' ? 'from you' : 'from them'}${subject ? `: ${subject}` : ''}`;
  }
  const yours = e.mine ? ` (${e.mine} from you)` : '';
  return `- ${day}, Signal: ${e.n} message${e.n === 1 ? '' : 's'}${yours}`;
}

function conversationLines(people: KnowledgePeople, id: string, tz: string): string[] {
  const events = people.events(id, RECENT_CONVERSATIONS);
  if (!events.length) return ['- (none yet)'];
  const t = people.totals(id);
  const counts = [
    t.mailIn + t.mailOut ? `${t.mailIn + t.mailOut} emails (${t.mailOut} from you)` : '',
    t.signal ? `${t.signal} Signal messages (${t.signalMine} from you)` : '',
  ].filter(Boolean);
  return [...events.map((e) => eventLine(e, tz)), ...(counts.length ? ['', `_In all: ${counts.join(', ')}. Signal keeps messages for a limited time._`] : [])];
}

/** The profile sections, to go after the title and its note. */
export function profileSections(people: KnowledgePeople, p: Person, facts: ProfileFact[], tz: string): string[] {
  return ['## Who they are', '', ...whoLines(p, tz), '', '## How you know them', '', ...howYouKnow(facts), '', '## Recent conversations', '', ...conversationLines(people, p.id, tz), ''];
}

/**
 * The whole page: the wiki's page (summary, facts, links, my notes) with the profile sections
 * put in after the title's note. `base` is the page as it is now, or a new one.
 */
export function renderProfile(people: KnowledgePeople, p: Person, base: WikiPage, facts: ProfileFact[], tz: string, renderBase: (w: WikiPage) => string = renderPage): string {
  const page = renderBase({ ...base, title: base.title || cleanNote(p.name, TITLE_CHARS) });
  const at = page.indexOf('\n## ');
  const head = at < 0 ? page : page.slice(0, at + 1);
  const rest = at < 0 ? '' : page.slice(at + 1);
  return `${head}\n${profileSections(people, p, facts, tz).join('\n')}\n${rest}`.replace(/\n{3,}/g, '\n\n');
}

/** Writes the profiles of these people (their pages are made when missing). Returns how many. */
export function writeProfiles(wiki: KnowledgeWiki, people: KnowledgePeople, ids: string[], factsFor: FactsFor, tz: string, stamp: string): number {
  let n = 0;
  for (const id of ids) {
    const p = people.get(id);
    const path = wiki.pathOf(id);
    if (!p || !path || !id.startsWith('people/')) continue;
    const base: WikiPage = wiki.read(id) ?? { id, kind: 'person', title: cleanNote(p.name, TITLE_CHARS), summary: '', contradictions: [], facts: [], links: [], myNotes: '', updated: null };
    wiki.write({ ...base, updated: stamp });
    writeAtomic(path, renderProfile(people, p, { ...base, updated: stamp }, factsFor(id), tz));
    n++;
  }
  return n;
}

export interface SignalSource {
  chats(limit?: number): { chat: string; kind: 'person' | 'group'; name: string; lastAt: number }[];
  messages(chat: string, limit?: number): { ts: number; mine: boolean }[];
}

export interface KnowledgeProfilesOptions {
  people: KnowledgePeople;
  wiki: KnowledgeWiki;
  /** The facts about a page (the facts records); none until they exist. */
  factsFor?: FactsFor | undefined;
  contacts?: ContactsApi | undefined;
  /** People looked up in Google Contacts per run. */
  contactsPerRun: number;
  signal?: SignalSource | undefined;
  timeZone: string;
}

export interface ProfilesRun {
  written: number;
  contactsAsked: number;
  contactsFound: number;
  signalChats: number;
  error?: string;
}

const MAX_SIGNAL_CHATS = 200;
const MAX_SIGNAL_MESSAGES = 2000;

/**
 * Keeps the person records and their pages up to date, once per knowledge run. Code only: no
 * model is called here, and nothing is sent anywhere but Google Contacts' search (read only).
 */
export class KnowledgeProfiles {
  private signalAt = 0;

  constructor(private readonly o: KnowledgeProfilesOptions) {}

  get people(): KnowledgePeople {
    return this.o.people;
  }

  /** The wiki's renderPerson: a person page with its profile, or null when they have no record. */
  renderFor(page: WikiPage): string | null {
    const p = this.o.people.get(page.id);
    return p ? renderProfile(this.o.people, p, page, (this.o.factsFor ?? (() => []))(page.id), this.o.timeZone) : null;
  }

  /** A person's page with its profile, as knowledge_search shows it; null when they have no record. */
  text(id: string): string | null {
    const p = this.o.people.get(id);
    const page = p ? this.o.wiki.read(id) : null;
    if (!p || !page) return null;
    return renderProfile(this.o.people, p, { ...page, facts: page.facts.slice(0, 40), myNotes: page.myNotes.slice(0, 1500) }, (this.o.factsFor ?? (() => []))(id), this.o.timeZone);
  }

  /** One email's headers, as the crawler lists it. */
  noteMail(m: MailSeen): void {
    this.o.people.noteMail(m);
  }

  /** Signal's one-to-one chats with new messages since the last run. */
  private async noteSignal(): Promise<number> {
    const s = this.o.signal;
    if (!s) return 0;
    const people = this.o.people;
    let n = 0;
    let newest = this.signalAt;
    for (const c of s.chats(MAX_SIGNAL_CHATS)) {
      if (c.kind !== 'person' || c.lastAt <= this.signalAt) continue;
      newest = Math.max(newest, c.lastAt);
      const messages = s.messages(c.chat, MAX_SIGNAL_MESSAGES);
      // A number nobody is known by yet: Contacts may say whose it is, so their mail and Signal are one person.
      let extra: PersonKey[] = [];
      let contactName = '';
      if (this.o.contacts && c.chat.startsWith('+') && !people.byKey('signal', c.chat) && !people.byKey('phone', c.chat) && messages.some((m) => m.mine)) {
        try {
          const found = KnowledgePeople.match({ keys: [{ kind: 'phone', value: c.chat }] }, await this.o.contacts.search(c.chat, 5, AbortSignal.timeout(15_000)));
          if (found?.source === 'saved') {
            extra = found.emails.map((e) => ({ kind: 'email' as const, value: e.address }));
            contactName = found.name;
          }
        } catch {
          // Contacts can't be asked now; the chat is still noted under its Signal name.
        }
      }
      if (people.noteSignal(c, messages, extra, contactName)) n++;
    }
    this.signalAt = newest;
    return n;
  }

  /**
   * After the wiki filed its facts: person pages it made get a record, Signal and Contacts are
   * read, and every changed person's page is written again.
   */
  async update(changedPages: string[], stamp: string, now: number): Promise<ProfilesRun> {
    const people = this.o.people;
    for (const id of changedPages) {
      if (!id.startsWith('people/')) continue;
      const page = this.o.wiki.read(id);
      if (page) people.ensurePage(id, page.title, now);
    }
    const signalChats = await this.noteSignal();
    const c = this.o.contacts ? await people.lookUpContacts(this.o.contacts, this.o.contactsPerRun, now) : { asked: 0, found: 0 };
    const ids = [...new Set([...people.takeChanged(), ...changedPages.filter((id) => people.get(id))])];
    const written = writeProfiles(this.o.wiki, people, ids, this.o.factsFor ?? (() => []), this.o.timeZone, stamp);
    return { written, contactsAsked: c.asked, contactsFound: c.found, signalChats, ...('error' in c && c.error ? { error: c.error } : {}) };
  }
}
