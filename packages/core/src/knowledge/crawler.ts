/**
 * K1: the knowledge base crawler. Every `[knowledge] everyMinutes` (an hour), outside quiet
 * hours and pause, it gathers what is new since the last update: mail that triage has read
 * (sender, subject, triage summary; never the body), calendar events from a week back to a
 * week ahead, descriptions of new or changed files from the F2 index, and the chat's own
 * messages and replies. Then:
 *
 * - Code writes "Upcoming" from the calendar, every run, with no model.
 * - One structured call on the chosen role (the local model by default) rewrites the other
 *   sections. It has no tools: the request has no `tools` field and the client it gets can
 *   only make structured calls (test). Every input, the current notes included, is inside
 *   <untrusted> wrappers, and each note it returns is cleaned to one short plain line.
 * - Without a model (no [models.local]) or when the call fails, code adds plain lines to
 *   "Recent activity" and the model's sections stay as they were.
 *
 * The result only ever goes to the knowledge file: nothing here calls a tool, writes memory or
 * config, or posts to the chat. The audit log records counts, never text.
 */
import type { KnowledgeConfig, KnowledgeSource } from '@aios/shared';
import { z } from 'zod';
import type { AuditLog } from '../audit.js';
import type { CalEvent, CalendarApi } from '../calendar/google.js';
import { utcToLocal } from '../calendar/time.js';
import type { FileCatalog, IndexedFile } from '../files/catalog.js';
import { inQuietHours } from '../mail/pipeline.js';
import type { MailEvent, MailState } from '../mail/state.js';
import { type ModelClient, ModelError, type ModelRequest } from '../model.js';
import { KNOWLEDGE_SYSTEM_PROMPT } from '../prompts.js';
import type { Store } from '../store.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type Knowledge, type KnowledgeFile, MODEL_SECTIONS, type ModelSection, type Note, SECTION_LIMITS, cleanNote } from './file.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The first update looks this far back. */
const FIRST_LOOK_BACK_MS = 7 * DAY;
const MAX_MAILS = 80;
const MAX_FILES = 40;
const MAX_EVENTS = 80;

/** The model's answer. Loose on length, so a long note is cut rather than failing the whole update. */
const NoteOut = z.strictObject({ text: z.string().min(1).max(1000), source: z.enum(['mail', 'calendar', 'files', 'chat']) });
export const KnowledgeUpdate = z.strictObject(
  Object.fromEntries(MODEL_SECTIONS.map((s) => [s, z.array(NoteOut).max(60)])) as Record<ModelSection, z.ZodArray<typeof NoteOut>>,
);
export type KnowledgeUpdate = z.infer<typeof KnowledgeUpdate>;

export type KnowledgeModel = Pick<ModelClient, 'structured'>;

export interface KnowledgeInputs {
  userName: string;
  now: string;
  current: Knowledge;
  mails: string[];
  events: string[];
  files: string[];
  chat: string[];
}

const wrapLines = (source: Parameters<typeof wrapUntrusted>[0], id: string, lines: string[], max: number) =>
  lines.length ? wrapUntrusted(source, id, sanitize({ text: lines.join('\n') }, { maxChars: max })) : '(none)';

/** The writer's request: no tools; the current notes and every new input inside <untrusted> wrappers. */
export function knowledgeRequest(role: ModelRequest['role'], i: KnowledgeInputs): ModelRequest {
  const current = MODEL_SECTIONS.flatMap((s) => [`[${s}]`, ...i.current.sections[s].map((n) => `- ${n.text} (${n.source})`)]);
  return {
    role,
    messages: [
      { role: 'system', content: KNOWLEDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `Person: ${i.userName}`,
          `Now: ${i.now}`,
          '',
          'Current notes:',
          wrapLines('knowledge', 'current-notes', current, 16_000),
          '',
          `New email (${i.mails.length}):`,
          wrapLines('email', 'knowledge-mail', i.mails, 10_000),
          '',
          `Calendar, a week back to a week ahead (${i.events.length}):`,
          wrapLines('calendar', 'knowledge-calendar', i.events, 6000),
          '',
          `New or changed files (${i.files.length}):`,
          wrapLines('document', 'knowledge-files', i.files, 8000),
          '',
          `Chat since the last update (${i.chat.length}):`,
          wrapLines('chat', 'knowledge-chat', i.chat, 8000),
        ].join('\n'),
      },
    ],
  };
}

/** Model notes to stored notes: cleaned, deduplicated, capped per section. */
export function cleanUpdate(u: KnowledgeUpdate): Record<ModelSection, Note[]> {
  const out = {} as Record<ModelSection, Note[]>;
  for (const s of MODEL_SECTIONS) {
    const seen = new Set<string>();
    out[s] = [];
    for (const n of u[s]) {
      const text = cleanNote(n.text);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out[s].push({ text, source: n.source });
      if (out[s].length >= SECTION_LIMITS[s]) break;
    }
  }
  return out;
}

const senderName = (from: string) => from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

export interface KnowledgeCrawlerOptions {
  config: KnowledgeConfig;
  userName: string;
  timeZone: string;
  file: KnowledgeFile;
  store: Store;
  audit: AuditLog;
  mail?: Pick<MailState, 'triagedSince'> | undefined;
  calendar?: Pick<CalendarApi, 'list'> | undefined;
  files?: Pick<FileCatalog, 'describedSince'> | undefined;
  /** Display name for a real file path (F1's FileRoots.display). */
  displayPath?: ((path: string) => string) | undefined;
  /** Null: code writes Upcoming and Recent activity only. */
  model: KnowledgeModel | null;
  role: ModelRequest['role'];
  isPaused: () => boolean;
  quietHours?: { start: string; end: string } | undefined;
  now?: () => number;
}

export type KnowledgeOutcome = 'off' | 'not_due' | 'running' | 'paused' | 'quiet' | 'updated';

export interface KnowledgeRun {
  by: 'model' | 'code';
  mails: number;
  events: number;
  files: number;
  chat: number;
  error?: string;
}

export class KnowledgeCrawler {
  private running = false;
  private readonly now: () => number;

  constructor(private readonly o: KnowledgeCrawlerOptions) {
    this.now = o.now ?? Date.now;
  }

  private on(s: KnowledgeSource): boolean {
    return this.o.config.sources.includes(s);
  }

  /** Called every few minutes; updates when an update is due. */
  async runIfDue(): Promise<KnowledgeOutcome> {
    if (!this.o.config.enabled) return 'off';
    if (this.running) return 'running';
    const now = this.now();
    const ranAt = Number(this.o.store.getSetting('knowledge.ranAt') ?? 0);
    if (ranAt && now - ranAt < this.o.config.everyMinutes * MINUTE) return 'not_due';
    if (this.o.isPaused()) return 'paused';
    if (inQuietHours(now, this.o.timeZone, this.o.quietHours)) return 'quiet';
    await this.run();
    return 'updated';
  }

  /** Updates the file now (also /knowledge update). Null when an update is already running. */
  async run(): Promise<KnowledgeRun | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.update();
    } finally {
      this.running = false;
    }
  }

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

  private when(e: CalEvent): string {
    const tz = this.o.timeZone;
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(e.startMs);
    return e.allDay ? `${day}, all day` : `${day} ${utcToLocal(e.startMs, tz).slice(11, 16)}`;
  }

  private async update(): Promise<KnowledgeRun> {
    const now = this.now();
    const tz = this.o.timeZone;
    const lastAt = Number(this.o.store.getSetting('knowledge.lastAt') ?? 0);
    const since = lastAt || now - FIRST_LOOK_BACK_MS;
    const current = this.o.file.read();

    const mailEvents: MailEvent[] = this.o.mail && this.on('mail') ? this.o.mail.triagedSince(since, MAX_MAILS).filter((e) => e.triage) : [];
    const mails = mailEvents.map((e) => `${senderName(e.from).slice(0, 120)}: ${e.subject.slice(0, 200)} (${e.triage!.summary}) [${e.triage!.category}, ${e.triage!.urgency}]`);
    const evs = await this.events(now);
    const events = (evs ?? []).map((e) => {
      const guests = e.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email).slice(0, 6);
      return `${this.when(e)}: ${e.title.slice(0, 200) || '(no title)'}${e.location ? ` at ${e.location.slice(0, 120)}` : ''}${guests.length ? ` with ${guests.join(', ')}` : ''}${e.startMs < now ? ' (past)' : ''}`;
    });
    // An hour of overlap: a file read before the last update can get its description after it.
    const fileRows: IndexedFile[] = this.o.files && this.on('files') ? this.o.files.describedSince(since - HOUR, MAX_FILES) : [];
    const display = this.o.displayPath ?? ((p: string) => p);
    const files = fileRows.map((f) => `${display(f.path).slice(0, 300)}: ${f.summary ?? ''}${f.keywords.length ? ` [${f.keywords.slice(0, 8).join(', ')}]` : ''}`);
    const turns = this.on('chat') ? this.o.store.chatTurnsBetween(since, now) : [];
    const chat = turns.slice(-60).map((t) => `${t.role === 'user' ? this.o.userName : 'AI OS'}: ${t.content.replace(/\s+/g, ' ').slice(0, t.role === 'user' ? 400 : 200)}`);

    // Upcoming: from the calendar by code, every run. Left as it was when the calendar can't be read.
    const k: Knowledge = { ...current, sections: { ...current.sections } };
    if (evs) {
      k.sections.upcoming = evs
        .filter((e) => e.endMs > now)
        .slice(0, SECTION_LIMITS.upcoming)
        .map((e) => ({ text: cleanNote(`${this.when(e)}: ${e.title || '(no title)'}${e.location ? ` at ${e.location}` : ''}`), source: 'calendar' as const }));
    } else if (!this.on('calendar') || !this.o.calendar) k.sections.upcoming = [];

    const run: KnowledgeRun = { by: 'code', mails: mails.length, events: events.length, files: files.length, chat: chat.length };
    const somethingNew = mails.length + files.length + chat.length > 0 || (events.length > 0 && !lastAt);
    let advanced = true;
    if (somethingNew && this.o.model) {
      try {
        const nowText = `${utcToLocal(now, tz).replace('T', ' ')} (${tz})`;
        const { value } = await this.o.model.structured(knowledgeRequest(this.o.role, { userName: this.o.userName, now: nowText, current, mails, events, files, chat }), 'knowledge_update', KnowledgeUpdate);
        const notes = cleanUpdate(value);
        const before = MODEL_SECTIONS.reduce((n, s) => n + current.sections[s].length, 0);
        const after = MODEL_SECTIONS.reduce((n, s) => n + notes[s].length, 0);
        // A small model that answers with nothing would wipe the file; keep what is there instead.
        if (before >= 5 && after === 0) throw new Error('empty answer');
        for (const s of MODEL_SECTIONS) k.sections[s] = notes[s];
        run.by = 'model';
      } catch (err) {
        run.error = err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200);
        // Try the same input again next time.
        advanced = false;
      }
    }
    if (run.by === 'code' && somethingNew) {
      const lines: Note[] = [
        ...mailEvents.slice(0, 8).map((e) => ({ text: cleanNote(`Email from ${senderName(e.from)}: ${e.subject}`), source: 'mail' as const })),
        ...fileRows.slice(0, 5).map((f) => ({ text: cleanNote(`File changed: ${f.name}`), source: 'files' as const })),
      ].filter((n) => n.text);
      const known = new Set(k.sections.recent.map((n) => n.text.toLowerCase()));
      k.sections.recent = [...lines.filter((n) => !known.has(n.text.toLowerCase())), ...k.sections.recent].slice(0, SECTION_LIMITS.recent);
    }
    k.updated = utcToLocal(now, tz).replace('T', ' ').slice(0, 16);
    this.o.file.write(k, utcToLocal(now, tz).slice(0, 10), this.o.config.keepDays);
    this.o.store.setSetting('knowledge.ranAt', String(now));
    if (advanced) this.o.store.setSetting('knowledge.lastAt', String(now));
    // Counts only: no names, subjects, titles or notes in the audit log.
    this.o.audit.append({
      kind: 'knowledge',
      event: 'updated',
      by: run.by,
      mails: run.mails,
      events: run.events,
      files: run.files,
      chat: run.chat,
      notes: Object.fromEntries(Object.entries(k.sections).map(([s, n]) => [s, n.length])),
      ...(run.error ? { error: run.error } : {}),
    });
    return run;
  }
}

/** /knowledge: the file for the chat, as plain text (the UI shows it as text, never as markup). */
export function knowledgeView(file: KnowledgeFile, maxChars = 12_000): string {
  const text = file.text();
  if (!text) return `There is no knowledge base yet. It is written in the background every hour; type /knowledge update to write it now. It will be at ${file.path}.`;
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n[… the rest is in the file]` : text;
  return `${body.trimEnd()}\n\nFile: ${file.path}`;
}

