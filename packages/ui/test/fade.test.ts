/** Fading older messages: what fades, how much, when, and what never does (fade.ts). */
import type { ChatItem } from '@aios/shared/protocol';
import { describe, expect, it } from 'vitest';
import { FADE_AFTER_MS, FADE_FIRST, FADE_FLOOR, FADE_STEP_MS, fadeLevels, idleSteps, needsYou } from '../src/fade';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 24, 9, 0);

const user = (id: string, at: number): ChatItem => ({ kind: 'user', id, text: `question ${id}`, at });
const reply = (id: string, at: number, streaming = false): ChatItem => ({ kind: 'assistant', id, text: `answer ${id}`, at, streaming });
const notice = (id: string, at: number): ChatItem => ({ kind: 'notice', id, level: 'info', text: 'Wallpaper dimmed.', at });
const memory = (id: string, at: number, state: 'pending' | 'saved'): ChatItem => ({ kind: 'memory', id, text: 'likes tea', target: 'facts', source: 'chat', state, at });
const draft = (id: string, at: number, state: 'pending' | 'sent'): ChatItem => ({ kind: 'draft', id, to: ['a@x.example'], subject: 's', body: 'b', hash: 'h', state, warnings: [], at });

/** Three exchanges, the second asked at 10 min, the third at 20 min. */
const chat = [user('q1', T0), reply('a1', T0 + 1000), user('q2', T0 + 10 * MIN), reply('a2', T0 + 10 * MIN + 1000), user('q3', T0 + 20 * MIN), reply('a3', T0 + 20 * MIN + 1000)];

describe('steps', () => {
  it('start a minute in, then add one a minute', () => {
    expect(idleSteps(0)).toBe(0);
    expect(idleSteps(FADE_AFTER_MS - 1)).toBe(0);
    expect(idleSteps(FADE_AFTER_MS)).toBe(1);
    expect(idleSteps(FADE_AFTER_MS + FADE_STEP_MS)).toBe(2);
    expect(idleSteps(Number.NaN)).toBe(0);
  });
});

describe('fade levels', () => {
  it('fades an exchange a minute after the next question, clearly enough to notice', () => {
    const items = [user('q1', T0), reply('a1', T0 + 1000), user('q2', T0 + 10 * MIN), reply('a2', T0 + 10 * MIN + 1000)];
    expect(fadeLevels(items, T0 + 10 * MIN + 30_000).size).toBe(0);
    const f = fadeLevels(items, T0 + 11 * MIN);
    expect(f.get('q1')).toBe(FADE_FIRST);
    expect(f.get('a1')).toBe(FADE_FIRST);
    expect(FADE_FIRST).toBeLessThanOrEqual(0.7);
  });

  it('keeps the latest question and answer solid, and makes older exchanges fainter', () => {
    const f = fadeLevels(chat, T0 + 23 * MIN);
    expect(f.has('q3')).toBe(false);
    expect(f.has('a3')).toBe(false);
    expect(f.get('q2')).toBe(f.get('a2'));
    expect(f.get('q1')!).toBeLessThan(f.get('q2')!);
  });

  it('keeps fading however much the user types or reads, but never below the floor', () => {
    for (const later of [30, 120, 10_000]) {
      for (const v of fadeLevels(chat, T0 + later * MIN).values()) expect(v).toBeGreaterThanOrEqual(FADE_FLOOR);
    }
    expect(fadeLevels(chat, T0 + 120 * MIN).get('q1')).toBe(FADE_FLOOR);
  });

  it('brings everything back when the user scrolls up, then fades again from then', () => {
    const now = T0 + 60 * MIN;
    expect(fadeLevels(chat, now, now).size).toBe(0);
    expect(fadeLevels(chat, now + 30_000, now).size).toBe(0);
    expect(fadeLevels(chat, now + MIN, now).get('q1')).toBe(FADE_FIRST);
  });

  it('keeps what came before the latest answer solid, and the newest item; later notices fade', () => {
    const tool: ChatItem = { kind: 'tool', id: 't', label: 'Checking', state: 'done', at: T0 + 10 * MIN };
    const items = [user('q1', T0), reply('a1', T0), user('q2', T0 + 10 * MIN), tool, reply('a2', T0 + 10 * MIN), notice('n1', T0 + 11 * MIN), notice('n2', T0 + 12 * MIN)];
    const f = fadeLevels(items, T0 + 30 * MIN);
    expect(f.has('t')).toBe(false);
    expect(f.has('a2')).toBe(false);
    expect(f.has('n2')).toBe(false);
    expect(f.get('n1')).toBe(FADE_FLOOR);
    // Before the answer comes, everything after the question stays.
    expect(fadeLevels([user('q1', T0), reply('a1', T0), user('q2', T0 + MIN), tool, notice('n1', T0 + MIN)], T0 + 60 * MIN).has('t')).toBe(false);
  });

  it('never fades a card that waits for the user, however old', () => {
    const items = [user('q1', T0), reply('a1', T0), memory('m-wait', T0, 'pending'), draft('d-wait', T0, 'pending'), memory('m-done', T0, 'saved'), draft('d-done', T0, 'sent'), user('q2', T0 + MIN), reply('a2', T0 + MIN)];
    const f = fadeLevels(items, T0 + 60 * MIN);
    expect(f.has('m-wait')).toBe(false);
    expect(f.has('d-wait')).toBe(false);
    expect(f.get('m-done')).toBe(FADE_FLOOR);
    expect(f.get('d-done')).toBe(FADE_FLOOR);
  });

  it('has nothing to fade before the user has asked anything', () => {
    expect(fadeLevels([reply('hello', T0)], T0 + 60 * MIN).size).toBe(0);
  });
});

describe('needs you', () => {
  it('is true only while a click is awaited or something is still happening', () => {
    expect(needsYou(reply('r', 0, true))).toBe(true);
    expect(needsYou(reply('r', 0))).toBe(false);
    expect(needsYou({ kind: 'action', id: 'a', title: 'Turn off Wi-Fi', confirm: 'Turn off', hash: 'h', state: 'pending', at: 0 })).toBe(true);
    expect(needsYou({ kind: 'action', id: 'a', title: 'Turn off Wi-Fi', confirm: 'Turn off', hash: 'h', state: 'done', at: 0 })).toBe(false);
    expect(needsYou({ kind: 'update', id: 'u', state: 'available', headline: 'An update', changes: [], more: 0, at: 0 })).toBe(true);
    expect(needsYou({ kind: 'update', id: 'u', state: 'current', headline: 'Up to date', changes: [], more: 0, at: 0 })).toBe(false);
    expect(needsYou(user('q', 0))).toBe(false);
  });
});
