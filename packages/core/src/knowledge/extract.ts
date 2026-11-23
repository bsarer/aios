/**
 * K2: reading one email, document, chat stretch or calendar week into a few notes and page facts.
 *
 * Extraction is one small structured call per item, so even a small local model has an easy
 * job. Like triage it has no tools: the requests have no `tools` field and the client it gets
 * can only make structured calls (test). Everything from the item (headers, body, file name and
 * text) is sanitized and inside one <untrusted> wrapper.
 *
 * K5: each note and fact comes back with its basis and an exact quote, and code keeps only what
 * `evidence.ts` checks against the item's text; the facts are stored with their quotes in
 * `facts.ts`, never merged by a model.
 */
import { z } from 'zod';
import type { ModelRequest } from '../model.js';
import { KNOWLEDGE_EXTRACT_LOCAL_RULES, KNOWLEDGE_EXTRACT_SYSTEM_PROMPT, KNOWLEDGE_PAGE_SYSTEM_PROMPT } from '../prompts.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type Candidate, type ItemText, QUOTE_CHARS, checkFact } from './evidence.js';
import { MODEL_SECTIONS, cleanNote } from './file.js';
import type { CheckedFact, ExtractedNote, ExtractedPage } from './ledger.js';
import { PAGE_KINDS, type WikiPage, pageId } from './wiki.js';

export const MAIL_TEXT_CHARS = 3000;
export const DOC_TEXT_CHARS = 6000;
export const MAX_NOTES_PER_ITEM = 12;

export const MAX_PAGES_PER_ITEM = 8;
export const MAX_FACTS_PER_PAGE = 6;

const PageRef = z.strictObject({ kind: z.enum(PAGE_KINDS), name: z.string().min(1).max(300) });
/** K5: where a note comes from. "inferred" is allowed so a model can be honest; code never keeps it. */
const Basis = z.enum(['stated', 'observed', 'inferred']);
const Quote = z.string().max(1000);

/**
 * The extractor's answer. Loose on length, so a long note is cut rather than failing the item.
 * K4: `pages` names the people, projects and organisations the item is about, with facts for
 * each one's page and links to the others. K5: every note and fact has a basis and a quote.
 */
export const ExtractedNotes = z.strictObject({
  notes: z.array(z.strictObject({ section: z.enum(MODEL_SECTIONS), text: z.string().min(1).max(1000), basis: Basis, quote: Quote })).max(40),
  pages: z
    .array(
      z.strictObject({
        ...PageRef.shape,
        facts: z.array(z.strictObject({ text: z.string().min(1).max(1000), basis: Basis, quote: Quote })).max(20),
        links: z.array(PageRef).max(20).optional(),
      }),
    )
    .max(30)
    .optional(),
});
export type ExtractedAnswer = z.infer<typeof ExtractedNotes>;

/**
 * The text a person wrote in this email: quoted replies ("> …", "On … wrote:", forwarded and
 * original-message blocks) and long signatures are cut, so a thread isn't read again each time.
 */
export function ownText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(-{2,}\s*(original message|forwarded message)\s*-{2,}|begin forwarded message:)/i.test(line)) break;
    if (/^\s*On .{4,200}(wrote|yazdı):\s*$/i.test(line)) break;
    if (/^\s*(From|Gönderen):\s.+/i.test(line) && out.some((l) => l.trim())) break;
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface MailItemInput {
  id: string;
  sentByUser: boolean;
  from: string;
  to: string[];
  date: string;
  subject: string;
  body: { text?: string; html?: string | null };
}

export interface DocItemInput {
  display: string;
  kind: string;
  title?: string | undefined;
  author?: string | undefined;
  summary?: string | null | undefined;
  text: string;
}

/**
 * K5: a request, with the item's text as the model sees it (to check quotes against) and the
 * part that is the user's own words.
 */
export interface ItemRequest {
  request: ModelRequest;
  check: Omit<ItemText, 'judgement'>;
}

const request = (role: ModelRequest['role'], user: string): ModelRequest => ({
  role,
  messages: [
    // The local model only records what happened (K5): judgement is left to the cloud model.
    { role: 'system', content: role === 'local' ? `${KNOWLEDGE_EXTRACT_SYSTEM_PROMPT}\n${KNOWLEDGE_EXTRACT_LOCAL_RULES}` : KNOWLEDGE_EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ],
});

/** One email. Headers and body are all inside the wrapper: anyone can write them. */
export function mailItem(role: ModelRequest['role'], userName: string, m: MailItemInput): ItemRequest {
  const body = m.body.text ? m.body.text : m.body.html ? sanitize({ html: m.body.html }, { maxChars: MAIL_TEXT_CHARS * 4 }) : '';
  const own = ownText(body);
  const text = sanitize({ text: [`From: ${m.from}`, `To: ${m.to.join(', ')}`, `Date: ${m.date}`, `Subject: ${m.subject}`, '', own].join('\n') }, { maxChars: MAIL_TEXT_CHARS });
  return {
    request: request(
      role,
      [`Person: ${userName}`, m.sentByUser ? `An email ${userName} wrote and sent (their own words):` : `An email ${userName} received (someone else's words):`, wrapUntrusted('email', m.id, text)].join('\n'),
    ),
    // Only the body of the user's own email is their words: not its headers, nor anything quoted.
    check: { text, own: m.sentByUser ? sanitize({ text: own }, { maxChars: MAIL_TEXT_CHARS }) : '' },
  };
}

export const mailRequest = (role: ModelRequest['role'], userName: string, m: MailItemInput): ModelRequest => mailItem(role, userName, m).request;

/** One document from the user's folders. Not counted as the user's own words: files come from anywhere. */
export function docItem(role: ModelRequest['role'], userName: string, d: DocItemInput): ItemRequest {
  const text = sanitize(
    {
      text: [`File: ${d.display} (${d.kind})`, ...(d.title ? [`Title: ${d.title}`] : []), ...(d.author ? [`Author: ${d.author}`] : []), ...(d.summary ? [`Description: ${d.summary}`] : []), '', d.text].join(
        '\n',
      ),
    },
    { maxChars: DOC_TEXT_CHARS },
  );
  return { request: request(role, [`Person: ${userName}`, `A document in ${userName}'s folders:`, wrapUntrusted('document', 'file', text)].join('\n')), check: { text, own: '' } };
}

export const docRequest = (role: ModelRequest['role'], userName: string, d: DocItemInput): ModelRequest => docItem(role, userName, d).request;

/**
 * K5: the user's own chat lines since the last stretch, and nothing the assistant wrote: its
 * replies repeat what the knowledge base guessed, so reading them back would confirm the guess.
 */
export function chatItem(role: ModelRequest['role'], userName: string, lines: string[]): ItemRequest {
  const text = sanitize({ text: lines.join('\n') }, { maxChars: 8000 });
  return { request: request(role, [`Person: ${userName}`, `What ${userName} typed to their assistant (their own words):`, wrapUntrusted('chat', 'chat', text)].join('\n')), check: { text, own: text } };
}

export const chatRequest = (role: ModelRequest['role'], userName: string, lines: string[]): ModelRequest => chatItem(role, userName, lines).request;

/** The calendar from a week back to a week ahead. Anyone can send an invite, so none of it is the user's words. */
export function calendarItem(role: ModelRequest['role'], userName: string, lines: string[]): ItemRequest {
  const text = sanitize({ text: lines.join('\n') }, { maxChars: 6000 });
  return { request: request(role, [`Person: ${userName}`, `${userName}'s calendar, a week back to a week ahead:`, wrapUntrusted('calendar', 'calendar', text)].join('\n')), check: { text, own: '' } };
}

export const calendarRequest = (role: ModelRequest['role'], userName: string, lines: string[]): ModelRequest => calendarItem(role, userName, lines).request;

/** Why facts were left out, counted for the audit log and the eval. */
export type Dropped = Partial<Record<'inferred' | 'no_quote' | 'quote_not_found' | 'relation' | 'liking' | 'judgement' | 'empty', number>>;

function checked(c: Candidate & { text: string }, item: ItemText, dropped: Dropped): CheckedFact | null {
  const text = cleanNote(c.text, 300);
  if (!text) {
    dropped.empty = (dropped.empty ?? 0) + 1;
    return null;
  }
  const v = checkFact({ ...c, text }, item);
  if (!v.ok) {
    dropped[v.why] = (dropped[v.why] ?? 0) + 1;
    return null;
  }
  return { text, basis: c.basis as CheckedFact['basis'], quote: cleanNote(v.quote, QUOTE_CHARS), byUser: v.byUser, relation: v.relation };
}

/** The extractor's notes that pass the checks, cleaned to one plain line each, deduplicated and capped. */
export function cleanExtracted(v: ExtractedAnswer, item: ItemText, dropped: Dropped = {}): ExtractedNote[] {
  const seen = new Set<string>();
  const out: ExtractedNote[] = [];
  for (const n of v.notes) {
    const f = checked({ text: n.text, basis: n.basis, quote: n.quote, aboutUser: true, section: n.section }, item, dropped);
    if (!f) continue;
    const key = `${n.section}:${normal(f.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section: n.section, ...f });
    if (out.length >= MAX_NOTES_PER_ITEM) break;
  }
  return out;
}

/**
 * K4: the extractor's pages, cleaned by code: names and facts to plain lines, pages with no
 * usable name (one that makes no slug: "../..") left out, at most 8 pages, 6 facts and 6 links
 * each. K5: only facts that pass the checks; links only between pages with a checked fact or
 * a name that is in the item.
 */
export function cleanPages(v: ExtractedAnswer, item: ItemText, dropped: Dropped = {}): ExtractedPage[] {
  const byId = new Map<string, ExtractedPage>();
  for (const p of v.pages ?? []) {
    const name = cleanNote(p.name, 80);
    const id = pageId(p.kind, name);
    if (!id) continue;
    const page = byId.get(id) ?? { kind: p.kind, name, facts: [], links: [] };
    if (!byId.has(id)) {
      if (byId.size >= MAX_PAGES_PER_ITEM) continue;
      byId.set(id, page);
    }
    for (const raw of p.facts) {
      const f = checked({ text: raw.text, basis: raw.basis, quote: raw.quote, aboutUser: false }, item, dropped);
      if (f && page.facts.length < MAX_FACTS_PER_PAGE && !page.facts.some((x) => normal(x.text) === normal(f.text))) page.facts.push(f);
    }
    for (const l of p.links ?? []) {
      const lname = cleanNote(l.name, 80);
      const lid = pageId(l.kind, lname);
      if (lid && lid !== id && page.links.length < MAX_FACTS_PER_PAGE && !page.links.some((x) => pageId(x.kind, x.name) === lid)) page.links.push({ kind: l.kind, name: lname });
    }
  }
  // A page needs a checked fact, or a name the item really has: no page for someone made up.
  return [...byId.values()].filter((p) => p.facts.length || (p.links.length && ` ${normal(item.text)} `.includes(` ${normal(p.name)} `)));
}

/** "Ana Lopez: emailed about…" → "Ana Lopez": the person a people note is about. */
export function personOf(text: string): string | null {
  const m = /^([^:]{2,60}):/.exec(text);
  return m ? m[1]!.trim() : null;
}

const normal = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ── K4: a page's summary, rewritten when it gets new facts ──

export const PAGE_FACTS_IN_SUMMARY = 80;
export const PageSummary = z.strictObject({
  summary: z.string().max(3000),
  contradictions: z.array(z.string().min(1).max(1000)).max(10),
});

/** K5: each fact says whether it is known or unconfirmed, so the summary can't state a guess as a fact. */
export function pageSummaryRequest(role: ModelRequest['role'], userName: string, p: WikiPage): ModelRequest {
  const lines = [
    `Page: ${p.title} (${p.kind})`,
    `Summary now: ${p.summary || '(none)'}`,
    'Facts, known first, newest first within each:',
    ...p.facts.slice(0, PAGE_FACTS_IN_SUMMARY).map((f) => `- ${f.unconfirmed ? '[unconfirmed] ' : f.mine ? '[the user wrote this] ' : '[known] '}${f.text} (${f.source}${f.on ? `, ${f.on}` : ''})`),
  ];
  return {
    role,
    messages: [
      { role: 'system', content: KNOWLEDGE_PAGE_SYSTEM_PROMPT },
      { role: 'user', content: [`Person: ${userName}`, 'One page of their knowledge wiki:', wrapUntrusted('knowledge', p.id, sanitize({ text: lines.join('\n') }, { maxChars: 20_000 }))].join('\n') },
    ],
  };
}
