/**
 * K2: reading one email, document, chat stretch or calendar week into a few notes, and merging
 * notes into the file.
 *
 * Extraction is one small structured call per item, so even a small local model has an easy
 * job. Like triage it has no tools: the requests have no `tools` field and the client it gets
 * can only make structured calls (test). Everything from the item (headers, body, file name and
 * text) is sanitized and inside one <untrusted> wrapper.
 *
 * Merging is code: notes are deduplicated, a person keeps their newest note, and each section
 * keeps its newest notes up to its limit. Once, after the first pass, a tidy call (no tools,
 * the notes inside <untrusted>) can rewrite the sections to fold near-duplicates together.
 */
import { z } from 'zod';
import type { ModelRequest } from '../model.js';
import { KNOWLEDGE_EXTRACT_SYSTEM_PROMPT, KNOWLEDGE_PAGE_SYSTEM_PROMPT, KNOWLEDGE_TIDY_SYSTEM_PROMPT } from '../prompts.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type Knowledge, MODEL_SECTIONS, type ModelSection, type Note, SECTION_LIMITS, cleanNote } from './file.js';
import type { ExtractedNote, ExtractedPage } from './ledger.js';
import { PAGE_KINDS, type WikiPage, pageId } from './wiki.js';

export const MAIL_TEXT_CHARS = 3000;
export const DOC_TEXT_CHARS = 6000;
export const MAX_NOTES_PER_ITEM = 12;

export const MAX_PAGES_PER_ITEM = 8;
export const MAX_FACTS_PER_PAGE = 6;

const PageRef = z.strictObject({ kind: z.enum(PAGE_KINDS), name: z.string().min(1).max(300) });

/**
 * The extractor's answer. Loose on length, so a long note is cut rather than failing the item.
 * K4: `pages` names the people, projects and organisations the item is about, with facts for
 * each one's page and links to the others. Code files them; a page can only gain facts.
 */
export const ExtractedNotes = z.strictObject({
  notes: z.array(z.strictObject({ section: z.enum(MODEL_SECTIONS), text: z.string().min(1).max(1000) })).max(40),
  pages: z
    .array(z.strictObject({ ...PageRef.shape, facts: z.array(z.string().min(1).max(1000)).max(20), links: z.array(PageRef).max(20).optional() }))
    .max(30)
    .optional(),
});

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

const request = (role: ModelRequest['role'], user: string): ModelRequest => ({
  role,
  messages: [
    { role: 'system', content: KNOWLEDGE_EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ],
});

/** One email. Headers and body are all inside the wrapper: anyone can write them. */
export function mailRequest(role: ModelRequest['role'], userName: string, m: MailItemInput): ModelRequest {
  const body = m.body.text ? m.body.text : m.body.html ? sanitize({ html: m.body.html }, { maxChars: MAIL_TEXT_CHARS * 4 }) : '';
  const text = [`From: ${m.from}`, `To: ${m.to.join(', ')}`, `Date: ${m.date}`, `Subject: ${m.subject}`, '', ownText(body)].join('\n');
  return request(
    role,
    [
      `Person: ${userName}`,
      m.sentByUser ? `An email ${userName} wrote and sent (their own words):` : `An email ${userName} received:`,
      wrapUntrusted('email', m.id, sanitize({ text }, { maxChars: MAIL_TEXT_CHARS })),
    ].join('\n'),
  );
}

/** One document from the user's folders. */
export function docRequest(role: ModelRequest['role'], userName: string, d: DocItemInput): ModelRequest {
  const text = [
    `File: ${d.display} (${d.kind})`,
    ...(d.title ? [`Title: ${d.title}`] : []),
    ...(d.author ? [`Author: ${d.author}`] : []),
    ...(d.summary ? [`Description: ${d.summary}`] : []),
    '',
    d.text,
  ].join('\n');
  return request(role, [`Person: ${userName}`, `A document in ${userName}'s folders:`, wrapUntrusted('document', 'file', sanitize({ text }, { maxChars: DOC_TEXT_CHARS }))].join('\n'));
}

/** The chat since the last stretch: the user's own messages and the assistant's replies (which can quote email). */
export function chatRequest(role: ModelRequest['role'], userName: string, lines: string[]): ModelRequest {
  return request(role, [`Person: ${userName}`, `${userName}'s recent chat with their assistant:`, wrapUntrusted('chat', 'chat', sanitize({ text: lines.join('\n') }, { maxChars: 8000 }))].join('\n'));
}

/** The calendar from a week back to a week ahead. */
export function calendarRequest(role: ModelRequest['role'], userName: string, lines: string[]): ModelRequest {
  return request(role, [`Person: ${userName}`, `${userName}'s calendar, a week back to a week ahead:`, wrapUntrusted('calendar', 'calendar', sanitize({ text: lines.join('\n') }, { maxChars: 6000 }))].join('\n'));
}

/** The extractor's notes, cleaned to one plain line each, deduplicated and capped. */
export function cleanExtracted(v: z.infer<typeof ExtractedNotes>): ExtractedNote[] {
  const seen = new Set<string>();
  const out: ExtractedNote[] = [];
  for (const n of v.notes) {
    const text = cleanNote(n.text);
    const key = `${n.section}:${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ section: n.section, text });
    if (out.length >= MAX_NOTES_PER_ITEM) break;
  }
  return out;
}

/**
 * K4: the extractor's pages, cleaned by code: names and facts to plain lines, pages with no
 * usable name (one that makes no slug: "../..") left out, at most 8 pages, 6 facts and 6 links each.
 */
export function cleanPages(v: z.infer<typeof ExtractedNotes>): ExtractedPage[] {
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
    for (const f of p.facts) {
      const text = cleanNote(f, 300);
      if (text && page.facts.length < MAX_FACTS_PER_PAGE && !page.facts.some((x) => normal(x) === normal(text))) page.facts.push(text);
    }
    for (const l of p.links ?? []) {
      const lname = cleanNote(l.name, 80);
      const lid = pageId(l.kind, lname);
      if (lid && lid !== id && page.links.length < MAX_FACTS_PER_PAGE && !page.links.some((x) => pageId(x.kind, x.name) === lid)) page.links.push({ kind: l.kind, name: lname });
    }
  }
  return [...byId.values()].filter((p) => p.facts.length || p.links.length);
}

/** "Ana Lopez: sister…" → "ana lopez": a person's note is replaced by a newer one about them. */
function personKey(text: string): string | null {
  const m = /^([^:]{2,60}):/.exec(text);
  return m ? m[1]!.trim().toLowerCase() : null;
}

const normal = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Merges new notes into the current ones, by code. Lines the user typed are always
 * kept; otherwise each section keeps its newest notes, and a person keeps only their newest one.
 */
export function mergeNotes(current: Knowledge, add: (Note & { section: ModelSection })[]): Knowledge {
  const k: Knowledge = { ...current, sections: { ...current.sections } };
  for (const s of MODEL_SECTIONS) {
    const all = [...k.sections[s], ...add.filter((n) => n.section === s).map(({ section: _s, ...n }) => n)];
    const byKey = new Map<string, Note>();
    for (const n of all) {
      const key = (s === 'people' ? personKey(n.text) : null) ?? normal(n.text);
      const had = byKey.get(key);
      // The user's own lines win; then the newer note (undated notes from before K2 count as oldest).
      if (!had || (!had.mine && (n.mine || (n.on ?? '0000') >= (had.on ?? '0000')))) byKey.set(key, n);
    }
    const kept = [...byKey.values()];
    const own = kept.filter((n) => n.mine);
    const rest = kept.filter((n) => !n.mine).sort((a, b) => (b.on ?? '0000').localeCompare(a.on ?? '0000'));
    k.sections[s] = [...own, ...rest.slice(0, Math.max(0, SECTION_LIMITS[s] - own.length))];
  }
  return k;
}

// ── K4: a page's summary, rewritten when it gets new facts ──

export const PAGE_FACTS_IN_SUMMARY = 80;
export const PageSummary = z.strictObject({
  summary: z.string().max(3000),
  contradictions: z.array(z.string().min(1).max(1000)).max(10),
});

export function pageSummaryRequest(role: ModelRequest['role'], userName: string, p: WikiPage): ModelRequest {
  const lines = [`Page: ${p.title} (${p.kind})`, `Summary now: ${p.summary || '(none)'}`, 'Facts, newest first:', ...p.facts.slice(0, PAGE_FACTS_IN_SUMMARY).map((f) => `- ${f.text} (${f.source}${f.on ? `, ${f.on}` : ''})`)];
  return {
    role,
    messages: [
      { role: 'system', content: KNOWLEDGE_PAGE_SYSTEM_PROMPT },
      { role: 'user', content: [`Person: ${userName}`, 'One page of their knowledge wiki:', wrapUntrusted('knowledge', p.id, sanitize({ text: lines.join('\n') }, { maxChars: 20_000 }))].join('\n') },
    ],
  };
}

// ── Tidy (once, after the first pass) ──

const TidyNote = z.strictObject({ text: z.string().min(1).max(1000), source: z.enum(['mail', 'calendar', 'files', 'chat']), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const TidiedNotes = z.strictObject(Object.fromEntries(MODEL_SECTIONS.map((s) => [s, z.array(TidyNote).max(60)])) as Record<ModelSection, z.ZodArray<typeof TidyNote>>);

export function tidyRequest(role: ModelRequest['role'], userName: string, k: Knowledge): ModelRequest {
  const lines = MODEL_SECTIONS.flatMap((s) => [`[${s}]`, ...k.sections[s].filter((n) => !n.mine).map((n) => `- ${n.text} (${n.source}${n.on ? `, ${n.on}` : ''})`)]);
  return {
    role,
    messages: [
      { role: 'system', content: KNOWLEDGE_TIDY_SYSTEM_PROMPT },
      { role: 'user', content: [`Person: ${userName}`, 'Notes:', wrapUntrusted('knowledge', 'notes', sanitize({ text: lines.join('\n') }, { maxChars: 30_000 }))].join('\n') },
    ],
  };
}

/** The tidied sections, cleaned; null when the answer would lose most of the notes. */
export function cleanTidied(before: Knowledge, v: z.infer<typeof TidiedNotes>): Knowledge | null {
  const k: Knowledge = { ...before, sections: { ...before.sections } };
  let had = 0;
  let has = 0;
  for (const s of MODEL_SECTIONS) {
    had += before.sections[s].length;
    const seen = new Set<string>();
    const notes: Note[] = [];
    for (const n of v[s]) {
      const text = cleanNote(n.text);
      if (!text || seen.has(normal(text))) continue;
      seen.add(normal(text));
      notes.push({ text, source: n.source, ...(n.on ? { on: n.on } : {}) });
    }
    // The user's own lines are never dropped by a model.
    const own = before.sections[s].filter((n) => n.mine && !seen.has(normal(n.text)));
    k.sections[s] = [...own, ...notes].slice(0, SECTION_LIMITS[s]);
    has += k.sections[s].length;
  }
  return had >= 10 && has < had / 3 ? null : k;
}
