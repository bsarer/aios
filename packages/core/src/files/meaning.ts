/**
 * Finding files by meaning (F3). Each file gets one vector from the local embedding model
 * (`ModelClient.embed`, Ollama on loopback only), made from its name, title, description,
 * keywords and the start of its text. That text comes from files anyone can send, so it is
 * sanitized and wrapped in <untrusted source="document"> like everything else from a file;
 * the embedding model has no tools and returns only numbers, so the text can steer nothing
 * but its own file's place in a ranking.
 *
 * files_search blends the word ranking (F2's fields and the whole text) with the meaning
 * ranking by reciprocal rank fusion, and falls back to words alone when the model is off.
 */
import { sanitize, wrapUntrusted } from '../untrusted.js';
import type { FileCatalog, IndexedFile, SearchHit, SearchQuery } from './catalog.js';
import { KIND_TEXT } from './roots.js';

export interface Embedder {
  /** The embedding model's name, stored with each vector. */
  model: string;
  batchSize: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

const VECTOR_TEXT_CHARS = 2400;

/** What a file's vector is made from, sanitized and wrapped as document text. */
export function vectorText(f: IndexedFile, display: string, body: string): string {
  const text = [
    `File: ${display}`,
    `Type: ${KIND_TEXT[f.kind]}`,
    f.facts?.title ? `Title: ${f.facts.title}` : '',
    f.summary ? `About: ${f.summary}` : '',
    f.keywords.length ? `Keywords: ${f.keywords.join(', ')}` : '',
    body ? `Text: ${body}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return wrapUntrusted('document', display, sanitize({ text }, { maxChars: VECTOR_TEXT_CHARS }));
}

/** Reciprocal rank fusion's usual constant: later ranks still count, the top ones most. */
const RRF_K = 60;
const CANDIDATES = 50;

export interface RankedFiles {
  files: IndexedFile[];
  /** No file had all the words (F2's fallback). */
  loose: boolean;
  hits: Map<string, SearchHit>;
  /** Files found by meaning, with their cosine similarity. */
  meaning: Map<string, number>;
  /** Search by meaning was asked for but couldn't run (the model is off or down). */
  meaningDown: boolean;
}

export interface RankOptions {
  catalog: Pick<FileCatalog, 'search' | 'nearest' | 'getMany'>;
  embedder?: Embedder | undefined;
  minScore: number;
  signal?: AbortSignal | undefined;
}

/** Files for a search, best first: words and meaning together when both can run. */
export async function rankFiles(q: SearchQuery, o: RankOptions): Promise<RankedFiles> {
  const limit = Math.min(Math.max(q.limit ?? 15, 1), 50);
  const words = o.catalog.search({ ...q, limit: q.query ? CANDIDATES : limit });
  const out = (files: IndexedFile[], meaning = new Map<string, number>(), meaningDown = false): RankedFiles => ({
    files: files.slice(0, limit),
    loose: words.loose,
    hits: words.hits,
    meaning,
    meaningDown,
  });
  if (!q.query?.trim() || !o.embedder) return out(words.files);
  let vec: Float32Array;
  try {
    [vec] = (await o.embedder.embed([q.query.trim()], o.signal)) as [Float32Array];
  } catch {
    return out(words.files, undefined, true);
  }
  const near = o.catalog.nearest(vec, o.embedder.model, { ...q, limit: CANDIDATES, minScore: o.minScore });
  const meaning = new Map(near.map((m) => [m.path, m.score]));
  const score = new Map<string, number>();
  // A loose word match (only some of the words) counts for less than a full one.
  const wordWeight = words.loose ? 0.5 : 1;
  words.files.forEach((f, n) => score.set(f.path, (score.get(f.path) ?? 0) + wordWeight / (RRF_K + n + 1)));
  near.forEach((m, n) => score.set(m.path, (score.get(m.path) ?? 0) + 1 / (RRF_K + n + 1)));
  const order = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const known = new Map(words.files.map((f) => [f.path, f]));
  const missing = o.catalog.getMany(order.filter((p) => !known.has(p)));
  for (const f of missing) known.set(f.path, f);
  return out(order.flatMap((p) => (known.has(p) ? [known.get(p)!] : [])), meaning);
}

const FIELD_TEXT: Record<string, string> = {
  name: 'the name',
  folder: 'the folder',
  title: 'the title',
  keywords: 'the keywords',
  tags: 'your tags',
  description: 'the description',
  details: 'the details',
  text: 'the text',
};

/**
 * One line on why a file matched, made by code: where the words were, or that it is close in
 * meaning. The snippet is file text: callers show it as plain text or inside a wrapper.
 */
export function whyMatched(path: string, r: Pick<RankedFiles, 'hits' | 'meaning'>): { why: string; snippet?: string } {
  const hit = r.hits.get(path);
  const parts: string[] = [];
  if (hit?.fields.length) {
    const fields = hit.fields.map((f) => FIELD_TEXT[f] ?? f);
    parts.push(`Your words are in ${fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0]}`);
  }
  if (r.meaning.has(path)) parts.push(parts.length ? 'and it is close in meaning' : 'Close in meaning to what you asked');
  const why = parts.length ? `${parts.join(' ')}.` : 'Newest match for the filters.';
  return { why, ...(hit?.snippet ? { snippet: hit.snippet } : {}) };
}
