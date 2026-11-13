/**
 * K1: the knowledge base file, `~/.config/aios/knowledge/about-me.md`. Plain Markdown the user
 * can read and edit: a few sections of "- note (source)" lines that the hourly crawler rewrites,
 * and a "My notes" section that is the user's own and kept exactly as written.
 *
 * Every note here was written from outside text (mail, invites, files) or from chat, so the file
 * is never memory: it is not in the chat's context, and knowledge_read shows it to the model only
 * inside <untrusted> tags. One copy a day goes to `history/` before the first change of the day.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_SOURCES, type KnowledgeSource } from '@aios/shared';

export const MODEL_SECTIONS = ['people', 'work', 'commitments', 'interests', 'recent'] as const;
export type ModelSection = (typeof MODEL_SECTIONS)[number];
export type Section = ModelSection | 'upcoming';

export const SECTION_TITLES: Record<Section, string> = {
  people: 'People',
  work: 'Work and projects',
  commitments: 'Commitments and open loops',
  upcoming: 'Upcoming',
  interests: 'Interests and preferences',
  recent: 'Recent activity',
};
const ORDER: Section[] = ['people', 'work', 'commitments', 'upcoming', 'interests', 'recent'];
const MY_NOTES = 'My notes';

/** Notes kept per section; the oldest go first when there are more. */
export const SECTION_LIMITS: Record<Section, number> = { people: 30, work: 20, commitments: 20, upcoming: 30, interests: 20, recent: 20 };
export const NOTE_CHARS = 240;

export interface Note {
  text: string;
  source: KnowledgeSource;
  /** K2: the day of the email, file or event the note came from (YYYY-MM-DD); none for lines the user typed. */
  on?: string | undefined;
  /** K2: a line the user typed (no source after it): never dropped or rewritten by AI OS. */
  mine?: boolean | undefined;
}

export interface Knowledge {
  sections: Record<Section, Note[]>;
  /** The user's own section, verbatim. */
  myNotes: string;
  updated: string | null;
}

export const emptyKnowledge = (): Knowledge => ({
  sections: { people: [], work: [], commitments: [], upcoming: [], interests: [], recent: [] },
  myNotes: '',
  updated: null,
});

/** One plain line: no Markdown, tags or comment markers, so the file stays parseable and inert. */
export function cleanNote(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/<!--|-->|[<>`*_#[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_CHARS);
}

const SOURCE_TAIL = new RegExp(`\\s*\\((${KNOWLEDGE_SOURCES.join('|')})(?:,\\s*(\\d{4}-\\d{2}-\\d{2}))?\\)\\s*$`);

export function parseKnowledge(md: string): Knowledge {
  const k = emptyKnowledge();
  const byTitle = new Map(ORDER.map((s) => [SECTION_TITLES[s].toLowerCase(), s]));
  let current: Section | 'mine' | null = null;
  const mine: string[] = [];
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const title = h[1]!.toLowerCase();
      current = title === MY_NOTES.toLowerCase() ? 'mine' : (byTitle.get(title) ?? null);
      continue;
    }
    const u = /^_Updated (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(line);
    if (u && !current) k.updated = u[1]!;
    if (current === 'mine') {
      mine.push(line);
      continue;
    }
    if (!current) continue;
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!b) continue;
    const m = SOURCE_TAIL.exec(b[1]!);
    // A line the user typed without a source counts as chat: their own words.
    const text = cleanNote(m ? b[1]!.slice(0, m.index) : b[1]!);
    if (text) k.sections[current].push({ text, source: (m?.[1] as KnowledgeSource | undefined) ?? 'chat', ...(m?.[2] ? { on: m[2] } : {}), ...(m ? {} : { mine: true }) });
  }
  k.myNotes = mine.join('\n').trim();
  for (const s of ORDER) k.sections[s] = k.sections[s].slice(0, SECTION_LIMITS[s]);
  return k;
}

export function renderKnowledge(k: Knowledge, userName: string): string {
  const out = [
    `# About ${cleanNote(userName) || 'you'}`,
    '',
    `_Updated ${k.updated ?? 'never'} by AI OS from your mail, calendar, files and chat. These are notes from outside text, not memory: AI OS never acts on them. Edit or delete any line; write your own under "${MY_NOTES}", which is never changed._`,
    '',
  ];
  for (const s of ORDER) {
    out.push(`## ${SECTION_TITLES[s]}`, '');
    const notes = k.sections[s];
    out.push(...(notes.length ? notes.map((n) => (n.mine ? `- ${n.text}` : `- ${n.text} (${n.source}${n.on ? `, ${n.on}` : ''})`)) : ['- (nothing yet)']), '');
  }
  out.push(`## ${MY_NOTES}`, '', k.myNotes, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class KnowledgeFile {
  readonly path: string;
  readonly historyDir: string;

  constructor(
    readonly dir: string,
    private readonly userName: string,
  ) {
    this.path = join(dir, 'about-me.md');
    this.historyDir = join(dir, 'history');
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  text(): string | null {
    return this.exists() ? readFileSync(this.path, 'utf8') : null;
  }

  read(): Knowledge {
    const t = this.text();
    // "(nothing yet)" placeholders are not notes.
    const k = t ? parseKnowledge(t) : emptyKnowledge();
    for (const s of ORDER) k.sections[s] = k.sections[s].filter((n) => n.text !== '(nothing yet)');
    return k;
  }

  /** Writes the file, first keeping today's copy (once a day) and dropping copies past `keepDays`. */
  write(k: Knowledge, today: string, keepDays: number): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    const copy = join(this.historyDir, `about-me-${today}.md`);
    if (this.exists() && !existsSync(copy)) copyFileSync(this.path, copy);
    const copies = readdirSync(this.historyDir).filter((f) => /^about-me-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - keepDays))) rmSync(join(this.historyDir, old), { force: true });
    writeAtomic(this.path, renderKnowledge(k, this.userName));
  }
}
