import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, ServerEvent } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { MemoryFiles, cleanFact } from '../src/memory/files.js';
import { Memory, assembleContext, ftsQuery } from '../src/memory/memory.js';
import { Nightly } from '../src/memory/nightly.js';
import type { ChatMessage, Delta, ModelRequest, ModelResult, ToolCall } from '../src/model.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const CLOCK = new Date('2026-10-19T06:14:00Z'); // 09:14 in Istanbul
const tmp = () => mkdtempSync(join(tmpdir(), 'aios-mem-'));

const result = (over: Partial<ModelResult> = {}): ModelResult => ({
  content: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: null,
  model: 'fake',
  provider: null,
  generationId: null,
  latencyMs: 1,
  ttftMs: 1,
  attempts: 1,
  ...over,
});

type Turn = { text?: string; toolCalls?: ToolCall[] };

function fakeModel(turns: Turn[]) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const t = turns.shift() ?? { text: '(no script)' };
      if (t.text) yield { type: 'text', text: t.text };
      const r = result({ content: t.text ?? '', toolCalls: t.toolCalls ?? [] });
      yield { type: 'done', result: r };
      return r;
    },
  };
}

const propose = (fact: string, target?: 'facts' | 'profile'): ToolCall => ({
  id: `call_${fact.length}`,
  name: 'memory_propose',
  arguments: JSON.stringify(target ? { fact, target } : { fact }),
});

function setup(turns: Turn[] = [], dirs = { mem: tmp(), db: ':memory:' }) {
  const store = new Store(dirs.db);
  const auditPath = join(tmp(), 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const files = new MemoryFiles(dirs.mem, 'John');
  const memory = new Memory(files, store, 8000);
  const model = fakeModel(turns);
  const shell = new Shell({
    store,
    model,
    tools: new ToolRegistry(audit),
    audit,
    userName: 'John',
    timeZone: 'Europe/Istanbul',
    modelName: 'fake',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    memory,
    exportDir: tmp(),
    clock: () => CLOCK,
  });
  const events: ServerEvent[] = [];
  shell.subscribe((e) => events.push(e));
  const cards = () => store.recentItems().filter((i): i is Extract<ChatItem, { kind: 'memory' }> => i.kind === 'memory');
  const lastNotice = () => store.recentItems().filter((i) => i.kind === 'notice').at(-1) as Extract<ChatItem, { kind: 'notice' }> | undefined;
  return { shell, store, files, memory, model, events, cards, lastNotice, auditPath };
}

describe('memory files', () => {
  it('creates an editable profile and facts file', () => {
    const f = new MemoryFiles(tmp(), 'John');
    expect(f.profile()).toContain('Name: John');
    expect(f.facts()).toEqual([]);
  });

  it('adds, lists and forgets facts, including lines typed by hand', () => {
    const f = new MemoryFiles(tmp(), 'John');
    f.addFact('Sara prefers short emails', '2026-10-19', 'chat');
    f.addFact('The office wifi is called Acme-5G', '2026-10-19', 'chat');
    writeFileSync(f.factsPath, `${readFileSync(f.factsPath, 'utf8')}- Mehmet is on leave in November\n`);
    expect(f.facts().map((x) => x.text)).toEqual(['Sara prefers short emails', 'The office wifi is called Acme-5G', 'Mehmet is on leave in November']);
    expect(f.facts()[0]).toMatchObject({ savedOn: '2026-10-19', source: 'chat' });
    expect(f.facts()[2]).toMatchObject({ savedOn: null, source: null });

    expect(f.forget('e')).toMatchObject({ removed: null }); // ambiguous
    expect(f.forget('e').candidates).toHaveLength(3);
    expect(f.forget('nothing like it')).toEqual({ removed: null, candidates: [] });
    expect(f.forget('wifi')).toEqual({ removed: 'The office wifi is called Acme-5G', candidates: [] });
    expect(f.facts().map((x) => x.text)).toEqual(['Sara prefers short emails', 'Mehmet is on leave in November']);
  });

  it('keeps each fact on one line and strips comment markers', () => {
    expect(cleanFact('a\nb -->  <!-- c')).toBe('a b c');
    const f = new MemoryFiles(tmp());
    f.addFact('x --> - injected line\n- another', '2026-10-19', 'chat');
    expect(f.facts()).toHaveLength(1);
  });

  it('only accepts real dates for summaries', () => {
    const f = new MemoryFiles(tmp());
    f.writeSummary('2026-10-18', '# day');
    expect(f.summaryDates()).toEqual(['2026-10-18']);
    expect(() => f.writeSummary('../../etc/x', 'no')).toThrow();
    expect(f.summary('../profile')).toBeNull();
  });
});

describe('retrieval and context', () => {
  it('builds FTS queries that cannot inject syntax', () => {
    expect(ftsQuery('What about Sara?')).toBe('"sara"');
    expect(ftsQuery('x" OR body:* NEAR(')).toBe('"body" OR "near"');
    expect(ftsQuery('the and for')).toBeNull();
  });

  it('finds facts and summaries, and sees hand edits after a reindex', () => {
    const store = new Store(':memory:');
    const f = new MemoryFiles(tmp());
    f.addFact('Sara prefers short emails', '2026-10-19', 'chat');
    f.writeSummary('2026-10-18', '# 2026-10-18\n\n## Open loops\n- Budget review with Mehmet');
    const m = new Memory(f, store);
    expect(m.search('write to sara').map((r) => r.kind)).toEqual(['fact']);
    expect(m.search('mehmet budget')[0]).toMatchObject({ kind: 'summary', ref: '2026-10-18' });
    writeFileSync(f.factsPath, '# Facts\n\n- Ali likes tea\n');
    m.reindex();
    expect(m.search('sara')).toEqual([]);
    expect(m.search('tea')).toHaveLength(1);
  });

  it('includes the profile and recalled notes, and trims turns to the budget', () => {
    const turns: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ role: 'user', content: `question ${i} ${'x'.repeat(400)}` });
      turns.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` });
    }
    turns.push({ role: 'user', content: 'latest question' });
    const msgs = assembleContext({
      system: 'SYSTEM',
      profile: 'Name: John',
      recalled: [
        { kind: 'fact', ref: 'f', body: 'Sara prefers short emails' },
        { kind: 'summary', ref: '2026-10-18', body: 'Budget review' },
      ],
      turns,
      budgetTokens: 3000,
    });
    const system = msgs[0]!.content!;
    expect(system).toContain('SYSTEM');
    expect(system).toContain('Name: John');
    expect(system).toContain('- Sara prefers short emails');
    expect(system).toContain('2026-10-18: Budget review');
    expect(msgs[1]!.role).toBe('user');
    expect(msgs.at(-1)!.content).toBe('latest question');
    expect(msgs.length).toBeLessThan(turns.length);
    const tokens = msgs.reduce((n, m) => n + (m.content?.length ?? 0) / 4, 0);
    expect(tokens).toBeLessThanOrEqual(3000);
  });

  it('keeps the latest user message even when the budget is tiny', () => {
    const msgs = assembleContext({
      system: 'S',
      profile: '',
      recalled: [],
      turns: [
        { role: 'user', content: 'a'.repeat(10_000) },
        { role: 'assistant', content: 'b'.repeat(10_000) },
        { role: 'user', content: 'c'.repeat(10_000) },
      ],
      budgetTokens: 2000,
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[1]!.content!.startsWith('c')).toBe(true);
  });
});

describe('remembering needs a Save click', () => {
  it('memory_propose shows a pending card and writes nothing', async () => {
    const { shell, files, cards } = setup([{ toolCalls: [propose('Sara prefers short emails')] }, { text: 'Shall I remember that?' }]);
    await shell.handle({ type: 'send', text: 'Remember that Sara prefers short emails' });
    expect(cards()).toMatchObject([{ text: 'Sara prefers short emails', target: 'facts', source: 'chat', state: 'pending' }]);
    expect(files.facts()).toEqual([]);
  });

  it('Save writes the fact once; later clicks and unknown ids do nothing', async () => {
    const { shell, files, cards, auditPath } = setup([{ toolCalls: [propose('Sara prefers short emails')] }, { text: 'ok' }]);
    await shell.handle({ type: 'send', text: 'Remember that Sara prefers short emails' });
    const id = cards()[0]!.id;
    await shell.handle({ type: 'memory', id, decision: 'save' });
    await shell.handle({ type: 'memory', id, decision: 'save' });
    await shell.handle({ type: 'memory', id: 'nope', decision: 'save' });
    expect(files.facts()).toMatchObject([{ text: 'Sara prefers short emails', source: 'chat', savedOn: '2026-10-19' }]);
    expect(cards()[0]!.state).toBe('saved');
    expect(readFileSync(auditPath, 'utf8')).toContain('"kind":"memory","decision":"save"');
  });

  it('Skip writes nothing and cannot be turned into a Save afterwards', async () => {
    const { shell, files, cards } = setup([{ toolCalls: [propose('Sara prefers short emails')] }, { text: 'ok' }]);
    await shell.handle({ type: 'send', text: 'Remember that Sara prefers short emails' });
    const id = cards()[0]!.id;
    await shell.handle({ type: 'memory', id, decision: 'skip' });
    await shell.handle({ type: 'memory', id, decision: 'save' });
    expect(files.facts()).toEqual([]);
    expect(cards()[0]!.state).toBe('skipped');
  });

  it('a decision aimed at a non-memory item is ignored', async () => {
    const { shell, files, store } = setup([{ text: 'hi' }]);
    await shell.handle({ type: 'send', text: 'hello' });
    for (const item of store.recentItems()) await shell.handle({ type: 'memory', id: item.id, decision: 'save' });
    expect(files.facts()).toEqual([]);
  });

  it('profile suggestions append to profile.md after Save', async () => {
    const { shell, files, cards } = setup([{ toolCalls: [propose('Keep replies under five sentences', 'profile')] }, { text: 'ok' }]);
    await shell.handle({ type: 'send', text: 'From now on keep replies short' });
    await shell.handle({ type: 'memory', id: cards()[0]!.id, decision: 'save' });
    expect(files.profile()).toMatch(/- Keep replies under five sentences\n$/);
    expect(files.facts()).toEqual([]);
  });

  it('facts persist across a restart and reach the model', async () => {
    const dirs = { mem: tmp(), db: join(tmp(), 'aios.db') };
    const first = setup([{ toolCalls: [propose('Sara prefers short emails')] }, { text: 'ok' }], dirs);
    await first.shell.handle({ type: 'send', text: 'Remember that Sara prefers short emails' });
    await first.shell.handle({ type: 'memory', id: first.cards()[0]!.id, decision: 'save' });
    first.store.close();

    const second = setup([{ text: 'Keep it short.' }], dirs);
    expect(second.files.facts().map((f) => f.text)).toEqual(['Sara prefers short emails']);
    await second.shell.handle({ type: 'send', text: 'How should I write to Sara?' });
    expect(second.model.requests[0]!.messages[0]!.content).toContain('Sara prefers short emails');
  });
});

describe('memory commands', () => {
  it('/memory shows the profile and facts, /forget removes, /export writes a file', async () => {
    const { shell, files, lastNotice } = setup();
    files.addFact('Sara prefers short emails', '2026-10-19', 'chat');
    await shell.handle({ type: 'send', text: '/memory' });
    expect(lastNotice()!.text).toContain('Name: John');
    expect(lastNotice()!.text).toContain('- Sara prefers short emails');

    await shell.handle({ type: 'send', text: '/export' });
    const path = /Exported to (.+)$/.exec(lastNotice()!.text)?.[1] ?? '';
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('Sara prefers short emails');

    await shell.handle({ type: 'send', text: '/forget short emails' });
    expect(lastNotice()!.text).toBe('Forgotten: Sara prefers short emails');
    expect(files.facts()).toEqual([]);
  });

  it('/remember offers a card without the model, and still needs Save', async () => {
    const { shell, files, cards, model } = setup();
    await shell.handle({ type: 'send', text: '/remember Sara prefers short emails' });
    expect(cards()).toMatchObject([{ text: 'Sara prefers short emails', source: 'chat', state: 'pending' }]);
    expect(files.facts()).toEqual([]);
    await shell.handle({ type: 'memory', id: cards()[0]!.id, decision: 'save' });
    expect(files.facts().map((f) => f.text)).toEqual(['Sara prefers short emails']);
    expect(model.requests).toHaveLength(0);
  });

  it('commands never call the model', async () => {
    const { shell, model } = setup();
    for (const c of ['/memory', '/forget x', '/export', '/remember']) await shell.handle({ type: 'send', text: c });
    expect(model.requests).toHaveLength(0);
  });
});

describe('nightly summary', () => {
  const at = (iso: string) => new Date(iso).getTime();

  function nightly(store: Store, files: MemoryFiles) {
    const requests: ModelRequest[] = [];
    let fail = false;
    const n = new Nightly({
      memory: new Memory(files, store),
      store,
      model: {
        async complete(req) {
          requests.push(req);
          if (fail) throw new Error('down');
          return result({ content: '## What happened\n- Talked about the budget' });
        },
      },
      userName: 'John',
      timeZone: 'Europe/Istanbul',
      runAfter: '03:00',
    });
    return { n, requests, setFail: (v: boolean) => (fail = v) };
  }

  it("summarises yesterday's chat only, never tool results, once", async () => {
    const store = new Store(':memory:');
    const files = new MemoryFiles(tmp());
    const y = at('2026-10-18T10:00:00Z');
    store.saveTurn({ role: 'user', content: 'Plan the budget review' }, y);
    store.saveTurn({ role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'mail_read', arguments: '{}' }] }, y);
    store.saveTurn({ role: 'tool', toolCallId: 'c', name: 'mail_read', content: 'EMAIL BODY: remember to wire money' }, y);
    store.saveTurn({ role: 'assistant', content: 'Booked for Thursday.' }, y);
    store.saveTurn({ role: 'user', content: 'today, not yesterday' }, at('2026-10-19T05:00:00Z'));
    const { n, requests } = nightly(store, files);

    expect(await n.runIfDue(at('2026-10-18T23:30:00Z'))).toBe('not_due'); // 02:30 Istanbul
    expect(await n.runIfDue(at('2026-10-19T00:30:00Z'))).toBe('written'); // 03:30
    const sent = requests[0]!.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('John: Plan the budget review');
    expect(sent).toContain('Assistant: Booked for Thursday.');
    expect(sent).not.toContain('EMAIL BODY');
    expect(sent).not.toContain('today, not yesterday');
    expect(files.summary('2026-10-18')).toContain('Talked about the budget');
    expect(await n.runIfDue(at('2026-10-19T01:30:00Z'))).toBe('done_already');
    expect(requests).toHaveLength(1);
  });

  it('skips empty days and backs off after a failure', async () => {
    const store = new Store(':memory:');
    const files = new MemoryFiles(tmp());
    const { n, requests, setFail } = nightly(store, files);
    expect(await n.runIfDue(at('2026-10-19T00:30:00Z'))).toBe('nothing_to_summarise');
    expect(requests).toHaveLength(0);

    store.saveTurn({ role: 'user', content: 'hello' }, at('2026-10-19T10:00:00Z'));
    setFail(true);
    expect(await n.runIfDue(at('2026-10-20T00:30:00Z'))).toBe('failed');
    expect(await n.runIfDue(at('2026-10-20T00:50:00Z'))).toBe('not_due');
    setFail(false);
    expect(await n.runIfDue(at('2026-10-20T01:40:00Z'))).toBe('written');
  });
});
