/**
 * The approval broker for calendar changes (C1). A model call can only put a card in the
 * chat: create, change or cancel one event. The change itself, and every invite, update or
 * cancellation email Google sends for it, happens only in confirm(), reached solely by a
 * click on that card carrying the hash of what the card showed.
 *
 *   pending ──confirm click (hash matches)──▶ running ──▶ done
 *      │                                        └──────▶ failed ──confirm click──▶ running
 *      └──── Discard ──▶ discarded                 (failed can be discarded too)
 *
 * Retrying is safe: a new event gets an id derived from its card, so a second insert finds
 * the first instead of making a copy; changes and cancellations land on the same state twice.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { type CalEvent, type CalendarApi, CalendarError, type EventWrite, describeCalendarError } from './google.js';
import { formatSpan, nextDay, zonedToUtc } from './time.js';

/** Start and end as the user's wall-clock times ("2026-11-02T15:00"), or dates for all-day events (end inclusive). */
export interface Span {
  start: string;
  end: string;
  allDay: boolean;
}

export type CalendarChange =
  | { change: 'create'; title: string; span: Span; location: string; description: string; attendees: string[] }
  | {
      change: 'update';
      eventId: string;
      /** The event's title now, for the card; `set.title` renames it. */
      title: string;
      set: { title?: string; span?: Span; location?: string; description?: string };
      /** Guests added by this change. */
      addAttendees: string[];
      /** Everyone who will get an update email: the event's guests after the change. */
      attendees: string[];
      before: string;
    }
  | { change: 'cancel'; eventId: string; title: string; when: string; attendees: string[] };

type EventItem = Extract<ChatItem, { kind: 'event' }>;
type EventState = EventItem['state'];

interface Row {
  id: string;
  spec: string;
  card: string;
  hash: string;
  state: EventState;
  result: string | null;
  created_at: number;
}

/** The part of the card that's shown; the hash covers it and the change behind it. */
type CardFields = Omit<EventItem, 'kind' | 'id' | 'hash' | 'state' | 'result' | 'at'>;

export interface CalendarActionsOptions {
  store: Store;
  api: CalendarApi;
  audit: AuditLog;
  timeZone: string;
  show: (item: ChatItem, isNew: boolean) => void;
  clock?: () => number;
  newId?: () => string;
}

export type CalendarConfirmResult = 'done' | 'failed' | 'refused';

const TOOL: Record<CalendarChange['change'], string> = { create: 'calendar_create_event', update: 'calendar_update_event', cancel: 'calendar_cancel_event' };

/** Google's event id for the event a create card makes: base32hex, so hex digits after "aios". */
export function eventIdForCard(cardId: string): string {
  return `aios${createHash('sha256').update(cardId).digest('hex').slice(0, 28)}`;
}

/** Instants for a span in `timeZone`; all-day ends are exclusive midnights (UTC dates). */
export function spanInstants(span: Span, timeZone: string): { startMs: number; endMs: number; allDay: boolean } {
  if (span.allDay) return { startMs: Date.parse(`${span.start}T00:00:00Z`), endMs: Date.parse(`${nextDay(span.end)}T00:00:00Z`), allDay: true };
  return { startMs: zonedToUtc(span.start, timeZone).getTime(), endMs: zonedToUtc(span.end, timeZone).getTime(), allDay: false };
}

function spanWrite(span: Span, timeZone: string): Pick<EventWrite, 'start' | 'end'> {
  if (span.allDay) return { start: { date: span.start }, end: { date: nextDay(span.end) } };
  return { start: { dateTime: `${span.start}:00`, timeZone }, end: { dateTime: `${span.end}:00`, timeZone } };
}

const norm = (a: string) => a.trim().toLowerCase();

export class CalendarActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: CalendarActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `cal-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM calendar_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): EventItem {
    return { kind: 'event', id: r.id, ...(JSON.parse(r.card) as CardFields), hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
  }

  get(id: string): EventItem | null {
    const r = this.row(id);
    return r ? this.item(r) : null;
  }

  private refresh(id: string): void {
    const r = this.row(id);
    if (r) this.o.show(this.item(r), false);
  }

  private transition(id: string, from: EventState[], to: EventState, result: string | null = null): boolean {
    const r = this.db
      .prepare(`UPDATE calendar_actions SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  private card(c: CalendarChange, warnings: string[]): CardFields {
    const tz = this.o.timeZone;
    switch (c.change) {
      case 'create':
        return {
          change: 'create',
          title: c.title,
          when: formatSpan(spanInstants(c.span, tz), tz),
          ...(c.location ? { location: c.location } : {}),
          ...(c.description ? { description: c.description } : {}),
          attendees: c.attendees,
          warnings,
        };
      case 'update':
        return {
          change: 'update',
          title: c.set.title ?? c.title,
          when: c.set.span ? formatSpan(spanInstants(c.set.span, tz), tz) : c.before,
          ...(c.set.span ? { before: c.before } : {}),
          ...(c.set.location !== undefined ? { location: c.set.location } : {}),
          ...(c.set.description !== undefined ? { description: c.set.description } : {}),
          attendees: c.attendees,
          warnings,
        };
      case 'cancel':
        return { change: 'cancel', title: c.title, when: c.when, attendees: c.attendees, warnings };
    }
  }

  /** Show a card asking for the change. Changes nothing, and sends nothing. */
  propose(c: CalendarChange, warnings: string[]): EventItem {
    const id = this.newId();
    const spec = JSON.stringify(c);
    const card = JSON.stringify(this.card(c, warnings));
    const hash = createHash('sha256').update(`${id}\n${spec}\n${card}`).digest('hex');
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO calendar_actions (id, spec, card, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, spec, card, hash, now, now);
    this.o.audit.append({ kind: 'calendar', event: 'proposed', cardId: id, change: c.change, ...('eventId' in c ? { eventId: c.eventId } : {}), attendees: c.attendees, warnings: warnings.length });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  /**
   * The confirm click. Runs only a pending (or failed, to retry) card whose hash matches
   * what the card showed. Exactly one of two concurrent clicks can win.
   */
  async confirm(id: string, shownHash: string): Promise<CalendarConfirmResult> {
    const r = this.row(id);
    const spec = r ? (JSON.parse(r.spec) as CalendarChange) : null;
    const audit = (entry: Record<string, unknown>) =>
      this.o.audit.append({ kind: 'tool', tool: spec ? TOOL[spec.change] : 'calendar', tier: 'write', cardId: id, via: 'click', ...entry });
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
    audit({ decision: 'approved', change: spec.change, ...('eventId' in spec ? { eventId: spec.eventId } : {}), attendees: spec.attendees });
    this.refresh(id);
    try {
      const { result, eventId } = await this.run(spec, id);
      this.transition(id, ['running'], 'done', result);
      audit({ decision: 'approved', ok: true, eventId });
      this.refresh(id);
      return 'done';
    } catch (err) {
      const why = describeCalendarError(err);
      this.transition(id, ['running'], 'failed', `Didn't work: ${why}.`);
      audit({ decision: 'approved', ok: false, error: why });
      this.refresh(id);
      return 'failed';
    }
  }

  discard(id: string): boolean {
    if (!this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'calendar', event: 'discarded', cardId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: a change left running by a crash is shown as failed, never re-run on its own. A click retries it safely. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM calendar_actions WHERE state = 'running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['running'], 'failed', 'The app stopped while doing this. Check your calendar, or click again: it will not be done twice.');
      this.o.audit.append({ kind: 'calendar', event: 'interrupted', cardId: id });
      this.refresh(id);
    }
  }

  /** The organizer's own copy of an event, fetched again at click time. */
  private async ownEvent(eventId: string): Promise<CalEvent | null> {
    const ev = await this.o.api.get(eventId);
    if (ev && !ev.mine) throw new CalendarError('forbidden', 'only the organizer can change this event');
    return ev;
  }

  private async run(c: CalendarChange, cardId: string): Promise<{ result: string; eventId: string }> {
    const tz = this.o.timeZone;
    const api = this.o.api;
    const invites = (n: number, what: string) => (n ? ` ${what} ${n === 1 ? 'goes' : 'go'} to ${n} ${n === 1 ? 'guest' : 'guests'}.` : '');
    switch (c.change) {
      case 'create': {
        const eventId = eventIdForCard(cardId);
        const body: EventWrite = {
          summary: c.title,
          ...spanWrite(c.span, tz),
          ...(c.location ? { location: c.location } : {}),
          ...(c.description ? { description: c.description } : {}),
          ...(c.attendees.length ? { attendees: c.attendees.map((email) => ({ email })) } : {}),
        };
        try {
          await api.insert(eventId, body, c.attendees.length ? 'all' : 'none');
        } catch (err) {
          // A retry after the first insert went through: it is there already.
          if (!(err instanceof CalendarError && err.kind === 'conflict') || !(await api.get(eventId))) throw err;
        }
        return { result: `✓ Added to your calendar.${invites(c.attendees.length, 'An invite')}`, eventId };
      }
      case 'update': {
        const ev = await this.ownEvent(c.eventId);
        if (!ev) throw new CalendarError('not_found', 'event is gone');
        const have = new Set(ev.attendees.map((a) => norm(a.email)));
        const added = c.addAttendees.filter((a) => !have.has(norm(a)));
        const body: EventWrite = {
          ...(c.set.title !== undefined ? { summary: c.set.title } : {}),
          ...(c.set.span ? spanWrite(c.set.span, tz) : {}),
          ...(c.set.location !== undefined ? { location: c.set.location } : {}),
          ...(c.set.description !== undefined ? { description: c.set.description } : {}),
          // Google replaces the whole list, so the guests already there (with their answers) stay in it.
          ...(added.length ? { attendees: [...ev.attendees.map((a) => ({ email: a.email })), ...added.map((email) => ({ email }))] } : {}),
        };
        const guests = ev.attendees.filter((a) => !a.self).length + added.length;
        await api.patch(c.eventId, body, guests ? 'all' : 'none');
        return { result: `✓ Changed.${invites(guests, 'An update')}`, eventId: c.eventId };
      }
      case 'cancel': {
        const ev = await this.ownEvent(c.eventId);
        if (!ev) return { result: '✓ It was already gone from your calendar.', eventId: c.eventId };
        const guests = ev.attendees.filter((a) => !a.self).length;
        try {
          await api.remove(c.eventId, guests ? 'all' : 'none');
        } catch (err) {
          if (!(err instanceof CalendarError && (err.kind === 'gone' || err.kind === 'not_found'))) throw err;
        }
        return { result: `✓ Cancelled.${invites(guests, 'A cancellation')}`, eventId: c.eventId };
      }
    }
  }
}
