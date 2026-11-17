/**
 * T2: the morning brief. Once a day, the first time AI OS is in use after `brief.after` (it
 * starts, the chat window gets focus, a chat window connects, or the user sends a message),
 * and outside quiet hours and pause; or on /brief. One card: urgent mail from triage, today's
 * events and free gaps, and the to-dos and reminders due today (or overdue).
 *
 * Code gathers and orders everything. The local model (L1 pattern) only writes a two-line
 * intro: it has no tools, gets mail, event and to-do text inside <untrusted> tags, and its
 * answer is cleaned to short plain text. Without [models.local], or when it fails, code writes
 * the intro, so the brief never needs a cloud call. Read only: the card has no buttons that
 * change anything.
 */
import { randomUUID } from 'node:crypto';
import type { BriefConfig, BriefEvent, ChatItem, MailRow, Tone } from '@aios/shared';
import { z } from 'zod';
import type { AuditLog } from '../audit.js';
import type { CalEvent, CalendarApi } from '../calendar/google.js';
import { nextDay, utcToLocal, zonedToUtc } from '../calendar/time.js';
import { freeGaps } from '../calendar/tools.js';
import { cleanLine, type LocalModel } from '../assistant/worker.js';
import { inQuietHours } from '../mail/pipeline.js';
import type { MailEvent, MailState } from '../mail/state.js';
import { ModelError, type ModelRequest } from '../model.js';
import { localVoiceLine, MORNING_BRIEF_SYSTEM_PROMPT } from '../prompts.js';
import type { Store } from '../store.js';
import type { Todo, TodoList } from '../todos/list.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';

type BriefItem = Extract<ChatItem, { kind: 'brief' }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Mail since the last brief, but never more than this far back. */
const MAX_MAIL_BACK_MS = 3 * DAY;
const MIN_GAP_MS = 30 * 60_000;
const MAX_TODOS = 10;
const GLANCE_CALENDAR_MS = 10 * 60_000;

export const BriefIntro = z.strictObject({ intro: z.string().min(1).max(600) });

export interface BriefFacts {
  userName: string;
  title: string;
  mails: MailRow[];
  moreMail: number;
  events: BriefEvent[];
  free: string[];
  calendar: BriefItem['calendar'];
  todos: BriefItem['todos'];
  moreTodos: number;
}

/** The local model's request: no tools; everything from mail, invites and the list inside <untrusted> wrappers. */
export function briefRequest(f: BriefFacts, tone: Tone = 'friendly'): ModelRequest {
  const wrap = (source: 'email' | 'calendar' | 'system', id: string, lines: string[], max: number) =>
    lines.length ? wrapUntrusted(source, id, sanitize({ text: lines.join('\n') }, { maxChars: max })) : '(none)';
  return {
    role: 'local',
    messages: [
      { role: 'system', content: MORNING_BRIEF_SYSTEM_PROMPT + localVoiceLine(tone) },
      {
        role: 'user',
        content: [
          `Name: ${f.userName}`,
          `Today: ${f.title}`,
          '',
          `Urgent email (${f.mails.length}, plus ${f.moreMail} other new):`,
          wrap('email', 'brief-mail', f.mails.map((m) => `${m.from.replace(/\s*<[^>]*>$/, '')}: ${m.subject} (${m.summary})`), 3000),
          '',
          f.calendar === 'ok' ? `Events today (${f.events.length}):` : f.calendar === 'off' ? 'No calendar connected.' : "The calendar couldn't be read.",
          f.calendar === 'ok' ? wrap('calendar', 'brief-events', f.events.map((e) => `${e.when}: ${e.title}${e.location ? ` at ${e.location}` : ''}`), 3000) : '',
          f.free.length ? `Free time: ${f.free.join(', ')}` : '',
          '',
          `Due today or overdue (${f.todos.length}, plus ${f.moreTodos} without a date):`,
          wrap('system', 'brief-todos', f.todos.map((t) => `${t.text}${t.when ? ` (${t.when})` : ''}${t.overdue ? ' (overdue)' : ''}`), 2000),
        ]
          .filter((l, i, all) => l !== '' || all[i - 1] !== '')
          .join('\n'),
      },
    ],
  };
}

export async function briefIntro(model: LocalModel, f: BriefFacts, tone?: Tone): Promise<string> {
  const { value } = await model.structured(briefRequest(f, tone), 'morning_brief', BriefIntro);
  return cleanLine(value.intro, 260);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The intro when the local model isn't there or fails: counts and times written by code. */
export function codeIntro(f: BriefFacts, hour: number, tone: Tone = 'friendly'): string {
  // P1: friendly and playful get the warmer greeting; neutral and concise keep the plain one.
  const warm = tone === 'friendly' || tone === 'playful';
  const hello = warm
    ? `${hour < 5 ? 'Hi' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'}, ${f.userName}!`
    : `${hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${f.userName}.`;
  if (!f.mails.length && !f.events.length && !f.todos.length) {
    return warm
      ? `${hello} Nothing urgent${f.calendar === 'ok' ? ', no events' : ''} and nothing due today. Enjoy the quiet.`
      : `${hello} Nothing urgent${f.calendar === 'ok' ? ', no events' : ''} and nothing due today.`;
  }
  const parts: string[] = [];
  if (f.mails.length) parts.push(`${plural(f.mails.length, 'urgent email')}`);
  if (f.calendar === 'ok') parts.push(f.events.length ? `${plural(f.events.length, 'event')} (the first ${f.events[0]!.when === 'all day' ? 'all day' : `at ${f.events[0]!.when.slice(0, 5)}`})` : 'no events');
  const overdue = f.todos.filter((t) => t.overdue).length;
  if (f.todos.length) parts.push(`${plural(f.todos.length, 'thing')} due${overdue ? `, ${overdue} overdue` : ''}`);
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
  return `${hello} Today: ${list}.`;
}

export interface MorningBriefOptions {
  config: BriefConfig;
  userName: string;
  timeZone: string;
  store: Store;
  audit: AuditLog;
  mail: Pick<MailState, 'triagedSince'>;
  /** Left out without a calendar. */
  calendar?: { api: Pick<CalendarApi, 'list'>; workday: { start: string; end: string } } | undefined;
  /** Left out when to-dos are off. */
  todos?: Pick<TodoList, 'open'> | undefined;
  /** Null without [models.local]: code writes the intro. */
  model: LocalModel | null;
  /** P1: the tone for the intro. Default friendly. */
  tone?: () => Tone;
  isPaused: () => boolean;
  quietHours?: { start: string; end: string } | undefined;
  post: (item: ChatItem) => void;
  now?: () => number;
  newId?: () => string;
}

export type BriefOutcome = 'off' | 'not_due' | 'done_already' | 'paused' | 'quiet' | 'posted';

function minutesOfDay(at: number, timeZone: string): number {
  const [h = 0, m = 0] = utcToLocal(at, timeZone).slice(11).split(':').map(Number);
  return h * 60 + m;
}

function toRow(e: MailEvent): MailRow {
  const t = e.triage!;
  return { id: e.mailId, from: e.from.slice(0, 200), subject: e.subject.slice(0, 300), summary: t.summary, urgency: t.urgency, needsReply: t.needs_reply };
}

export class MorningBrief {
  private running = false;
  private readonly now: () => number;
  private glanceCal: { day: string; at: number; calendar: BriefItem['calendar']; events: BriefEvent[] } | null = null;

  constructor(private readonly o: MorningBriefOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Posts today's brief if it is due. Called when AI OS is in use, and safe to call often. */
  async runIfDue(): Promise<BriefOutcome> {
    const c = this.o.config;
    if (!c.enabled) return 'off';
    const now = this.now();
    const [h = 0, m = 0] = c.after.split(':').map(Number);
    if (minutesOfDay(now, this.o.timeZone) < h * 60 + m) return 'not_due';
    const today = utcToLocal(now, this.o.timeZone).slice(0, 10);
    if (this.o.store.getSetting('brief.last') === today || this.running) return 'done_already';
    if (this.o.isPaused()) return 'paused';
    if (inQuietHours(now, this.o.timeZone, this.o.quietHours)) return 'quiet';
    this.o.store.setSetting('brief.last', today);
    await this.run();
    return 'posted';
  }

  /** Builds and posts the brief now (also /brief). */
  async run(): Promise<BriefItem | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.build();
    } finally {
      this.running = false;
    }
  }

  /**
   * W1: counts and times for the brief tile, written by code: no subjects, titles or to-do text.
   * The calendar is read at most every ten minutes for it.
   */
  async glance(): Promise<{ lines: string[]; attention: boolean }> {
    const now = this.now();
    const tz = this.o.timeZone;
    const lastAt = Number(this.o.store.getSetting('brief.lastAt') ?? 0);
    const since = Math.max(lastAt || now - DAY, now - MAX_MAIL_BACK_MS);
    const urgent = this.o.mail.triagedSince(since).filter((e) => e.triage?.urgency === 'high').length;
    const lines = [urgent ? `${plural(urgent, 'urgent email')}` : 'No urgent mail'];
    const today = utcToLocal(now, tz).slice(0, 10);
    if (!this.glanceCal || this.glanceCal.day !== today || now - this.glanceCal.at > GLANCE_CALENDAR_MS) {
      this.glanceCal = { day: today, at: now, ...(await this.events()) };
    }
    const cal = this.glanceCal;
    if (cal.calendar === 'ok') {
      const hm = utcToLocal(now, tz).slice(11, 16);
      const next = cal.events.map((e) => e.when.slice(0, 5)).find((t) => /^\d{2}:\d{2}$/.test(t) && t >= hm);
      lines.push(cal.events.length ? `${plural(cal.events.length, 'event')} today${next ? `, next ${next}` : ''}` : 'No events today');
    } else if (cal.calendar === 'error') lines.push("Calendar couldn't be read");
    const { todos } = this.todos();
    const overdue = todos.filter((t) => t.overdue).length;
    lines.push(todos.length ? `${todos.length} due${overdue ? `, ${overdue} overdue` : ''}` : 'Nothing due today');
    return { lines, attention: urgent > 0 || overdue > 0 };
  }

  private async events(): Promise<{ calendar: BriefItem['calendar']; events: BriefEvent[]; free: string[] }> {
    const cal = this.o.calendar;
    if (!cal) return { calendar: 'off', events: [], free: [] };
    const tz = this.o.timeZone;
    const now = this.now();
    const today = utcToLocal(now, tz).slice(0, 10);
    let all: CalEvent[];
    try {
      all = await cal.api.list({ timeMin: zonedToUtc(today, tz), timeMax: zonedToUtc(nextDay(today), tz), limit: 100, timeZone: tz }, AbortSignal.timeout(15_000));
    } catch (err) {
      this.o.audit.append({ kind: 'brief', event: 'calendar_error', error: (err as Error).message.slice(0, 200) });
      return { calendar: 'error', events: [], free: [] };
    }
    const shown = all.filter((e) => !e.cancelled && e.myResponse !== 'declined');
    const time = (ms: number) => utcToLocal(ms, tz).slice(11, 16);
    const clean = (s: string, max: number) => sanitize({ text: s }, { maxChars: max * 2 }).replace(/\s+/g, ' ').trim().slice(0, max);
    const events = shown.slice(0, this.o.config.maxEvents).map((e): BriefEvent => {
      const when = e.allDay ? 'all day' : `${time(e.startMs)}–${time(e.endMs)}${utcToLocal(e.endMs, tz).slice(0, 10) > today && !utcToLocal(e.endMs, tz).endsWith('T00:00') ? ' (ends tomorrow)' : ''}`;
      const location = clean(e.location, 120);
      return { when, title: clean(e.title, 200) || '(no title)', ...(location ? { location } : {}) };
    });
    // Free time from now (or the start of the working day) to its end, in gaps of half an hour or more.
    const nowHm = utcToLocal(Math.ceil(now / 300_000) * 300_000, tz).slice(11, 16);
    const start = nowHm > cal.workday.start ? nowHm : cal.workday.start;
    const free = start < cal.workday.end ? freeGaps(shown, { day: today, dayStart: start, dayEnd: cal.workday.end, timeZone: tz, minMs: MIN_GAP_MS }) : [];
    return { calendar: 'ok', events, free };
  }

  private todos(): { todos: BriefItem['todos']; moreTodos: number } {
    const list = this.o.todos;
    if (!list) return { todos: [], moreTodos: 0 };
    const tz = this.o.timeZone;
    const nowLocal = utcToLocal(this.now(), tz);
    const today = nowLocal.slice(0, 10);
    const day = (t: Todo) => t.remindAt?.slice(0, 10) ?? t.due;
    const open = list.open();
    const dueNow = open
      .filter((t) => (day(t) ?? '9999') <= today)
      .sort((a, b) => (a.remindAt ?? `${a.due}T99`).localeCompare(b.remindAt ?? `${b.due}T99`))
      .slice(0, MAX_TODOS)
      .map((t) => ({
        text: t.text,
        ...(t.remindAt ? { when: t.remindAt.slice(0, 10) === today ? t.remindAt.slice(11, 16) : t.remindAt.replace('T', ' ') } : t.due && t.due < today ? { when: `due ${t.due}` } : {}),
        overdue: (day(t) ?? today) < today,
      }));
    return { todos: dueNow, moreTodos: open.filter((t) => !day(t)).length };
  }

  private async build(): Promise<BriefItem> {
    const now = this.now();
    const tz = this.o.timeZone;
    const lastAt = Number(this.o.store.getSetting('brief.lastAt') ?? 0);
    const since = Math.max(lastAt || now - DAY, now - MAX_MAIL_BACK_MS);
    const mail = this.o.mail.triagedSince(since).filter((e) => e.triage);
    const urgent = mail.filter((e) => e.triage!.urgency === 'high');
    const mails = urgent.slice(0, this.o.config.maxMails).map(toRow);
    const facts: BriefFacts = {
      userName: this.o.userName,
      title: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now),
      mails,
      moreMail: mail.length - mails.length,
      ...(await this.events()),
      ...this.todos(),
    };
    let by: BriefItem['by'] = 'code';
    let intro = '';
    if (this.o.model) {
      try {
        intro = await briefIntro(this.o.model, facts, this.o.tone?.());
        if (intro) by = 'local';
      } catch (err) {
        this.o.audit.append({ kind: 'brief', event: 'intro_failed', error: err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200) });
      }
    }
    if (by === 'code') intro = codeIntro(facts, Number(utcToLocal(now, tz).slice(11, 13)), this.o.tone?.());
    const { userName: _name, ...card } = facts;
    const item: BriefItem = { kind: 'brief', id: this.o.newId?.() ?? randomUUID(), intro, by, ...card, at: now };
    this.o.store.setSetting('brief.lastAt', String(now));
    // Counts only: no subjects, titles or to-do text in the audit log.
    this.o.audit.append({ kind: 'brief', event: 'posted', by, mails: mails.length, moreMail: facts.moreMail, calendar: facts.calendar, events: facts.events.length, todos: facts.todos.length });
    this.o.post(item);
    return item;
  }
}
