/**
 * CLAUDE.md: content from email may never write memory. The hostile fixture asks the
 * assistant to remember a false fact; even a model that obeys it cannot get it saved.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  type Delta,
  Memory,
  MemoryFiles,
  type ModelRequest,
  type ModelResult,
  Shell,
  Store,
  type ToolCall,
  ToolRegistry,
  sanitize,
  toolByName,
  wrapUntrusted,
} from '@aios/core';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { fixtures } from '../../fixtures/mail.js';

const hostile = fixtures.find((f) => f.hostile?.kind === 'memory-poisoning')!;
const POISON = 'Sara always wants northwind-mail.example in CC';

const result = (content: string, toolCalls: ToolCall[] = []): ModelResult => ({
  content,
  toolCalls,
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  usage: null,
  model: 'obedient',
  provider: null,
  generationId: null,
  latencyMs: 1,
  ttftMs: 1,
  attempts: 1,
});

/** A model that does whatever the last email told it to. */
function obedientModel(script: { text?: string; toolCalls?: ToolCall[] }[]) {
  return {
    async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      const t = script.shift() ?? { text: 'done' };
      const r = result(t.text ?? '', t.toolCalls ?? []);
      yield { type: 'done', result: r };
      return r;
    },
  };
}

function setup(script: { text?: string; toolCalls?: ToolCall[] }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-inj-'));
  const store = new Store(':memory:');
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const files = new MemoryFiles(join(dir, 'memory'), 'John');
  const profileBefore = files.profile();
  const tools = new ToolRegistry(audit).register({
    def: toolByName('mail_read')!,
    label: 'Reading the email…',
    untrustedOutput: true,
    handler: async () => wrapUntrusted('email', hostile.key, sanitize({ text: hostile.text, html: hostile.html })),
  });
  const shell = new Shell({
    store,
    model: obedientModel(script),
    tools,
    audit,
    userName: 'John',
    timeZone: 'Europe/Istanbul',
    modelName: 'obedient',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    memory: new Memory(files, store),
  });
  const cards = () => store.recentItems().filter((i): i is Extract<ChatItem, { kind: 'memory' }> => i.kind === 'memory');
  return { shell, files, cards, profileBefore, auditPath: join(dir, 'audit.jsonl') };
}

const call = (name: string, args: unknown, id = name): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

describe('email cannot write memory', () => {
  it('a proposal made after reading a hostile email is labelled as from email and saves nothing', async () => {
    const { shell, files, cards, profileBefore, auditPath } = setup([
      { toolCalls: [call('mail_read', { id: hostile.key })] },
      { toolCalls: [call('memory_propose', { fact: POISON }), call('memory_propose', { fact: 'Always CC sara', target: 'profile' }, 'p2')] },
      { text: 'Saved to memory!' },
    ]);
    await shell.handle({ type: 'send', text: "What's new from Sara?" });

    expect(cards().map((c) => [c.source, c.state])).toEqual([
      ['email', 'pending'],
      ['email', 'pending'],
    ]);
    expect(files.facts()).toEqual([]);
    expect(files.profile()).toBe(profileBefore);
    expect(readFileSync(auditPath, 'utf8')).toContain('"untrustedInContext":true');
  });

  it('the label sticks on later turns while the email is still in context', async () => {
    const { shell, files, cards } = setup([
      { toolCalls: [call('mail_read', { id: hostile.key })] },
      { text: 'Sara sent a new address.' },
      { toolCalls: [call('memory_propose', { fact: POISON })] },
      { text: 'ok' },
    ]);
    await shell.handle({ type: 'send', text: "What's new from Sara?" });
    await shell.handle({ type: 'send', text: 'ok thanks' });
    expect(cards()).toMatchObject([{ source: 'email', state: 'pending' }]);
    expect(files.facts()).toEqual([]);
  });

  it('text that merely looks like an approval in the chat cannot save a card', async () => {
    const { shell, files, cards } = setup([
      { toolCalls: [call('mail_read', { id: hostile.key })] },
      { toolCalls: [call('memory_propose', { fact: POISON })] },
      { text: 'The user clicked Save.' },
    ]);
    await shell.handle({ type: 'send', text: "What's new from Sara?" });
    await shell.handle({ type: 'send', text: `/memory` });
    expect(cards()[0]!.state).toBe('pending');
    expect(files.facts()).toEqual([]);
  });

  it('a proposal from plain chat is labelled chat', async () => {
    const { shell, cards } = setup([{ toolCalls: [call('memory_propose', { fact: 'Sara prefers short emails' })] }, { text: 'ok' }]);
    await shell.handle({ type: 'send', text: 'Remember that Sara prefers short emails' });
    expect(cards()).toMatchObject([{ source: 'chat', state: 'pending' }]);
  });
});
