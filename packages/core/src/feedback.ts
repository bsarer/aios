/**
 * /feedback: the user's own improvement ideas, typed in the chat and kept for building the backlog.
 * Each idea is one JSON line `{"at": ISO time, "text": ...}` in `feedback.jsonl` in the config
 * folder (so `astra backup` keeps it), readable in any editor or with `jq`. Only Shell calls `add`,
 * for /feedback typed in the chat: there is no tool for it, so neither the model nor text from an
 * email, invite or document can add one, and the ideas never reach the model. `remove` is the
 * same: only the user's typed /feedback remove <n> reaches it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const FEEDBACK_MAX_CHARS = 4000;

const Entry = z.object({ at: z.string(), text: z.string() });
export type FeedbackEntry = z.infer<typeof Entry>;

export class FeedbackLog {
  constructor(readonly path: string) {}

  /** Appends one idea. Returns the entry, or an error line for the chat. */
  add(text: string, now: Date): FeedbackEntry | { error: string } {
    const t = text.trim();
    if (!t) return { error: 'Nothing to save. Type your idea after /feedback.' };
    if (t.length > FEEDBACK_MAX_CHARS) return { error: `That is ${t.length} characters; keep one idea under ${FEEDBACK_MAX_CHARS}.` };
    const entry: FeedbackEntry = { at: now.toISOString(), text: t };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  /** Every saved idea, oldest first. Lines that don't parse (a hand edit gone wrong) are skipped. */
  list(): FeedbackEntry[] {
    return this.lines().flatMap((l) => (l.entry ? [l.entry] : []));
  }

  /**
   * Deletes idea number `n` as /feedback list numbers them (1 is the oldest). Every other line,
   * broken ones included, is written back as it was; the file is replaced in one rename.
   */
  remove(n: number): FeedbackEntry | { error: string } {
    const lines = this.lines();
    const ideas = lines.filter((l) => l.entry);
    const target = Number.isInteger(n) && n >= 1 ? ideas[n - 1] : undefined;
    if (!target?.entry) return { error: ideas.length ? `There is no idea #${n}; /feedback list shows ${ideas.length === 1 ? 'the one' : `all ${ideas.length}`}.` : 'No ideas saved yet.' };
    const kept = lines.filter((l) => l !== target).map((l) => `${l.raw}\n`).join('');
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, kept, { mode: 0o600 });
    renameSync(tmp, this.path);
    return target.entry;
  }

  private lines(): { raw: string; entry: FeedbackEntry | null }[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((raw) => raw.trim())
      .map((raw) => {
        try {
          const parsed = Entry.safeParse(JSON.parse(raw));
          return { raw, entry: parsed.success ? parsed.data : null };
        } catch {
          // keep a broken line as it is
          return { raw, entry: null };
        }
      });
  }
}

/** The chat text for /feedback list: numbered, with the date, newest last. */
export function feedbackListText(entries: FeedbackEntry[], path: string): string {
  if (!entries.length) return 'No ideas saved yet. Type /feedback followed by your idea to add one.';
  const lines = entries.map((e, i) => `${i + 1}. ${e.at.slice(0, 10)}  ${e.text}`);
  return [`${entries.length} idea${entries.length === 1 ? '' : 's'} saved in ${path}:`, ...lines, 'To delete one, type /feedback remove and its number.'].join('\n');
}
