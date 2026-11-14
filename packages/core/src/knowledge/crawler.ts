/**
 * K1/K2: the knowledge base crawler.
 *
 * First pass (K2): the first run lists INBOX and Sent mail from `backfillDays` back (at most
 * `backfillMaxMails`) and every indexed document (at most `backfillMaxFiles`), and reads
 * `perRun` of them every five minutes until done, on `backfillModel` (the cloud nightly role
 * by default). Then, once, a tidy call folds near-duplicate notes together.
 *
 * Hourly: new mail in INBOX and Sent, new or changed documents, the chat since the last run
 * and (once a day) the calendar, read on `model` (the local model by default), outside quiet
 * hours and pause.
 *
 * K3, for big mailboxes: mail is listed a month at a time going back, so tens of thousands of
 * messages are never fetched at once. Gmail's Promotions, Social, Updates and Forums tabs are
 * left out by the search, and bulk or automated mail by its headers (`mailfilter.ts`), before
 * any model sees it. The user's sent mail is read first, then mail they replied to, starred or
 * Important mail, then mail from people they write to. Mail older than the window (`olderMail`)
 * is read on the local model overnight by default. Cloud reading stops for the day at
 * `dailyBudgetUsd`, inside the daily cost cap; /knowledge shows what it spent.
 *
 * Each item is read once (the ledger, `ledger.ts`) by one small structured call with no tools,
 * the item inside <untrusted> (`extract.ts`). Code merges the notes into the file and writes
 * Upcoming from the calendar. Without a model, the items wait and code adds plain lines to
 * Recent activity. Nothing here calls a tool, writes memory or config, or posts to the chat;
 * the audit log records counts only.
 */
import type { KnowledgeConfig } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { CalEvent, CalendarApi } from '../calendar/google.js';
import { utcToLocal } from '../calendar/time.js';
import type { FileCatalog } from '../files/catalog.js';
import { inQuietHours } from '../mail/pipeline.js';
import type { ListedMail, MailClient } from '../mail/imap.js';
import { type ModelClient, ModelError, type ModelErrorKind, type ModelRequest } from '../model.js';
import type { Store } from '../store.js';
import {
  DOC_TEXT_CHARS,
  ExtractedNotes,
  TidiedNotes,
  calendarRequest,
  chatRequest,
  cleanExtracted,
  cleanTidied,
  docRequest,
  mailRequest,
  mergeNotes,
  tidyRequest,
} from './extract.js';
import { type Knowledge, type KnowledgeFile, type ModelSection, type Note, SECTION_LIMITS, cleanNote } from './file.js';
import { type Item, type ItemKind, KnowledgeLedger, PRIORITY, type Phase, type Progress } from './ledger.js';
import { skipReason } from './mailfilter.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 3;
const MAX_HOURLY_MAILS = 100;
const MAX_HOURLY_FILES = 50;
const MAX_EVENTS = 80;
/** K3: mail is listed this much at a time, going back, and at most this many per folder. */
const CHUNK = 30 * DAY;
const MAX_CHUNK_MAILS = 5000;
/** K3: more mail is listed while fewer than this many runs' worth wait, at most this many months a run. */
const QUEUE_RUNS = 2;
const MAX_CHUNKS_PER_RUN = 6;
/** These mean no call will work right now: stop the run and try again later. */
const STOP_KINDS = new Set<string>(['auth', 'credits', 'forbidden', 'rate_limited', 'timeout', 'unavailable', 'network', 'aborted', 'paused', 'cost_cap', 'key_missing', 'not_configured'] satisfies ModelErrorKind[]);

export type KnowledgeModel = Pick<ModelClient, 'structured'>;
export interface ModelChoice {
  model: KnowledgeModel;
  role: ModelRequest['role'];
}

export interface KnowledgeCrawlerOptions {
  config: KnowledgeConfig;
  userName: string;
  /** The user's own addresses, to tell sent mail from received mail when a folder doesn't. */
  userAddresses?: string[] | undefined;
  /** K3: the mailbox's address. When it changes, the mail listing starts again for the new one. */
  account?: string | undefined;
  timeZone: string;
  file: KnowledgeFile;
  store: Store;
  audit: AuditLog;
  mail?: Pick<MailClient, 'list' | 'read'> | undefined;
  calendar?: Pick<CalendarApi, 'list'> | undefined;
  files?: Pick<FileCatalog, 'readableSince' | 'get' | 'body'> | undefined;
  /** Display name for a real file path (F1's FileRoots.display). */
  displayPath?: ((path: string) => string) | undefined;
  /** Null when that model isn't there: its items wait. `older` (K3): for mail before the window. */
  models: { backfill: ModelChoice | null; hourly: ModelChoice | null; older?: ModelChoice | null | undefined };
  isPaused: () => boolean;
  quietHours?: { start: string; end: string } | undefined;
  now?: () => number;
}

export type KnowledgeOutcome = 'off' | 'not_due' | 'running' | 'paused' | 'quiet' | 'updated';

export interface KnowledgeRun {
  by: 'model' | 'code';
  phase: Phase;
  /** Items found this run. */
  found: number;
  /** Items read this run, and the notes they gave. */
  read: number;
  notes: number;
  /** K3: of `read`, how many were older mail. */
  older: number;
  /** K3: emails left out this run as bulk, automated or from a skipped sender. */
  skipped: number;
  tidied: boolean;
  error?: string;
}

/** K3: what /knowledge says besides the counts. */
export interface KnowledgeProgress extends Progress {
  windowDays: number;
  olderMail: KnowledgeConfig['olderMail'];
  /** The local date the mail listing has gone back to, while it lists older mail. */
  olderBackTo: string | null;
  skipped: number;
  spentToday: number;
  spentTotal: number;
  budget: number;
}

const sourceOf = (k: ItemKind): Note['source'] => (k === 'sent' || k === 'mail' ? 'mail' : k === 'file' ? 'files' : k);
const senderName = (from: string) => from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

export class KnowledgeCrawler {
  readonly ledger: KnowledgeLedger;
  private running = false;
  private skippedThisRun = 0;
  private readonly now: () => number;

  constructor(private readonly o: KnowledgeCrawlerOptions) {
    this.now = o.now ?? Date.now;
    this.ledger = new KnowledgeLedger(o.store);
  }

  private on(s: KnowledgeConfig['sources'][number]): boolean {
    return this.o.config.sources.includes(s);
  }

  private get setting() {
    return {
      get: (k: string) => this.o.store.getSetting(`knowledge.${k}`),
      set: (k: string, v: string) => this.o.store.setSetting(`knowledge.${k}`, v),
    };
  }

  private num(k: string): number {
    return Number(this.setting.get(k) || 0);
  }

  /** K3: every month of the first pass's window has been listed. */
  private windowListed(): boolean {
    const from = this.num('windowFrom');
    return this.o.config.backfillDays <= 0 || (from > 0 && this.num('cursor') <= from);
  }

  /** The first pass hasn't listed all its items yet, or still has some to read. */
  private backfilling(): boolean {
    return !this.windowListed() || this.ledger.backfillOpen();
  }

  /** K3: where older mail stops: `olderMailMonths` before the window. */
  private olderFrom(): number {
    return this.num('windowFrom') - this.o.config.olderMailMonths * CHUNK;
  }

  private olderOn(): boolean {
    const c = this.o.config;
    return c.olderMail !== 'off' && c.olderMailMonths > 0 && !!this.o.models.older && this.on('mail') && !!this.o.mail;
  }

  /** K3: the model for older mail now, or null (off, no model, or outside the overnight hours). */
  private olderModel(now: number): ModelChoice | null {
    const m = this.o.models.older ?? null;
    if (!m || !this.olderOn()) return null;
    if (this.o.config.olderMail === 'local-overnight' && !inQuietHours(now, this.o.timeZone, this.o.config.overnight)) return null;
    return m;
  }

  /** K3: older mail to read or list, and its model can run now. */
  private olderDue(now: number): boolean {
    const m = this.olderModel(now);
    if (!m || this.overBudget(m, now) || !this.windowListed() || this.ledger.backfillOpen()) return false;
    return this.ledger.pendingCount('older') > 0 || this.num('cursor') > this.olderFrom();
  }

  // ── K3: spending ──

  private day(now: number): string {
    return utcToLocal(now, this.o.timeZone).slice(0, 10);
  }

  private spentToday(now: number): number {
    return this.num(`spent:${this.day(now)}`);
  }

  /** Cloud reading waits for tomorrow once today's knowledge spending reaches the budget. */
  private overBudget(choice: ModelChoice, now: number): boolean {
    return choice.role !== 'local' && this.spentToday(now) >= this.o.config.dailyBudgetUsd;
  }

  /** What one call cost, as the provider reports it (the cost cap counts the same numbers). */
  private spend(choice: ModelChoice, usd: number | null | undefined, now: number): void {
    if (choice.role === 'local' || !usd || usd <= 0) return;
    const round = (n: number) => String(Math.round(n * 1e6) / 1e6);
    this.setting.set(`spent:${this.day(now)}`, round(this.spentToday(now) + usd));
    this.setting.set('spentTotal', round(this.num('spentTotal') + usd));
  }

  progress(): KnowledgeProgress {
    const now = this.now();
    const c = this.o.config;
    const cursor = this.num('cursor');
    const listingOlder = this.olderOn() && this.windowListed() && cursor > 0;
    return {
      ...this.ledger.progress(),
      windowDays: c.backfillDays,
      olderMail: c.olderMail,
      olderBackTo: listingOlder ? this.day(Math.max(cursor, this.olderFrom())) : null,
      skipped: this.num('skipped'),
      spentToday: this.spentToday(now),
      spentTotal: this.num('spentTotal'),
      budget: c.dailyBudgetUsd,
    };
  }

  /**
   * Called every five minutes. The first pass runs at each call until it is done (quiet hours
   * too: it notifies nobody); after that, an update once every `everyMinutes`, outside quiet hours.
   */
  async runIfDue(): Promise<KnowledgeOutcome> {
    if (!this.o.config.enabled) return 'off';
    if (this.running) return 'running';
    if (this.o.isPaused()) return 'paused';
    const now = this.now();
    const b = this.o.models.backfill;
    const backfill = this.backfilling() && !!b && !this.overBudget(b, now);
    // Older mail, overnight by default, also every five minutes until it is all read.
    if (!backfill && !this.olderDue(now)) {
      const ranAt = Number(this.setting.get('ranAt') ?? 0);
      if (ranAt && now - ranAt < this.o.config.everyMinutes * MINUTE) return 'not_due';
      if (inQuietHours(now, this.o.timeZone, this.o.quietHours)) return 'quiet';
    }
    await this.run();
    return 'updated';
  }

  /** Runs now (also /knowledge update). Null when a run is already going. */
  async run(): Promise<KnowledgeRun | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.update();
    } finally {
      this.running = false;
    }
  }

  // ── Finding items ──

  private mailKind(m: ListedMail): ItemKind {
    if (m.id.startsWith('Sent:')) return 'sent';
    const own = (this.o.userAddresses ?? []).map((a) => a.toLowerCase());
    return m.from && own.includes(m.from.address.toLowerCase()) ? 'sent' : 'mail';
  }

  /**
   * K3: lists mail from `since` up to `before`, skips what the filters leave out, and adds the
   * rest with its priority. Sent mail goes first, so what it answers and whom it goes to raise
   * the mail beside it. Null when the mailbox can't be listed.
   */
  private async listMail(since: number, before: number | undefined, limit: number, phase: Phase, now: number): Promise<{ added: number; fresh: ListedMail[] } | null> {
    if (!this.o.mail || !this.on('mail') || limit <= 0) return { added: 0, fresh: [] };
    const c = this.o.config;
    let found: ListedMail[];
    try {
      found = await this.o.mail.list({ since: new Date(since), before: before === undefined ? undefined : new Date(before), limit, skipCategories: c.skipCategories });
    } catch (err) {
      this.o.audit.append({ kind: 'knowledge', event: 'mail_error', error: (err as Error).message.slice(0, 200) });
      return null;
    }
    const key = (m: ListedMail) => `mail:${m.messageId ?? m.id}`;
    const items: { key: string; kind: ItemKind; ref: string; at: number; phase: Phase; priority: number }[] = [];
    const fresh: ListedMail[] = [];
    const sent = found.filter((m) => this.mailKind(m) === 'sent');
    for (const m of sent) {
      if (this.ledger.has(key(m))) continue;
      for (const to of m.to) this.ledger.signal('contact', to.address);
      if (m.inReplyTo) {
        this.ledger.signal('replied', m.inReplyTo);
        this.ledger.raise(`mail:${m.inReplyTo}`, PRIORITY.replied);
      }
      if (m.threadId) this.ledger.signal('thread', m.threadId);
      items.push({ key: key(m), kind: 'sent', ref: m.id, at: m.date?.getTime() ?? now, phase, priority: PRIORITY.sent });
      fresh.push(m);
    }
    let skipped = 0;
    for (const m of found) {
      if (this.mailKind(m) === 'sent' || this.ledger.has(key(m))) continue;
      if (skipReason(m, false, c)) {
        skipped++;
        continue;
      }
      const replied = this.ledger.signalCount('replied', m.messageId) > 0 || this.ledger.signalCount('thread', m.threadId) > 0;
      const priority = replied || m.starred || m.important ? PRIORITY.replied : this.ledger.signalCount('contact', m.from?.address) >= 2 ? PRIORITY.contact : PRIORITY.mail;
      items.push({ key: key(m), kind: 'mail', ref: m.id, at: m.date?.getTime() ?? now, phase, priority });
      fresh.push(m);
    }
    if (skipped) this.setting.set('skipped', String(this.num('skipped') + skipped));
    this.skippedThisRun += skipped;
    return { added: this.ledger.add(items, now), fresh: fresh.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)) };
  }

  private findFiles(since: number, limit: number, phase: Phase, now: number): number {
    if (!this.o.files || !this.on('files') || limit <= 0) return 0;
    const files = this.o.files.readableSince(since, limit);
    return this.ledger.add(files.map((f) => ({ key: `file:${f.path}:${f.mtimeMs}`, kind: 'file' as const, ref: f.path, at: Math.round(f.mtimeMs), phase })), now);
  }

  /** K3: a different mailbox than last time: list its mail from the start, and drop the old one's waiting mail. */
  private checkAccount(now: number): void {
    const account = this.o.account?.trim().toLowerCase();
    if (!account) return;
    const was = this.setting.get('account');
    if (was && was !== account) {
      const dropped = this.ledger.dropWaitingMail(now);
      for (const k of ['windowFrom', 'cursor', 'windowListed', 'mailAt', 'tidied']) this.setting.set(k, '');
      this.o.audit.append({ kind: 'knowledge', event: 'mailbox_changed', dropped });
    }
    if (was !== account) this.setting.set('account', account);
  }

  private async discover(now: number): Promise<{ found: number; freshMail: ListedMail[] }> {
    const c = this.o.config;
    this.checkAccount(now);
    let found = 0;
    const freshMail: ListedMail[] = [];
    const first = !this.setting.get('backfillStarted');
    const queueFull = (phase: Phase) => this.ledger.pendingCount(phase) >= c.perRun * QUEUE_RUNS;
    if (c.backfillDays > 0 && !this.windowListed()) {
      // The first pass's window, a month at a time going back from today, while little of it waits.
      if (!this.num('windowFrom')) {
        this.setting.set('windowFrom', String(now - c.backfillDays * DAY));
        this.setting.set('cursor', String(now));
        this.setting.set('windowListed', '0');
      }
      const windowFrom = this.num('windowFrom');
      const hasMail = !!this.o.mail && this.on('mail');
      let listedOnce = false;
      for (let n = 0; n < MAX_CHUNKS_PER_RUN && !this.windowListed() && !queueFull('backfill'); n++) {
        const cursor = this.num('cursor');
        const from = Math.max(cursor - CHUNK, windowFrom);
        const mail = await this.listMail(from, cursor, Math.min(c.backfillMaxMails - this.num('windowListed'), MAX_CHUNK_MAILS), 'backfill', now);
        if (!mail) break;
        listedOnce = true;
        found += mail.added;
        const listed = this.num('windowListed') + mail.added;
        this.setting.set('windowListed', String(listed));
        this.setting.set('cursor', String(!hasMail || from <= windowFrom || listed >= c.backfillMaxMails ? windowFrom : from));
      }
      if (first) found += this.findFiles(0, c.backfillMaxFiles, 'backfill', now);
      // Started once the mailbox could be listed; the files are added again harmlessly if not.
      if (listedOnce || this.windowListed()) {
        if (first) {
          this.setting.set('backfillStarted', String(now));
          this.setting.set('mailAt', String(now));
          this.setting.set('filesAt', String(now));
          this.setting.set('chatAt', String(now));
        }
        if (!this.num('mailAt')) this.setting.set('mailAt', String(now));
      }
      if (first) return { found, freshMail };
    } else if (c.backfillDays <= 0 && !this.num('windowFrom')) {
      // No first pass: older mail goes back from today.
      this.setting.set('windowFrom', String(now));
      this.setting.set('cursor', String(now));
    }
    // K3: older mail, a month at a time, while little of it waits.
    if (this.olderOn() && this.windowListed() && !this.ledger.backfillOpen()) {
      const stop = this.olderFrom();
      for (let n = 0; n < MAX_CHUNKS_PER_RUN && this.num('cursor') > stop && !queueFull('older'); n++) {
        const cursor = this.num('cursor');
        const from = Math.max(cursor - CHUNK, stop);
        const mail = await this.listMail(from, cursor, MAX_CHUNK_MAILS, 'older', now);
        if (!mail) break;
        found += mail.added;
        this.setting.set('cursor', String(from));
      }
    }
    // New since the last look, with a day of overlap for mail (late arrivals) and an hour for files.
    const mailAt = this.num('mailAt') || now - DAY;
    const mail = await this.listMail(mailAt - DAY, undefined, MAX_HOURLY_MAILS, 'hourly', now);
    if (mail) {
      found += mail.added;
      freshMail.push(...mail.fresh);
      this.setting.set('mailAt', String(now));
    }
    found += this.findFiles(Number(this.setting.get('filesAt') ?? now - DAY) - HOUR, MAX_HOURLY_FILES, 'hourly', now);
    this.setting.set('filesAt', String(now));
    const chatAt = Number(this.setting.get('chatAt') ?? now - DAY);
    if (this.on('chat') && this.o.store.chatTurnsBetween(chatAt, now).length) {
      found += this.ledger.add([{ key: `chat:${chatAt}-${now}`, kind: 'chat', ref: `${chatAt}-${now}`, at: now, phase: 'hourly' }], now);
      this.setting.set('chatAt', String(now));
    }
    const today = utcToLocal(now, this.o.timeZone).slice(0, 10);
    if (this.o.calendar && this.on('calendar')) found += this.ledger.add([{ key: `calendar:${today}`, kind: 'calendar', ref: today, at: now, phase: 'hourly' }], now);
    return { found, freshMail };
  }

  // ── Reading items ──

  private async events(now: number): Promise<CalEvent[] | null> {
    if (!this.o.calendar || !this.on('calendar')) return null;
    const days = this.o.config.calendarDays * DAY;
    try {
      const all = await this.o.calendar.list(
        { timeMin: new Date(now - days), timeMax: new Date(now + Math.max(days, DAY)), limit: MAX_EVENTS, timeZone: this.o.timeZone },
        AbortSignal.timeout(20_000),
      );
      return all.filter((e) => !e.cancelled && e.myResponse !== 'declined');
    } catch (err) {
      this.o.audit.append({ kind: 'knowledge', event: 'calendar_error', error: (err as Error).message.slice(0, 200) });
      return null;
    }
  }

  private when(ms: number, allDay = false): string {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: this.o.timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
    return allDay ? `${day}, all day` : `${day} ${utcToLocal(ms, this.o.timeZone).slice(11, 16)}`;
  }

  /** The request for one item, or null when there is nothing in it to read. */
  private async requestFor(item: Item, role: ModelRequest['role'], events: CalEvent[] | null, now: number): Promise<ModelRequest | null> {
    const name = this.o.userName;
    if (item.kind === 'sent' || item.kind === 'mail') {
      const m = await this.o.mail?.read(item.ref);
      if (!m) return null;
      const who = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
      return mailRequest(role, name, {
        id: m.id,
        sentByUser: item.kind === 'sent',
        from: m.from ? who(m.from) : '(unknown)',
        to: [...m.to, ...m.cc].slice(0, 10).map(who),
        date: m.date ? utcToLocal(m.date.getTime(), this.o.timeZone).replace('T', ' ') : '(no date)',
        subject: m.subject,
        body: { text: m.text, html: m.html },
      });
    }
    if (item.kind === 'file') {
      const f = this.o.files?.get(item.ref);
      if (!f) return null;
      const text = this.o.files!.body(f.path, DOC_TEXT_CHARS);
      if (!text.trim() && !f.summary) return null;
      return docRequest(role, name, { display: (this.o.displayPath ?? ((p: string) => p))(f.path), kind: f.kind, title: f.facts?.title, author: f.facts?.author, summary: f.summary, text });
    }
    if (item.kind === 'chat') {
      const [from = 0, to = now] = item.ref.split('-').map(Number);
      const turns = this.o.store.chatTurnsBetween(from, to).slice(-60);
      if (!turns.length) return null;
      return chatRequest(role, name, turns.map((t) => `${t.role === 'user' ? name : 'AI OS'}: ${t.content.replace(/\s+/g, ' ').slice(0, t.role === 'user' ? 600 : 300)}`));
    }
    if (!events?.length) return null;
    return calendarRequest(
      role,
      name,
      events.map((e) => {
        const guests = e.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email).slice(0, 6);
        return `${this.when(e.startMs, e.allDay)}: ${e.title.slice(0, 200) || '(no title)'}${e.location ? ` at ${e.location.slice(0, 120)}` : ''}${guests.length ? ` with ${guests.join(', ')}` : ''}${e.startMs < now ? ' (past)' : ''}`;
      }),
    );
  }

  /** Reads up to `limit` pending items of `phases`; stops early when the model can't be reached or the day's budget is spent. */
  private async extract(choice: ModelChoice, phases: readonly Phase[], limit: number, events: CalEvent[] | null, now: number): Promise<{ tried: number; read: number; notes: number; error?: string }> {
    const items = this.ledger.pending(limit, phases);
    // The cloud takes a few at once; a laptop's local model one at a time.
    const lanes = choice.role === 'local' ? 1 : 3;
    let read = 0;
    let notes = 0;
    let stop: string | undefined;
    let next = 0;
    const lane = async () => {
      while (!stop && next < items.length) {
        if (this.overBudget(choice, now)) {
          stop = 'budget';
          return;
        }
        const item = items[next++]!;
        try {
          const req = await this.requestFor(item, choice.role, events, now);
          if (!req) {
            this.ledger.setExtracted(item.key, [], now);
            continue;
          }
          const { value, result } = await choice.model.structured(req, 'knowledge_notes', ExtractedNotes);
          this.spend(choice, result?.usage?.costUsd, now);
          const found = cleanExtracted(value);
          this.ledger.setExtracted(item.key, found, now);
          read++;
          notes += found.length;
        } catch (err) {
          const kind = err instanceof ModelError ? err.kind : 'read_error';
          if (STOP_KINDS.has(kind)) {
            stop = kind;
            return;
          }
          this.ledger.setFailed(item.key, now, MAX_ATTEMPTS);
          this.o.audit.append({ kind: 'knowledge', event: 'item_failed', item: item.kind, error: err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
    return { tried: Math.min(next, items.length), read, notes, ...(stop ? { error: stop } : {}) };
  }

  // ── The run ──

  private async update(): Promise<KnowledgeRun> {
    const now = this.now();
    const tz = this.o.timeZone;
    this.skippedThisRun = 0;
    const { found, freshMail } = await this.discover(now);
    const phase: Phase = this.backfilling() ? 'backfill' : 'hourly';
    let choice = phase === 'backfill' ? this.o.models.backfill : this.o.models.hourly;
    let budgetHit = false;
    // The first pass also takes new mail; when today's budget is spent, new mail goes on the hourly model.
    let reads: [ModelChoice | null, Phase[]][] = [[choice, phase === 'backfill' ? ['backfill', 'hourly'] : ['hourly']]];
    if (choice && this.overBudget(choice, now)) {
      budgetHit = true;
      choice = phase === 'backfill' && this.o.models.hourly && !this.overBudget(this.o.models.hourly, now) ? this.o.models.hourly : null;
      reads = [[choice, ['hourly']]];
    }
    const older = this.olderModel(now);
    if (older && phase === 'hourly') reads.push([older, ['older']]);
    const evs = await this.events(now);
    const run: KnowledgeRun = { by: choice ? 'model' : 'code', phase, found, read: 0, notes: 0, older: 0, skipped: this.skippedThisRun, tidied: false };
    let left = this.o.config.perRun;
    for (const [m, phases] of reads) {
      if (!m || left <= 0) continue;
      if (this.overBudget(m, now)) {
        budgetHit = true;
        continue;
      }
      const r = await this.extract(m, phases, left, evs, now);
      left -= r.tried;
      run.read += r.read;
      run.notes += r.notes;
      if (phases.includes('older')) run.older += r.read;
      if (r.error === 'budget') budgetHit = true;
      else if (r.error) run.error ??= r.error;
    }
    if (budgetHit) run.error ??= 'budget';

    let k: Knowledge = this.o.file.read();
    // Merge what has been read (this run, or an earlier one that stopped before merging).
    const extracted = this.ledger.extracted(2000);
    k = mergeNotes(
      k,
      extracted.flatMap((i) => i.notes.map((n) => ({ section: n.section as ModelSection, text: n.text, source: sourceOf(i.kind), on: utcToLocal(i.at, tz).slice(0, 10) }))),
    );
    // Upcoming: from the calendar by code, every run. Kept as it was when the calendar can't be read.
    if (evs) {
      k.sections.upcoming = evs
        .filter((e) => e.endMs > now)
        .slice(0, SECTION_LIMITS.upcoming)
        .map((e) => ({ text: cleanNote(`${this.when(e.startMs, e.allDay)}: ${e.title || '(no title)'}${e.location ? ` at ${e.location}` : ''}`), source: 'calendar' as const, on: utcToLocal(e.startMs, tz).slice(0, 10) }));
    } else if (!this.on('calendar') || !this.o.calendar) k.sections.upcoming = [];
    // No model for these items: code says what came in, so the file still moves.
    if (!choice && freshMail.length) {
      const lines: Note[] = freshMail.slice(0, 8).map((m) => ({
        text: cleanNote(`${m.id.startsWith('Sent:') ? 'Sent' : 'Email from'} ${m.id.startsWith('Sent:') ? `to ${m.to[0]?.name || m.to[0]?.address || '(unknown)'}` : senderName(m.from?.name || m.from?.address || '(unknown)')}: ${m.subject}`),
        source: 'mail',
        on: utcToLocal(m.date?.getTime() ?? now, tz).slice(0, 10),
      }));
      k = mergeNotes(k, lines.filter((n) => n.text).map((n) => ({ ...n, section: 'recent' as const })));
    }

    // Once, when the first pass is done: fold near-duplicates together.
    const tidy = this.o.models.backfill;
    if (tidy && phase === 'backfill' && this.windowListed() && !this.ledger.backfillPending() && !this.setting.get('tidied') && !run.error && !this.overBudget(tidy, now)) {
      try {
        const { value, result } = await tidy.model.structured(tidyRequest(tidy.role, this.o.userName, k), 'knowledge_tidy', TidiedNotes);
        this.spend(tidy, result?.usage?.costUsd, now);
        const tidied = cleanTidied(k, value);
        if (tidied) {
          k = tidied;
          run.tidied = true;
        }
        this.setting.set('tidied', String(now));
      } catch (err) {
        this.o.audit.append({ kind: 'knowledge', event: 'tidy_failed', error: err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200) });
      }
    }

    k.updated = utcToLocal(now, tz).replace('T', ' ').slice(0, 16);
    this.o.file.write(k, utcToLocal(now, tz).slice(0, 10), this.o.config.keepDays);
    this.ledger.setMerged(extracted.map((i) => i.key), now);
    this.setting.set('ranAt', String(now));
    const p = this.ledger.progress();
    // Counts only: no names, subjects, file names or notes in the audit log.
    this.o.audit.append({
      kind: 'knowledge',
      event: 'updated',
      by: run.by,
      phase,
      found,
      read: run.read,
      notes: run.notes,
      older: run.older,
      skipped: run.skipped,
      tidied: run.tidied,
      mail: p.mail,
      files: p.files,
      spentToday: this.spentToday(now),
      sections: Object.fromEntries(Object.entries(k.sections).map(([s, n]) => [s, n.length])),
      ...(run.error ? { error: run.error } : {}),
    });
    return run;
  }
}

const span = (days: number) => (days >= 60 ? `${Math.round(days / 30.4)} months` : `${days} days`);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** A few lines on how far the reading is and what it cost, for /knowledge. */
export function progressText(p: Progress & Partial<KnowledgeProgress>, backfillOnCloud: boolean): string {
  const lines: string[] = [];
  if (p.phase === 'backfill') {
    const what = p.windowDays ? `the last ${span(p.windowDays)} of mail` : 'your history';
    lines.push(`Reading ${what}${backfillOnCloud ? ' on the cloud model' : ''}: ${p.mail.done} of ${p.mail.total} emails and ${p.files.done} of ${p.files.total} files so far. It continues every five minutes.`);
  } else {
    // Older mail has its own line.
    const waiting = p.waiting - ((p.older?.total ?? 0) - (p.older?.done ?? 0));
    lines.push(`Read so far: ${p.mail.done} emails and ${p.files.done} files.${waiting > 0 ? ` ${waiting} waiting for the next update.` : ''}`);
  }
  if (p.older?.total || p.olderBackTo) {
    const done = p.older?.done ?? 0;
    const total = p.older?.total ?? 0;
    const when = p.olderMail === 'local-overnight' ? 'overnight on the local model' : 'every five minutes';
    lines.push(`Older mail: ${done} of ${total} read${p.olderBackTo ? `, listed back to ${p.olderBackTo}` : ''}.${total > done || p.olderBackTo ? ` It continues ${when}.` : ''}`);
  }
  if (p.skipped) lines.push(`Skipped ${p.skipped} bulk or automated emails.`);
  if (p.budget !== undefined) {
    const today = p.spentToday ?? 0;
    lines.push(
      p.budget > 0
        ? `Cloud spending on it: ${usd(today)} today of the ${usd(p.budget)} daily budget, ${usd(p.spentTotal ?? 0)} in all.${today >= p.budget ? ' The budget is spent, so cloud reading waits for tomorrow.' : ''}`
        : 'Cloud reading is off (knowledge.dailyBudgetUsd is 0).',
    );
  }
  return lines.join('\n');
}

/** /knowledge: the file for the chat, as plain text (the UI shows it as text, never as markup). */
export function knowledgeView(file: KnowledgeFile, progress?: string, maxChars = 12_000): string {
  const text = file.text();
  if (!text) return `There is no knowledge base yet. It is written in the background; type /knowledge update to start now. It will be at ${file.path}.${progress ? `\n${progress}` : ''}`;
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n[… the rest is in the file]` : text;
  return `${progress ? `${progress}\n\n` : ''}${body.trimEnd()}\n\nFile: ${file.path}`;
}
