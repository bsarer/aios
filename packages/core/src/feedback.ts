/**
 * /feedback: the user's own improvement ideas, typed in the chat and kept for building the backlog.
 * Each idea is one JSON line `{"at": ISO time, "text": ...}` in `feedback.jsonl` in the config
 * folder (so `astra backup` keeps it), readable in any editor or with `jq`. Only Shell calls `add`,
 * for /feedback typed in the chat: there is no tool for it, so neither the model nor text from an
 * email, invite or document can add one, and the ideas never reach the model.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    if (!existsSync(this.path)) return [];
    const out: FeedbackEntry[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = Entry.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // skip a broken line
      }
    }
    return out;
  }
}

/** The chat text for /feedback list: numbered, with the date, newest last. */
export function feedbackListText(entries: FeedbackEntry[], path: string): string {
  if (!entries.length) return 'No ideas saved yet. Type /feedback followed by your idea to add one.';
  const lines = entries.map((e, i) => `${i + 1}. ${e.at.slice(0, 10)}  ${e.text}`);
  return [`${entries.length} idea${entries.length === 1 ? '' : 's'} saved in ${path}:`, ...lines].join('\n');
}
