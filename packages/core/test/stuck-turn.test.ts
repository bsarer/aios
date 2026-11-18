/**
 * A chat step that never finishes (a mail tool waiting on a slow or dead IMAP connection, or
 * one cut off by a restart) must not show as running forever or break the next request.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { Store, UNFINISHED_TOOL_RESULT } from '../src/store.js';
import { toolByName } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const audit = () => new AuditLog(join(mkdtempSync(join(tmpdir(), 'aios-stuck-')), 'audit.jsonl'));
const call = { id: 'c1', name: 'mail_thread', arguments: JSON.stringify({ id: 'INBOX:1' }) };

describe('a tool that never answers', () => {
  // Like an IMAP command on a connection that died without closing: ignores the signal, never settles.
  const hung = () => new Promise<string>(() => undefined);

  it('fails at the time limit instead of holding the turn', async () => {
    const tools = new ToolRegistry(audit(), { timeoutMs: 50 });
    tools.register({ def: toolByName('mail_thread')!, label: 'Reading the thread…', untrustedOutput: true, handler: hung });
    const started = Date.now();
    const out = await tools.execute(call, { signal: new AbortController().signal, untrustedInContext: false, userText: 'x' });
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/stopped waiting/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('ends at once on Stop', async () => {
    const tools = new ToolRegistry(audit(), { timeoutMs: 60_000 });
    tools.register({ def: toolByName('mail_thread')!, label: 'Reading the thread…', untrustedOutput: true, handler: hung });
    const stop = new AbortController();
    const pending = tools.execute(call, { signal: stop.signal, untrustedInContext: false, userText: 'x' });
    setTimeout(() => stop.abort(), 10);
    const out = await pending;
    expect(out).toMatchObject({ ok: false, content: 'Error: Stopped.' });
  });

  it('still returns a quick result', async () => {
    const tools = new ToolRegistry(audit(), { timeoutMs: 1000 });
    tools.register({ def: toolByName('mail_thread')!, label: 'Reading the thread…', untrustedOutput: true, handler: async () => 'ok' });
    expect(await tools.execute(call, { signal: new AbortController().signal, untrustedInContext: false, userText: 'x' })).toMatchObject({ ok: true, content: 'ok' });
  });
});

describe('after a restart', () => {
  it('a step left running shows as failed and a streaming reply as stopped', () => {
    const store = new Store(':memory:');
    const items: ChatItem[] = [
      { kind: 'assistant', id: 'a1', text: 'Pulling up the emails now.', at: 1, streaming: true },
      { kind: 'tool', id: 't1', label: 'Searching mail…', state: 'done', at: 2 },
      { kind: 'tool', id: 't2', label: 'Reading the thread…', state: 'running', at: 3 },
    ];
    items.forEach((i) => store.saveItem(i));
    expect(store.recoverItems()).toBe(2);
    expect(store.recentItems()).toEqual([
      { ...items[0], streaming: false, stopped: true },
      items[1],
      { ...items[2], state: 'failed' },
    ]);
    expect(store.recoverItems()).toBe(0);
  });

  it('a tool call without a saved result gets one, so the next request is not refused', () => {
    const store = new Store(':memory:');
    store.saveTurn({ role: 'user', content: 'find the meeting emails' }, 1);
    store.saveTurn({ role: 'assistant', content: null, toolCalls: [{ id: 's', name: 'mail_search', arguments: '{}' }] }, 2);
    store.saveTurn({ role: 'tool', toolCallId: 's', name: 'mail_search', content: 'found' }, 3);
    store.saveTurn({ role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'th', name: 'mail_thread', arguments: '{}' }] }, 4);
    // Astra stopped here; the next message:
    store.saveTurn({ role: 'user', content: 'hello?' }, 5);
    const turns = store.recentTurns();
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
    expect(turns[4]).toEqual({ role: 'tool', toolCallId: 'th', name: 'mail_thread', content: UNFINISHED_TOOL_RESULT });
  });
});
