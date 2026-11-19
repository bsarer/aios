/**
 * SG1 in the side rail: new Signal messages wait there like mail does (calm mail alerts), instead
 * of a line in the chat. This file is the pure part, tested without a browser
 * (packages/ui/test/signals.test.ts). Everything is read from the notification items core
 * already sends; names and text come from whoever wrote them and are only shown as plain text.
 * The buttons send back only the chat id, checked here again, never a name or the message.
 *
 * "Seen" is this screen's display choice, kept in localStorage; it never reaches core, and
 * never marks a chat read (only reading it does).
 */
import { type ChatItem, SIGNAL_CHAT_ID, type SignalRow } from '@aios/shared/protocol';

type Notification = Extract<ChatItem, { kind: 'notification' }>;

export interface SignalMessageRow extends SignalRow {
  /** When the notification it came in was posted. */
  at: number;
}

/** One chat in the panel: its newest message, and how many came in the last day. */
export interface SignalChatRow {
  chat: string;
  kind: SignalRow['kind'];
  name: string;
  latest: SignalMessageRow;
  messages: SignalMessageRow[];
}

const DAY = 24 * 60 * 60 * 1000;
export const SIGNAL_PEEK_MS = 8000;

const withSignals = (i: ChatItem): i is Notification & { signals: SignalRow[] } => i.kind === 'notification' && Array.isArray(i.signals) && i.signals.length > 0;

/** True once any Signal message has come in on this chat screen: the rail shows Signal's button. */
export const hasSignal = (items: ChatItem[]) => items.some(withSignals);

/**
 * Messages from the last day's notifications, one per message id, newest first. `kept` are the
 * messages core had when this screen connected (hello), so ones from before an update or a
 * restart show too; they count as posted when they were sent.
 */
export function signalMessages(items: ChatItem[], now: number, kept: SignalRow[] = []): SignalMessageRow[] {
  const seen = new Set<string>();
  const out: SignalMessageRow[] = [];
  for (const s of kept) {
    if (s.date < now - DAY || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ ...s, at: s.date });
  }
  for (const n of items.filter(withSignals)) {
    if (n.at < now - DAY) continue;
    for (const s of n.signals) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ ...s, at: n.at });
    }
  }
  return out.sort((a, b) => b.date - a.date);
}

/** The panel's rows: one per chat, the chat with the newest message first. */
export function signalChats(items: ChatItem[], now: number, kept: SignalRow[] = []): SignalChatRow[] {
  const by = new Map<string, SignalChatRow>();
  for (const m of signalMessages(items, now, kept)) {
    const c = by.get(m.chat);
    if (c) c.messages.push(m);
    else by.set(m.chat, { chat: m.chat, kind: m.kind, name: m.name, latest: m, messages: [m] });
  }
  return [...by.values()];
}

/** Posted after the user last opened the Signal panel. */
export const isNewSignal = (m: SignalMessageRow, seenAt: number) => m.at > seenAt;

export function signalCounts(chats: SignalChatRow[], seenAt: number): { fresh: number; chats: number } {
  const fresh = chats.map((c) => c.messages.filter((m) => isNewSignal(m, seenAt)).length);
  return { fresh: fresh.reduce((a, b) => a + b, 0), chats: fresh.filter((n) => n > 0).length };
}

/**
 * The message to peek for, if any: a person's own message (groups wait quietly), only from a
 * notification posted after this page opened, not already peeked, not marked quiet by core
 * (quiet hours, pause) and not during the rail's quiet hour.
 */
export function signalPeekFor(items: ChatItem[], since: number, done: ReadonlySet<string>, quietUntil: number, now: number): SignalMessageRow | null {
  if (now < quietUntil) return null;
  for (const n of items.filter(withSignals)) {
    if (n.at < since || n.quiet || done.has(n.id)) continue;
    const s = n.signals.find((r) => r.kind === 'person');
    if (s) return { ...s, at: n.at };
  }
  return null;
}

/** The words a button sends, naming only the chat by its checked id; null for anything else. */
export function signalAsk(what: 'read' | 'reply', chat: string): string | null {
  if (!SIGNAL_CHAT_ID.test(chat)) return null;
  return what === 'read' ? `Read my Signal chat ${chat}` : `Draft a Signal reply to chat ${chat}`;
}

/** The second line of a row: who wrote it in a group, and the text or its attachments. */
export function signalLine(m: SignalRow): string {
  const files = m.attachments ? `${m.attachments} attachment${m.attachments === 1 ? '' : 's'}` : '';
  const body = m.text || files;
  const extra = m.text && files ? ` (+${files})` : '';
  return `${m.sender ? `${m.sender}: ` : ''}${body}${extra}`;
}

// ── This screen's own choice, best effort ──────────────────────────────────

const SEEN_KEY = 'astra.signal.seenAt';

export function loadSignalSeenAt(fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(SEEN_KEY));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
export function saveSignalSeenAt(v: number): void {
  try {
    window.localStorage.setItem(SEEN_KEY, String(v));
  } catch {
    // Private window or blocked storage: the choice lasts until the page reloads.
  }
}
