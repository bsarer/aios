/**
 * The approval broker for Signal (SG1). A model call can only put a card in the chat: one
 * message to one chat. The message goes out only in send(), reached solely by a Send click on
 * that card carrying the hash of what the card showed.
 *
 *   pending ──Send click (hash matches)──▶ sending ──▶ sent
 *      │                                      └──────▶ failed ──Send click──▶ sending
 *      └──── Discard ──▶ discarded               (failed can be discarded too)
 *
 * Signal has no way to send a message only once, so a send cut short by a crash is shown as
 * failed with a note to check the phone first; it is never sent again on its own.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { type ChatId, CHAT_ID, sendTarget } from './envelope.js';
import type { SignalInbox } from './inbox.js';
import { SignalError, type SignalRpc } from './rpc.js';

type SignalItem = Extract<ChatItem, { kind: 'signal' }>;
type SignalState = SignalItem['state'];

export interface SignalDraft {
  chat: ChatId;
  text: string;
}

interface Row {
  id: string;
  spec: string;
  card: string;
  hash: string;
  state: SignalState;
  result: string | null;
  created_at: number;
}

type CardFields = Pick<SignalItem, 'to' | 'toDetail' | 'text' | 'warnings'>;

export interface SignalActionsOptions {
  store: Store;
  rpc: Pick<SignalRpc, 'request'>;
  inbox: SignalInbox;
  audit: AuditLog;
  show: (item: ChatItem, isNew: boolean) => void;
  clock?: () => number;
  newId?: () => string;
}

export type SignalSendResult = 'sent' | 'failed' | 'refused';

/** What the card says a chat is, written by code: the number, or that it is a group. */
export function chatDetail(chat: ChatId): string {
  if (chat.startsWith('g:')) return 'Signal group';
  if (chat.startsWith('u:')) return 'Signal user (no number shared)';
  return chat;
}

/** sha256 of the card's id, what is sent and to whom, and what the card shows (exported for tests). */
export function signalHash(id: string, d: SignalDraft, card: CardFields): string {
  return createHash('sha256').update(`${id}\n${JSON.stringify(d)}\n${JSON.stringify(card)}`).digest('hex');
}

export class SignalActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: SignalActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `sig-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM signal_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): SignalItem {
    return { kind: 'signal', id: r.id, ...(JSON.parse(r.card) as CardFields), hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
  }

  get(id: string): SignalItem | null {
    const r = this.row(id);
    return r ? this.item(r) : null;
  }

  private refresh(id: string): void {
    const r = this.row(id);
    if (r) this.o.show(this.item(r), false);
  }

  private transition(id: string, from: SignalState[], to: SignalState, result: string | null = null): boolean {
    const r = this.db
      .prepare(`UPDATE signal_actions SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  /** Show a card for one message. Sends nothing. */
  propose(d: SignalDraft, warnings: string[]): SignalItem {
    if (!CHAT_ID.test(d.chat)) throw new SignalError('refused', 'internal: bad chat id');
    const id = this.newId();
    const name = this.o.inbox.chat(d.chat)?.name ?? '';
    const card: CardFields = { to: name || chatDetail(d.chat), toDetail: chatDetail(d.chat), text: d.text, warnings };
    const hash = signalHash(id, d, card);
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO signal_actions (id, spec, card, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, JSON.stringify(d), JSON.stringify(card), hash, now, now);
    // The audit log gets who and how long, never the words.
    this.o.audit.append({ kind: 'signal', event: 'proposed', cardId: id, chat: auditChat(d.chat), chars: d.text.length, warnings: warnings.length });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  /** The Send click. Sends only a pending (or failed) card whose hash matches; one of two clicks wins. */
  async send(id: string, shownHash: string): Promise<SignalSendResult> {
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: 'signal_send', tier: 'write', cardId: id, via: 'click', ...entry });
    const r = this.row(id);
    if (!r) {
      audit({ decision: 'denied', reason: 'unknown card' });
      return 'refused';
    }
    if (r.hash !== shownHash) {
      audit({ decision: 'denied', reason: 'hash does not match the card' });
      this.refresh(id);
      return 'refused';
    }
    const d = JSON.parse(r.spec) as SignalDraft;
    // Belt and braces: what is about to go out must be what the card showed.
    if (signalHash(id, d, JSON.parse(r.card) as CardFields) !== shownHash) {
      audit({ decision: 'denied', reason: 'card changed after it was shown' });
      return 'refused';
    }
    if (!this.transition(id, ['pending', 'failed'], 'sending')) {
      audit({ decision: 'denied', reason: `card is ${r.state}` });
      return 'refused';
    }
    audit({ decision: 'approved', chat: auditChat(d.chat), chars: d.text.length });
    this.refresh(id);
    try {
      const res = await this.o.rpc.request('send', { ...sendTarget(d.chat), message: d.text });
      const ts = typeof (res as { timestamp?: unknown } | null)?.timestamp === 'number' ? (res as { timestamp: number }).timestamp : this.clock();
      this.o.inbox.add({ chat: d.chat, kind: d.chat.startsWith('g:') ? 'group' : 'person', groupName: '', from: 'me', fromName: '', text: d.text, ts, attachments: 0, mine: true });
      this.transition(id, ['sending'], 'sent', '✓ Sent on Signal.');
      audit({ decision: 'approved', ok: true });
      this.refresh(id);
      return 'sent';
    } catch (err) {
      const why = err instanceof SignalError ? err.message : 'Signal did not answer';
      this.transition(id, ['sending'], 'failed', `Not sent: ${why}.`);
      audit({ decision: 'approved', ok: false, error: (err as Error).message.slice(0, 300) });
      this.refresh(id);
      return 'failed';
    }
  }

  discard(id: string): boolean {
    if (!this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'signal', event: 'discarded', cardId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: a message left sending by a crash may have gone out. Never send it again on our own. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM signal_actions WHERE state = 'sending'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['sending'], 'failed', 'Astra stopped while sending this. Check Signal on your phone before sending it again.');
      this.o.audit.append({ kind: 'signal', event: 'interrupted', cardId: id });
      this.refresh(id);
    }
  }
}

/** Chats in the audit log: groups and people by a short hash, so the log holds no numbers. */
export function auditChat(chat: ChatId): string {
  return `${chat.startsWith('g:') ? 'group' : 'person'}:${createHash('sha256').update(chat).digest('hex').slice(0, 12)}`;
}
