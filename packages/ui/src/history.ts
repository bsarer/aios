/**
 * Up/Down in the message box steps through what the user sent, like a shell. Pure, so it can be
 * tested without a browser (packages/ui/test/history.test.ts). Nothing is stored: the list is the
 * user's own messages already in the chat plus what was sent from this page, commands included.
 */

export interface Recall {
  /** Oldest first. */
  entries: string[];
  /** The entry shown now, or null when the box holds the user's own typing. */
  at: number | null;
  /** What the box held before Up was first pressed, put back by Down past the newest entry. */
  draft: string;
}

export const MAX_ENTRIES = 200;

export const emptyRecall = (): Recall => ({ entries: [], at: null, draft: '' });

/** Adds a sent message; a repeat of the newest entry is kept once. Browsing ends. */
export function remember(r: Recall, text: string): Recall {
  const t = text.trim();
  const entries = !t || r.entries.at(-1) === t ? r.entries : [...r.entries, t].slice(-MAX_ENTRIES);
  return { entries, at: null, draft: '' };
}

/** Puts earlier messages (from the chat as loaded) before the ones sent from this page. */
export function seed(r: Recall, earlier: string[]): Recall {
  let entries: string[] = [];
  for (const e of [...earlier, ...r.entries]) {
    const t = e.trim();
    if (t && entries.at(-1) !== t) entries.push(t);
  }
  entries = entries.slice(-MAX_ENTRIES);
  return { entries, at: null, draft: r.draft };
}

/** Up: the entry before the one shown, starting from the newest. null when there is nothing older. */
export function up(r: Recall, current: string): { recall: Recall; text: string } | null {
  if (!r.entries.length || r.at === 0) return null;
  const at = r.at === null ? r.entries.length - 1 : r.at - 1;
  const draft = r.at === null ? current : r.draft;
  return { recall: { ...r, at, draft }, text: r.entries[at] ?? '' };
}

/** Down: the entry after the one shown; past the newest, the draft comes back. null when not browsing. */
export function down(r: Recall): { recall: Recall; text: string } | null {
  if (r.at === null) return null;
  if (r.at >= r.entries.length - 1) return { recall: { ...r, at: null, draft: '' }, text: r.draft };
  const at = r.at + 1;
  return { recall: { ...r, at }, text: r.entries[at] ?? '' };
}

/** Typing ends browsing: the edited text is the user's own now. */
export const edited = (r: Recall): Recall => (r.at === null ? r : { ...r, at: null, draft: '' });

/** Up only takes over on the first line, Down only on the last, so they still move within a long message. */
export function onFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes('\n');
}
export function onLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes('\n');
}
