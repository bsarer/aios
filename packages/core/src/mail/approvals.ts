/**
 * The approval broker for mail (plan §4, risk tiers). A draft becomes a card with Send,
 * Edit and Discard. The only code path that sends mail is approveSend(), reached from a
 * Send click on that card carrying the hash of what the card showed. The model's
 * mail_send_draft call never gets here: the tool registry refuses every write-tier call.
 *
 *   pending ──Send click (hash matches)──▶ sending ──▶ sent
 *      │  ▲                                  └──────▶ failed ──Send click──▶ sending
 *      │  └── Edit (new hash)
 *      └──── Discard ──▶ discarded           (failed can be edited or discarded too)
 *
 * Attached files (M1) are fixed when the draft is made: their bytes are in the hash, and
 * before a send or an edit each file is read again and must be exactly the same.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { describeMailError } from './errors.js';
import { type AttachmentContent, type OutgoingFields, type ReplyHeaders, type Sender, buildMessage, fieldsHash, newMessageId } from './message.js';
import type { OutgoingAttachment, OutgoingFiles } from './outgoing-files.js';

/** IMAP and SMTP side effects, injected so tests can count them. */
export interface MailOutbox {
  /** Append to the Drafts folder; returns the new UID when the server reports it. */
  saveDraft(raw: Buffer, messageId: string): Promise<number | null>;
  deleteDraft(uid: number): Promise<void>;
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[]; rejected: string[] }>;
  saveSent(raw: Buffer): Promise<void>;
}

type DraftItem = Extract<ChatItem, { kind: 'draft' }>;
type DraftState = DraftItem['state'];

export interface Draft {
  id: string;
  to: string[];
  subject: string;
  body: string;
  /** Mail id being replied to, e.g. INBOX:37. */
  inReplyTo: string | null;
  reply: ReplyHeaders | null;
  /** Files to attach (M1), checked again against their bytes before each send. */
  attachments: OutgoingAttachment[];
  hash: string;
  state: DraftState;
  warnings: string[];
  error: string | null;
  messageId: string;
  draftUid: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

interface Row {
  id: string;
  to_json: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  reply_headers: string | null;
  attachments: string;
  hash: string;
  state: DraftState;
  warnings: string;
  error: string | null;
  message_id: string;
  draft_uid: number | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

const fromRow = (r: Row): Draft => ({
  id: r.id,
  to: JSON.parse(r.to_json) as string[],
  subject: r.subject,
  body: r.body,
  inReplyTo: r.in_reply_to,
  reply: r.reply_headers ? (JSON.parse(r.reply_headers) as ReplyHeaders) : null,
  attachments: JSON.parse(r.attachments) as OutgoingAttachment[],
  hash: r.hash,
  state: r.state,
  warnings: JSON.parse(r.warnings) as string[],
  error: r.error,
  messageId: r.message_id,
  draftUid: r.draft_uid,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sentAt: r.sent_at,
});

export interface NewDraft {
  to: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  reply: ReplyHeaders | null;
  warnings: string[];
  /** Files picked by OutgoingFiles.pick, with the bytes the hash is made from. */
  files?: { attachments: OutgoingAttachment[]; contents: AttachmentContent[] };
}

export interface ApprovalBrokerOptions {
  store: Store;
  outbox: MailOutbox;
  audit: AuditLog;
  from: Sender;
  saveSentCopy: boolean;
  /** Reads attached files again before a send or an edit. Without it, drafts with files can't be sent. */
  files?: Pick<OutgoingFiles, 'load'>;
  /** Show a new card, or update an existing one. */
  show: (item: ChatItem, isNew: boolean) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  clock?: () => number;
  newId?: () => string;
}

export type SendResult = 'sent' | 'failed' | 'refused';

export class ApprovalBroker {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: ApprovalBrokerOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `draft-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  get(id: string): Draft | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  private fields(d: Pick<Draft, 'to' | 'subject' | 'body' | 'reply'>, attachments: AttachmentContent[] = []): OutgoingFields {
    return { from: this.o.from, to: d.to, subject: d.subject, body: d.body, reply: d.reply, attachments };
  }

  /** The attached files' bytes, read again; throws when one is gone or changed. */
  private async contents(list: OutgoingAttachment[]): Promise<AttachmentContent[]> {
    if (!list.length) return [];
    if (!this.o.files) throw new Error('attaching files is turned off ([files] enabled = false)');
    return this.o.files.load(list);
  }

  private item(d: Draft): DraftItem {
    return {
      kind: 'draft',
      id: d.id,
      to: d.to,
      subject: d.subject,
      body: d.body,
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
      ...(d.attachments.length ? { attachments: d.attachments.map((a) => ({ name: a.name, path: a.display, bytes: a.bytes })) } : {}),
      hash: d.hash,
      state: d.state,
      warnings: [...d.warnings, ...d.attachments.flatMap((a) => (a.warning ? [a.warning] : []))],
      ...(d.error ? { error: d.error } : {}),
      at: d.createdAt,
    };
  }

  private refresh(id: string): void {
    const d = this.get(id);
    if (d) this.o.show(this.item(d), false);
  }

  /** Atomic state change; false when the draft was not in one of `from` (e.g. a second Send click). */
  private transition(id: string, from: DraftState[], to: DraftState, extra: { error?: string | null; sentAt?: number } = {}): boolean {
    const r = this.db
      .prepare(
        `UPDATE drafts SET state = ?, error = ?, sent_at = COALESCE(?, sent_at), updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`,
      )
      .run(to, extra.error ?? null, extra.sentAt ?? null, this.clock(), id, ...from);
    return r.changes === 1;
  }

  /** Save to Drafts and show the card. Called by the mail_create_draft tool; never sends. */
  async create(n: NewDraft): Promise<Draft> {
    const now = this.clock();
    const fields = this.fields(n, n.files?.contents);
    const messageId = newMessageId(this.o.from);
    const uid = await this.o.outbox.saveDraft(await buildMessage(fields, messageId, new Date(now)), messageId);
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO drafts (id, to_json, subject, body, in_reply_to, reply_headers, attachments, hash, state, warnings, error, message_id, draft_uid, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        JSON.stringify(n.to),
        n.subject,
        n.body,
        n.inReplyTo,
        n.reply ? JSON.stringify(n.reply) : null,
        JSON.stringify(n.files?.attachments ?? []),
        fieldsHash(fields),
        JSON.stringify(n.warnings),
        messageId,
        uid,
        now,
        now,
      );
    const d = this.get(id)!;
    this.o.show(this.item(d), true);
    return d;
  }

  /**
   * The Send click. Sends only if the card's hash matches the stored draft, the draft is
   * pending (or failed, for a retry), and the fields the message is built from still hash
   * to the approved value. Exactly one of two concurrent clicks can win.
   */
  async approveSend(id: string, shownHash: string): Promise<SendResult> {
    const audit = (entry: Record<string, unknown>) =>
      this.o.audit.append({ kind: 'tool', tool: 'mail_send_draft', tier: 'write', draftId: id, via: 'click', ...entry });
    const d = this.get(id);
    if (!d) {
      audit({ decision: 'denied', reason: 'unknown draft' });
      return 'refused';
    }
    if (d.hash !== shownHash) {
      audit({ decision: 'denied', reason: 'hash does not match the card', shownHash, hash: d.hash });
      this.refresh(id);
      return 'refused';
    }
    if (!this.transition(id, ['pending', 'failed'], 'sending')) {
      audit({ decision: 'denied', reason: `draft is ${d.state}` });
      return 'refused';
    }
    audit({ decision: 'approved', hash: shownHash, to: d.to, ...(d.attachments.length ? { files: d.attachments.length, fileBytes: d.attachments.reduce((n, a) => n + a.bytes, 0) } : {}) });
    this.refresh(id);

    const approved = this.get(id)!;
    try {
      // Attached files are read again here; one that is gone or changed stops the send.
      const fields = this.fields(approved, await this.contents(approved.attachments));
      // Belt and braces: what is about to be built and sent must be what was approved.
      if (fieldsHash(fields) !== shownHash) throw new Error('the draft changed after it was approved');
      const raw = await buildMessage(fields, approved.messageId, new Date(this.clock()));
      const result = await this.o.outbox.send({ from: this.o.from.address, to: fields.to }, raw);
      if (!result.accepted.length) throw new Error(`the server refused every recipient (${result.rejected.join(', ')})`);
      this.transition(id, ['sending'], 'sent', { sentAt: this.clock() });
      audit({ decision: 'approved', ok: true, hash: shownHash, accepted: result.accepted, rejected: result.rejected, bytes: raw.length });
      this.refresh(id);
      if (result.rejected.length) this.o.notice('warning', `Sent, but these addresses were refused: ${result.rejected.join(', ')}.`);
      await this.tidyAfterSend(approved, raw);
      return 'sent';
    } catch (err) {
      const message = (err as Error).message;
      this.transition(id, ['sending'], 'failed', { error: `Not sent: ${describeMailError(err)}.` });
      audit({ decision: 'approved', ok: false, error: message });
      this.refresh(id);
      return 'failed';
    }
  }

  /** Copy to Sent and remove the draft. Failures here never undo or repeat the send. */
  private async tidyAfterSend(d: Draft, raw: Buffer): Promise<void> {
    try {
      if (this.o.saveSentCopy) await this.o.outbox.saveSent(raw);
      if (d.draftUid !== null) await this.o.outbox.deleteDraft(d.draftUid);
    } catch (err) {
      this.o.audit.append({ kind: 'mail', event: 'after_send_failed', draftId: d.id, error: (err as Error).message });
      this.o.notice('warning', 'The email was sent, but I could not update your Sent or Drafts folder.');
    }
  }

  /** The user's own edit from the card. Gives a new hash, so an earlier Send click can no longer match. */
  /**
   * `keep` lists, by position, the attached files to keep (all of them when left out). An
   * edit can only remove files, never add one.
   */
  async edit(id: string, e: { to: string[]; subject: string; body: string; keep?: number[] | undefined }): Promise<boolean> {
    const d = this.get(id);
    if (!d || (d.state !== 'pending' && d.state !== 'failed')) return false;
    const attachments = e.keep ? d.attachments.filter((_, i) => e.keep!.includes(i)) : d.attachments;
    const fields = this.fields({ ...e, reply: d.reply }, await this.contents(attachments));
    const messageId = newMessageId(this.o.from);
    const uid = await this.o.outbox.saveDraft(await buildMessage(fields, messageId, new Date(this.clock())), messageId);
    // The user typed these recipients, so warnings about where they came from no longer apply.
    // Warnings about attached files stay with the files that are kept.
    const r = this.db
      .prepare(
        `UPDATE drafts SET to_json = ?, subject = ?, body = ?, attachments = ?, hash = ?, state = 'pending', warnings = '[]', error = NULL, message_id = ?, draft_uid = ?, updated_at = ?
         WHERE id = ? AND state IN ('pending', 'failed')`,
      )
      .run(JSON.stringify(e.to), e.subject, e.body, JSON.stringify(attachments), fieldsHash(fields), messageId, uid, this.clock(), id);
    if (r.changes !== 1) return false;
    this.o.audit.append({ kind: 'mail', event: 'draft_edited', draftId: id, hash: fieldsHash(fields) });
    if (d.draftUid !== null) await this.o.outbox.deleteDraft(d.draftUid).catch(() => undefined);
    this.refresh(id);
    return true;
  }

  async discard(id: string): Promise<boolean> {
    const d = this.get(id);
    if (!d || !this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'mail', event: 'draft_discarded', draftId: id });
    this.refresh(id);
    if (d.draftUid !== null) await this.o.outbox.deleteDraft(d.draftUid).catch(() => undefined);
    return true;
  }

  /** At startup: a draft left 'sending' by a crash may or may not have gone out. Never resend it on our own. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM drafts WHERE state = 'sending'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['sending'], 'failed', { error: 'The app stopped while sending this. Check your Sent folder before sending it again.' });
      this.o.audit.append({ kind: 'mail', event: 'send_interrupted', draftId: id });
      this.refresh(id);
    }
  }
}
