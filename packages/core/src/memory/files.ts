/**
 * Long-term memory as plain, user-owned Markdown files (plan §6):
 *   profile.md               always in context; the user can edit it by hand
 *   facts.md                 one "- fact" line per durable fact the user confirmed
 *   summaries/YYYY-MM-DD.md  nightly consolidation of that day's chat
 * Nothing in this module decides *whether* to write; the shell only calls the write
 * methods after the user clicks Save on a memory card.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Fact {
  text: string;
  /** YYYY-MM-DD, from the trailing comment; null for lines the user typed by hand. */
  savedOn: string | null;
  source: 'chat' | 'email' | null;
}

const FACT_LINE = /^- (.*?)(?:\s*<!--\s*saved (\d{4}-\d{2}-\d{2})(?: · (chat|email))?\s*-->)?\s*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One line, no Markdown comment markers, bounded. Keeps hand-edited files parseable. */
export function cleanFact(text: string): string {
  return text
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class MemoryFiles {
  readonly profilePath: string;
  readonly factsPath: string;
  readonly summariesDir: string;

  constructor(
    readonly dir: string,
    userName = 'you',
  ) {
    this.profilePath = join(dir, 'profile.md');
    this.factsPath = join(dir, 'facts.md');
    this.summariesDir = join(dir, 'summaries');
    mkdirSync(this.summariesDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.profilePath)) {
      writeAtomic(
        this.profilePath,
        `# Profile\n\nName: ${userName}\nRole:\nWorking hours:\nVIP senders:\nTone for replies:\n\n## Standing instructions\n`,
      );
    }
    if (!existsSync(this.factsPath)) writeAtomic(this.factsPath, '# Facts\n\nThings you asked me to remember. Edit freely.\n\n');
  }

  profile(): string {
    return readFileSync(this.profilePath, 'utf8');
  }

  facts(): Fact[] {
    return readFileSync(this.factsPath, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const m = FACT_LINE.exec(line);
        if (!m || !m[1]?.trim()) return [];
        return [{ text: m[1].trim(), savedOn: m[2] ?? null, source: (m[3] as Fact['source']) ?? null }];
      });
  }

  addFact(text: string, savedOn: string, source: 'chat' | 'email'): string {
    const fact = cleanFact(text);
    const current = readFileSync(this.factsPath, 'utf8');
    writeAtomic(this.factsPath, `${current.replace(/\n*$/, '\n')}- ${fact} <!-- saved ${savedOn} · ${source} -->\n`);
    return fact;
  }

  /** Appends a line to the profile's standing instructions (the end of the file). */
  addToProfile(text: string): string {
    const line = cleanFact(text);
    const current = this.profile();
    writeAtomic(this.profilePath, `${current.replace(/\n*$/, '\n')}- ${line}\n`);
    return line;
  }

  /**
   * Removes the fact matching `query`: an exact (case-insensitive) match, or the only
   * fact containing it. Several partial matches remove nothing and are returned so the
   * user can be more specific.
   */
  forget(query: string): { removed: string | null; candidates: string[] } {
    const q = query.trim().toLowerCase();
    if (!q) return { removed: null, candidates: [] };
    const facts = this.facts();
    const exact = facts.filter((f) => f.text.toLowerCase() === q);
    const partial = facts.filter((f) => f.text.toLowerCase().includes(q));
    const target = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
    if (!target) return { removed: null, candidates: partial.map((f) => f.text) };
    const lines = readFileSync(this.factsPath, 'utf8').split('\n');
    const index = lines.findIndex((l) => FACT_LINE.exec(l)?.[1]?.trim() === target.text);
    if (index < 0) return { removed: null, candidates: [] };
    lines.splice(index, 1);
    writeAtomic(this.factsPath, lines.join('\n'));
    return { removed: target.text, candidates: [] };
  }

  summaryDates(): string[] {
    return readdirSync(this.summariesDir)
      .map((f) => f.replace(/\.md$/, ''))
      .filter((d) => DATE.test(d))
      .sort();
  }

  summary(date: string): string | null {
    if (!DATE.test(date)) return null;
    const path = join(this.summariesDir, `${date}.md`);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  writeSummary(date: string, markdown: string): void {
    if (!DATE.test(date)) throw new Error(`bad summary date: ${date}`);
    writeAtomic(join(this.summariesDir, `${date}.md`), markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  }
}
