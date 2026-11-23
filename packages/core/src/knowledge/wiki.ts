/**
 * K4: the knowledge wiki. Beside `about-me.md` (the overview), one Markdown page per person,
 * project and organisation the reading finds, under `knowledge/people/`, `projects/` and
 * `orgs/`, plus answers the user saved from the chat under `saved/`:
 *
 *   # Ana Lopez
 *   ## Summary          a short paragraph, rewritten by a call with no tools when facts arrive
 *   ## Facts            "- fact (source, YYYY-MM-DD)", newest first; added by code, never dropped by a model
 *   ## Might not agree  facts the summary call found that disagree
 *   ## Links            "- [[projects/house-move]]": the edges between pages
 *   ## My notes         the user's own, kept as written
 *
 * `index.md` lists every page with one line and `log.md` says what each run filed; code
 * writes both. Page names come from outside text, so a page's path is only ever its folder
 * and a slug of letters, digits and dashes (`slugOf`), checked again to be inside the folder.
 * Nothing here deletes, renames or merges a page: reading only adds facts and links.
 *
 * Like about-me.md, the pages are notes from outside text, never memory: the chat reads them
 * only through knowledge_search, inside <untrusted> tags.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { KnowledgeSource } from '@aios/shared';
import { type Knowledge, SOURCE_TAIL, cleanNote, sourceTail, writeAtomic } from './file.js';

export const PAGE_KINDS = ['person', 'project', 'org'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
/** `saved`: an answer the user saved from the chat with its Save button. */
export type WikiKind = PageKind | 'saved';
export const WIKI_FOLDERS: Record<WikiKind, string> = { person: 'people', project: 'projects', org: 'orgs', saved: 'saved' };
const KIND_OF_FOLDER = new Map(Object.entries(WIKI_FOLDERS).map(([k, f]) => [f, k as WikiKind]));
const KIND_TITLES: Record<WikiKind, string> = { person: 'Person', project: 'Project', org: 'Organisation', saved: 'Saved answer' };
const INDEX_TITLES: Record<WikiKind, string> = { person: 'People', project: 'Projects', org: 'Organisations', saved: 'Saved answers' };

export const SLUG_CHARS = 60;
export const TITLE_CHARS = 80;
export const FACT_CHARS = 300;
export const SUMMARY_CHARS = 700;
/** Facts kept per page, newest first; far more than a page usually gets. */
export const MAX_FACTS = 300;
export const MAX_LINKS = 60;
/** No more pages are made past this; facts for them are counted and left out. */
export const MAX_PAGES = 3000;
const LOG_LINES = 400;
const MY_NOTES = 'My notes';

export interface PageFact {
  text: string;
  source: KnowledgeSource;
  on?: string | undefined;
  /** A line the user typed (no source after it): kept as written. */
  mine?: boolean | undefined;
  /** K5: only one origin says it so far, or it was written before quotes were kept. */
  unconfirmed?: boolean | undefined;
}

/** K5: one fact's line on a page: "- text (mail, 2026-10-03, unconfirmed)", or as typed for the user's own. */
export const factLine = (f: PageFact) => (f.mine ? `- ${f.text}` : `- ${f.text} ${sourceTail(f)}`);

/** K5: a page's Facts section (heading included), for renderPage and the person profiles. */
export function renderFacts(facts: PageFact[]): string[] {
  return ['## Facts', '', ...(facts.length ? facts.map(factLine) : ['- (nothing yet)']), ''];
}

export interface WikiPage {
  /** "people/ana-lopez" */
  id: string;
  kind: WikiKind;
  title: string;
  summary: string;
  contradictions: string[];
  facts: PageFact[];
  /** Ids of the pages this one links to. */
  links: string[];
  myNotes: string;
  updated: string | null;
}

/** A fact the reading found, for code to file on its page. */
export interface FiledFact {
  kind: PageKind;
  name: string;
  text: string;
  links: { kind: PageKind; name: string }[];
  source: KnowledgeSource;
  on?: string | undefined;
}

/**
 * A page name's slug: letters and digits (any script) joined by dashes, at most 60 characters.
 * No dot, slash or backslash can survive, so "../../.ssh/config" is "ssh-config". Null when nothing is left.
 */
export function slugOf(name: string): string | null {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_CHARS)
    .replace(/-+$/, '');
  return slug || null;
}

const ID_RE = /^(people|projects|orgs|saved)\/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)$/u;

/** "people/ana-lopez" when `id` is a well-formed page id, else null. */
export function checkId(id: string): { kind: WikiKind; slug: string } | null {
  const m = ID_RE.exec(id.normalize('NFKC'));
  if (!m || m[2]!.length > SLUG_CHARS) return null;
  return { kind: KIND_OF_FOLDER.get(m[1]!)!, slug: m[2]! };
}

export const pageId = (kind: WikiKind, name: string): string | null => {
  const slug = slugOf(name);
  return slug ? `${WIKI_FOLDERS[kind]}/${slug}` : null;
};

/** For comparing fact texts and titles. */
export const normal = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const newestFirst = (a: PageFact, b: PageFact) => (b.on ?? '0000').localeCompare(a.on ?? '0000');

export function parsePage(md: string, id: string, kind: WikiKind): WikiPage {
  const p: WikiPage = { id, kind, title: '', summary: '', contradictions: [], facts: [], links: [], myNotes: '', updated: null };
  let current: 'summary' | 'facts' | 'disagree' | 'links' | 'mine' | null = null;
  const summary: string[] = [];
  const mine: string[] = [];
  for (const line of md.split('\n')) {
    const t = /^#\s+(.+?)\s*$/.exec(line);
    if (t && !p.title) {
      p.title = cleanNote(t[1]!, TITLE_CHARS);
      continue;
    }
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const title = h[1]!.toLowerCase();
      current = title === 'summary' ? 'summary' : title === 'facts' ? 'facts' : title === 'might not agree' ? 'disagree' : title === 'links' ? 'links' : title === MY_NOTES.toLowerCase() ? 'mine' : null;
      continue;
    }
    const u = /^_.*Updated (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(line);
    if (u && !current) p.updated = u[1]!;
    if (current === 'mine') {
      mine.push(line);
      continue;
    }
    if (current === 'summary') {
      if (line.trim()) summary.push(line.trim());
      continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!b || !current) continue;
    if (current === 'links') {
      const l = /^\[\[([^\]]+)\]\]/.exec(b[1]!.trim());
      if (l && checkId(l[1]!) && l[1] !== id && !p.links.includes(l[1]!)) p.links.push(l[1]!);
      continue;
    }
    if (current === 'disagree') {
      const text = cleanNote(b[1]!, FACT_CHARS);
      if (text) p.contradictions.push(text);
      continue;
    }
    const m = SOURCE_TAIL.exec(b[1]!);
    const text = cleanNote(m ? b[1]!.slice(0, m.index) : b[1]!, FACT_CHARS);
    if (text) p.facts.push({ text, source: (m?.[1] as KnowledgeSource | undefined) ?? 'chat', ...(m?.[2] ? { on: m[2] } : {}), ...(m?.[3] ? { unconfirmed: true } : {}), ...(m ? {} : { mine: true }) });
  }
  p.summary = cleanNote(summary.join(' '), SUMMARY_CHARS);
  if (p.summary === '(not written yet)') p.summary = '';
  p.myNotes = mine.join('\n').trim();
  p.facts = p.facts.slice(0, MAX_FACTS);
  p.links = p.links.slice(0, MAX_LINKS);
  p.contradictions = p.contradictions.slice(0, 10);
  return p;
}

export function renderPage(p: WikiPage): string {
  const out = [
    `# ${cleanNote(p.title, TITLE_CHARS) || p.id}`,
    '',
    `_${KIND_TITLES[p.kind]}. Updated ${p.updated ?? 'never'} by Astra from your mail, calendar, files and chat. Notes from outside text, not memory: Astra never acts on them. "unconfirmed" means only one source says it so far. Delete a wrong line and it won't be learned again; write your own under "${MY_NOTES}"._`,
    '',
    '## Summary',
    '',
    p.summary || '(not written yet)',
    '',
    ...renderFacts(p.facts),
  ];
  if (p.contradictions.length) out.push('## Might not agree', '', ...p.contradictions.map((c) => `- ${c}`), '');
  out.push('## Links', '', ...(p.links.length ? p.links.map((l) => `- [[${l}]]`) : ['- (none yet)']), '', `## ${MY_NOTES}`, '', p.myNotes, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export interface WikiCheck {
  /** Overview commitments older than `staleDays`. */
  stale: string[];
  /** Pairs of pages that look like the same person, project or organisation. */
  duplicates: [string, string][];
  /** Pages nothing links to and that link to nothing. */
  orphans: string[];
  /** Pages whose facts might not agree. */
  disagree: string[];
  /** Links to pages that don't exist (yet). */
  missing: number;
  pages: number;
}

export interface FileResult {
  /** Pages that got new facts or links. */
  changed: string[];
  created: number;
  facts: number;
  /** Facts left out: no usable page name, or past MAX_PAGES. */
  skipped: number;
}

export interface WikiOptions {
  /**
   * People profiles: the text of a person's page, or null to use renderPage. Must keep the
   * page's title, "## Facts" (renderFacts) and "## My notes" so the page reads back the same.
   */
  renderPerson?: ((p: WikiPage) => string | null) | undefined;
}

export class KnowledgeWiki {
  constructor(
    readonly dir: string,
    private readonly opts: WikiOptions = {},
  ) {}

  get indexPath(): string {
    return join(this.dir, 'index.md');
  }

  get logPath(): string {
    return join(this.dir, 'log.md');
  }

  get checkPath(): string {
    return join(this.dir, 'check.md');
  }

  /** The page's file, only ever inside its folder. Null for an id that isn't well formed. */
  pathOf(id: string): string | null {
    const c = checkId(id);
    if (!c) return null;
    const folder = resolve(this.dir, WIKI_FOLDERS[c.kind]);
    const path = resolve(folder, `${c.slug}.md`);
    return path.startsWith(folder + sep) ? path : null;
  }

  read(id: string): WikiPage | null {
    const path = this.pathOf(id);
    const c = checkId(id);
    // Only plain files: a symbolic link someone made in the folder is not followed.
    if (!path || !c || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
    const p = parsePage(readFileSync(path, 'utf8'), id, c.kind);
    p.facts = p.facts.filter((n) => n.text !== '(nothing yet)');
    return p;
  }

  write(p: WikiPage): void {
    const path = this.pathOf(p.id);
    if (!path) throw new Error('bad page id');
    const folder = join(this.dir, WIKI_FOLDERS[p.kind]);
    // A folder someone swapped for a symbolic link is never written through.
    if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('page folder is a link');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeAtomic(path, (p.kind === 'person' ? this.opts.renderPerson?.(p) : null) ?? renderPage(p));
  }

  /** K5: a page's facts as the facts store has them now (written by code); false when there is no such page. */
  setFacts(id: string, facts: PageFact[], stamp: string): boolean {
    const p = this.read(id);
    if (!p) return false;
    p.facts = facts.slice(0, MAX_FACTS);
    p.updated = stamp;
    this.write(p);
    return true;
  }

  /** Every page's id, by folder. */
  ids(): string[] {
    const out: string[] = [];
    for (const folder of Object.values(WIKI_FOLDERS)) {
      const d = join(this.dir, folder);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).sort()) {
        if (!f.endsWith('.md')) continue;
        const id = `${folder}/${f.slice(0, -3)}`;
        if (checkId(id)) out.push(id);
      }
    }
    return out;
  }

  all(): WikiPage[] {
    return this.ids()
      .map((id) => this.read(id))
      .filter((p): p is WikiPage => !!p);
  }

  /**
   * Files the facts on their pages, by code: a page is made the first time a name is seen, a
   * fact already on the page isn't added again, and links go both ways when both pages exist.
   * Nothing is removed. Pages are written when changed; `stamp` is the local time.
   */
  file(facts: FiledFact[], stamp: string): FileResult {
    const r: FileResult = { changed: [], created: 0, facts: 0, skipped: 0 };
    if (!facts.length) return r;
    const pages = new Map<string, WikiPage>();
    const changed = new Set<string>();
    let count = this.ids().length;
    const load = (kind: PageKind, name: string, create: boolean): WikiPage | null => {
      const id = pageId(kind, name);
      if (!id) return null;
      const had = pages.get(id) ?? this.read(id);
      if (had) {
        pages.set(id, had);
        return had;
      }
      if (!create || count >= MAX_PAGES) return null;
      const title = cleanNote(name, TITLE_CHARS);
      if (!title) return null;
      const p: WikiPage = { id, kind, title, summary: '', contradictions: [], facts: [], links: [], myNotes: '', updated: null };
      pages.set(id, p);
      changed.add(id);
      count++;
      r.created++;
      return p;
    };
    const link = (from: WikiPage, to: string) => {
      if (to === from.id || from.links.includes(to) || from.links.length >= MAX_LINKS) return;
      from.links.push(to);
      changed.add(from.id);
    };
    // Pages first, so a link to a page this batch makes goes both ways.
    const of = facts.map((f) => load(f.kind, f.name, true));
    for (const [n, f] of facts.entries()) {
      // An entry with no text only brings links.
      const text = cleanNote(f.text, FACT_CHARS);
      const page = of[n];
      if (!page) {
        r.skipped++;
        continue;
      }
      if (text && !page.facts.some((x) => normal(x.text) === normal(text))) {
        page.facts.push({ text, source: f.source, ...(f.on ? { on: f.on } : {}) });
        changed.add(page.id);
        r.facts++;
      }
      for (const l of f.links) {
        const to = pageId(l.kind, l.name);
        if (!to) continue;
        link(page, to);
        const back = load(l.kind, l.name, false);
        if (back) link(back, page.id);
      }
    }
    for (const id of changed) {
      const p = pages.get(id)!;
      const own = p.facts.filter((f) => f.mine);
      const rest = p.facts.filter((f) => !f.mine).sort(newestFirst);
      p.facts = [...own, ...rest].slice(0, MAX_FACTS);
      p.updated = stamp;
      this.write(p);
    }
    r.changed = [...changed];
    return r;
  }

  /** K4: the summary call's answer for a page, cleaned by code. */
  setSummary(id: string, summary: string, contradictions: string[], stamp: string): boolean {
    const p = this.read(id);
    if (!p) return false;
    p.summary = cleanNote(summary, SUMMARY_CHARS);
    p.contradictions = [...new Set(contradictions.map((c) => cleanNote(c, FACT_CHARS)).filter(Boolean))].slice(0, 5);
    p.updated = stamp;
    this.write(p);
    return true;
  }

  /** An answer the user saved from the chat (their click). Linked to the pages whose names it mentions. */
  saveAnswer(text: string, stamp: string): string | null {
    const lines = text
      .split(/\n+/)
      .map((l) => cleanNote(l.replace(/^\s*([-*+]|\d+[.)])\s+/, ''), 600))
      .filter(Boolean)
      .slice(0, 40);
    if (!lines.length) return null;
    const day = stamp.slice(0, 10);
    const title = cleanNote(lines[0]!.split(/(?<=[.!?])\s/)[0]!, TITLE_CHARS);
    let id = pageId('saved', `${day} ${title}`);
    if (!id) return null;
    for (let n = 2; this.read(id); n++) id = pageId('saved', `${day} ${title} ${n}`)!;
    const words = ` ${normal(text)} `;
    const links = this.all()
      .filter((p) => p.kind !== 'saved' && normal(p.title).length >= 4 && words.includes(` ${normal(p.title)} `))
      .map((p) => p.id)
      .slice(0, MAX_LINKS);
    this.write({ id, kind: 'saved', title, summary: '', contradictions: [], facts: lines.map((l) => ({ text: l, source: 'chat', on: day })), links, myNotes: '', updated: stamp });
    return id;
  }

  /** index.md: one line per page, written by code. */
  writeIndex(stamp: string, pages = this.all()): void {
    const out = ['# Knowledge index', '', `_Updated ${stamp} by Astra. One line per page; the overview is about-me.md. Notes from outside text, not memory._`, ''];
    for (const kind of [...PAGE_KINDS, 'saved'] as const) {
      const of = pages.filter((p) => p.kind === kind).sort((a, b) => a.title.localeCompare(b.title));
      out.push(`## ${INDEX_TITLES[kind]} (${of.length})`, '');
      out.push(...(of.length ? of.map((p) => `- [[${p.id}]] ${p.title}${p.summary ? `: ${cleanNote(p.summary, 140)}` : ''} (${p.facts.length} facts${p.updated ? `, ${p.updated.slice(0, 10)}` : ''})`) : ['- (none yet)']), '');
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.indexPath, `${out.join('\n').trimEnd()}\n`);
  }

  /** log.md: one line per run that changed something, newest last, the last 400 kept. */
  log(stamp: string, line: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const had = existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8').split('\n').filter((l) => l.startsWith('- ')) : [];
    const lines = [...had, `- ${stamp} ${cleanNote(line, 600)}`].slice(-LOG_LINES);
    writeAtomic(this.logPath, `# Knowledge log\n\n_What each update filed, newest last._\n\n${lines.join('\n')}\n`);
  }

  /**
   * The pages that best match the words, by code: title words count most, then the summary,
   * then facts. Reads the index's lines (titles and summaries) for every page, then only the matching pages' facts.
   */
  search(query: string, limit = 5): WikiPage[] {
    const words = normal(query)
      .split(' ')
      .filter((w) => w.length >= 2)
      .slice(0, 12);
    if (!words.length) return [];
    const scored = this.all()
      .map((p) => {
        const title = ` ${normal(p.title)} `;
        const summary = ` ${normal(p.summary)} `;
        const facts = ` ${normal(p.facts.map((f) => f.text).join(' '))} `;
        let score = 0;
        for (const w of words) {
          if (title.includes(` ${w} `)) score += 5;
          else if (title.includes(` ${w}`)) score += 3;
          if (summary.includes(` ${w}`)) score += 2;
          if (facts.includes(` ${w}`)) score += 1;
        }
        return { p, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title));
    return scored.slice(0, limit).map((s) => s.p);
  }

  /** The weekly check, by code only. */
  check(overview: Knowledge, today: string, staleDays = 30): WikiCheck {
    const pages = this.all();
    const ids = new Set(pages.map((p) => p.id));
    const linkedTo = new Set(pages.flatMap((p) => p.links));
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - staleDays * 86_400_000).toISOString().slice(0, 10);
    const stale = overview.sections.commitments.filter((n) => !n.mine && n.on && n.on < cutoff).map((n) => `${n.text} (${n.on})`);
    const duplicates: [string, string][] = [];
    for (const kind of PAGE_KINDS) {
      const of = pages.filter((p) => p.kind === kind).map((p) => ({ p, words: new Set(normal(p.title).split(' ').filter(Boolean)) }));
      for (let i = 0; i < of.length && duplicates.length < 30; i++)
        for (let j = i + 1; j < of.length && duplicates.length < 30; j++) {
          const [a, b] = of[i]!.words.size <= of[j]!.words.size ? [of[i]!, of[j]!] : [of[j]!, of[i]!];
          if (a.words.size && [...a.words].every((w) => b.words.has(w))) duplicates.push([a.p.title, b.p.title]);
        }
    }
    return {
      stale,
      duplicates,
      orphans: pages.filter((p) => p.kind !== 'saved' && !p.links.length && !linkedTo.has(p.id)).map((p) => p.title),
      disagree: pages.filter((p) => p.contradictions.length).map((p) => p.title),
      missing: pages.flatMap((p) => p.links).filter((l) => !ids.has(l)).length,
      pages: pages.length,
    };
  }

  /** check.md, and the text /knowledge check shows. */
  writeCheck(c: WikiCheck, stamp: string): string {
    const text = checkText(c, stamp);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.checkPath, `# Knowledge check\n\n${text}\n`);
    return text;
  }
}

const list = (items: string[], max = 15) => [...items.slice(0, max).map((s) => `- ${s}`), ...(items.length > max ? [`- and ${items.length - max} more`] : [])];

/** Counts first, then the lists, all written by code. */
export function checkText(c: WikiCheck, stamp: string): string {
  const out = [
    `Checked ${stamp}: ${c.pages} pages. ${c.stale.length} old commitments, ${c.duplicates.length} possible duplicates, ${c.orphans.length} pages with no links, ${c.disagree.length} pages whose facts might not agree.`,
  ];
  if (c.stale.length) out.push('', 'Commitments over a month old (still open?):', ...list(c.stale));
  if (c.duplicates.length) out.push('', 'Might be the same:', ...list(c.duplicates.map(([a, b]) => `${a} and ${b}`)));
  if (c.orphans.length) out.push('', 'No links to or from:', ...list(c.orphans));
  if (c.disagree.length) out.push('', 'Facts that might not agree:', ...list(c.disagree));
  if (c.missing) out.push('', `${c.missing} links point to pages that don't exist yet.`);
  out.push('', 'Fix any of these by editing the pages; Astra never merges or deletes a page itself.');
  return out.join('\n');
}

/** A short line on the wiki for /knowledge. */
export function wikiLine(w: KnowledgeWiki): string {
  const ids = w.ids();
  const n = (kind: WikiKind) => ids.filter((i) => i.startsWith(`${WIKI_FOLDERS[kind]}/`)).length;
  if (!ids.length) return `Wiki: no pages yet. They are written in ${w.dir} as the reading finds people, projects and organisations.`;
  return `Wiki: ${n('person')} people, ${n('project')} projects, ${n('org')} organisations and ${n('saved')} saved answers, in ${w.dir} (index.md lists them). /knowledge check looks for old commitments, duplicates and pages with no links.`;
}
