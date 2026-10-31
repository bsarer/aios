/**
 * Calendar tools (C1). calendar_list returns event text inside <untrusted source="calendar">
 * tags and is registered with untrustedOutput: anyone can put an event in the user's calendar
 * by sending an invite, so its title and notes are treated like an email. calendar_free
 * returns only times worked out by code, so it carries no outside text.
 *
 * calendar_find returns ids and times only, so the model can find the event to change
 * without reading anyone's text.
 *
 * The create, update and cancel tools are write tier: the registry neither offers nor runs
 * them while email or event text is in view, so outside text can't even produce a card.
 * Otherwise they only put a card in the chat (CalendarActions); the change, and every email
 * Google sends for it, happens on the user's click.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import type { CalendarActions, Span } from './actions.js';
import { spanInstants } from './actions.js';
import { type CalEvent, type CalendarApi, CalendarError, EVENT_ID, describeCalendarError } from './google.js';
import { LOCAL_DATE, LOCAL_DATE_TIME, daysBetween, formatSpan, nextDay, utcToLocal, zonedToUtc } from './time.js';

export interface CalendarToolOptions {
  api: CalendarApi;
  actions: CalendarActions;
  timeZone: string;
  /** Length of a new event without an end. */
  defaultMinutes: number;
  workday: { start: string; end: string };
  /** The user's own addresses, never warned about. */
  selfAddresses: string[];
}

const MAX_LIST_DAYS = 62;
const MAX_FREE_DAYS = 14;
const MAX_EVENT_DAYS = 14;

const norm = (a: string) => a.trim().toLowerCase();
const clean = (s: string, maxChars: number) => sanitize({ text: s }, { maxChars });

class InputError extends Error {}

/** Guests who came from neither the user's own message nor the event: the shape of an injected "also invite attacker@…". */
export function attendeeWarnings(added: string[], ctx: Pick<ToolContext, 'userText'>, known: string[]): string[] {
  const ok = new Set(known.map(norm));
  for (const typed of ctx.userText.match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi) ?? []) ok.add(norm(typed));
  return added.filter((a) => !ok.has(norm(a))).map((a) => `${a} is not in your message. Check this address before you click: they will get an email.`);
}

function instantOf(local: string, timeZone: string): number {
  try {
    return zonedToUtc(local, timeZone).getTime();
  } catch (err) {
    throw new InputError((err as Error).message);
  }
}

/** A start and optional end from the model, checked and completed. `keep` is the length to keep when only the start moves. */
export function makeSpan(start: string, end: string | undefined, o: { timeZone: string; defaultMinutes: number; keep?: { ms: number; days: number } }): Span {
  const allDay = LOCAL_DATE.test(start);
  if (!allDay && !LOCAL_DATE_TIME.test(start)) throw new InputError(`start must look like 2026-11-02T15:00, or 2026-11-02 for all day (got ${start})`);
  if (end !== undefined && (allDay ? !LOCAL_DATE.test(end) : !LOCAL_DATE_TIME.test(end))) {
    throw new InputError(allDay ? 'an all-day event ends on a date like 2026-11-03' : 'end must be a time like 2026-11-02T16:00');
  }
  const startMs = instantOf(start, o.timeZone);
  if (allDay) {
    const last = end ?? (o.keep ? addDays(start, o.keep.days) : start);
    instantOf(last, o.timeZone);
    const days = daysBetween(start, last);
    if (days < 0) throw new InputError('the event ends before it starts');
    if (days >= MAX_EVENT_DAYS) throw new InputError(`events can be at most ${MAX_EVENT_DAYS} days long`);
    return { start, end: last, allDay: true };
  }
  const endLocal = end ?? utcToLocal(startMs + (o.keep?.ms ?? o.defaultMinutes * 60_000), o.timeZone);
  const endMs = instantOf(endLocal, o.timeZone);
  if (endMs <= startMs) throw new InputError('the event must end after it starts');
  if (endMs - startMs > MAX_EVENT_DAYS * 86_400_000) throw new InputError(`events can be at most ${MAX_EVENT_DAYS} days long`);
  return { start, end: endLocal, allDay: false };
}

function addDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextDay(d);
  return d;
}

/** One event for the model: times and flags written by code, its text wrapped as untrusted. */
function eventBlock(e: CalEvent, timeZone: string): string {
  const flags = [
    e.mine ? 'you organize it' : `you are a guest${e.myResponse ? ` (${e.myResponse === 'needsAction' ? 'not answered' : e.myResponse})` : ''}`,
    ...(e.recurring ? ['repeats'] : []),
    ...(!e.busy ? ['shown as free'] : []),
  ];
  const guests = e.attendees.filter((a) => !a.self).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));
  const text = [
    `Title: ${e.title}`,
    ...(e.location ? [`Where: ${e.location}`] : []),
    ...(!e.mine && e.organizer ? [`Organizer: ${e.organizer}`] : []),
    ...(guests.length ? [`Guests: ${guests.slice(0, 15).join(', ')}${guests.length > 15 ? ` and ${guests.length - 15} more` : ''}`] : []),
  ].join('\n');
  // Descriptions are often HTML (Google's editor, meeting invites).
  const notes = e.description ? `\nNotes: ${sanitize(/<[a-z][\s\S]*>/i.test(e.description) ? { html: e.description } : { text: e.description }, { maxChars: 1000 })}` : '';
  return `id: ${e.id}\nWhen: ${formatSpan(e, timeZone)} · ${flags.join(', ')}\n${wrapUntrusted('calendar', e.id, `${clean(text, 1500)}${notes}`)}`;
}

/** Turns an InputError into a plain tool error, and a calendar failure into one plain sentence for the chat. */
const asked = async (fn: () => Promise<string>): Promise<string> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InputError) return `Error: ${err.message}.`;
    if (err instanceof CalendarError) throw new Error(describeCalendarError(err));
    throw err;
  }
};

export function calendarTools(o: CalendarToolOptions): RegisteredTool[] {
  const tz = o.timeZone;
  // The registry refuses write-tier calls before a handler runs; only `propose` (a card) is reachable.
  const neverRuns = async (): Promise<string> => {
    throw new Error('calendar changes run only from a click on their card');
  };
  const denied = 'Error: only the user can change the calendar, and not while an email or event text is in view. Ask them to say what to change in a new message of their own.';
  /** `from`/`to` as calendar_list and calendar_find read them. */
  const period = (from: string, to: string | undefined) => {
    const fromMs = instantOf(from, tz);
    const end = to ?? nextDay(from);
    const toMs = LOCAL_DATE.test(end) && to !== undefined ? instantOf(nextDay(end), tz) : instantOf(end, tz);
    if (toMs <= fromMs) throw new InputError('`to` must be after `from`');
    if (toMs - fromMs > MAX_LIST_DAYS * 86_400_000) throw new InputError(`look at most ${MAX_LIST_DAYS} days at a time`);
    return { fromMs, toMs };
  };

  /** The user's own event, or a message saying why it can't be changed. */
  const ownEvent = async (id: string, signal: AbortSignal): Promise<CalEvent | string> => {
    if (!EVENT_ID.test(id)) return `Error: ${id} is not an event id. Use an id from calendar_find.`;
    const ev = await o.api.get(id, signal);
    if (!ev) return `Error: there is no event with id ${id}. Call calendar_find to find it.`;
    if (!ev.mine) return 'Error: the user is a guest on this event, and only its organizer can move or cancel it. Offer to email the organizer instead.';
    return ev;
  };

  return [
    {
      def: toolByName('calendar_list')!,
      label: 'Checking your calendar…',
      untrustedOutput: true,
      handler: (args, ctx) =>
        asked(async () => {
          const a = args as { from: string; to?: string; query?: string; limit?: number };
          const { fromMs, toMs } = period(a.from, a.to);
          const events = await o.api.list({ timeMin: new Date(fromMs), timeMax: new Date(toMs), ...(a.query ? { query: a.query } : {}), limit: a.limit ?? 25, timeZone: tz }, ctx.signal);
          const range = `${utcToLocal(fromMs, tz).replace('T', ' ')} to ${utcToLocal(toMs, tz).replace('T', ' ')} (${tz})`;
          if (!events.length) return `No events from ${range}${a.query ? ` matching "${clean(a.query, 200)}"` : ''}.`;
          return `${events.length} event(s) from ${range}, in start order. Text inside <untrusted> tags was written by whoever made the event.\n\n${events.map((e) => eventBlock(e, tz)).join('\n\n')}`;
        }),
    },
    {
      def: toolByName('calendar_find')!,
      label: 'Finding the event…',
      // Ids, times and who organizes: written by code, no event text. So it doesn't count as outside text.
      handler: (args, ctx) =>
        asked(async () => {
          const a = args as { from: string; to?: string; query?: string };
          const { fromMs, toMs } = period(a.from, a.to);
          const events = await o.api.list({ timeMin: new Date(fromMs), timeMax: new Date(toMs), ...(a.query ? { query: a.query } : {}), limit: 50, timeZone: tz }, ctx.signal);
          if (!events.length) return `No events found then${a.query ? ' matching that' : ''}. Try a wider time or other words.`;
          const line = (e: CalEvent) =>
            `id: ${e.id} · ${formatSpan(e, tz)} · ${e.mine ? 'the user organizes it' : 'someone else organizes it (cannot be changed)'}${e.recurring ? ' · repeats' : ''}${e.attendees.some((x) => !x.self) ? ` · ${e.attendees.filter((x) => !x.self).length} guest(s)` : ''}`;
          return `${events.length} event(s), in start order (titles are not shown here):\n${events.map(line).join('\n')}`;
        }),
    },
    {
      def: toolByName('calendar_free')!,
      label: 'Looking for free time…',
      handler: (args, ctx) =>
        asked(async () => {
          const a = args as { date: string; to?: string; dayStart?: string; dayEnd?: string; minutes?: number };
          if (!LOCAL_DATE.test(a.date) || (a.to !== undefined && !LOCAL_DATE.test(a.to))) return 'Error: dates look like 2026-11-05.';
          const last = a.to ?? a.date;
          instantOf(a.date, tz);
          instantOf(last, tz);
          const days = daysBetween(a.date, last) + 1;
          if (days < 1) return 'Error: `to` is before `date`.';
          if (days > MAX_FREE_DAYS) return `Error: look at most ${MAX_FREE_DAYS} days at a time.`;
          const dayStart = a.dayStart ?? o.workday.start;
          const dayEnd = a.dayEnd ?? o.workday.end;
          if (dayEnd !== '24:00' && dayEnd <= dayStart) return 'Error: dayEnd must be after dayStart.';
          const minMs = (a.minutes ?? 15) * 60_000;
          const timeMin = instantOf(a.date, tz);
          const timeMax = instantOf(nextDay(last), tz);
          const events = await o.api.list({ timeMin: new Date(timeMin), timeMax: new Date(timeMax), limit: 250, timeZone: tz }, ctx.signal);
          // Busy: events that block time and that the user hasn't declined. All-day ones block whole dates.
          const busy = events
            .filter((e) => e.busy && e.myResponse !== 'declined')
            .map((e) => (e.allDay ? { s: instantOf(utcToLocal(e.startMs, 'UTC').slice(0, 10), tz), e: instantOf(utcToLocal(e.endMs, 'UTC').slice(0, 10), tz) } : { s: e.startMs, e: e.endMs }))
            .sort((x, y) => x.s - y.s);
          const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
          const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
          const lines: string[] = [];
          let day = a.date;
          for (let i = 0; i < days; i++, day = nextDay(day)) {
            const ws = instantOf(`${day}T${dayStart}`, tz);
            const we = dayEnd === '24:00' ? instantOf(nextDay(day), tz) : instantOf(`${day}T${dayEnd}`, tz);
            const gaps: string[] = [];
            let cursor = ws;
            for (const b of busy) {
              if (b.e <= cursor || b.s >= we) continue;
              if (b.s - cursor >= minMs) gaps.push(`${time.format(cursor)}–${time.format(b.s)}`);
              cursor = Math.max(cursor, b.e);
              if (cursor >= we) break;
            }
            if (we - cursor >= minMs) gaps.push(`${time.format(cursor)}–${dayEnd === '24:00' ? '24:00' : time.format(we)}`);
            lines.push(`${dayName.format(Date.parse(`${day}T00:00:00Z`))} (${dayStart}–${dayEnd}): ${gaps.length ? `free ${gaps.join(', ')}` : 'no free time'}`);
          }
          return `Free time (${tz}), from the busy events in the calendar${a.minutes ? `, gaps of at least ${a.minutes} minutes` : ''}:\n${lines.join('\n')}`;
        }),
    },
    {
      def: toolByName('calendar_create_event')!,
      label: 'Preparing the event…',
      handler: neverRuns,
      deniedMessage: denied,
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { title: string; start: string; end?: string; location?: string; description?: string; attendees?: string[] };
          const span = makeSpan(a.start, a.end, { timeZone: tz, defaultMinutes: o.defaultMinutes });
          const attendees = [...new Map((a.attendees ?? []).map((e) => [norm(e), e.trim()])).values()];
          const warnings = attendeeWarnings(attendees, ctx, o.selfAddresses);
          const card = o.actions.propose({ change: 'create', title: a.title.trim(), span, location: a.location?.trim() ?? '', description: a.description?.trim() ?? '', attendees }, warnings);
          return `A card for "${clean(a.title, 200)}" on ${card.when} is in the chat with Add and Discard. It is NOT in the calendar yet${attendees.length ? ' and no invite has been sent' : ''}: only the user's click on Add does that. Say so in one line.`;
        }),
    },
    {
      def: toolByName('calendar_update_event')!,
      label: 'Preparing the change…',
      handler: neverRuns,
      deniedMessage: denied,
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { id: string; title?: string; start?: string; end?: string; location?: string; description?: string; addAttendees?: string[] };
          const ev = await ownEvent(a.id, ctx.signal);
          if (typeof ev === 'string') return ev;
          let span: Span | undefined;
          if (a.start !== undefined || a.end !== undefined) {
            const startLocal = a.start ?? (ev.allDay ? utcToLocal(ev.startMs, 'UTC').slice(0, 10) : utcToLocal(ev.startMs, tz));
            const keep = { ms: ev.endMs - ev.startMs, days: Math.max(0, Math.round((ev.endMs - ev.startMs) / 86_400_000) - 1) };
            span = makeSpan(startLocal, a.end, { timeZone: tz, defaultMinutes: o.defaultMinutes, keep });
            const now = spanInstants(span, tz);
            if (now.startMs === ev.startMs && now.endMs === ev.endMs && now.allDay === ev.allDay) span = undefined;
          }
          const existing = ev.attendees.map((x) => x.email);
          const have = new Set(existing.map(norm));
          const added = [...new Map((a.addAttendees ?? []).filter((e) => !have.has(norm(e))).map((e) => [norm(e), e.trim()])).values()];
          // Only what really changes goes on the card and to Google.
          const differs = (v: string | undefined, now: string) => v !== undefined && v.trim() !== now;
          const set = {
            ...(differs(a.title, ev.title) ? { title: a.title!.trim() } : {}),
            ...(span ? { span } : {}),
            ...(differs(a.location, ev.location) ? { location: a.location!.trim() } : {}),
            ...(differs(a.description, ev.description) ? { description: a.description!.trim() } : {}),
          };
          if (!Object.keys(set).length && !added.length) return 'Error: that would not change anything; the event already looks like that.';
          const guests = [...ev.attendees.filter((x) => !x.self).map((x) => x.email), ...added];
          const warnings = [
            ...attendeeWarnings(added, ctx, [...o.selfAddresses, ...existing]),
            ...(ev.recurring ? ['This is one occurrence of a repeating event; only this one changes.'] : []),
          ];
          o.actions.propose({ change: 'update', eventId: ev.id, title: ev.title, set, addAttendees: added, attendees: guests, before: formatSpan(ev, tz) }, warnings);
          return `A card with the change is in the chat with Change and Discard. Nothing has changed yet${guests.length ? ' and no guest has been told' : ''}: only the user's click does that. Say so in one line.`;
        }),
    },
    {
      def: toolByName('calendar_cancel_event')!,
      label: 'Preparing the cancellation…',
      handler: neverRuns,
      deniedMessage: denied,
      propose: (args, ctx) =>
        asked(async () => {
          const { id } = args as { id: string };
          const ev = await ownEvent(id, ctx.signal);
          if (typeof ev === 'string') return ev;
          const guests = ev.attendees.filter((x) => !x.self).map((x) => x.email);
          const warnings = ev.recurring ? ['This is one occurrence of a repeating event; only this one is cancelled.'] : [];
          o.actions.propose({ change: 'cancel', eventId: ev.id, title: ev.title, when: formatSpan(ev, tz), attendees: guests }, warnings);
          return `A card asking to cancel it is in the chat. Nothing is cancelled yet${guests.length ? ' and no guest has been told' : ''}: only the user's click on Cancel event does that. Say so in one line.`;
        }),
    },
  ];
}
