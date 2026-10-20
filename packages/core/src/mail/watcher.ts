/**
 * Mail watcher (plan §5, no AI): an IDLE connection on INBOX plus a fallback poll.
 * New messages are queued in SQLite together with the folder state, keyed by
 * Message-ID, so reconnects, server restarts and UIDVALIDITY changes cause no
 * duplicates and no losses. No new mail means no work and no model calls.
 */
import type { ImapFlow } from 'imapflow';
import { sanitize } from '../untrusted.js';
import { type Address, type MailConnection, connect, mailId, readFull } from './imap.js';
import type { MailState, NewMail } from './state.js';

const FOLDER = 'INBOX';
/** After a UIDVALIDITY change, look back this far before the last check (clock skew). */
const RESYNC_MARGIN_MS = 15 * 60 * 1000;
const TRIAGE_BODY_CHARS = 2000;

export interface MailboxInfo {
  uidValidity: string;
  uidNext: number;
}

/** The IMAP operations the watcher needs; ImapMailSource in production, a fake in tests. */
export interface MailSource {
  /** Connect and select INBOX. Rejects on failure. */
  open(): Promise<MailboxInfo>;
  /** Current UIDVALIDITY and UIDNEXT of the open mailbox. */
  info(): Promise<MailboxInfo>;
  /** Messages with UID greater than `uid`. */
  fetchAfter(uid: number): Promise<(NewMail & { uid: number })[]>;
  /** Messages that arrived on or after `date` (used after a UIDVALIDITY change). */
  fetchSince(date: Date): Promise<(NewMail & { uid: number })[]>;
  /** Called when the server announces new messages. */
  onExists(cb: () => void): void;
  /** Called once when the connection ends, for any reason. */
  onClose(cb: () => void): void;
  close(): Promise<void>;
}

export type WatcherStatus = 'connecting' | 'connected' | 'error';

export interface WatcherOptions {
  source: () => MailSource;
  state: MailState;
  pollMs: number;
  /** Called after new messages were queued. */
  onNew: (count: number) => void;
  onStatus: (status: WatcherStatus, detail?: string) => void;
  now?: () => number;
  /** Reconnect delays in ms; the last value repeats. */
  backoffMs?: number[];
}

export class MailWatcher {
  private source: MailSource | null = null;
  private poll: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private checking: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly backoff: number[];

  constructor(private readonly o: WatcherOptions) {
    this.now = o.now ?? Date.now;
    this.backoff = o.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.retry);
    await this.source?.close().catch(() => undefined);
    this.source = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.attempt === 0) this.o.onStatus('connecting');
    const source = this.o.source();
    let closed = false;
    source.onClose(() => {
      if (closed) return;
      closed = true;
      clearInterval(this.poll);
      if (this.source === source) this.source = null;
      if (!this.stopped) this.o.onStatus('connecting', 'connection lost');
      this.scheduleReconnect();
    });
    try {
      await source.open();
      if (this.stopped) return void (await source.close());
      this.source = source;
      this.attempt = 0;
      this.o.onStatus('connected');
      source.onExists(() => void this.check());
      clearInterval(this.poll);
      this.poll = setInterval(() => void this.check(), this.o.pollMs);
      this.poll.unref?.();
      await this.check();
    } catch (err) {
      this.o.onStatus('error', (err as Error).message);
      if (!closed) {
        closed = true;
        await source.close().catch(() => undefined);
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff[Math.min(this.attempt++, this.backoff.length - 1)]!;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), delay);
    this.retry.unref?.();
  }

  /** Look for new mail. Serialised: overlapping triggers (IDLE + poll) run one after another. */
  check(): Promise<void> {
    this.checking = this.checking.then(() => this.checkOnce()).catch(() => undefined);
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const source = this.source;
    if (!source) return;
    const info = await source.info();
    const now = this.now();
    const prev = this.o.state.folder(FOLDER);
    if (!prev) {
      // First run: start from now instead of triaging the whole existing mailbox.
      this.o.state.record(FOLDER, { uidValidity: info.uidValidity, lastUid: info.uidNext - 1, checkedAt: now }, [], now);
      return;
    }
    const resync = prev.uidValidity !== info.uidValidity;
    const found = resync ? await source.fetchSince(new Date(prev.checkedAt - RESYNC_MARGIN_MS)) : await source.fetchAfter(prev.lastUid);
    const fresh = found.filter((m) => !this.o.state.known(m.messageId));
    const lastUid = Math.max(resync ? info.uidNext - 1 : prev.lastUid, ...found.map((m) => m.uid));
    const added = this.o.state.record(FOLDER, { uidValidity: info.uidValidity, lastUid, checkedAt: now }, fresh, now);
    if (added) this.o.onNew(added);
  }
}

const fromText = (a: Address | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'unknown sender');

/** MailSource over imapflow. One instance per connection; the watcher makes a new one to reconnect. */
export class ImapMailSource implements MailSource {
  private client: ImapFlow | null = null;
  private closeCbs: (() => void)[] = [];
  private existsCbs: (() => void)[] = [];

  constructor(private readonly c: MailConnection) {}

  async open(): Promise<MailboxInfo> {
    const client = connect(this.c, await this.c.password(), { idle: true });
    this.client = client;
    client.on('close', () => this.closeCbs.forEach((cb) => cb()));
    client.on('exists', () => this.existsCbs.forEach((cb) => cb()));
    await client.connect();
    const box = await client.mailboxOpen(FOLDER, { readOnly: true });
    return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
  }

  async info(): Promise<MailboxInfo> {
    const client = this.need();
    const s = await client.status(FOLDER, { uidValidity: true, uidNext: true });
    if (!s) throw new Error('could not read INBOX status');
    return { uidValidity: String(s.uidValidity), uidNext: s.uidNext ?? 1 };
  }

  private need(): ImapFlow {
    if (!this.client?.usable) throw new Error('not connected');
    return this.client;
  }

  private async load(uids: number[]): Promise<(NewMail & { uid: number })[]> {
    const client = this.need();
    const out: (NewMail & { uid: number })[] = [];
    for (const uid of uids.sort((a, b) => a - b)) {
      const m = await readFull(client, FOLDER, uid);
      if (!m) continue;
      out.push({
        uid,
        messageId: m.messageId ?? `<no-id-${uid}@aios.local>`,
        mailId: mailId(FOLDER, uid),
        from: fromText(m.from),
        subject: m.subject,
        date: m.date?.getTime() ?? null,
        body: sanitize({ text: m.text || undefined, html: m.html ?? undefined }, { maxChars: TRIAGE_BODY_CHARS }),
      });
    }
    return out;
  }

  async fetchAfter(uid: number): Promise<(NewMail & { uid: number })[]> {
    const uids = ((await this.need().search({ uid: `${uid + 1}:*` }, { uid: true })) || []).filter((u) => u > uid);
    return this.load(uids);
  }

  async fetchSince(date: Date): Promise<(NewMail & { uid: number })[]> {
    // IMAP SINCE is date-only; filter to the exact time afterwards.
    const client = this.need();
    const uids = (await client.search({ since: date }, { uid: true })) || [];
    const fetched = uids.length ? await client.fetchAll(uids.join(','), { uid: true, internalDate: true }, { uid: true }) : [];
    return this.load(fetched.filter((m) => m.internalDate && new Date(m.internalDate).getTime() >= date.getTime()).map((m) => m.uid));
  }

  onExists(cb: () => void): void {
    this.existsCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    await c.logout().catch(() => c.close());
  }
}
