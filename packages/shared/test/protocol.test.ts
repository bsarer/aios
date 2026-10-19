import { describe, expect, it } from 'vitest';
import { ClientMessage, type Status, applyEvent, initialChatState } from '../src/protocol.js';

const status: Status = { battery: null, wifi: null, mail: 'not_configured', agent: 'idle', costTodayUsd: 0, costCapUsd: 2, model: 'm' };

describe('chat reducer', () => {
  it('streams deltas into an assistant item and patches it when done', () => {
    let s = applyEvent(initialChatState, { type: 'hello', userName: 'John', items: [], status, theme: {} });
    s = applyEvent(s, { type: 'item', item: { kind: 'assistant', id: 'a1', text: '', at: 1, streaming: true } });
    s = applyEvent(s, { type: 'delta', id: 'a1', text: 'Hel' });
    s = applyEvent(s, { type: 'delta', id: 'a1', text: 'lo' });
    expect(s.items[0]).toMatchObject({ text: 'Hello', streaming: true });
    s = applyEvent(s, { type: 'patch', id: 'a1', item: { kind: 'assistant', id: 'a1', text: 'Hello', at: 1, streaming: false } });
    expect(s.items[0]).toMatchObject({ streaming: false });
  });

  it('replaces an item re-sent with the same id instead of duplicating it', () => {
    let s = applyEvent(initialChatState, { type: 'item', item: { kind: 'tool', id: 't', label: 'x', state: 'running', at: 1 } });
    s = applyEvent(s, { type: 'item', item: { kind: 'tool', id: 't', label: 'x', state: 'done', at: 1 } });
    expect(s.items).toHaveLength(1);
  });
});

describe('client messages', () => {
  it('rejects unknown types and empty text', () => {
    expect(ClientMessage.safeParse({ type: 'send', text: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'exec', cmd: 'rm' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'stop' }).success).toBe(true);
  });
});
