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
 * K4, the wiki (`wiki.ts`): the same call names the people, projects and organisations the item
 * is about, with facts and links; code files them on one page each, then rewrites up to
 * `pageSummariesPerRun` changed pages' summaries (one call each, no tools, the page inside
 * <untrusted>), and writes index.md and log.md. Every `checkEveryDays`, code checks for old
 * commitments, duplicates and pages with no links, and `onCheck` gets the counts.
 *
 * Each item is read once (the ledger, `ledger.ts`) by one small structured call with no tools,
 * the item inside <untrusted> (`extract.ts`). Code merges the notes into the file and writes
 * Upcoming from the calendar. Without a model, the items wait and code adds plain lines to
 * Recent activity. Nothing here calls a tool, writes memory or config, or posts to the chat;
 * the audit log records counts only.
 */
import { existsSync } from 'node:fs';
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
  type Dropped,
  ExtractedNotes,
  type ItemRequest,
  PageSummary,
  calendarItem,
  chatItem,
  cleanExtracted,
  cleanPages,
  docItem,
  mailItem,
  pageSummaryRequest,
  personOf,
} from './extract.js';
import { type Fact, KnowledgeFacts, ME, originOf } from './facts.js';
import { type Knowledge, type KnowledgeFile, MODEL_SECTIONS, type Note, SECTION_LIMITS, cleanNote } from './file.js';
import { type Item, type ItemKind, type ItemSource, KnowledgeLedger, PRIORITY, type Phase, type Progress } from './ledger.js';
import { skipReason } from './mailfilter.js';
import type { KnowledgeProfiles } from './profile.js';
import { type FiledFact, type KnowledgeWiki, type PageFact, checkText, pageId } from './wiki.js';

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
/** K5: on its first run, items read in the last this many days (at most this many) are read again under the new rules. */
const REREAD_DAYS = 30;
const REREAD_MAX = 400;
const FACTS_VERSION = '1';
/** K5: judgement (relationships, interests) comes from the user's own words, so these go to the cloud model when there is one. */
const OWN_WORDS: ItemKind[] = ['sent', 'chat'];
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
  /** K4: the wiki pages beside the file; none when [knowledge] wiki is off. */
  wiki?: KnowledgeWiki | undefined;
  /** Profiles: a page per person from mail headers, Google Contacts and Signal (needs the wiki). */
  profiles?: KnowledgeProfiles | undefined;
  /** K4: the weekly check's one line of counts, written by code (main posts it as a notice). */
  onCheck?: ((line: string) => void) | undefined;
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
  /** K5: facts left out by code's checks (no quote in the item, a guessed relationship…), by reason. */
  dropped: Dropped;
  /** K5: items read again on the first run under the new rules. */
  reread: number;
  /** K4: wiki pages that got new facts or links, and summaries rewritten. */
  pages: number;
  summaries: number;
  /** Profiles written again this run. */
  profiles?: number;
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

/** A fact as a line in the file or on a page. */
const asNote = (f: Fact): Note & PageFact => ({ text: f.text, source: f.source, ...(f.lastOn ? { on: f.lastOn } : {}), ...(f.mine ? { mine: true } : {}), ...(f.state === 'unconfirmed' ? { unconfirmed: true } : {}) });

export class KnowledgeCrawler {
  readonly ledger: KnowledgeLedger;
  /** K5: every fact with its quotes and sources. */
  readonly facts: KnowledgeFacts;
  private running = false;
  private skippedThisRun = 0;
  private readonly now: () => number;

  constructor(private readonly o: KnowledgeCrawlerOptions) {
    this.now = o.now ?? Date.now;
    this.ledger = new KnowledgeLedger(o.store);
    this.facts = new KnowledgeFacts(o.store);
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
      this.o.profiles?.noteMail({ key: key(m), sent: true, from: m.from, to: m.to, subject: m.subject, at: m.date?.getTime() ?? now });
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
      this.o.profiles?.noteMail({ key: key(m), sent: false, from: m.from, to: m.to, subject: m.subject, at: m.date?.getTime() ?? now });
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

  /** The request for one item and where its words came from, or null when there is nothing in it to read. */
  private async requestFor(item: Item, role: ModelRequest['role'], events: CalEvent[] | null, now: number): Promise<{ req: ItemRequest; source: ItemSource } | null> {
    const name = this.o.userName;
    if (item.kind === 'sent' || item.kind === 'mail') {
      const m = await this.o.mail?.read(item.ref);
      if (!m) return null;
      const who = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
      const sent = item.kind === 'sent';
      const day = m.date ? this.when(m.date.getTime(), true).replace(', all day', '') : '';
      const to = m.to[0]?.name || m.to[0]?.address || '(unknown)';
      const from = senderName(m.from?.name || m.from?.address || '(unknown)');
      return {
        req: mailItem(role, name, {
          id: m.id,
          sentByUser: sent,
          from: m.from ? who(m.from) : '(unknown)',
          to: [...m.to, ...m.cc].slice(0, 10).map(who),
          date: m.date ? utcToLocal(m.date.getTime(), this.o.timeZone).replace('T', ' ') : '(no date)',
          subject: m.subject,
          body: { text: m.text, html: m.html },
        }),
        source: {
          origin: sent ? 'user' : originOf(`mail:${m.from?.address ?? '(unknown)'}`),
          label: cleanNote(`${sent ? `your email to ${to}` : `email from ${from}`}${day ? `, ${day}` : ''}: ${m.subject || '(no subject)'}`, 160),
        },
      };
    }
    if (item.kind === 'file') {
      const f = this.o.files?.get(item.ref);
      if (!f) return null;
      const text = this.o.files!.body(f.path, DOC_TEXT_CHARS);
      if (!text.trim() && !f.summary) return null;
      const display = (this.o.displayPath ?? ((p: string) => p))(f.path);
      return {
        req: docItem(role, name, { display, kind: f.kind, title: f.facts?.title, author: f.facts?.author, summary: f.summary, text }),
        source: { origin: originOf(`file:${f.path}`), label: cleanNote(`file ${display}`, 160) },
      };
    }
    if (item.kind === 'chat') {
      const [from = 0, to = now] = item.ref.split('-').map(Number);
      // K5: only what the user typed. The assistant's replies repeat the knowledge base's own notes.
      const turns = this.o.store
        .chatTurnsBetween(from, to)
        .filter((t) => t.role === 'user')
        .slice(-60);
      if (!turns.length) return null;
      return {
        req: chatItem(role, name, turns.map((t) => t.content.replace(/\s+/g, ' ').slice(0, 600))),
        source: { origin: 'user', label: cleanNote(`what you typed in the chat, ${this.when(from, true).replace(', all day', '')}`, 160) },
      };
    }
    if (!events?.length) return null;
    return {
      req: calendarItem(
        role,
        name,
        events.map((e) => {
          const guests = e.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email).slice(0, 6);
          return `${this.when(e.startMs, e.allDay)}: ${e.title.slice(0, 200) || '(no title)'}${e.location ? ` at ${e.location.slice(0, 120)}` : ''}${guests.length ? ` with ${guests.join(', ')}` : ''}${e.startMs < now ? ' (past)' : ''}`;
        }),
      ),
      // Every day's calendar is one origin: the same event read on two days confirms nothing.
      source: { origin: 'calendar', label: 'your calendar' },
    };
  }

  /** Reads these items; stops early when the model can't be reached or the day's budget is spent. */
  private async extract(choice: ModelChoice, items: Item[], events: CalEvent[] | null, now: number, dropped: Dropped): Promise<{ tried: number; read: number; notes: number; error?: string }> {
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
          const r = await this.requestFor(item, choice.role, events, now);
          if (!r) {
            this.ledger.setExtracted(item.key, [], now);
            continue;
          }
          const { value, result } = await choice.model.structured(r.req.request, 'knowledge_notes', ExtractedNotes);
          this.spend(choice, result?.usage?.costUsd, now);
          // K5: code checks every quote against the item; the local model only records what happened.
          const check = { ...r.req.check, judgement: choice.role !== 'local' };
          const found = cleanExtracted(value, check, dropped);
          const pages = this.o.wiki ? cleanPages(value, check, dropped) : [];
          this.ledger.setExtracted(item.key, found, now, pages, r.source);
          read++;
          notes += found.length + pages.reduce((n, p) => n + p.facts.length, 0);
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

  // ── K5: facts ──

  /**
   * K5's first run: every line in the file and on the pages becomes an unconfirmed fact (the
   * user's own lines stay theirs), and recent items are read again under the new rules.
   */
  private upgrade(now: number): number {
    if (this.setting.get('factsVersion') === FACTS_VERSION) return 0;
    const k = this.o.file.read();
    for (const s of MODEL_SECTIONS)
      for (const n of k.sections[s]) {
        if (n.mine) this.facts.addMine(ME, s, n.text, now);
        else this.facts.addLegacy(ME, s, n.text, n.source, n.on, this.aboutOf(s, n.text), now);
      }
    const wiki = this.o.wiki;
    if (wiki)
      for (const p of wiki.all()) {
        if (p.kind === 'saved') continue;
        for (const f of p.facts) {
          if (f.mine) this.facts.addMine(p.id, '', f.text, now);
          else this.facts.addLegacy(p.id, '', f.text, f.source, f.on, null, now);
        }
        wiki.setFacts(p.id, this.facts.of(p.id).map(asNote), p.updated ?? utcToLocal(now, this.o.timeZone).replace('T', ' ').slice(0, 16));
      }
    const reread = this.ledger.requeueSince(now - REREAD_DAYS * DAY, REREAD_MAX, now);
    this.setting.set('factsVersion', FACTS_VERSION);
    this.o.audit.append({ kind: 'knowledge', event: 'facts_upgrade', facts: this.facts.count(), reread });
    return reread;
  }

  /** The person page a people line is about ("Ana Lopez: …" → people/ana-lopez). */
  private aboutOf(section: string, text: string): string | null {
    if (section !== 'people') return null;
    const who = personOf(text);
    return who ? pageId('person', who) : null;
  }

  /** The user's edits to the file since it was last written: deleted lines are wrong, typed ones theirs. */
  private syncFile(k: Knowledge, now: number): void {
    for (const s of MODEL_SECTIONS) this.facts.sync(ME, s, k.sections[s].map((n) => ({ text: n.text, mine: !!n.mine })), now);
  }

  /** The file's model sections from the facts, by code: the user's own first, then known, then unconfirmed. */
  private fromFacts(k: Knowledge): Knowledge {
    const out: Knowledge = { ...k, sections: { ...k.sections } };
    for (const s of MODEL_SECTIONS) {
      const shown = this.facts.of(ME, s).slice(0, SECTION_LIMITS[s]);
      this.facts.setShown(ME, s, shown.map((f) => f.id));
      out.sections[s] = shown.map(asNote);
    }
    return out;
  }

  /** Files what has been read as facts with their quotes. Returns the pages that got facts. */
  private fileFacts(extracted: Item[], now: number): { pages: Set<string>; added: number; pageFacts: number } {
    const tz = this.o.timeZone;
    const pages = new Set<string>();
    let added = 0;
    let pageFacts = 0;
    for (const i of extracted) {
      // Read before K5, with no quotes: K5's first run reads it again.
      if (!i.source) continue;
      const on = utcToLocal(i.at, tz).slice(0, 10);
      const evidence = (f: { quote: string; byUser: boolean }) => ({
        itemKey: i.key,
        kind: i.kind,
        quote: f.quote,
        byUser: f.byUser,
        origin: f.byUser ? 'user' : i.source!.origin,
        label: i.source!.label,
        on,
        at: i.at,
      });
      for (const n of i.notes) {
        const r = this.facts.add({ subject: ME, section: n.section, about: this.aboutOf(n.section, n.text), text: n.text, basis: n.basis, relation: n.relation, source: sourceOf(i.kind), on, evidence: evidence(n) }, now);
        if ('id' in r && r.added) added++;
      }
      for (const p of i.pages) {
        const id = pageId(p.kind, p.name);
        if (!id) continue;
        for (const f of p.facts) {
          const r = this.facts.add({ subject: id, text: f.text, basis: f.basis, relation: f.relation, source: sourceOf(i.kind), on, evidence: evidence(f) }, now);
          if ('id' in r) {
            pages.add(id);
            if (r.added) {
              added++;
              pageFacts++;
            }
          }
        }
      }
    }
    return { pages, added, pageFacts };
  }

  /** K5: where a fact came from, for /knowledge why. Written by code; quotes are shown as plain text. */
  why(query: string): string {
    const found = this.facts.search(query, 8);
    if (!query.trim()) return 'Type /knowledge why and a few words from the line, for example /knowledge why Buket.';
    if (!found.length) return `No line in the knowledge base matches "${cleanNote(query, 80)}".`;
    const out = [`Where these lines came from. To take one out for good, type /knowledge wrong and its number.`];
    for (const f of found) {
      const where = f.subject === ME ? `About you, ${f.section}` : `Page ${f.subject}`;
      const state = f.mine ? 'you wrote this' : f.state === 'known' ? (f.evidence.some((e) => e.byUser) ? 'known: in your own words' : 'known: two separate sources') : 'unconfirmed: one source so far';
      out.push('', `#${f.id} ${f.text}`, `${where}. ${state}.`);
      if (f.basis === 'legacy' && !f.evidence.length) out.push('Written before Astra kept sources, so where it came from is not known.');
      for (const e of f.evidence.slice(0, 4)) out.push(`From ${e.label}: "${cleanNote(e.quote, 300)}"`);
      if (f.evidence.length > 4) out.push(`and ${f.evidence.length - 4} more.`);
    }
    return out.join('\n');
  }

  /** K5: the user's typed /knowledge wrong: the fact is taken out of the file or page and never learned again. */
  wrong(id: number): string {
    const f = this.facts.get(id);
    if (!f || f.state === 'wrong') return `There is no line #${id} to take out. Type /knowledge why and a few of its words to find its number.`;
    const now = this.now();
    this.facts.setWrong(id, now);
    const stamp = utcToLocal(now, this.o.timeZone).replace('T', ' ').slice(0, 16);
    if (f.subject === ME) {
      const k = this.fromFacts(this.o.file.read());
      k.updated = stamp;
      this.o.file.write(k, utcToLocal(now, this.o.timeZone).slice(0, 10), this.o.config.keepDays);
    } else this.o.wiki?.setFacts(f.subject, this.facts.of(f.subject).map(asNote), stamp);
    this.o.audit.append({ kind: 'knowledge', event: 'wrong', subject: f.subject === ME ? 'me' : 'page', relation: !!f.relation });
    return `Taken out: "${f.text}". Astra won't learn it again${f.relation ? `, or that this person is your ${f.relation}` : ''}.`;
  }

  // ── The run ──

  private async update(): Promise<KnowledgeRun> {
    const now = this.now();
    const tz = this.o.timeZone;
    this.skippedThisRun = 0;
    const reread = this.upgrade(now);
    const { found, freshMail } = await this.discover(now);
    const phase: Phase = this.backfilling() ? 'backfill' : 'hourly';
    let choice = phase === 'backfill' ? this.o.models.backfill : this.o.models.hourly;
    let budgetHit = false;
    // The first pass also takes new mail; when today's budget is spent, new mail goes on the hourly model.
    let reads: [ModelChoice | null, Phase[], readonly ItemKind[] | null][] = [[choice, phase === 'backfill' ? ['backfill', 'hourly'] : ['hourly'], null]];
    if (choice && this.overBudget(choice, now)) {
      budgetHit = true;
      choice = phase === 'backfill' && this.o.models.hourly && !this.overBudget(this.o.models.hourly, now) ? this.o.models.hourly : null;
      reads = [[choice, ['hourly'], null]];
    }
    // K5: judgement calls go to the cloud. The user's own words (sent mail, chat) are read there
    // first when the hourly model is the local one; the local model then only records what happened.
    const cloud = this.o.models.backfill;
    if (phase === 'hourly' && choice?.role === 'local' && cloud && cloud.role !== 'local' && !this.overBudget(cloud, now)) reads.unshift([cloud, ['hourly'], OWN_WORDS]);
    const older = this.olderModel(now);
    if (older && phase === 'hourly') reads.push([older, ['older'], null]);
    const evs = await this.events(now);
    const run: KnowledgeRun = { by: choice ? 'model' : 'code', phase, found, read: 0, notes: 0, older: 0, skipped: this.skippedThisRun, dropped: {}, reread, pages: 0, summaries: 0 };
    let left = this.o.config.perRun;
    for (const [m, phases, kinds] of reads) {
      if (!m || left <= 0) continue;
      if (this.overBudget(m, now)) {
        budgetHit = true;
        continue;
      }
      const items = kinds ? this.ledger.pendingOfKinds(left, kinds, phases) : this.ledger.pending(left, phases);
      const r = await this.extract(m, items, evs, now, run.dropped);
      left -= r.tried;
      run.read += r.read;
      run.notes += r.notes;
      if (phases.includes('older')) run.older += r.read;
      if (r.error === 'budget') budgetHit = true;
      else if (r.error) run.error ??= r.error;
    }
    if (budgetHit) run.error ??= 'budget';

    // K5: the user's edits to the file first (a deleted line is wrong), then what has been read
    // (this run, or an earlier one that stopped before filing) as facts with their quotes.
    let k: Knowledge = this.o.file.read();
    this.syncFile(k, now);
    const extracted = this.ledger.extracted(2000);
    const filed = this.fileFacts(extracted, now);
    // No model for these items: code says what came in, from the headers, so the file still moves.
    if (!choice && freshMail.length) {
      for (const m of freshMail.slice(0, 8)) {
        const text = cleanNote(
          `${m.id.startsWith('Sent:') ? 'Sent' : 'Email from'} ${m.id.startsWith('Sent:') ? `to ${m.to[0]?.name || m.to[0]?.address || '(unknown)'}` : senderName(m.from?.name || m.from?.address || '(unknown)')}: ${m.subject}`,
        );
        if (text) this.facts.add({ subject: ME, section: 'recent', text, basis: 'code', source: 'mail', on: utcToLocal(m.date?.getTime() ?? now, tz).slice(0, 10) }, now);
      }
    }
    k = this.fromFacts(k);
    // Upcoming: from the calendar by code, every run. Kept as it was when the calendar can't be read.
    if (evs) {
      k.sections.upcoming = evs
        .filter((e) => e.endMs > now)
        .slice(0, SECTION_LIMITS.upcoming)
        .map((e) => ({ text: cleanNote(`${this.when(e.startMs, e.allDay)}: ${e.title || '(no title)'}${e.location ? ` at ${e.location}` : ''}`), source: 'calendar' as const, on: utcToLocal(e.startMs, tz).slice(0, 10) }));
    } else if (!this.on('calendar') || !this.o.calendar) k.sections.upcoming = [];

    const stamp = utcToLocal(now, tz).replace('T', ' ').slice(0, 16);
    k.updated = stamp;
    this.o.file.write(k, utcToLocal(now, tz).slice(0, 10), this.o.config.keepDays);
    // K4: pages and links filed by code, the pages' facts from the facts store, then the changed pages' summaries.
    if (this.o.wiki) await this.updateWiki(this.o.wiki, extracted, filed, choice, run, stamp, now);
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
      facts: filed.added,
      dropped: run.dropped,
      older: run.older,
      skipped: run.skipped,
      reread: run.reread,
      pages: run.pages,
      summaries: run.summaries,
      profiles: run.profiles ?? 0,
      mail: p.mail,
      files: p.files,
      spentToday: this.spentToday(now),
      sections: Object.fromEntries(Object.entries(k.sections).map(([s, n]) => [s, n.length])),
      ...(run.error ? { error: run.error } : {}),
    });
    return run;
  }

  // ── K4: the wiki ──

  private dirtyPages(): string[] {
    try {
      const v = JSON.parse(this.setting.get('wikiDirty') || '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private async updateWiki(wiki: KnowledgeWiki, extracted: Item[], filedFacts: { pages: Set<string>; pageFacts: number }, choice: ModelChoice | null, run: KnowledgeRun, stamp: string, now: number): Promise<void> {
    const withFacts = filedFacts.pages;
    // Pages and links first (code makes a page the first time a name is seen); facts come from the facts store.
    const facts: FiledFact[] = extracted.flatMap((i) =>
      !i.source ? [] : i.pages.filter((p) => p.links.length || withFacts.has(pageId(p.kind, p.name) ?? '')).map((p) => ({ kind: p.kind, name: p.name, links: p.links, source: sourceOf(i.kind), text: '' })),
    );
    const filed = wiki.file(facts, stamp);
    const changed = new Set(filed.changed);
    for (const id of withFacts) {
      const page = wiki.read(id);
      if (!page) continue;
      // The user's edits to the page since it was last written: a deleted line is wrong, a typed one theirs.
      this.facts.sync(id, '', page.facts.map((f) => ({ text: f.text, mine: !!f.mine })), now);
      const shown = this.facts.of(id).slice(0, 300);
      this.facts.setShown(id, '', shown.map((f) => f.id));
      wiki.setFacts(id, shown.map(asNote), stamp);
      changed.add(id);
    }
    filed.changed = [...changed];
    filed.facts = filedFacts.pageFacts;
    run.pages = filed.changed.length;
    // Pages waiting for a summary, oldest first; kept between runs (500 at most).
    let dirty = [...new Set([...this.dirtyPages(), ...filed.changed])].slice(-500);
    const summarized: string[] = [];
    const limit = this.o.config.pageSummariesPerRun;
    if (choice && limit > 0 && !run.error) {
      for (const id of dirty.slice(0, limit)) {
        if (this.overBudget(choice, now)) break;
        const page = wiki.read(id);
        if (!page?.facts.length) {
          dirty = dirty.filter((d) => d !== id);
          continue;
        }
        try {
          const { value, result } = await choice.model.structured(pageSummaryRequest(choice.role, this.o.userName, page), 'knowledge_page', PageSummary);
          this.spend(choice, result?.usage?.costUsd, now);
          wiki.setSummary(id, value.summary, value.contradictions, stamp);
          summarized.push(id);
          run.summaries++;
          dirty = dirty.filter((d) => d !== id);
        } catch (err) {
          const kind = err instanceof ModelError ? err.kind : 'read_error';
          if (STOP_KINDS.has(kind)) break;
          // A page that can't be summarised waits for its next new fact.
          dirty = dirty.filter((d) => d !== id);
          this.o.audit.append({ kind: 'knowledge', event: 'summary_failed', error: kind });
        }
      }
    }
    this.setting.set('wikiDirty', JSON.stringify(dirty));
    // Profiles: person pages the filing changed or made, and people new from mail, Signal or Contacts.
    if (this.o.profiles) {
      const pr = await this.o.profiles.update([...new Set([...filed.changed, ...summarized])], stamp, now);
      run.profiles = pr.written;
      if (pr.error) this.o.audit.append({ kind: 'knowledge', event: 'contacts_error', error: pr.error });
    }
    if (filed.changed.length || run.summaries || run.profiles || !existsSync(wiki.indexPath)) wiki.writeIndex(stamp);
    if (filed.changed.length || run.summaries) {
      wiki.log(stamp, `Filed ${filed.facts} facts on ${filed.changed.length} pages (${filed.created} new)${run.summaries ? `, rewrote ${run.summaries} summaries` : ''}: ${filed.changed.slice(0, 12).join(', ')}${filed.changed.length > 12 ? ', …' : ''}`);
    }
    // The check, every checkEveryDays, once there are pages.
    const every = this.o.config.checkEveryDays;
    const checkedAt = this.num('checkedAt');
    if (every > 0 && (!checkedAt || now - checkedAt >= every * DAY) && wiki.ids().length) {
      this.setting.set('checkedAt', String(now));
      const text = this.check(stamp);
      this.o.onCheck?.(text.split('\n')[0]!);
    }
  }

  /** K4: the check, by code, written to check.md; also /knowledge check. */
  check(stamp = utcToLocal(this.now(), this.o.timeZone).replace('T', ' ').slice(0, 16)): string {
    const wiki = this.o.wiki;
    if (!wiki) return 'The knowledge wiki is off (wiki = false under [knowledge]).';
    const c = wiki.check(this.o.file.read(), stamp.slice(0, 10));
    this.o.audit.append({ kind: 'knowledge', event: 'check', pages: c.pages, stale: c.stale.length, duplicates: c.duplicates.length, orphans: c.orphans.length, disagree: c.disagree.length });
    wiki.log(stamp, checkText(c, stamp).split('\n')[0]!);
    return wiki.writeCheck(c, stamp);
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
