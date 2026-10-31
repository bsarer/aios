/** C1: wall-clock times in the user's zone, and the Google sign-in request. */
import { describe, expect, it } from 'vitest';
import { CALENDAR_SCOPE, describeCalendarError, CalendarError, toCalEvent } from '../src/calendar/google.js';
import { authorizationUrl, exchangeCode, newPkce, readRedirect } from '../src/calendar/oauth.js';
import { daysBetween, formatSpan, nextDay, utcToLocal, zonedToUtc } from '../src/calendar/time.js';
import { createHash } from 'node:crypto';

describe('calendar times', () => {
  it('turns local times into instants in zones with and without DST', () => {
    expect(zonedToUtc('2026-11-02T15:00', 'Europe/Istanbul').toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(zonedToUtc('2026-07-01T09:30', 'Europe/Berlin').toISOString()).toBe('2026-07-01T07:30:00.000Z');
    expect(zonedToUtc('2026-12-01T09:30', 'Europe/Berlin').toISOString()).toBe('2026-12-01T08:30:00.000Z');
    expect(zonedToUtc('2026-11-02T09:00', 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
    // The night clocks go back: 02:30 happens twice; either is a real instant.
    expect(utcToLocal(zonedToUtc('2026-10-25T02:30', 'Europe/Berlin').getTime(), 'Europe/Berlin')).toBe('2026-10-25T02:30');
    // A date alone is local midnight.
    expect(zonedToUtc('2026-11-02', 'Europe/Istanbul').toISOString()).toBe('2026-11-01T21:00:00.000Z');
  });

  it('refuses dates and times that do not exist', () => {
    expect(() => zonedToUtc('2026-02-30T10:00', 'UTC')).toThrow(/not a real date/);
    expect(() => zonedToUtc('2026-11-02T25:00', 'UTC')).toThrow(/not a real date/);
    expect(() => zonedToUtc('next tuesday', 'UTC')).toThrow(/not a date/);
    expect(() => zonedToUtc('2026-11-02T15:00+03:00', 'UTC')).toThrow(/not a date/);
  });

  it('counts days and formats spans the way people say them', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28T10:00')).toBe('2028-02-29');
    expect(daysBetween('2026-11-02', '2026-11-05')).toBe(3);
    const tz = 'Europe/Istanbul';
    const at = (s: string) => zonedToUtc(s, tz).getTime();
    expect(formatSpan({ startMs: at('2026-11-02T15:00'), endMs: at('2026-11-02T15:30'), allDay: false }, tz)).toBe('Mon 2 Nov, 15:00–15:30');
    expect(formatSpan({ startMs: at('2026-11-02T23:00'), endMs: at('2026-11-03T01:00'), allDay: false }, tz)).toBe('Mon 2 Nov, 23:00 – Tue 3 Nov, 01:00');
    expect(formatSpan({ startMs: Date.parse('2026-11-02T00:00:00Z'), endMs: Date.parse('2026-11-03T00:00:00Z'), allDay: true }, tz)).toBe('Mon 2 Nov, all day');
    expect(formatSpan({ startMs: Date.parse('2026-11-02T00:00:00Z'), endMs: Date.parse('2026-11-05T00:00:00Z'), allDay: true }, tz)).toBe('Mon 2 Nov – Wed 4 Nov, all day');
  });
});

describe('Google events', () => {
  it('reads who organizes an event and how the user answered', () => {
    const guest = toCalEvent({
      id: 'e1',
      summary: 'Review',
      start: { dateTime: '2026-11-02T15:00:00+03:00' },
      end: { dateTime: '2026-11-02T16:00:00+03:00' },
      organizer: { email: 'lena@aios.test' },
      attendees: [{ email: 'john@aios.test', self: true, responseStatus: 'declined' }],
    })!;
    expect(guest).toMatchObject({ mine: false, myResponse: 'declined', busy: true, allDay: false, startMs: Date.parse('2026-11-02T12:00:00Z') });
    const own = toCalEvent({ id: 'e2', start: { date: '2026-11-02' }, end: { date: '2026-11-03' }, transparency: 'transparent' })!;
    expect(own).toMatchObject({ mine: true, title: '(no title)', allDay: true, busy: false });
    // Google's stubs for deleted occurrences have no times.
    expect(toCalEvent({ id: 'gone', status: 'cancelled' })).toBeNull();
  });

  it('says what went wrong in one plain sentence', () => {
    expect(describeCalendarError(new CalendarError('auth', 'invalid_grant'))).toMatch(/pnpm calendar:login/);
    expect(describeCalendarError(new CalendarError('not_signed_in', ''))).toMatch(/not signed in/);
  });
});

describe('Google sign-in', () => {
  it('asks for calendar events only, with PKCE and a state', () => {
    const pkce = newPkce();
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    const url = new URL(authorizationUrl({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', clientId: 'c1', redirectUri: 'http://127.0.0.1:5555', pkce }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'c1',
      redirect_uri: 'http://127.0.0.1:5555',
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('accepts the redirect only with the right state', () => {
    expect(readRedirect(new URL('http://127.0.0.1/?state=s1&code=abc'), 's1')).toEqual({ code: 'abc' });
    expect(readRedirect(new URL('http://127.0.0.1/?state=forged&code=abc'), 's1')).toHaveProperty('error');
    expect(readRedirect(new URL('http://127.0.0.1/?state=s1&error=access_denied'), 's1')).toEqual({ error: 'access was not granted' });
  });

  it('refuses a sign-in that did not grant calendar access', async () => {
    const fake = (async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', scope: 'openid email' }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCode({ tokenUrl: 'http://x/token', clientId: 'c', clientSecret: null, code: 'k', redirectUri: 'http://127.0.0.1:1', verifier: 'v', fetch: fake })).rejects.toThrow(/calendar access was not granted/);
  });
});
