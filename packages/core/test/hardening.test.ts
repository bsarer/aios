/**
 * A7: the cost cap and pause are enforced at the model client, for every caller; the
 * audit log rotates without losing or splitting entries.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRoleConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { modelGate } from '../src/gate.js';
import { ModelClient } from '../src/model.js';
import { Secret } from '../src/secrets/keyring.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const CLOCK = new Date('2026-10-19T06:14:00Z'); // 09:14 in Istanbul
const TZ = 'Europe/Istanbul';

function setup(cap = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-hard-'));
  const store = new Store(':memory:');
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  let fetches = 0;
  const cfg = ModelRoleConfig.parse({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKeyRef: 'keyring:x' });
  const model = new ModelClient({
    models: { chat: cfg, triage: cfg, nightly: cfg },
    resolveKey: async () => new Secret('k'),
    fetch: (async () => {
      fetches++;
      throw new Error('should not be called');
    }) as typeof fetch,
    gate: modelGate({ store, timeZone: TZ, dailyCapUsd: cap, now: () => CLOCK.getTime() }),
    maxAttempts: 1,
  });
  const shell = new Shell({
    store,
    model,
    tools: new ToolRegistry(audit),
    audit,
    userName: 'John',
    timeZone: TZ,
    modelName: 'm',
    costCapUsd: cap,
    readBattery: async () => null,
    readWifi: async () => null,
    clock: () => CLOCK,
  });
  const spend = (usd: number, at = CLOCK.getTime() - 1000) => store.recordUsage({ at, role: 'chat', model: 'm', ok: true, costUsd: usd });
  const last = () => store.recentItems().at(-1);
  return { store, model, shell, spend, last, fetches: () => fetches };
}

describe('cost cap', () => {
  it('counts only today in the user timezone', () => {
    const { store, spend } = setup();
    const gate = modelGate({ store, timeZone: TZ, dailyCapUsd: 1, now: () => CLOCK.getTime() });
    spend(5, new Date('2026-10-18T20:59:00Z').getTime()); // 23:59 yesterday in Istanbul
    expect(gate('chat')).toBeNull();
    spend(0.6);
    expect(gate('chat')).toBeNull();
    spend(0.4);
    expect(gate('chat')).toBe('cost_cap');
  });

  it('at the cap, a chat message gets a clear notice and nothing reaches the provider', async () => {
    const { shell, spend, last, fetches } = setup();
    spend(1.2);
    await shell.handle({ type: 'send', text: 'hello' });
    expect(last()).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringMatching(/daily cap.*until tomorrow/) });
    expect(fetches()).toBe(0);
  });

  it('/cost says the cap is reached and how to change it', async () => {
    const { shell, spend, last } = setup();
    spend(1);
    await shell.handle({ type: 'send', text: '/cost' });
    expect(last()).toMatchObject({ text: expect.stringMatching(/cap is reached.*cost\.dailyCapUsd/) });
  });
});

describe('pause stops every model call', () => {
  it('chat, triage and nightly are all refused while paused, and work again after /resume', async () => {
    const { shell, model, fetches } = setup(100);
    await shell.handle({ type: 'send', text: '/pause' });
    for (const role of ['chat', 'triage', 'nightly'] as const) {
      await expect(model.complete({ role, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'paused' });
    }
    expect(fetches()).toBe(0);
    await shell.handle({ type: 'send', text: '/resume' });
    // Now it gets as far as the (unreachable) provider.
    await expect(model.complete({ role: 'triage', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'network' });
    expect(fetches()).toBeGreaterThan(0);
  });
});

describe('audit log rotation', () => {
  it('rotates whole files, keeps N, and never splits an entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-audit-'));
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path, { maxBytes: 300, keep: 2 });
    for (let i = 0; i < 40; i++) log.append({ kind: 'tool', tool: 'now', n: i });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    const lines = [`${path}.2`, `${path}.1`, path].flatMap((f) => readFileSync(f, 'utf8').trim().split('\n'));
    const ns = lines.map((l) => (JSON.parse(l) as { n: number }).n);
    // Newest entries kept, in order, each line whole.
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(ns.at(-1)).toBe(39);
    for (const f of [path, `${path}.1`]) expect(readFileSync(f).length).toBeLessThanOrEqual(300);
  });

  it('picks up the size of an existing file after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-audit-'));
    const path = join(dir, 'audit.jsonl');
    const a = new AuditLog(path, { maxBytes: 200 });
    for (let i = 0; i < 3; i++) a.append({ kind: 'tool', n: i });
    const b = new AuditLog(path, { maxBytes: 200 });
    for (let i = 3; i < 6; i++) b.append({ kind: 'tool', n: i });
    expect(existsSync(`${path}.1`)).toBe(true);
  });
});
