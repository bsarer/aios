/**
 * The Settings gear: only the user's click (or their typed /settings) opens the setup window, and
 * what runs is the fixed `/usr/bin/astra settings` in its own unit. There is no tool for it.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientMessage, type ServerEvent } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { HELP_TEXT, parseCommand } from '../src/commands.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { SETTINGS_COMMAND, SettingsError, openSettingsWindow } from '../src/settings.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('openSettingsWindow', () => {
  it('runs only the fixed astra settings, in its own unit through uwsm-app', async () => {
    const runs: [string, string[]][] = [];
    await openSettingsWindow({}, async (c, a) => void runs.push([c, a]), async (c) => c === 'uwsm-app', () => true);
    expect(runs).toEqual([['uwsm-app', ['--', '/usr/bin/astra', 'settings']]]);
    expect(SETTINGS_COMMAND).toEqual(['/usr/bin/astra', 'settings']);
  });

  it('falls back to systemd-run, so Finish restarting the service does not close the window', async () => {
    const runs: [string, string[]][] = [];
    await openSettingsWindow({}, async (c, a) => void runs.push([c, a]), async () => false, () => true);
    expect(runs).toEqual([['systemd-run', ['--user', '--collect', '--quiet', '--', '/usr/bin/astra', 'settings']]]);
  });

  it('says to use a terminal when there is no astra command (a checkout), and runs nothing', async () => {
    const runs: string[] = [];
    await expect(openSettingsWindow({}, async (c) => void runs.push(c), async () => true, () => false)).rejects.toBeInstanceOf(SettingsError);
    expect(runs).toEqual([]);
  });
});

function rig(open: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-settings-'));
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const events: ServerEvent[] = [];
  const requests: ModelRequest[] = [];
  const model = {
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
      yield { type: 'done', result: r };
      return r;
    },
  };
  const shell = new Shell({
    store: new Store(':memory:'),
    model,
    tools: new ToolRegistry(audit),
    audit,
    userName: 'John',
    timeZone: 'UTC',
    modelName: 'm',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    settings: { open },
  });
  shell.subscribe((e) => events.push(e));
  const notices = () => events.flatMap((e) => (e.type === 'item' && e.item.kind === 'notice' ? [e.item.text] : []));
  return { shell, notices, requests, audit: () => readFileSync(auditPath, 'utf8') };
}

describe('the Settings gear in the chat', () => {
  it('opens on the click and on /settings, never calling the model', async () => {
    let opened = 0;
    const r = rig(async () => void opened++);
    await r.shell.handle(ClientMessage.parse({ type: 'settings_open' }));
    expect(opened).toBe(1);
    expect(r.notices().at(-1)).toContain('Settings opened in their own window');
    await r.shell.handle({ type: 'send', text: '/settings' });
    expect(opened).toBe(2);
    expect(r.requests).toHaveLength(0);
    expect(r.audit()).toContain('"kind":"settings","event":"open","via":"click"');
    expect(r.audit()).toContain('"via":"command"');
  });

  it('works while paused, since it is the user\'s own click', async () => {
    let opened = 0;
    const r = rig(async () => void opened++);
    await r.shell.handle({ type: 'send', text: '/pause' });
    await r.shell.handle({ type: 'settings_open' });
    expect(opened).toBe(1);
  });

  it('says why when the window cannot open', async () => {
    const r = rig(async () => {
      throw new SettingsError('this install has no astra command. Run `astra settings` (or `pnpm run setup`) in a terminal.');
    });
    await r.shell.handle({ type: 'settings_open' });
    expect(r.notices().at(-1)).toContain("Couldn’t open settings: this install has no astra command");
    expect(r.audit()).toContain('"event":"failed"');
  });

  it('has no tool, so the model and outside text cannot open settings', () => {
    expect(ALPHA_TOOLS.some((t) => /setting|setup|config/i.test(t.name))).toBe(false);
  });

  it('is parsed and listed in /help', () => {
    expect(parseCommand('/settings')).toEqual({ name: 'settings' });
    expect(parseCommand('/setup')).toEqual({ name: 'settings' });
    expect(HELP_TEXT).toContain('/settings');
    expect(ClientMessage.safeParse({ type: 'settings_open', extra: 1 }).success).toBe(false);
  });
});
