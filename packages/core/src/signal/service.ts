/**
 * SG1: keeps Signal running while Astra runs. signal-cli's messages go into the inbox; a new
 * one from someone else puts a line written by code in the chat ("New Signal message from
 * Sam.") and a desktop notification, held in quiet hours and while paused. Contacts and
 * groups are synced from signal-cli at start and every six hours. Nothing here reaches a model.
 */
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
  /** A line in the chat, written by code. */
  notice: (text: string) => void;
  desktop: (title: string, body: string) => void;
  spawn?: SignalRpcOptions['spawn'];
  clock?: () => number;
  /** How long new messages are gathered into one line. Default 8 s. */
  batchMs?: number;
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
    if (m.mine || !this.o.notify) return;
    this.pending.push(m);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.o.batchMs ?? 8000);
      this.batchTimer.unref?.();
    }
  }

  /** Posts the gathered messages as one line, unless paused or in quiet hours (they stay unread). */
  flush(): void {
    this.batchTimer = null;
    const batch = this.pending;
    this.pending = [];
    if (!batch.length || this.o.isPaused() || inQuietHours(this.clock(), this.o.timeZone, this.o.quietHours)) return;
    const text = newMessagesLine(batch, (chat) => this.o.inbox.chat(chat)?.name ?? '');
    this.o.notice(`${text} Ask me what they said, or reply from here.`);
    this.o.desktop('Signal', text);
  }

  /** For /signal: one plain line, written by code. */
  status(): string {
    const unread = this.o.inbox.unreadTotal();
    const s = this.rpc.state;
    const head =
      s === 'running'
        ? 'Signal is connected.'
        : s === 'missing'
          ? `Signal is set up, but ${this.o.command} isn't installed. Install the package's Signal add-on: sudo pacman -S signal-cli`
          : s === 'starting'
            ? 'Signal is starting…'
            : `Signal isn't connected right now${this.rpc.detail ? ` (${this.rpc.detail})` : ''}. I'll keep trying.`;
    return `${head} ${unread ? `${unread} unread message${unread === 1 ? '' : 's'}.` : 'No unread messages.'}`;
  }
}

/** "New Signal message from Sam." / "3 new Signal messages from Sam and Family." Written by code. */
export function newMessagesLine(batch: SignalMessage[], chatName: (chat: string) => string): string {
  const who: string[] = [];
  for (const m of batch) {
    const name = plainName(m.kind === 'group' ? chatName(m.chat) || m.groupName || 'a group' : chatName(m.chat) || m.fromName || (m.from.startsWith('+') ? m.from : 'someone'));
    if (!who.includes(name)) who.push(name);
  }
  const names = who.length <= 3 ? (who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)!}` : who[0]!) : `${who.slice(0, 2).join(', ')} and ${who.length - 2} others`;
  return batch.length === 1 ? `New Signal message from ${names}.` : `${batch.length} new Signal messages from ${names}.`;
}
