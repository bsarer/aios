/**
 * The approval broker for mail actions: moving emails to Trash and unsubscribing from a list.
 * Asking (the mail_trash and mail_unsubscribe tools, or Delete and Unsubscribe in the inbox)
 * only puts a card in the chat; the action runs in confirm(), reached solely by a click on that
 * card carrying the hash of what it showed (the same pattern as drafts and file changes).
 *
 *   pending ──confirm click (hash matches)──▶ running ──▶ done
 *      │                                        └──────▶ failed ──confirm click──▶ running
 *      └──── Discard ──▶ discarded
 *
 * Delete means Trash: an email is moved to the server's Trash folder (Gmail keeps it there 30
 * days), never removed outright, and only if the message at that id still has the Message-ID
 * the card was made from. What the card lists (sender, subject, date) is read by code from the
 * server, never written by a model. Unsubscribing uses only the email's own List-Unsubscribe
 * header (unsubscribe.ts); an unsubscribe email becomes an ordinary draft card instead, so
 * mail still goes out only from a Send click (approvals.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import type { ApprovalBroker } from './approvals.js';
import type { Address, InspectedMail, MailClient } from './imap.js';
import { type PostOneClick, UNSUBSCRIBE_HEADERS, unsubscribeWay } from './unsubscribe.js';

type ActionItem = Extract<ChatItem, { kind: 'mail_action' }>;
type ActionState = ActionItem['state'];
type CardFields = Omit<ActionItem, 'kind' | 'id' | 'hash' | 'state' | 'result' | 'at'>;

export type MailActionSpec =
  | { op: 'trash'; mails: { id: string; messageId: string | null }[] }
  | { op: 'unsubscribe'; mailId: string; method: 'one_click' | 'link'; url: string };

/** At most this many emails on one Trash card. */
export const MAX_TRASH = 25;

interface Row {
  id: string;
  spec: string;
  card: string;
  hash: string;
  state: ActionState;
  result: string | null;
  created_at: number;
}

export interface MailActionsOptions {
  store: Store;
  mail: Pick<MailClient, 'inspect' | 'trash'>;
  audit: AuditLog;
  show: (item: ChatItem, isNew: boolean) => void;
  /** Unsubscribe emails become draft cards here. */
  drafts: Pick<ApprovalBroker, 'create'>;
  /** RFC 8058's POST (createOneClickPoster). */
  postOneClick: PostOneClick;
  /** Opens an unsubscribe page in the browser. Without it, pages can't be opened and the card says so. */
  openLink?: (url: string) => Promise<void>;
  /** Called with the ids of emails just moved to Trash, so the inbox can grey them out. */
  onTrashed?: (mailIds: string[]) => void;
  clock?: () => number;
  newId?: () => string;
}

export type MailConfirmResult = 'done' | 'failed' | 'refused';

export type UnsubscribeProposal =
  | { kind: 'card'; item: ActionItem }
  | { kind: 'draft'; draftId: string; to: string }
  | { kind: 'none'; from: string }
  | { kind: 'missing' };

/** A sender's or subject's words for the card: one line, no control or direction characters, capped. */
export function cardText(s: string, max = 200): string {
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const who = (a: Address | null) => cardText(a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'unknown sender');
const siteOf = (url: string) => new URL(url).hostname;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export class MailActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: MailActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `mailact-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM mail_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): ActionItem {
    return { kind: 'mail_action', id: r.id, ...(JSON.parse(r.card) as CardFields), hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
  }

  get(id: string): ActionItem | null {
    const r = this.row(id);
    return r ? this.item(r) : null;
  }

  private refresh(id: string): void {
    const r = this.row(id);
    if (r) this.o.show(this.item(r), false);
  }

  private transition(id: string, from: ActionState[], to: ActionState, result: string | null = null): boolean {
    const r = this.db
      .prepare(`UPDATE mail_actions SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  private card(spec: MailActionSpec, card: CardFields): ActionItem {
    const id = this.newId();
    const specJson = JSON.stringify(spec);
    const cardJson = JSON.stringify(card);
    const hash = createHash('sha256').update(`${id}\n${specJson}\n${cardJson}`).digest('hex');
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO mail_actions (id, spec, card, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, specJson, cardJson, hash, now, now);
    this.o.audit.append({
      kind: 'mail',
      event: 'action_proposed',
      cardId: id,
      op: spec.op,
      ...(spec.op === 'trash' ? { mails: spec.mails.map((m) => m.id) } : { mailId: spec.mailId, method: spec.method, site: siteOf(spec.url) }),
      warnings: card.warnings.length,
    });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  private static listed(m: InspectedMail): CardFields['mails'][number] {
    return { from: who(m.from), subject: cardText(m.subject || '(no subject)'), ...(m.date ? { date: m.date.getTime() } : {}) };
  }

  /** A card asking to move these emails to Trash. Changes nothing. `missing` are ids with no email. */
  async proposeTrash(ids: string[], warnings: string[], signal?: AbortSignal): Promise<{ item: ActionItem | null; missing: string[] }> {
    const unique = [...new Set(ids.map((i) => i.trim()))].slice(0, MAX_TRASH);
    const found: InspectedMail[] = [];
    const missing: string[] = [];
    for (const id of unique) {
      const m = await this.o.mail.inspect(id, [], signal);
      if (m) found.push(m);
      else missing.push(id);
    }
    if (!found.length) return { item: null, missing };
    const item = this.card({ op: 'trash', mails: found.map((m) => ({ id: m.id, messageId: m.messageId })) }, { action: 'trash', mails: found.map(MailActions.listed), warnings });
    return { item, missing };
  }

  /**
   * Unsubscribing from the list one email came from: a card for one-click or a page, a draft
   * card for an unsubscribe email, or nothing when the email names no way to unsubscribe.
   */
  async proposeUnsubscribe(id: string, warnings: string[], signal?: AbortSignal): Promise<UnsubscribeProposal> {
    const m = await this.o.mail.inspect(id, UNSUBSCRIBE_HEADERS, signal);
    if (!m) return { kind: 'missing' };
    const way = unsubscribeWay(m.headers);
    const from = who(m.from);
    if (!way) {
      this.o.audit.append({ kind: 'mail', event: 'unsubscribe_none', mailId: m.id });
      return { kind: 'none', from };
    }
    if (way.method === 'email') {
      const d = await this.o.drafts.create({
        to: [way.to],
        subject: way.subject,
        body: way.body,
        inReplyTo: null,
        reply: null,
        warnings: [`To unsubscribe from ${from}: this address is the one their email gives for it. Sending this asks them to stop.`, ...warnings],
      });
      this.o.audit.append({ kind: 'mail', event: 'unsubscribe_draft', mailId: m.id, draftId: d.id });
      return { kind: 'draft', draftId: d.id, to: way.to };
    }
    const site = siteOf(way.url);
    const extra = way.method === 'link' ? [`This opens ${site}, a page ${from} chose, in your browser. Finish unsubscribing there.`] : [];
    const item = this.card({ op: 'unsubscribe', mailId: m.id, method: way.method, url: way.url }, { action: 'unsubscribe', mails: [MailActions.listed(m)], method: way.method, site, warnings: [...extra, ...warnings] });
    return { kind: 'card', item };
  }

  /** The click. Runs only a pending (or failed) card whose hash matches what it showed. */
  async confirm(id: string, shownHash: string): Promise<MailConfirmResult> {
    const r = this.row(id);
    const spec = r ? (JSON.parse(r.spec) as MailActionSpec) : null;
    const tool = spec?.op === 'unsubscribe' ? 'mail_unsubscribe' : 'mail_trash';
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool, tier: 'write', cardId: id, via: 'click', ...entry });
    if (!r || !spec) {
      audit({ decision: 'denied', reason: 'unknown card' });
      return 'refused';
    }
    if (r.hash !== shownHash) {
      audit({ decision: 'denied', reason: 'hash does not match the card' });
      this.refresh(id);
      return 'refused';
    }
    if (!this.transition(id, ['pending', 'failed'], 'running')) {
      audit({ decision: 'denied', reason: `card is ${r.state}` });
      return 'refused';
    }
    audit({ decision: 'approved', op: spec.op, ...(spec.op === 'trash' ? { mails: spec.mails.map((m) => m.id) } : { mailId: spec.mailId, method: spec.method, site: siteOf(spec.url) }) });
    this.refresh(id);
    try {
      const result = spec.op === 'trash' ? await this.runTrash(spec) : await this.runUnsubscribe(spec);
      this.transition(id, ['running'], 'done', result);
      audit({ decision: 'approved', ok: true });
      this.refresh(id);
      return 'done';
    } catch (err) {
      const why = (err as Error).message;
      this.transition(id, ['running'], 'failed', `Didn't work: ${why}`);
      audit({ decision: 'approved', ok: false, error: why });
      this.refresh(id);
      return 'failed';
    }
  }

  private async runTrash(spec: Extract<MailActionSpec, { op: 'trash' }>): Promise<string> {
    const moved: string[] = [];
    let gone = 0;
    try {
      for (const m of spec.mails) {
        if ((await this.o.mail.trash(m.id, m.messageId)) === 'moved') moved.push(m.id);
        else gone++;
      }
    } catch (err) {
      if (moved.length) this.o.onTrashed?.(moved);
      const done = moved.length ? `moved ${moved.length} of ${spec.mails.length} to Trash, then ` : '';
      throw new Error(`${done}${(err as Error).message}`, { cause: err });
    }
    if (moved.length) this.o.onTrashed?.(moved);
    if (!moved.length) return gone === 1 ? 'That email is no longer there (it may have been moved or deleted already).' : 'Those emails are no longer there (they may have been moved or deleted already).';
    const notThere = gone ? ` ${plural(gone, 'email')} ${gone === 1 ? 'was' : 'were'} no longer there.` : '';
    return `✓ Moved ${plural(moved.length, 'email')} to Trash. You can get ${moved.length === 1 ? 'it' : 'them'} back from the Trash folder for a while.${notThere}`;
  }

  private async runUnsubscribe(spec: Extract<MailActionSpec, { op: 'unsubscribe' }>): Promise<string> {
    const site = siteOf(spec.url);
    if (spec.method === 'one_click') {
      await this.o.postOneClick(spec.url, AbortSignal.timeout(15_000));
      return `✓ Asked ${site} to unsubscribe you. It can take a few days for their emails to stop.`;
    }
    if (!this.o.openLink) throw new Error('opening links is turned off, so the unsubscribe page could not be opened');
    await this.o.openLink(spec.url);
    return `✓ Opened the unsubscribe page on ${site} in your browser. Finish there.`;
  }

  discard(id: string): boolean {
    if (!this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'mail', event: 'action_discarded', cardId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: an action left running by a crash is shown as failed, never re-run on its own. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM mail_actions WHERE state = 'running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['running'], 'failed', 'The app stopped while doing this. Check your mailbox before trying again.');
      this.o.audit.append({ kind: 'mail', event: 'action_interrupted', cardId: id });
      this.refresh(id);
    }
  }
}
