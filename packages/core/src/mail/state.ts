/**
 * Persisted mail state (plan §5): per-folder UIDVALIDITY and last seen UID, and the
 * queue of new messages waiting for triage and notification. Message-ID is the key,
 * so a message is processed once even if the server renumbers UIDs.
 */
import type { TriageItem } from '@aios/shared';
import type { Store } from '../store.js';

export interface FolderState {
  uidValidity: string;
  lastUid: number;
  checkedAt: number;
}

export interface NewMail {
  messageId: string;
  mailId: string;
  /** "Name <address>", as sent; untrusted. */
  from: string;
  subject: string;
  date: number | null;
  /** sanitize()d body excerpt for triage. */
  body: string;
}

export type MailStatus = 'pending' | 'triaged' | 'notified' | 'ignored';

export interface MailEvent extends NewMail {
  receivedAt: number;
  status: MailStatus;
  triage: TriageItem | null;
  attempts: number;
}

const KEEP_EVENTS = 200;

interface Row {
  message_id: string;
  mail_id: string;
  from_text: string;
  subject: string;
  date: number | null;
  received_at: number;
  body: string;
  status: MailStatus;
  triage: string | null;
  attempts: number;
}

const toEvent = (r: Row): MailEvent => ({
  messageId: r.message_id,
  mailId: r.mail_id,
  from: r.from_text,
  subject: r.subject,
  date: r.date,
  receivedAt: r.received_at,
  body: r.body,
  status: r.status,
  triage: r.triage ? (JSON.parse(r.triage) as TriageItem) : null,
  attempts: r.attempts,
});

export class MailState {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  folder(folder: string): FolderState | null {
    const r = this.db.prepare('SELECT uidvalidity, last_uid, checked_at FROM mail_state WHERE folder = ?').get(folder) as
      | { uidvalidity: string; last_uid: number; checked_at: number }
      | undefined;
    return r ? { uidValidity: r.uidvalidity, lastUid: r.last_uid, checkedAt: r.checked_at } : null;
  }

  known(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM mail_events WHERE message_id = ?').get(messageId);
  }

  /**
   * Queue new messages and advance the folder state in one transaction, so a crash
   * between the two can neither lose a message nor queue it twice. Returns how many were new.
   */
  record(folder: string, state: FolderState, mails: NewMail[], receivedAt: number): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO mail_events (message_id, mail_id, from_text, subject, date, received_at, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    let added = 0;
    this.db.transaction(() => {
      for (const m of mails) added += insert.run(m.messageId, m.mailId, m.from, m.subject, m.date, receivedAt, m.body).changes;
      this.db
        .prepare(
          `INSERT INTO mail_state (folder, uidvalidity, last_uid, checked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(folder) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, checked_at = excluded.checked_at`,
        )
        .run(folder, state.uidValidity, state.lastUid, state.checkedAt);
      this.prune();
    })();
    return added;
  }

  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM mail_events WHERE status IN ('notified', 'ignored') AND message_id NOT IN
         (SELECT message_id FROM mail_events ORDER BY received_at DESC LIMIT ?)`,
      )
      .run(KEEP_EVENTS);
  }

  withStatus(status: MailStatus, limit = 50): MailEvent[] {
    return (this.db.prepare('SELECT * FROM mail_events WHERE status = ? ORDER BY received_at, rowid LIMIT ?').all(status, limit) as Row[]).map(toEvent);
  }

  saveTriage(messageId: string, item: TriageItem): void {
    this.db.prepare("UPDATE mail_events SET status = 'triaged', triage = ? WHERE message_id = ? AND status = 'pending'").run(JSON.stringify(item), messageId);
  }

  failedAttempt(messageIds: string[]): void {
    const stmt = this.db.prepare('UPDATE mail_events SET attempts = attempts + 1 WHERE message_id = ?');
    this.db.transaction(() => messageIds.forEach((id) => stmt.run(id)))();
  }

  markNotified(messageIds: string[], at: number): void {
    const stmt = this.db.prepare("UPDATE mail_events SET status = 'notified' WHERE message_id = ? AND status = 'triaged'");
    this.db.transaction(() => {
      messageIds.forEach((id) => stmt.run(id));
      this.db.prepare('INSERT INTO notification_log (at) VALUES (?)').run(at);
      this.db.prepare('DELETE FROM notification_log WHERE at < ?').run(at - 24 * 60 * 60 * 1000);
    })();
  }

  markIgnored(mailId: string): void {
    this.db.prepare("UPDATE mail_events SET status = 'ignored' WHERE mail_id = ?").run(mailId);
  }

  notificationsSince(since: number): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM notification_log WHERE at >= ?').get(since) as { n: number }).n;
  }
}
