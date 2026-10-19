import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, ServerEvent } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { MAX_ITERATIONS } from '../src/agent.js';
import { AuditLog, redact } from '../src/audit.js';
import { parseCommand } from '../src/commands.js';
import { type Delta, ModelError, type ModelRequest, type ModelResult, type ToolCall } from '../src/model.js';
import { Shell } from '../src/shell.js';
import { parseNmcli, readBattery } from '../src/status/system.js';
import { parseThemeToml } from '../src/status/theme.js';
import { Store, startOfDay } from '../src/store.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';
import { formatNow, nowTool } from '../src/tools/now.js';
import { ToolRegistry } from '../src/tools/registry.js';

const CLOCK = new Date('2026-10-19T06:14:00Z'); // 09:14 in Istanbul

const result = (over: Partial<ModelResult> = {}): ModelResult => ({
  content: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: null,
  model: 'fake',
  provider: null,
  generationId: null,
  latencyMs: 10,
  ttftMs: 5,
  attempts: 1,
  ...over,
});

type Turn = { text?: string[]; toolCalls?: ToolCall[]; error?: Error; hang?: boolean };

/** Scripted model: one entry per model call. */
function fakeModel(turns: Turn[]) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const t = turns.shift() ?? { text: ['(no script)'] };
      for (const piece of t.text ?? []) {
        yield { type: 'text', text: piece };
        if (t.hang) {
          await new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(new ModelError('aborted', 'stopped'))));
        }
      }
      if (t.error) throw t.error;
      const r = result({ content: (t.text ?? []).join(''), toolCalls: t.toolCalls ?? [] });
      yield { type: 'done', result: r };
      return r;
    },
  };
}

function setup(turns: Turn[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-'));
  const store = new Store(':memory:');
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const tools = new ToolRegistry(audit).register(nowTool('Europe/Istanbul', () => CLOCK));
  const model = fakeModel(turns);
  const shell = new Shell({
    store,
    model,
    tools,
    audit,
    userName: 'John',
    timeZone: 'Europe/Istanbul',
    modelName: 'fake',
    costCapUsd: 2,
    readBattery: async () => ({ percent: 80, charging: false }),
    readWifi: async () => ({ connected: true, ssid: 'home' }),
    clock: () => CLOCK,
  });
  const events: ServerEvent[] = [];
  shell.subscribe((e) => events.push(e));
  const items = () => store.recentItems();
  const audits = () => readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { shell, store, model, events, items, audits };
}

const kinds = (items: ChatItem[]) => items.map((i) => (i.kind === 'tool' ? `tool:${i.state}` : i.kind));

describe('agent loop', () => {
  it('streams a plain answer and persists it', async () => {
    const { shell, events, items, model } = setup([{ text: ['Hi ', 'John.'] }]);
    await shell.handle({ type: 'send', text: 'hello' });
    expect(kinds(items())).toEqual(['user', 'assistant']);
    expect(items()[1]).toMatchObject({ text: 'Hi John.', streaming: false });
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Hi ', 'John.']);
    // Only the registered tool is offered, and the system prompt carries the current time.
    expect(model.requests[0]!.tools!.map((t) => t.name)).toEqual(['now']);
    expect(model.requests[0]!.messages[0]!.content).toContain('19 October 2026, 09:14');
  });

  it('runs the now() tool and feeds the result back', async () => {
    const { shell, items, model, audits } = setup([{ toolCalls: [{ id: 'c1', name: 'now', arguments: '{}' }] }, { text: ['It is 09:14.'] }]);
    await shell.handle({ type: 'send', text: 'what time is it' });
    expect(kinds(items())).toEqual(['user', 'tool:done', 'assistant']);
    const second = model.requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 'now' });
    expect((second.at(-1) as { content: string }).content).toContain('09:14 (Europe/Istanbul, UTC+03:00)');
    expect(audits().filter((a) => a.kind === 'tool')).toEqual([expect.objectContaining({ tool: 'now', decision: 'allowed', ok: true })]);
  });

  it('rejects unknown tools and bad arguments, and audits both', async () => {
    const { shell, audits, items } = setup([
      { toolCalls: [{ id: 'c1', name: 'mail_send_draft', arguments: '{"draftId":"x"}' }, { id: 'c2', name: 'now', arguments: '{"x":1}' }] },
      { text: ['Sorry.'] },
    ]);
    await shell.handle({ type: 'send', text: 'send it' });
    expect(kinds(items())).toEqual(['user', 'tool:failed', 'tool:failed', 'assistant']);
    expect(audits().filter((a) => a.kind === 'tool').map((a) => [a.tool, a.decision, a.reason])).toEqual([
      ['mail_send_draft', 'rejected', 'unknown tool'],
      ['now', 'rejected', 'invalid arguments'],
    ]);
  });

  it('stops after the iteration limit', async () => {
    const loop = Array.from({ length: MAX_ITERATIONS + 1 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'now', arguments: '{}' }] }));
    const { shell, items, model } = setup(loop);
    await shell.handle({ type: 'send', text: 'loop' });
    expect(model.requests).toHaveLength(MAX_ITERATIONS);
    expect(items().at(-1)).toMatchObject({ kind: 'notice', level: 'warning' });
  });

  it('Esc stops generation mid-stream and keeps the partial text', async () => {
    const { shell, items, store } = setup([{ text: ['Partial'], hang: true }]);
    const done = shell.handle({ type: 'send', text: 'write an essay' });
    await new Promise((r) => setTimeout(r, 20));
    expect(shell.status().agent).toBe('working');
    await shell.handle({ type: 'stop' });
    await done;
    expect(items().at(-1)).toMatchObject({ kind: 'assistant', text: 'Partial', streaming: false, stopped: true });
    expect(shell.status().agent).toBe('idle');
    expect(store.recentTurns().at(-1)).toEqual({ role: 'assistant', content: 'Partial' });
  });

  it('turns model errors into a plain-language notice', async () => {
    const { shell, items } = setup([{ error: new ModelError('auth', 'bad key', 401) }]);
    await shell.handle({ type: 'send', text: 'hi' });
    expect(items().at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('API key') });
  });

  it('refuses a second request while busy', async () => {
    const { shell, items } = setup([{ text: ['a'], hang: true }]);
    const first = shell.handle({ type: 'send', text: 'one' });
    await new Promise((r) => setTimeout(r, 10));
    await shell.handle({ type: 'send', text: 'two' });
    expect(items().at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Esc') });
    await shell.handle({ type: 'stop' });
    await first;
  });
});

describe('slash commands', () => {
  it('parses commands and leaves normal text alone', () => {
    expect(parseCommand('/forget  Sara prefers calls')).toEqual({ name: 'forget', text: 'Sara prefers calls' });
    expect(parseCommand('/PAUSE')).toEqual({ name: 'pause' });
    expect(parseCommand('hello /pause')).toBeNull();
    expect(parseCommand('/nope')).toEqual({ name: 'unknown', raw: '/nope' });
  });

  it('/pause blocks model calls until /resume and survives restart', async () => {
    const { shell, model, store, items } = setup([{ text: ['ok'] }]);
    await shell.handle({ type: 'send', text: '/pause' });
    expect(shell.status().agent).toBe('paused');
    await shell.handle({ type: 'send', text: 'hello' });
    expect(model.requests).toHaveLength(0);
    expect(items().at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('/resume') });
    expect(store.getSetting('paused')).toBe('1');
    await shell.handle({ type: 'send', text: '/resume' });
    await shell.handle({ type: 'send', text: 'hello' });
    expect(model.requests).toHaveLength(1);
  });

  it('/cost reports today from the usage table', async () => {
    const { shell, store, items } = setup();
    store.recordUsage({ at: CLOCK.getTime() - 1000, role: 'chat', model: 'm', ok: true, costUsd: 0.0123, promptTokens: 100, completionTokens: 20 });
    store.recordUsage({ at: CLOCK.getTime() - 86_400_000, role: 'chat', model: 'm', ok: true, costUsd: 5 });
    await shell.handle({ type: 'send', text: '/cost' });
    expect(items().at(-1)).toMatchObject({ text: expect.stringContaining('$0.0123 across 1 model calls (120 tokens)') });
    expect(shell.status().costTodayUsd).toBeCloseTo(0.0123);
  });

  it('commands never reach the model', async () => {
    const { shell, model } = setup();
    for (const c of ['/help', '/cost', '/memory', '/forget x', '/whatever']) await shell.handle({ type: 'send', text: c });
    expect(model.requests).toHaveLength(0);
  });
});

describe('store', () => {
  it('trims the context window so it never starts with an orphan tool result', () => {
    const store = new Store(':memory:');
    store.saveTurn({ role: 'user', content: 'q1' }, 1);
    store.saveTurn({ role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'now', arguments: '{}' }] }, 2);
    store.saveTurn({ role: 'tool', toolCallId: 'c', name: 'now', content: 't' }, 3);
    store.saveTurn({ role: 'assistant', content: 'a1' }, 4);
    store.saveTurn({ role: 'user', content: 'q2' }, 5);
    expect(store.recentTurns(3)).toEqual([{ role: 'user', content: 'q2' }]);
    expect(store.recentTurns(10)[1]).toEqual({ role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'now', arguments: '{}' }] });
  });

  it('computes local midnight in the user timezone', () => {
    expect(new Date(startOfDay(CLOCK.getTime(), 'Europe/Istanbul')).toISOString()).toBe('2026-10-18T21:00:00.000Z');
  });
});

describe('status and theme', () => {
  it('reads the battery from sysfs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ps-'));
    for (const [name, files] of Object.entries({ AC: { type: 'Mains' }, BAT0: { type: 'Battery', capacity: '57', status: 'Charging' } })) {
      mkdirSync(join(root, name));
      for (const [f, v] of Object.entries(files)) writeFileSync(join(root, name, f), `${v}\n`);
    }
    expect(await readBattery(root)).toEqual({ percent: 57, charging: true });
    expect(await readBattery(join(root, 'missing'))).toBeNull();
  });

  it('parses nmcli terse output', () => {
    expect(parseNmcli('no:Neighbour\nyes:Home\\:5G\n')).toEqual({ connected: true, ssid: 'Home:5G' });
    expect(parseNmcli('no:x\n')).toEqual({ connected: false, ssid: null });
  });

  it('flattens theme colours and ignores everything else', () => {
    expect(parseThemeToml('background = "#1a1b26"\naccent = "0x7aa2f7"\nname = "tokyo"\n[normal]\nred = "#f7768e"')).toEqual({
      background: '#1a1b26',
      accent: '#7aa2f7',
      'normal.red': '#f7768e',
    });
    expect(parseThemeToml('not toml [')).toEqual({});
  });

  it('formats the current time with zone and offset', () => {
    expect(formatNow(CLOCK, 'Europe/Istanbul')).toBe('Monday, 19 October 2026, 09:14 (Europe/Istanbul, UTC+03:00)');
    expect(formatNow(CLOCK, 'UTC')).toContain('(UTC, UTC+00:00)');
  });

  it('greets by time of day', () => {
    const { shell, items } = setup();
    shell.greet();
    expect(items().at(-1)).toMatchObject({ kind: 'assistant', text: 'Morning, John. What can I do for you?' });
  });
});

describe('audit and tiers', () => {
  it('redacts secret-looking keys', () => {
    expect(redact({ a: 1, apiKey: 'sk', nested: { Authorization: 'Bearer x', ok: [{ password: 'p' }] } })).toEqual({
      a: 1,
      apiKey: '[redacted]',
      nested: { Authorization: '[redacted]', ok: [{ password: '[redacted]' }] },
    });
  });

  it('denies write-tier tools in code even when registered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-'));
    const audit = new AuditLog(join(dir, 'a.jsonl'));
    let ran = false;
    const reg = new ToolRegistry(audit).register({
      def: ALPHA_TOOLS.find((t) => t.name === 'mail_send_draft')!,
      label: 'Sending…',
      handler: async () => {
        ran = true;
        return 'sent';
      },
    });
    const out = await reg.execute({ id: 'c', name: 'mail_send_draft', arguments: '{"draftId":"d1"}' }, { signal: new AbortController().signal, untrustedInContext: false });
    expect(out.ok).toBe(false);
    expect(ran).toBe(false);
    expect(readFileSync(join(dir, 'a.jsonl'), 'utf8')).toContain('"decision":"denied"');
  });
});
