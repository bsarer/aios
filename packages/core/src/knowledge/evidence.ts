/**
 * K5: the checks every fact passes before it is kept, all by code.
 *
 * The extractor returns each note and page fact with `basis` (stated, observed or inferred) and
 * `quote`, the exact words from the item. Code keeps a fact only when:
 * - it isn't inferred: guesses are never kept;
 * - its quote really is in the item (compared on letters and digits, so spacing and case don't matter);
 * - a relationship to the user ("sister", "colleague") is in the quote, and the quote is the
 *   user's own words (their sent mail or chat lines): a surname, a "hey bro" or another
 *   person's "my sister" never makes one;
 * - a liking ("loves", "favourite") is in the quote, and when it is the user's (an interest, or
 *   any line about them), the quote is their own words: a city on a booking is not a liking;
 * - on the local model (`judgement: false`), it only says what happened: no relationships,
 *   likings or interests at all, which are left to the cloud model.
 */
import { norm } from './facts.js';

export type Basis = 'stated' | 'observed' | 'inferred';

/** Relationships to a person. Job titles ("manager") are not here: a signature can state those. */
const RELATIONS: [RegExp, string][] = [
  [/\b(sisters?|sis)\b/, 'sister'],
  [/\b(brothers?)\b/, 'brother'],
  [/\bsiblings?\b/, 'sibling'],
  [/\b(mother|mom|mum|mama|mommy)\b/, 'mother'],
  [/\b(father|dad|papa|daddy)\b/, 'father'],
  [/\b(parents?)\b/, 'parent'],
  [/\b(daughters?)\b/, 'daughter'],
  [/\b(sons?)\b/, 'son'],
  [/\b(cousins?)\b/, 'cousin'],
  [/\b(aunts?|auntie)\b/, 'aunt'],
  [/\b(uncles?)\b/, 'uncle'],
  [/\b(nieces?)\b/, 'niece'],
  [/\b(nephews?)\b/, 'nephew'],
  [/\b(grandmother|grandma|granny|grandfather|grandpa|grandparents?)\b/, 'grandparent'],
  [/\b(in ?laws?)\b/, 'in-law'],
  [/\b(wife|husband|spouse)\b/, 'spouse'],
  [/\b(girlfriend|boyfriend|fianc[eé]e?|partner)\b/, 'partner'],
  [/\b(relatives?|family member)\b/, 'relative'],
  [/\b(colleagues?|co ?workers?|teammates?|team mates?|workmates?)\b/, 'colleague'],
  [/\b(boss|my manager|line manager|supervisor)\b/, 'boss'],
  [/\b(friends?|best friend|bff)\b/, 'friend'],
  [/\b(neighbou?rs?)\b/, 'neighbour'],
  [/\b(landlord|landlady|tenant|roommate|flatmate)\b/, 'housing'],
];
const LIKING = /\b(likes?|liked|loves?|loved|enjoys?|enjoyed|fond of|fan of|favou?rites?|interested in|passionate|passion for|prefers?|hates?|dislikes?)\b/;

const plain = (s: string) => ` ${norm(s)} `;

/** The relationship a text names ("sister"), or null. */
export function relationOf(text: string): string | null {
  const t = plain(text);
  for (const [re, name] of RELATIONS) if (re.test(t)) return name;
  return null;
}

const relationsIn = (text: string) => new Set(RELATIONS.filter(([re]) => re.test(plain(text))).map(([, n]) => n));
const likes = (text: string) => LIKING.test(plain(text));

export interface ItemText {
  /** Everything the model was shown from the item, as it was shown (sanitized). */
  text: string;
  /** The part that is the user's own words: their sent mail's own text, or their chat lines. Empty otherwise. */
  own: string;
  /** False on the local model: it only records what happened. */
  judgement: boolean;
}

export interface Candidate {
  text: string;
  basis: Basis;
  quote: string;
  /** "me": a line about the user (an about-me section); a page fact otherwise. */
  aboutUser: boolean;
  section?: string | undefined;
}

export type Verdict = { ok: true; relation: string | null; byUser: boolean; quote: string } | { ok: false; why: 'inferred' | 'no_quote' | 'quote_not_found' | 'relation' | 'liking' | 'judgement' };

export const QUOTE_MIN = 3;
export const QUOTE_CHARS = 300;

/** Whether `quote` is in `text`, on letters and digits only. */
export function quoted(quote: string, text: string): boolean {
  const q = norm(quote);
  return q.length >= QUOTE_MIN && plain(text).includes(` ${q} `);
}

export function checkFact(c: Candidate, item: ItemText): Verdict {
  if (c.basis === 'inferred') return { ok: false, why: 'inferred' };
  const quote = c.quote.replace(/\s+/g, ' ').trim().slice(0, QUOTE_CHARS);
  if (norm(quote).length < QUOTE_MIN) return { ok: false, why: 'no_quote' };
  if (!quoted(quote, item.text)) return { ok: false, why: 'quote_not_found' };
  const byUser = !!item.own && quoted(quote, item.own);
  const rels = relationsIn(c.text);
  const liking = likes(c.text);
  const interest = c.section === 'interests';
  if (!item.judgement && (rels.size || liking || interest)) return { ok: false, why: 'judgement' };
  // Every relationship the fact names must be in the quote, and in the user's own words.
  if (rels.size) {
    const inQuote = relationsIn(quote);
    if (!byUser || [...rels].some((r) => !inQuote.has(r))) return { ok: false, why: 'relation' };
  }
  // A liking is only in someone's words; the user's own likings and interests only in theirs.
  if (liking && (c.basis !== 'stated' || !likes(quote) || ((c.aboutUser || interest) && !byUser))) return { ok: false, why: 'liking' };
  if (interest && (c.basis !== 'stated' || !byUser)) return { ok: false, why: 'liking' };
  return { ok: true, relation: rels.size && byUser ? [...rels][0]! : null, byUser, quote };
}
