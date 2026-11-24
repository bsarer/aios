/** Fading older messages: what fades, how much, and what never does (fade.ts). */
import type { ChatItem } from '@aios/shared/protocol';
import { describe, expect, it } from 'vitest';
import { FADE_AFTER_MS, FADE_FLOOR, FADE_STEP_MS, fadeLevels, idleSteps, needsYou } from '../src/fade';

const user = (id: string): ChatItem => ({ kind: 'user', id, text: `question ${id}`, at: 0 });
const reply = (id: string, streaming = false): ChatItem => ({ kind: 'assistant', id, text: `answer ${id}`, at: 0, streaming });
const memory = (id: string, state: 'pending' | 'saved'): ChatItem => ({ kind: 'memory', id, text: 'likes tea', target: 'facts', source: 'chat', state, at: 0 });
const draft = (id: string, state: 'pending' | 'sent'): ChatItem => ({ kind: 'draft', id, to: ['a@x.example'], subject: 's', body: 'b', hash: 'h', state, warnings: [], at: 0 });

/** Three exchanges: q1/a1, q2/a2, q3/a3. */
const chat = [user('q1'), reply('a1'), user('q2'), reply('a2'), user('q3'), reply('a3')];

describe('idle steps', () => {
  it('starts only after a couple of idle minutes, then adds a step a minute', () => {
    expect(idleSteps(0)).toBe(0);
    expect(idleSteps(FADE_AFTER_MS - 1)).toBe(0);
    expect(idleSteps(FADE_AFTER_MS)).toBe(1);
    expect(idleSteps(FADE_AFTER_MS + FADE_STEP_MS)).toBe(2);
    expect(idleSteps(Number.NaN)).toBe(0);
  });
});

describe('fade levels', () => {
  it('fades nothing while the user is here', () => {
    expect(fadeLevels(chat, 0).size).toBe(0);
  });

  it('keeps the latest question and answer solid and fades older exchanges more the further back', () => {
    const f = fadeLevels(chat, 1);
    expect(f.has('q3')).toBe(false);
    expect(f.has('a3')).toBe(false);
    expect(f.get('q2')).toBe(f.get('a2'));
    expect(f.get('q2')!).toBeLessThan(1);
    expect(f.get('q1')!).toBeLessThan(f.get('q2')!);
  });

  it('makes the first step clear enough to notice at a glance', () => {
    expect(fadeLevels(chat, 1).get('q2')!).toBeLessThanOrEqual(0.7);
  });

  it('gets fainter each idle minute but never below the floor', () => {
    const a = fadeLevels(chat, 1).get('q2')!;
    const b = fadeLevels(chat, 2).get('q2')!;
    expect(b).toBeLessThan(a);
    for (const steps of [5, 20, 1000]) {
      for (const v of fadeLevels(chat, steps).values()) expect(v).toBeGreaterThanOrEqual(FADE_FLOOR);
    }
    expect(fadeLevels(chat, 1000).get('q1')).toBe(FADE_FLOOR);
  });

  it('keeps what came before the latest answer solid, and the newest item; later notices fade a step', () => {
    const notice = (id: string): ChatItem => ({ kind: 'notice', id, level: 'info', text: 'Wallpaper dimmed.', at: 0 });
    const tool: ChatItem = { kind: 'tool', id: 't', label: 'Checking', state: 'done', at: 0 };
    const items = [user('q1'), reply('a1'), user('q2'), tool, reply('a2'), notice('n1'), notice('n2')];
    const f = fadeLevels(items, 1);
    expect(f.has('t')).toBe(false);
    expect(f.has('a2')).toBe(false);
    expect(f.has('n2')).toBe(false);
    expect(f.get('n1')).toBe(f.get('a1'));
    // Before the answer comes, everything after the question stays.
    expect(fadeLevels([user('q1'), reply('a1'), user('q2'), tool, notice('n1')], 3).has('t')).toBe(false);
  });

  it('never fades a card that waits for the user, however old', () => {
    const items = [user('q1'), reply('a1'), memory('m-wait', 'pending'), draft('d-wait', 'pending'), memory('m-done', 'saved'), draft('d-done', 'sent'), user('q2'), reply('a2')];
    const f = fadeLevels(items, 50);
    expect(f.has('m-wait')).toBe(false);
    expect(f.has('d-wait')).toBe(false);
    expect(f.get('m-done')).toBe(FADE_FLOOR);
    expect(f.get('d-done')).toBe(FADE_FLOOR);
  });

  it('has nothing to fade before the user has asked anything', () => {
    expect(fadeLevels([reply('hello')], 50).size).toBe(0);
  });
});

describe('needs you', () => {
  it('is true only while a click is awaited or something is still happening', () => {
    expect(needsYou(reply('r', true))).toBe(true);
    expect(needsYou(reply('r'))).toBe(false);
    expect(needsYou({ kind: 'action', id: 'a', title: 'Turn off Wi-Fi', confirm: 'Turn off', hash: 'h', state: 'pending', at: 0 })).toBe(true);
    expect(needsYou({ kind: 'action', id: 'a', title: 'Turn off Wi-Fi', confirm: 'Turn off', hash: 'h', state: 'done', at: 0 })).toBe(false);
    expect(needsYou({ kind: 'update', id: 'u', state: 'available', headline: 'An update', changes: [], more: 0, at: 0 })).toBe(true);
    expect(needsYou({ kind: 'update', id: 'u', state: 'current', headline: 'Up to date', changes: [], more: 0, at: 0 })).toBe(false);
    expect(needsYou(user('q'))).toBe(false);
  });
});
