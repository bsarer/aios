/**
 * SG1: keeps Signal running while Astra runs. signal-cli's messages go into the inbox; new ones
 * from someone else are posted as a notification for the side rail (like calm mail alerts: the
 * chat shows nothing) with a desktop notification whose line is written by code ("New Signal
 * message from Sam."). In quiet hours and while paused they still reach the rail, marked quiet,
 * with no desktop notification and no peek. Contacts and groups are synced from signal-cli at
 * start and every six hours. Nothing here reaches a model: chat items are only shown.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem, SignalRow } from '@aios/shared/protocol';
import type { AuditLog } from '../audit.js';
import { inQuietHours } from '../mail/pipeline.js';
import { auditChat } from './actions.js';
import { type SignalMessage, parseContacts, parseGroups, parseReceive } from './envelope.js';
import type { SignalInbox } from './inbox.js';
import { SignalRpc, type SignalRpcOptions, type SignalState } from './rpc.js';

export interface SignalServiceOptions {
  command: string;
  account: string;
  inbox: SignalInbox;
  audit: AuditLog;
  keepDays: number;
  notify: boolean;
  timeZone: string;
  quietHours?: { start: string; end: string } | undefined;
  isPaused: () => boolean;
  /** Shows a chat item (the side rail reads the notification's `signals`). */
  post: (item: ChatItem) => void;
  desktop: (title: string, body: string) => void;
  spawn?: SignalRpcOptions['spawn'];
  clock?: () => number;
  /** How long new messages are gathered into one notification. Default 8 s. */
  batchMs?: number;
  newId?: () => string;
}

/** A sender's or group's name for a line written by code: one line, no tags, short. */
export function plainName(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F\u2028\u2029<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

export class SignalService {
  readonly rpc: SignalRpc;
  private pending: SignalMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;

  constructor(private readonly o: SignalServiceOptions) {
    this.clock = o.clock ?? Date.now;
    this.rpc = new SignalRpc({
      command: o.command,
      account: o.account,
      onReceive: (p) => this.receive(p),
      onState: (s, detail) => this.state(s, detail),
      ...(o.spawn ? { spawn: o.spawn } : {}),
    });
  }

  start(): void {
    this.o.inbox.prune(this.clock(), this.o.keepDays);
    this.rpc.start();
    this.syncTimer = setInterval(() => {
      this.o.inbox.prune(this.clock(), this.o.keepDays);
      void this.syncContacts();
    }, 6 * 3600_000);
    this.syncTimer.unref?.();
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.rpc.stop();
  }

  private lastState: SignalState | null = null;
  private state(s: SignalState, detail?: string): void {
    if (s === this.lastState) return;
    this.lastState = s;
    this.o.audit.append({ kind: 'signal', event: 'state', state: s, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    // The first moment it runs, learn the contacts and groups (a little later, so signal-cli is ready).
    if (s === 'running') setTimeout(() => void this.syncContacts(), 5000).unref?.();
  }

  async syncContacts(): Promise<number> {
    try {
      const [contacts, groups] = await Promise.all([this.rpc.request('listContacts'), this.rpc.request('listGroups')]);
      const chats = [...parseContacts(contacts), ...parseGroups(groups)];
      this.o.inbox.know(chats);
      this.o.audit.append({ kind: 'signal', event: 'contacts', count: chats.length });
      return chats.length;
    } catch (err) {
      this.o.audit.append({ kind: 'signal', event: 'contacts_error', error: (err as Error).message.slice(0, 200) });
      return 0;
    }
  }

  /** One `receive` notification (exported through the class for tests). */
  receive(params: unknown): void {
    const m = parseReceive(params);
    if (!m) return;
    if (!this.o.inbox.add(m)) return;
    this.o.audit.append({ kind: 'signal', event: 'message', chat: auditChat(m.chat), mine: m.mine, chars: m.text.length, attachments: m.attachments });
    // The side rail always gets it; `[signal] notify` only turns the desktop notification off.
    if (m.mine) return;
    this.pending.push(m);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.o.batchMs ?? 8000);
      this.batchTimer.unref?.();
    }
  }

  /**
   * Posts the gathered messages to the side rail as one notification. Paused or in quiet hours
   * they still go there, marked quiet: no desktop notification and no peek.
   */
  flush(): void {
    this.batchTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    const now = this.clock();
    const quiet = this.o.isPaused() || inQuietHours(now, this.o.timeZone, this.o.quietHours);
    const chatName = (chat: string) => this.o.inbox.chat(chat)?.name ?? '';
    const text = newMessagesLine(batch, chatName);
    this.o.post({
      kind: 'notification',
      id: this.o.newId?.() ?? randomUUID(),
      text,
      at: now,
      signals: batch.map((m) => signalRow(m, chatName)),
      ...(quiet ? { quiet: true } : {}),
    });
    if (!quiet && this.o.notify) this.o.desktop('Signal', text);
  }

  /** The last day's messages from others, newest first, for the side rail when a screen connects. */
  recent(limit = 100): SignalRow[] {
    return this.o.inbox.recentFromOthers(this.clock() - 86_400_000, limit).map(({ message: r, chat: c }) =>
      signalRow(
        { chat: r.chat, kind: c.kind, groupName: c.kind === 'group' ? c.name : '', from: r.from, fromName: r.fromName, text: r.text, ts: r.ts, attachments: r.attachments, mine: false },
        () => c.name,
      ),
    );
  }

  /** For /signal: one plain line, written by code. */
  status(): string {
    const unread = this.o.inbox.unreadTotal();
    const s = this.rpc.state;
    const head =
      s === 'running'
        ? 'Signal is connected.'
        : s === 'missing'
          ? `Signal is set up, but ${this.o.command} isn't installed. Install the Signal add-on: astra addons --signal`
          : s === 'starting'
            ? 'Signal is starting…'
            : `Signal isn't connected right now${this.rpc.detail ? ` (${this.rpc.detail})` : ''}. I'll keep trying.`;
    return `${head} ${unread ? `${unread} unread message${unread === 1 ? '' : 's'}.` : 'No unread messages.'}`;
  }
}

/** The chat's or sender's name as code shows it: the saved name, else the Signal name, else the number. */
function displayName(m: SignalMessage, chatName: (chat: string) => string): string {
  if (m.kind === 'group') return plainName(chatName(m.chat) || m.groupName || 'a group');
  return plainName(chatName(m.chat) || m.fromName || (m.from.startsWith('+') ? m.from : 'someone'));
}

/** Text for the rail, shown as plain text only: one line, no control characters. */
const preview = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** One message as the side rail shows it (exported for tests). */
export function signalRow(m: SignalMessage, chatName: (chat: string) => string): SignalRow {
  const sender = m.kind === 'group' ? plainName(m.fromName || (m.from.startsWith('+') ? m.from : 'someone')) : '';
  return { id: `${m.chat}|${m.from}|${m.ts}`, chat: m.chat, kind: m.kind, name: displayName(m, chatName), sender, text: preview(m.text, 300), attachments: m.attachments, date: m.ts };
}

/** "New Signal message from Sam." / "3 new Signal messages from Sam and Family." Written by code. */
export function newMessagesLine(batch: SignalMessage[], chatName: (chat: string) => string): string {
  const who: string[] = [];
  for (const m of batch) {
    const name = displayName(m, chatName);
    if (!who.includes(name)) who.push(name);
  }
  const names = who.length <= 3 ? (who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)!}` : who[0]!) : `${who.slice(0, 2).join(', ')} and ${who.length - 2} others`;
  return batch.length === 1 ? `New Signal message from ${names}.` : `${batch.length} new Signal messages from ${names}.`;
}
