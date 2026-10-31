/**
 * C1: the calendar tools and their cards against the pretend Google Calendar, over HTTP,
 * through the real sign-in, client, tools and approval broker. Nothing reaches "Google"
 * except reads until a click with the card's hash; retries never make a second event.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  CalendarActions,
  type Delta,
  GoogleAuth,
  GoogleCalendar,
  type ModelRequest,
  type ModelResult,
  Shell,
  Store,
  type ToolCall,
  ToolRegistry,
  calendarTools,
  eventIdForCard,
  quarantineEarlierEmail,
  toolByName,
  zonedToUtc,
} from '@aios/core';
import type { ChatItem } from '@aios/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CAL_SELF, FAKE_CLIENT_ID, type FakeGoogleCalendar, calendarFixtures, startFakeGoogleCalendar } from '../../fixtures/calendar.js';

const TZ = 'Europe/Istanbul';
const BASE = '2026-11-02';
const day = (n: number) => new Date(Date.parse(`${BASE}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number, hhmm: string) => zonedToUtc(`${day(n)}T${hhmm}`, TZ).toISOString();
const TOMORROW = day(1);

let fake: FakeGoogleCalendar | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function setup(o: { refreshToken?: string | null } = {}) {
  fake = await startFakeGoogleCalendar(calendarFixtures(at, day));
  const dir = mkdtempSync(join(tmpdir(), 'aios-cal-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const store = new Store(':memory:');
  const auth = new GoogleAuth({
    tokenUrl: fake.tokenUrl,
    clientId: FAKE_CLIENT_ID,
    clientSecret: async () => null,
    refreshToken: async () => (o.refreshToken === undefined ? 'test-only-refresh-token' : o.refreshToken),
  });
  const api = new GoogleCalendar({ apiBaseUrl: fake.apiBaseUrl, calendarId: 'primary', auth, retryDelayMs: 1 });
  const cards: ChatItem[] = [];
  const show = (item: ChatItem, isNew: boolean) => (isNew ? cards.push(item) : cards.splice(cards.findIndex((c) => c.id === item.id), 1, item));
  const actions = new CalendarActions({ store, api, audit, timeZone: TZ, show });
  const tools = new ToolRegistry(audit);
  for (const t of calendarTools({ api, actions, timeZone: TZ, defaultMinutes: 30, workday: { start: '09:00', end: '18:00' }, selfAddresses: [CAL_SELF] })) tools.register(t);
  let n = 0;
  const run = (name: string, args: unknown, ctx: { untrustedInContext?: boolean; userText?: string } = {}) =>
    tools.execute({ id: `c${++n}`, name, arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext: ctx.untrustedInContext ?? false, userText: ctx.userText ?? '' });
  const writes = () => fake!.requests.filter((r) => r.path.includes('/events') && r.method !== 'GET');
  const auditLog = () => readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const eventCards = () => cards.filter((c): c is Extract<ChatItem, { kind: 'event' }> => c.kind === 'event');
  return { fake, store, audit, api, auth, actions, tools, run, writes, auditLog, cards, eventCards };
}

describe('calendar tools', () => {
  it('registers reads as read tier, changes as cards, and marks event text as untrusted', async () => {
    const { tools } = await setup();
    expect(toolByName('calendar_list')!.tier).toBe('read');
    expect(toolByName('calendar_free')!.tier).toBe('read');
    expect(toolByName('calendar_find')!.tier).toBe('read');
    for (const n of ['calendar_create_event', 'calendar_update_event', 'calendar_cancel_event']) expect(toolByName(n)!.tier).toBe('write');
    expect(tools.returnsUntrusted('calendar_list')).toBe(true);
    // Free time and finding an event's id are worked out by code from times alone: no event text in them.
    expect(tools.returnsUntrusted('calendar_free')).toBe(false);
    expect(tools.returnsUntrusted('calendar_find')).toBe(false);
  });

  it("lists a day's events in order, with times written by code and each event's text wrapped", async () => {
    const { run } = await setup();
    const r = await run('calendar_list', { from: TOMORROW });
    expect(r.ok).toBe(true);
    const ids = [...r.content.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(['standup1', 'lunch1', 'review1', 'focus1', 'evil1']);
    expect(r.content).toContain('When: Tue 3 Nov, 10:00–10:15 · you organize it');
    expect(r.content).toContain('When: Tue 3 Nov, 15:00–16:00 · you are a guest (accepted)');
    expect(r.content).toContain('When: Tue 3 Nov, 17:00–17:30 · you are a guest (not answered)');
    expect(r.content).toContain('shown as free');
    // One wrapper per event, which the hostile text cannot close.
    expect(r.content.match(/<untrusted source="calendar" id="[^"]+">/g)).toHaveLength(5);
    expect(r.content.match(/<\/untrusted>/g)).toHaveLength(5);
    expect(r.content).not.toMatch(/<\/?system>/);
    expect(r.content).toContain('Guests: Ana Costa <ana@aios.test>');
    // HTML notes become text.
    expect(r.content).toContain('Notes: Bring the Q4 mockups.');
  });

  it('finds events by words and across days, and says when there are none', async () => {
    const { run } = await setup();
    const r = await run('calendar_list', { from: day(0), to: day(6), query: 'lunch' });
    expect([...r.content.matchAll(/^id: (\S+)$/gm)].map((m) => m[1])).toEqual(['lunch1']);
    expect((await run('calendar_list', { from: day(10) })).content).toMatch(/^No events from/);
    expect((await run('calendar_list', { from: day(0), to: day(100) })).content).toMatch(/at most 62 days/);
    expect((await run('calendar_list', { from: 'next week' })).content).toMatch(/^Error: .*not a date/);
  });

  it('finds an event by words and time, giving ids and times but no event text', async () => {
    const { run } = await setup();
    const all = await run('calendar_find', { from: TOMORROW });
    expect(all.content.split('\n').slice(1)).toEqual([
      'id: standup1 · Tue 3 Nov, 10:00–10:15 · the user organizes it · 1 guest(s)',
      'id: lunch1 · Tue 3 Nov, 12:30–13:30 · the user organizes it',
      'id: review1 · Tue 3 Nov, 15:00–16:00 · someone else organizes it (cannot be changed) · 1 guest(s)',
      'id: focus1 · Tue 3 Nov, 16:00–17:00 · the user organizes it',
      'id: evil1 · Tue 3 Nov, 17:00–17:30 · someone else organizes it (cannot be changed) · 1 guest(s)',
    ]);
    expect(all.content).not.toMatch(/Team standup|Lunch with|Quarterly|NOTE TO|untrusted|evil\.example|Lakeside/);
    const lunch = await run('calendar_find', { from: day(0), to: day(6), query: 'lunch' });
    expect(lunch.content).toContain('id: lunch1 ·');
    expect(lunch.content.match(/^id: /gm)).toHaveLength(1);
  });

  it('finds free time between busy events, ignoring free and declined ones', async () => {
    const { run } = await setup();
    const r = await run('calendar_free', { date: TOMORROW, to: day(3) });
    expect(r.content).toContain('Tue 3 Nov (09:00–18:00): free 09:00–10:00, 10:15–12:30, 13:30–15:00, 16:00–17:00, 17:30–18:00');
    expect(r.content).toContain('Wed 4 Nov (09:00–18:00): free 09:00–18:00');
    // The all-day offsite fills the day.
    expect(r.content).toContain('Thu 5 Nov (09:00–18:00): no free time');
    const long = await run('calendar_free', { date: TOMORROW, minutes: 90, dayStart: '08:00', dayEnd: '20:00' });
    expect(long.content).toContain('free 08:00–10:00, 10:15–12:30, 13:30–15:00, 17:30–20:00');
    expect(long.content).not.toMatch(/untrusted|Quarterly|Standup/i);
  });
});

describe('calendar cards', () => {
  it('a new event is only a card until the click; the click adds it once and invites the guests', async () => {
    const { run, writes, actions, eventCards, fake, auditLog } = await setup();
    const r = await run('calendar_create_event', { title: 'Coffee with Ana', start: `${TOMORROW}T14:00`, location: 'Lakeside', attendees: ['ana@aios.test'] }, { userText: 'set up coffee with ana@aios.test at 2 tomorrow' });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/NOT in the calendar yet and no invite has been sent/);
    expect(writes()).toEqual([]);
    const card = eventCards()[0]!;
    expect(card).toMatchObject({ change: 'create', title: 'Coffee with Ana', when: 'Tue 3 Nov, 14:00–14:30', location: 'Lakeside', attendees: ['ana@aios.test'], warnings: [], state: 'pending' });

    expect(await actions.confirm(card.id, 'f'.repeat(64))).toBe('refused');
    expect(writes()).toEqual([]);
    expect(await actions.confirm(card.id, card.hash)).toBe('done');
    expect(await actions.confirm(card.id, card.hash)).toBe('refused');
    const posts = writes();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      method: 'POST',
      query: { sendUpdates: 'all' },
      body: {
        id: eventIdForCard(card.id),
        summary: 'Coffee with Ana',
        location: 'Lakeside',
        start: { dateTime: `${TOMORROW}T14:00:00`, timeZone: TZ },
        end: { dateTime: `${TOMORROW}T14:30:00`, timeZone: TZ },
        attendees: [{ email: 'ana@aios.test' }],
      },
    });
    expect(fake.events.get(eventIdForCard(card.id))?.summary).toBe('Coffee with Ana');
    expect(eventCards()[0]).toMatchObject({ state: 'done', result: '✓ Added to your calendar. An invite goes to 1 guest.' });
    const clicks = auditLog().filter((e) => e.tool === 'calendar_create_event' && e.via === 'click');
    expect(clicks.map((e) => e.decision)).toEqual(['denied', 'approved', 'approved', 'denied']);
  });

  it('an event without guests sends no email, and all-day events use dates', async () => {
    const { run, writes, actions, eventCards } = await setup();
    await run('calendar_create_event', { title: 'Dentist', start: `${day(5)}T09:00`, end: `${day(5)}T10:00` });
    await run('calendar_create_event', { title: 'Holiday', start: day(8), end: day(9) });
    const [dentist, holiday] = eventCards();
    expect(holiday!.when).toBe('Tue 10 Nov – Wed 11 Nov, all day');
    await actions.confirm(dentist!.id, dentist!.hash);
    await actions.confirm(holiday!.id, holiday!.hash);
    expect(writes().map((w) => w.query.sendUpdates)).toEqual(['none', 'none']);
    expect((writes()[1]!.body as { start: unknown; end: unknown })).toMatchObject({ start: { date: day(8) }, end: { date: day(10) } });
  });

  it('refuses impossible times before any card', async () => {
    const { run, eventCards } = await setup();
    expect((await run('calendar_create_event', { title: 'x', start: `${TOMORROW}T14:00`, end: `${TOMORROW}T13:00` })).content).toMatch(/end after it starts/);
    expect((await run('calendar_create_event', { title: 'x', start: `${TOMORROW}T14:00`, end: day(2) })).content).toMatch(/end must be a time/);
    expect((await run('calendar_create_event', { title: 'x', start: '2026-02-30T10:00' })).content).toMatch(/not a real date/);
    expect((await run('calendar_create_event', { title: 'x', start: day(1), end: day(30) })).content).toMatch(/at most 14 days/);
    expect(eventCards()).toEqual([]);
  });

  it('moving an event keeps its length, changes only the time, and tells its guests on the click', async () => {
    const { run, writes, actions, eventCards } = await setup();
    const r = await run('calendar_update_event', { id: 'standup1', start: `${TOMORROW}T11:00` });
    expect(r.content).toMatch(/no guest has been told/);
    const card = eventCards()[0]!;
    expect(card).toMatchObject({ change: 'update', title: 'Team standup', before: 'Tue 3 Nov, 10:00–10:15', when: 'Tue 3 Nov, 11:00–11:15', attendees: ['ana@aios.test'] });
    expect(writes()).toEqual([]);
    expect(await actions.confirm(card.id, card.hash)).toBe('done');
    expect(writes()).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: '/calendar/v3/calendars/primary/events/standup1',
        query: { sendUpdates: 'all' },
        body: { start: { dateTime: `${TOMORROW}T11:00:00`, timeZone: TZ }, end: { dateTime: `${TOMORROW}T11:15:00`, timeZone: TZ } },
      }),
    ]);
  });

  it('adding a guest keeps the guests already there, and an address from nowhere is flagged', async () => {
    const { run, writes, actions, eventCards } = await setup();
    await run('calendar_update_event', { id: 'lunch1', addAttendees: ['sara@aios.test', 'stranger@elsewhere.example'] }, { userText: 'add sara@aios.test to lunch' });
    const card = eventCards()[0]!;
    expect(card.attendees).toEqual(['sara@aios.test', 'stranger@elsewhere.example']);
    expect(card.warnings).toEqual(['stranger@elsewhere.example is not in your message. Check this address before you click: they will get an email.']);
    await actions.confirm(card.id, card.hash);
    expect(writes()[0]!.body).toEqual({ attendees: [{ email: 'sara@aios.test' }, { email: 'stranger@elsewhere.example' }] });
  });

  it("refuses to change or cancel someone else's event, or one that doesn't exist", async () => {
    const { run, eventCards } = await setup();
    expect((await run('calendar_update_event', { id: 'review1', start: `${TOMORROW}T16:00` })).content).toMatch(/only its organizer/);
    expect((await run('calendar_cancel_event', { id: 'evil1' })).content).toMatch(/only its organizer/);
    expect((await run('calendar_cancel_event', { id: 'nope' })).content).toMatch(/no event with id nope/);
    expect((await run('calendar_cancel_event', { id: '../../users/me' })).content).toMatch(/not an event id/);
    expect((await run('calendar_update_event', { id: 'lunch1', title: 'Lunch with Sara' })).content).toMatch(/would not change anything/);
    expect(eventCards()).toEqual([]);
  });

  it('cancelling deletes on the click only, emails the guests, and Discard changes nothing', async () => {
    const { run, writes, actions, eventCards, fake } = await setup();
    await run('calendar_cancel_event', { id: 'standup1' });
    await run('calendar_cancel_event', { id: 'lunch1' });
    const [standup, lunch] = eventCards();
    expect(standup).toMatchObject({ change: 'cancel', title: 'Team standup', when: 'Tue 3 Nov, 10:00–10:15', attendees: ['ana@aios.test'] });
    expect(actions.discard(lunch!.id)).toBe(true);
    expect(await actions.confirm(lunch!.id, lunch!.hash)).toBe('refused');
    expect(await actions.confirm(standup!.id, standup!.hash)).toBe('done');
    expect(writes().map((w) => [w.method, w.path.split('/').at(-1), w.query.sendUpdates])).toEqual([['DELETE', 'standup1', 'all']]);
    expect(fake.events.get('standup1')?.status).toBe('cancelled');
    expect(fake.events.get('lunch1')?.status).toBeUndefined();
  });

  it('while email or event text is in view, calendar changes are neither offered nor run, and no card appears', async () => {
    const { run, tools, eventCards } = await setup();
    const offered = tools.specs({ untrustedInContext: true }).map((t) => t.name);
    expect(offered.sort()).toEqual(['calendar_find', 'calendar_free', 'calendar_list']);
    for (const [name, args] of [
      ['calendar_create_event', { title: 'Sync', start: `${TOMORROW}T09:00` }],
      ['calendar_update_event', { id: 'standup1', start: `${TOMORROW}T11:00` }],
      ['calendar_cancel_event', { id: 'standup1' }],
    ] as const) {
      const r = await run(name, args, { untrustedInContext: true });
      expect(r.ok).toBe(false);
      expect(r.content).toMatch(/cannot run while text from an email or another outside source/);
    }
    expect(eventCards()).toEqual([]);
  });

  it('a retry after a crash or a failure never makes a second event', async () => {
    const { run, actions, eventCards, fake, store, writes } = await setup();
    await run('calendar_create_event', { title: 'Planning', start: `${TOMORROW}T08:00` });
    const card = eventCards()[0]!;
    // The insert went through, then the app stopped before it noted that.
    fake.failNext(503);
    fake.failNext(503);
    store.db.prepare("UPDATE calendar_actions SET state = 'running' WHERE id = ?").run(card.id);
    actions.recover();
    expect(eventCards()[0]).toMatchObject({ state: 'failed' });
    expect(eventCards()[0]!.result).toMatch(/will not be done twice/);
    fake.events.set(eventIdForCard(card.id), { id: eventIdForCard(card.id), summary: 'Planning', start: { dateTime: at(1, '08:00') }, end: { dateTime: at(1, '08:30') }, organizer: { email: CAL_SELF, self: true } });
    // The first try meets a 503 twice (one retry), so the card fails; the click after that finds the event already there.
    expect(await actions.confirm(card.id, card.hash)).toBe('failed');
    expect(eventCards()[0]!.result).toMatch(/Google Calendar had a problem/);
    expect(await actions.confirm(card.id, card.hash)).toBe('done');
    expect([...fake.events.values()].filter((e) => e.summary === 'Planning')).toHaveLength(1);
    expect(writes().filter((w) => w.method === 'POST')).toHaveLength(3);
  });

  it('works through the shell: the click messages from the UI', async () => {
    const { run, actions, eventCards, store, tools, audit, writes } = await setup();
    const model = {
      async *stream(): AsyncGenerator<Delta, ModelResult> {
        const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
        yield { type: 'done', result: r };
        return r;
      },
    };
    const shell = new Shell({ store, model, tools, audit, userName: 'John', timeZone: TZ, modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null, calendarActions: actions });
    await run('calendar_create_event', { title: 'A', start: `${TOMORROW}T08:00` });
    await run('calendar_create_event', { title: 'B', start: `${TOMORROW}T08:30` });
    const [a, b] = eventCards();
    await shell.handle({ type: 'event_discard', id: b!.id });
    await shell.handle({ type: 'event_confirm', id: a!.id, hash: a!.hash });
    expect(eventCards().map((c) => c.state)).toEqual(['done', 'discarded']);
    expect(writes()).toHaveLength(1);
  });
});

describe('calendar sign-in', () => {
  it('gets an access token once and reuses it, and gets a new one after a 401', async () => {
    const { run, fake } = await setup();
    await run('calendar_list', { from: TOMORROW });
    await run('calendar_list', { from: day(2) });
    expect(fake.requests.filter((r) => r.path === '/token')).toHaveLength(1);
    fake.revokeAccessTokens();
    expect((await run('calendar_list', { from: TOMORROW })).ok).toBe(true);
    expect(fake.requests.filter((r) => r.path === '/token')).toHaveLength(2);
    // The refresh token itself never appears in a request URL.
    expect(fake.requests.every((r) => !JSON.stringify(r.query).includes('refresh'))).toBe(true);
  });

  it('says plainly when nobody has signed in or the sign-in has expired', async () => {
    const none = await setup({ refreshToken: null });
    const r = await none.run('calendar_list', { from: TOMORROW });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not signed in to Google Calendar yet. Run `pnpm calendar:login`/);
    await fake!.close();
    fake = null;
    const expired = await setup({ refreshToken: 'revoked' });
    expect((await expired.run('calendar_list', { from: TOMORROW })).content).toMatch(/expired or was revoked/);
  });
});

describe('calendar quarantine', () => {
  it('folds an earlier calendar read into a note about the calendar', () => {
    const call: ToolCall = { id: 'c1', name: 'calendar_list', arguments: '{"from":"2026-11-03"}' };
    const out = quarantineEarlierEmail(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: "what's on tomorrow" },
        { role: 'assistant', content: null, toolCalls: [call] },
        { role: 'tool', toolCallId: 'c1', name: 'calendar_list', content: '<untrusted source="calendar" id="e">x</untrusted>' },
        { role: 'assistant', content: 'You have a standup.' },
        { role: 'user', content: 'thanks' },
      ],
      (n) => n === 'calendar_list',
    );
    expect(out.map((m) => m.content)).toEqual([
      's',
      "what's on tomorrow",
      '(Answering this, I read the calendar. That exchange is hidden from me now, because event text from invites can carry instructions. If the user refers to it, look at the calendar again.)',
      'thanks',
    ]);
  });

  it('the chat model is told about the calendar only when it has the tools', async () => {
    const { store, tools, audit } = await setup();
    const requests: ModelRequest[] = [];
    const model = {
      async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
        requests.push(req);
        const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
        yield { type: 'done', result: r };
        return r;
      },
    };
    const shell = new Shell({ store, model, tools, audit, userName: 'John', timeZone: TZ, modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null });
    await shell.handle({ type: 'send', text: 'hi' });
    const system = String(requests[0]!.messages[0]!.content);
    expect(system).toContain('calendar_create_event');
    // The rules must not look like outside text themselves, or every turn would count as tainted.
    expect(system).not.toMatch(/<untrusted source=/);
    expect(system).not.toContain('You are reading an email or calendar event');
    const bare = new Shell({ store: new Store(':memory:'), model, tools: new ToolRegistry(audit), audit, userName: 'John', timeZone: TZ, modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null });
    await bare.handle({ type: 'send', text: 'hi' });
    expect(String(requests[1]!.messages[0]!.content)).not.toContain('calendar');
  });
});
