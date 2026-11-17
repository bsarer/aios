/**
 * Calm mail alerts: new mail no longer appears as a card in the chat. It waits in the side rail's
 * inbox (components/MailRail.tsx). This file is the pure part, tested without a browser
 * (packages/ui/test/inbox.test.ts). Everything is read from the notification items core already
 * sends; from/subject/summary come from email and are only ever shown as plain text.
 *
 * "Seen" and "quiet for an hour" are display choices for this screen only, kept in localStorage.
 * They never reach core: mail keeps arriving, and pause and quiet hours stay core's.
 */
import type { ChatItem, MailRow } from '@aios/shared/protocol';

type Notification = Extract<ChatItem, { kind: 'notification' }>;

export interface InboxRow extends MailRow {
  /** The notification item this row came in, for Ignore. */
  itemId: string;
  /** When that notification was posted. */
  at: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** How long an urgent mail's peek stays out from the rail. */
export const PEEK_MS = 8000;
/** The rail's quiet button holds peeks this long. */
export const QUIET_MS = 60 * 60 * 1000;

const isNote = (i: ChatItem): i is Notification => i.kind === 'notification';

/** When the email itself was sent; mail from before rows carried a date shows when it was posted. */
export const sentAt = (r: InboxRow) => r.date ?? r.at;

/**
 * The row's time: the clock today, else the day too. All mail in one notification used to share
 * the notification's time; each row now shows its own email's.
 */
export function rowTime(r: InboxRow, now: number): string {
  const t = new Date(sentAt(r));
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (t.toDateString() === new Date(now).toDateString()) return time;
  return `${t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Mail from the last day's notifications, newest email first; one row per mail id (the newest notification wins). */
export function inboxRows(items: ChatItem[], now: number): InboxRow[] {
  const seen = new Set<string>();
  const out: InboxRow[] = [];
  const notes = items.filter(isNote).filter((n) => n.at >= now - DAY);
  for (const n of [...notes].sort((a, b) => b.at - a.at)) {
    for (const m of n.mails ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ ...m, itemId: n.id, at: n.at });
    }
  }
  return out.sort((a, b) => sentAt(b) - sentAt(a));
}

/** Not ignored and posted after the user last opened the inbox. */
export const isNew = (r: InboxRow, seenAt: number) => !r.ignored && r.at > seenAt;

export function counts(rows: InboxRow[], seenAt: number): { fresh: number; urgent: number } {
  const fresh = rows.filter((r) => isNew(r, seenAt));
  return { fresh: fresh.length, urgent: fresh.filter((r) => r.urgency === 'high').length };
}

/** The panel's groups, in the order they are shown. Ignored rows stay, greyed, in their group. */
export function groups(rows: InboxRow[]): { needs: InboxRow[]; others: InboxRow[]; low: InboxRow[] } {
  return {
    needs: rows.filter((r) => r.urgency === 'high'),
    others: rows.filter((r) => r.urgency === 'normal'),
    low: rows.filter((r) => r.urgency === 'low'),
  };
}

/**
 * The urgent mail to peek for, if any: only from a notification posted after this page opened
 * (`since`; history loaded with the chat never peeks), not already peeked (`done`), not ignored,
 * not marked quiet by core (quiet hours, the hourly limit), and not during the rail's quiet hour.
 */
export function peekFor(items: ChatItem[], since: number, done: ReadonlySet<string>, quietUntil: number, now: number): InboxRow | null {
  if (now < quietUntil) return null;
  for (const n of items.filter(isNote)) {
    if (n.at < since || n.quiet || done.has(n.id)) continue;
    const m = (n.mails ?? []).find((r) => r.urgency === 'high' && !r.ignored);
    if (m) return { ...m, itemId: n.id, at: n.at };
  }
  return null;
}

/** The sender's name without the address, as the chat card showed it. */
export const senderName = (from: string) => from.replace(/\s*<[^>]*>$/, '') || from;

// ── This screen's own choices, best effort ─────────────────────────────────

const SEEN_KEY = 'astra.inbox.seenAt';
const QUIET_KEY = 'astra.inbox.quietUntil';

function read(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function write(key: string, v: number): void {
  try {
    window.localStorage.setItem(key, String(v));
  } catch {
    // Private window or blocked storage: the choice lasts until the page reloads.
  }
}

/** First visit: mail already in the chat counts as seen, so the badge starts at what is new. */
export const loadSeenAt = (fallback: number) => read(SEEN_KEY) ?? fallback;
export const saveSeenAt = (v: number) => write(SEEN_KEY, v);
export const loadQuietUntil = () => read(QUIET_KEY) ?? 0;
export const saveQuietUntil = (v: number) => write(QUIET_KEY, v);
