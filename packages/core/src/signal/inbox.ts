/**
 * SG1: the Signal chats and messages Astra keeps, in its own SQLite store on this computer.
 * signal-cli hands each message over once, so Astra keeps the last [signal] keepDays of them
 * to answer "what did Sam say?". Names and text are stored as they came, and only ever reach
 * a model sanitized inside <untrusted source="signal"> (tools.ts).
 */
import type { Store } from '../store.js';
import type { ChatId, KnownChat, SignalMessage } from './envelope.js';

export interface ChatRow {
  chat: ChatId;
  kind: 'person' | 'group';
  name: string;
  lastAt: number;
  unread: number;
}

export interface MessageRow {
  chat: ChatId;
  from: ChatId | 'me';
  fromName: string;
  text: string;
  ts: number;
  attachments: number;
  mine: boolean;
}

interface DbChat {
  chat: string;
  kind: 'person' | 'group';
  name: string;
  last_at: number;
  unread: number;
}
interface DbMessage {
  chat: string;
  sender: string;
  sender_name: string;
  body: string;
  ts: number;
  attachments: number;
  mine: number;
}

const chatRow = (r: DbChat): ChatRow => ({ chat: r.chat, kind: r.kind, name: r.name, lastAt: r.last_at, unread: r.unread });
const messageRow = (r: DbMessage): MessageRow => ({ chat: r.chat, from: r.sender, fromName: r.sender_name, text: r.body, ts: r.ts, attachments: r.attachments, mine: r.mine === 1 });

export class SignalInbox {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  /** Keeps a message; false when it was already kept (signal-cli can hand one over twice). */
  add(m: SignalMessage): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO signal_messages (chat, sender, sender_name, body, ts, attachments, mine) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.chat, m.from, m.fromName, m.text, m.ts, m.attachments, m.mine ? 1 : 0);
    if (r.changes !== 1) return false;
    // A person's chat is named after them; a group's after the group, when the message says it.
    const name = m.kind === 'group' ? m.groupName : m.mine ? '' : m.fromName;
    this.db
      .prepare(
        `INSERT INTO signal_chats (chat, kind, name, last_at, unread) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
           last_at = MAX(last_at, excluded.last_at), unread = CASE WHEN ? THEN 0 ELSE unread + 1 END`,
      )
      .run(m.chat, m.kind, name, m.ts, m.mine ? 0 : 1, m.mine ? 1 : 0);
    return true;
  }

  /** Contacts and groups from signal-cli, so the user can write to someone before they write first. */
  know(chats: KnownChat[]): void {
    const up = this.db.prepare(
      `INSERT INTO signal_chats (chat, kind, name, last_at, unread) VALUES (?, ?, ?, 0, 0)
       ON CONFLICT(chat) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END`,
    );
    this.db.transaction(() => {
      for (const c of chats) up.run(c.chat, c.kind, c.name);
    })();
  }

  chat(chat: ChatId): ChatRow | null {
    const r = this.db.prepare('SELECT * FROM signal_chats WHERE chat = ?').get(chat) as DbChat | undefined;
    return r ? chatRow(r) : null;
  }

  /** Chats with messages, newest first. */
  chats(limit = 20): ChatRow[] {
    return (this.db.prepare('SELECT * FROM signal_chats WHERE last_at > 0 ORDER BY last_at DESC LIMIT ?').all(limit) as DbChat[]).map(chatRow);
  }

  /** Chats whose name or number holds `query` (case does not matter), ones with messages first. */
  find(query: string, limit = 10): ChatRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const digits = q.replace(/[^\d]/g, '');
    const rows = this.db.prepare('SELECT * FROM signal_chats ORDER BY last_at DESC').all() as DbChat[];
    return rows
      .filter((r) => r.name.toLowerCase().includes(q) || (digits.length >= 4 && r.chat.replace(/[^\d]/g, '').includes(digits)))
      .slice(0, limit)
      .map(chatRow);
  }

  /** The newest messages in a chat, oldest first. */
  messages(chat: ChatId, limit = 30): MessageRow[] {
    const rows = this.db.prepare('SELECT * FROM signal_messages WHERE chat = ? ORDER BY ts DESC LIMIT ?').all(chat, limit) as DbMessage[];
    return rows.reverse().map(messageRow);
  }

  /** The last message in a chat that someone else wrote. */
  lastFromOthers(chat: ChatId): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM signal_messages WHERE chat = ? AND mine = 0 ORDER BY ts DESC LIMIT 1').get(chat) as DbMessage | undefined;
    return r ? messageRow(r) : null;
  }

  /** Messages from others since `since`, newest first, with their chat (for the side rail at connect). */
  recentFromOthers(since: number, limit = 100): { message: MessageRow; chat: ChatRow }[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, c.kind AS c_kind, c.name AS c_name, c.last_at AS c_last_at, c.unread AS c_unread FROM signal_messages m
         JOIN signal_chats c ON c.chat = m.chat WHERE m.mine = 0 AND m.ts >= ? ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(since, limit) as (DbMessage & { c_kind: 'person' | 'group'; c_name: string; c_last_at: number; c_unread: number })[];
    return rows.map((r) => ({ message: messageRow(r), chat: { chat: r.chat, kind: r.c_kind, name: r.c_name, lastAt: r.c_last_at, unread: r.c_unread } }));
  }

  markRead(chat: ChatId): void {
    this.db.prepare('UPDATE signal_chats SET unread = 0 WHERE chat = ?').run(chat);
  }

  unreadTotal(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM signal_chats').get() as { n: number }).n;
  }

  /** Forgets messages older than `keepDays`. */
  prune(now: number, keepDays: number): number {
    return this.db.prepare('DELETE FROM signal_messages WHERE ts < ?').run(now - keepDays * 86_400_000).changes;
  }
}
