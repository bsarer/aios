/**
 * Google Calendar over its REST API (v3) with plain fetch (C1). No Google SDK: a handful
 * of endpoints, each response checked with zod. Paths, parameters and scopes were checked
 * on 2026-10-31 against Google's discovery document
 * (https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest, revision 20261028) and
 * its OpenID configuration (https://accounts.google.com/.well-known/openid-configuration).
 *
 * The access token lives in memory only; the refresh token is read from the keyring for
 * each refresh and never logged.
 */
import { z } from 'zod';

/** Only events: no calendar settings, sharing or deleting calendars. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export type CalendarErrorKind = 'not_signed_in' | 'auth' | 'not_found' | 'gone' | 'forbidden' | 'conflict' | 'rate' | 'server' | 'network' | 'bad_request';

export class CalendarError extends Error {
  override readonly name = 'CalendarError';
  constructor(
    readonly kind: CalendarErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** One short reason for the chat. */
export function describeCalendarError(err: unknown): string {
  if (err instanceof CalendarError) {
    switch (err.kind) {
      case 'not_signed_in':
        return 'AI OS is not signed in to Google Calendar yet. Run `pnpm calendar:login`';
      case 'auth':
        return 'the Google Calendar sign-in has expired or was revoked. Run `pnpm calendar:login` again';
      case 'not_found':
        return 'that event is not in the calendar any more';
      case 'gone':
        return 'that event was already deleted';
      case 'forbidden':
        return "Google Calendar doesn't allow this change (only the organizer can change some events)";
      case 'conflict':
        return 'that event already exists';
      case 'rate':
        return 'Google Calendar is limiting requests; try again in a minute';
      case 'server':
        return 'Google Calendar had a problem; try again shortly';
      case 'network':
        return "Google Calendar can't be reached. Check the network connection";
      case 'bad_request':
        return `Google Calendar refused the request: ${err.message}`.slice(0, 200);
    }
  }
  if ((err as Error)?.name === 'KeyringError') return "the calendar sign-in isn't readable from the keyring (it may still be locked)";
  return ((err as Error)?.message ?? 'unknown error').slice(0, 200);
}

type Fetch = typeof fetch;

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.string() });
const OAuthError = z.object({ error: z.string(), error_description: z.string().optional() });

export interface GoogleAuthOptions {
  tokenUrl: string;
  clientId: string;
  /** Desktop clients may send their secret; Google treats it as optional with PKCE. */
  clientSecret: () => Promise<string | null>;
  /** From the keyring; null when nobody has signed in. */
  refreshToken: () => Promise<string | null>;
  fetch?: Fetch;
  clock?: () => number;
}

/** Access tokens from the stored refresh token, cached until a minute before they expire. */
export class GoogleAuth {
  private token: { value: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetch: Fetch;
  private readonly clock: () => number;

  constructor(private readonly o: GoogleAuthOptions) {
    this.fetch = o.fetch ?? fetch;
    this.clock = o.clock ?? Date.now;
  }

  /** Forget the cached access token, e.g. after a 401. */
  invalidate(): void {
    this.token = null;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expires > this.clock()) return this.token.value;
    this.pending ??= this.refresh(signal).finally(() => (this.pending = null));
    return this.pending;
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const refreshToken = await this.o.refreshToken();
    if (!refreshToken) throw new CalendarError('not_signed_in', 'no refresh token');
    const secret = await this.o.clientSecret();
    const body = new URLSearchParams({ client_id: this.o.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, ...(secret ? { client_secret: secret } : {}) });
    let res: Response;
    try {
      res = await this.fetch(this.o.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CalendarError('network', (err as Error).message);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = OAuthError.safeParse(json);
      // invalid_grant: the refresh token expired or was revoked (Google: sign in again).
      if (e.success && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(e.data.error)) throw new CalendarError('auth', e.data.error, res.status);
      throw new CalendarError(res.status >= 500 ? 'server' : 'bad_request', e.success ? e.data.error : `token endpoint answered ${res.status}`, res.status);
    }
    const t = TokenResponse.safeParse(json);
    if (!t.success) throw new CalendarError('server', 'the token endpoint sent something unexpected');
    this.token = { value: t.data.access_token, expires: this.clock() + (t.data.expires_in - 60) * 1000 };
    return t.data.access_token;
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

const EventTime = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() });
const Person = z.object({ email: z.string().optional(), displayName: z.string().optional(), self: z.boolean().optional() });

/** What AI OS reads of an event. Other fields Google sends are dropped. */
export const GoogleEvent = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventTime.optional(),
  end: EventTime.optional(),
  transparency: z.string().optional(),
  recurringEventId: z.string().optional(),
  organizer: Person.optional(),
  attendees: z
    .array(Person.extend({ responseStatus: z.string().optional(), organizer: z.boolean().optional(), resource: z.boolean().optional() }))
    .optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEvent>;

const EventList = z.object({ items: z.array(GoogleEvent).default([]), nextPageToken: z.string().optional(), timeZone: z.string().optional() });

/** An event as the tools use it. Times are instants; all-day events are UTC midnights of their dates. */
export interface CalEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** Free (transparent) events don't block time. */
  busy: boolean;
  /** The user organizes it (or it has no organizer, like a private event). */
  mine: boolean;
  organizer: string | null;
  attendees: { email: string; name: string | null; self: boolean; response: string | null; organizer: boolean }[];
  /** How the user answered the invite, when they are a guest. */
  myResponse: string | null;
  /** One occurrence of a repeating event. */
  recurring: boolean;
  cancelled: boolean;
}

function instant(t: z.infer<typeof EventTime> | undefined): { ms: number; allDay: boolean } | null {
  if (t?.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isNaN(ms) ? null : { ms, allDay: false };
  }
  if (t?.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { ms: Date.parse(`${t.date}T00:00:00Z`), allDay: true };
  return null;
}

const who = (p: { email?: string | undefined; displayName?: string | undefined } | undefined) =>
  p ? (p.displayName && p.email ? `${p.displayName} <${p.email}>` : (p.email ?? p.displayName ?? null)) : null;

/** Null for events without usable times (Google's cancelled stubs). */
export function toCalEvent(e: GoogleEvent): CalEvent | null {
  const start = instant(e.start);
  const end = instant(e.end) ?? (start ? { ms: start.ms + (start.allDay ? 86_400_000 : 0), allDay: start.allDay } : null);
  if (!start || !end) return null;
  const attendees = (e.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({ email: a.email!, name: a.displayName ?? null, self: a.self === true, response: a.responseStatus ?? null, organizer: a.organizer === true }));
  return {
    id: e.id,
    title: e.summary ?? '(no title)',
    description: e.description ?? '',
    location: e.location ?? '',
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
    busy: e.transparency !== 'transparent',
    mine: !e.organizer || e.organizer.self === true,
    organizer: who(e.organizer),
    attendees,
    myResponse: attendees.find((a) => a.self)?.response ?? null,
    recurring: !!e.recurringEventId,
    cancelled: e.status === 'cancelled',
  };
}

/** What AI OS writes. Times are wall-clock in `timeZone`, or dates for all-day events. */
export interface EventWrite {
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime: string; timeZone: string } | { date: string };
  end?: { dateTime: string; timeZone: string } | { date: string };
  attendees?: { email: string }[];
}

/** "all" emails every guest; "none" is used only when an event has no guests at all. */
export type SendUpdates = 'all' | 'none';

export interface CalendarApi {
  list(q: { timeMin: Date; timeMax: Date; query?: string; limit: number; timeZone: string }, signal?: AbortSignal): Promise<CalEvent[]>;
  get(id: string, signal?: AbortSignal): Promise<CalEvent | null>;
  /** `id` is chosen by AI OS, so a retried insert can't create the event twice. */
  insert(id: string, body: EventWrite, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<CalEvent>;
  patch(id: string, body: EventWrite, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<CalEvent>;
  remove(id: string, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<void>;
}

/** Ids Google gives events (base32hex, with "_<time>" for an occurrence). Anything else is refused before a request. */
export const EVENT_ID = /^[A-Za-z0-9_-]{1,300}$/;

export interface GoogleCalendarOptions {
  apiBaseUrl: string;
  calendarId: string;
  auth: Pick<GoogleAuth, 'accessToken' | 'invalidate'>;
  fetch?: Fetch;
  /** Wait before the one retry after a 429 or 5xx. */
  retryDelayMs?: number;
}

const ApiError = z.object({ error: z.object({ code: z.number().optional(), message: z.string().optional(), errors: z.array(z.object({ reason: z.string().optional() })).optional() }) });

export class GoogleCalendar implements CalendarApi {
  private readonly fetch: Fetch;

  constructor(private readonly o: GoogleCalendarOptions) {
    this.fetch = o.fetch ?? fetch;
  }

  private url(path: string, params: Record<string, string | undefined> = {}): string {
    const base = this.o.apiBaseUrl.replace(/\/$/, '');
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
    const s = qs.toString();
    return `${base}/calendars/${encodeURIComponent(this.o.calendarId)}/${path}${s ? `?${s}` : ''}`;
  }

  private async request(method: string, url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.auth.accessToken(signal);
      let res: Response;
      try {
        res = await this.fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new CalendarError('network', (err as Error).message);
      }
      if (res.status === 204) return null;
      const json: unknown = await res.json().catch(() => null);
      if (res.ok) return json;
      // A token that stopped working early: get a new one once.
      if (res.status === 401 && attempt === 0) {
        this.o.auth.invalidate();
        continue;
      }
      const e = ApiError.safeParse(json);
      const reason = e.success ? (e.data.error.errors?.[0]?.reason ?? '') : '';
      const message = (e.success ? e.data.error.message : undefined) ?? `HTTP ${res.status}`;
      const rate = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason));
      if ((rate || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 1000));
        continue;
      }
      const kind: CalendarErrorKind =
        res.status === 401 ? 'auth' : rate ? 'rate' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : res.status === 410 ? 'gone' : res.status >= 500 ? 'server' : 'bad_request';
      throw new CalendarError(kind, message.slice(0, 200), res.status);
    }
  }

  private parse(json: unknown): CalEvent {
    const e = GoogleEvent.safeParse(json);
    const ev = e.success ? toCalEvent(e.data) : null;
    if (!ev) throw new CalendarError('server', 'Google Calendar sent an event without times');
    return ev;
  }

  async list(q: { timeMin: Date; timeMax: Date; query?: string; limit: number; timeZone: string }, signal?: AbortSignal): Promise<CalEvent[]> {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    // Repeating events come as their occurrences, in start order.
    do {
      const json = await this.request(
        'GET',
        this.url('events', {
          singleEvents: 'true',
          orderBy: 'startTime',
          timeMin: q.timeMin.toISOString(),
          timeMax: q.timeMax.toISOString(),
          timeZone: q.timeZone,
          maxResults: String(Math.min(250, q.limit)),
          q: q.query || undefined,
          pageToken,
        }),
        undefined,
        signal,
      );
      const page = EventList.safeParse(json);
      if (!page.success) throw new CalendarError('server', 'Google Calendar sent an unexpected event list');
      for (const item of page.data.items) {
        const ev = toCalEvent(item);
        if (ev && !ev.cancelled) out.push(ev);
      }
      pageToken = page.data.nextPageToken;
    } while (pageToken && out.length < q.limit);
    return out.slice(0, q.limit);
  }

  async get(id: string, signal?: AbortSignal): Promise<CalEvent | null> {
    if (!EVENT_ID.test(id)) return null;
    try {
      const ev = this.parse(await this.request('GET', this.url(`events/${encodeURIComponent(id)}`), undefined, signal));
      return ev.cancelled ? null : ev;
    } catch (err) {
      if (err instanceof CalendarError && (err.kind === 'not_found' || err.kind === 'gone')) return null;
      throw err;
    }
  }

  async insert(id: string, body: EventWrite, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<CalEvent> {
    return this.parse(await this.request('POST', this.url('events', { sendUpdates }), { id, ...body }, signal));
  }

  async patch(id: string, body: EventWrite, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<CalEvent> {
    if (!EVENT_ID.test(id)) throw new CalendarError('not_found', 'not an event id');
    return this.parse(await this.request('PATCH', this.url(`events/${encodeURIComponent(id)}`, { sendUpdates }), body, signal));
  }

  async remove(id: string, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<void> {
    if (!EVENT_ID.test(id)) throw new CalendarError('not_found', 'not an event id');
    await this.request('DELETE', this.url(`events/${encodeURIComponent(id)}`, { sendUpdates }), undefined, signal);
  }
}
