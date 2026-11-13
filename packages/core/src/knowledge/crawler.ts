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
import type { MailClient, MessageSummary } from '../mail/imap.js';
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
import { type Item, type ItemKind, KnowledgeLedger, type Phase, type Progress } from './ledger.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 3;
const MAX_HOURLY_MAILS = 100;
const MAX_HOURLY_FILES = 50;
const MAX_EVENTS = 80;
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
  timeZone: string;
  file: KnowledgeFile;
  store: Store;
  audit: AuditLog;
  mail?: Pick<MailClient, 'search' | 'read'> | undefined;
  calendar?: Pick<CalendarApi, 'list'> | undefined;
  files?: Pick<FileCatalog, 'readableSince' | 'get' | 'body'> | undefined;
  /** Display name for a real file path (F1's FileRoots.display). */
  displayPath?: ((path: string) => string) | undefined;
  /** Null when that model isn't there: its items wait. */
  models: { backfill: ModelChoice | null; hourly: ModelChoice | null };
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
  tidied: boolean;
  error?: string;
}

const sourceOf = (k: ItemKind): Note['source'] => (k === 'sent' || k === 'mail' ? 'mail' : k === 'file' ? 'files' : k);
const senderName = (from: string) => from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

export class KnowledgeCrawler {
  readonly ledger: KnowledgeLedger;
  private running = false;
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

  /** The first pass hasn't listed its items yet, or still has some to read. */
  private backfilling(): boolean {
    return (this.o.config.backfillDays > 0 && !this.setting.get('backfillStarted')) || this.ledger.backfillOpen();
  }

  progress(): Progress {
    return this.ledger.progress();
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
    const backfill = this.backfilling() && !!this.o.models.backfill;
    if (!backfill) {
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

  private mailKind(m: MessageSummary): ItemKind {
    if (m.id.startsWith('Sent:')) return 'sent';
    const own = (this.o.userAddresses ?? []).map((a) => a.toLowerCase());
    return m.from && own.includes(m.from.address.toLowerCase()) ? 'sent' : 'mail';
  }

  private async findMail(since: number, limit: number, phase: Phase, now: number): Promise<{ added: number; fresh: MessageSummary[] } | null> {
    if (!this.o.mail || !this.on('mail') || limit <= 0) return { added: 0, fresh: [] };
    let found: MessageSummary[];
    try {
      found = await this.o.mail.search('', { since: new Date(since), limit });
    } catch (err) {
      this.o.audit.append({ kind: 'knowledge', event: 'mail_error', error: (err as Error).message.slice(0, 200) });
      return null;
    }
    const items = found.map((m) => ({ key: `mail:${m.messageId ?? m.id}`, kind: this.mailKind(m), ref: m.id, at: m.date?.getTime() ?? now, phase }));
    const fresh = found.filter((m) => !this.ledger.has(`mail:${m.messageId ?? m.id}`));
    return { added: this.ledger.add(items, now), fresh };
  }

  private findFiles(since: number, limit: number, phase: Phase, now: number): number {
    if (!this.o.files || !this.on('files') || limit <= 0) return 0;
    const files = this.o.files.readableSince(since, limit);
    return this.ledger.add(files.map((f) => ({ key: `file:${f.path}:${f.mtimeMs}`, kind: 'file' as const, ref: f.path, at: Math.round(f.mtimeMs), phase })), now);
  }

  private async discover(now: number): Promise<{ found: number; freshMail: MessageSummary[] }> {
    const c = this.o.config;
    let found = 0;
    const freshMail: MessageSummary[] = [];
    if (c.backfillDays > 0 && !this.setting.get('backfillStarted')) {
      const mail = await this.findMail(now - c.backfillDays * DAY, c.backfillMaxMails, 'backfill', now);
      found += this.findFiles(0, c.backfillMaxFiles, 'backfill', now);
      // Started once the mailbox could be listed; the files are added again harmlessly if not.
      if (mail) {
        found += mail.added;
        this.setting.set('backfillStarted', String(now));
        this.setting.set('mailAt', String(now));
        this.setting.set('filesAt', String(now));
        this.setting.set('chatAt', String(now));
      }
      return { found, freshMail };
    }
    // New since the last look, with a day of overlap for mail (late arrivals) and an hour for files.
    const mailAt = Number(this.setting.get('mailAt') ?? now - DAY);
    const mail = await this.findMail(mailAt - DAY, MAX_HOURLY_MAILS, 'hourly', now);
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
      return chatRequest(role, name, turns.map((t) => `${t.role === 'user' ? name : 'Astra'}: ${t.content.replace(/\s+/g, ' ').slice(0, t.role === 'user' ? 600 : 300)}`));
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

  /** Reads up to `perRun` pending items; stops early when the model can't be reached. */
  private async extract(choice: ModelChoice, events: CalEvent[] | null, now: number): Promise<{ read: number; notes: number; error?: string }> {
    const items = this.ledger.pending(this.o.config.perRun);
    // The cloud takes a few at once; a laptop's local model one at a time.
    const lanes = choice.role === 'local' ? 1 : 3;
    let read = 0;
    let notes = 0;
    let stop: string | undefined;
    let next = 0;
    const lane = async () => {
      while (!stop && next < items.length) {
        const item = items[next++]!;
        try {
          const req = await this.requestFor(item, choice.role, events, now);
          if (!req) {
            this.ledger.setExtracted(item.key, [], now);
            continue;
          }
          const { value } = await choice.model.structured(req, 'knowledge_notes', ExtractedNotes);
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
    return { read, notes, ...(stop ? { error: stop } : {}) };
  }

  // ── The run ──

  private async update(): Promise<KnowledgeRun> {
    const now = this.now();
    const tz = this.o.timeZone;
    const { found, freshMail } = await this.discover(now);
    const phase: Phase = this.backfilling() ? 'backfill' : 'hourly';
    const choice = phase === 'backfill' ? this.o.models.backfill : this.o.models.hourly;
    const evs = await this.events(now);
    const run: KnowledgeRun = { by: choice ? 'model' : 'code', phase, found, read: 0, notes: 0, tidied: false };
    if (choice) Object.assign(run, await this.extract(choice, evs, now));

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
    if (tidy && phase === 'backfill' && !this.ledger.backfillPending() && !this.setting.get('tidied') && !run.error) {
      try {
        const { value } = await tidy.model.structured(tidyRequest(tidy.role, this.o.userName, k), 'knowledge_tidy', TidiedNotes);
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
      tidied: run.tidied,
      mail: p.mail,
      files: p.files,
      sections: Object.fromEntries(Object.entries(k.sections).map(([s, n]) => [s, n.length])),
      ...(run.error ? { error: run.error } : {}),
    });
    return run;
  }
}

/** One line on how far the reading is, for /knowledge. */
export function progressText(p: Progress, backfillOnCloud: boolean): string {
  if (p.phase === 'backfill') {
    return `Reading your history${backfillOnCloud ? ' on the cloud model' : ''}: ${p.mail.done} of ${p.mail.total} emails and ${p.files.done} of ${p.files.total} files so far. It continues every five minutes.`;
  }
  return `Read so far: ${p.mail.done} emails and ${p.files.done} files.${p.waiting ? ` ${p.waiting} waiting for the next update.` : ''}`;
}

/** /knowledge: the file for the chat, as plain text (the UI shows it as text, never as markup). */
export function knowledgeView(file: KnowledgeFile, progress?: string, maxChars = 12_000): string {
  const text = file.text();
  if (!text) return `There is no knowledge base yet. It is written in the background; type /knowledge update to start now. It will be at ${file.path}.${progress ? `\n${progress}` : ''}`;
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n[… the rest is in the file]` : text;
  return `${progress ? `${progress}\n\n` : ''}${body.trimEnd()}\n\nFile: ${file.path}`;
}
