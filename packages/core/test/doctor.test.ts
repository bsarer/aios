/** P1, R1: `astra doctor` and `/doctor`, against fake probes. Never the real computer. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';
import { type DoctorProbes, OMARCHY_COMMANDS, formatChecks, runDoctor, unitTargets } from '../src/doctor.js';
import { BAR_ID, kioskPaths } from '../src/kiosk-paths.js';

const HOME = '/home/john';
const env = { HOME, PATH: '/usr/bin:/home/john/.local/share/omarchy/bin' };
const paths = kioskPaths(env);
const CONFIG = `
[user]
name = "John"
timezone = "Europe/Istanbul"
[models.chat]
baseUrl = "https://example.invalid/v1"
model = "m"
apiKeyRef = "keyring:model-chat"
[models.triage]
baseUrl = "https://example.invalid/v1"
model = "m"
apiKeyRef = "keyring:model-chat"
[models.nightly]
baseUrl = "https://example.invalid/v1"
model = "m"
apiKeyRef = "keyring:model-chat"
[mail]
address = "john@aios.test"
username = "john@aios.test"
passwordRef = "keyring:mail"
imap = { host = "127.0.0.1", port = 3143, tls = false }
smtp = { host = "127.0.0.1", port = 3025, tls = false }
[builder]
enabled = false
[docs]
enabled = false
`;
const UNIT = `[Service]\nWorkingDirectory=/home/john/.local/share/aios/app/packages/core\nExecStart=/usr/bin/node --import tsx src/main.ts\n`;

/** A working install; each test breaks one thing. */
function healthy() {
  const files = new Map<string, string>([
    [join(HOME, '.config', 'astra', 'config.toml'), CONFIG],
    [paths.unit, UNIT],
    [paths.hyprlandLua, `require("hypr.bindings")\n${paths.requireLine}\n`],
    [paths.aiosLua, '-- aios'],
    [paths.shellJson, JSON.stringify({ bar: { layout: { right: [{ id: BAR_ID }] } } })],
    ['/usr/bin/node', ''],
    ['/home/john/.local/share/aios/app/packages/core', ''],
    ...OMARCHY_COMMANDS.map((c) => [`/home/john/.local/share/omarchy/bin/${c}`, ''] as [string, string]),
  ]);
  const runs = new Map<string, { code: number; stdout: string }>([
    ['systemctl --user is-enabled astra.service', { code: 0, stdout: 'enabled\n' }],
    ['systemctl --user is-active astra.service', { code: 0, stdout: 'active\n' }],
    ['systemctl --user show-environment', { code: 0, stdout: 'HOME=/home/john\nWAYLAND_DISPLAY=wayland-1\nHYPRLAND_INSTANCE_SIGNATURE=abc\n' }],
    ['secret-tool', { code: 2, stdout: '' }],
  ]);
  const secrets = new Set(['keyring:mail', 'keyring:model-chat']);
  const asked: string[] = [];
  let up = true;
  const probes: DoctorProbes = {
    env,
    paths,
    readFile: async (p) => files.get(p) ?? null,
    exists: async (p) => files.has(p),
    run: async (cmd, args) => runs.get([cmd, ...args].join(' ')) ?? { code: 127, stdout: '' },
    health: async () => up,
    hasSecret: async (ref) => {
      asked.push(ref);
      return secrets.has(ref);
    },
  };
  return { probes, files, runs, secrets, asked, down: () => void (up = false) };
}

const byName = async (p: DoctorProbes) => Object.fromEntries((await runDoctor(p)).map((c) => [c.name, c]));

describe('doctor', () => {
  it('passes on a working install and asks the keyring only whether each secret is stored', async () => {
    const h = healthy();
    const checks = await runDoctor(h.probes);
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(['Config', 'Service', 'Service paths', 'Chat page', 'Kiosk', 'Desktop session', 'Omarchy commands', 'Top bar button', 'Keyring']);
    expect(h.asked.sort()).toEqual(['keyring:mail', 'keyring:model-chat']);
  });

  it('finds what an Omarchy update can break, each with a fix', async () => {
    const h = healthy();
    h.files.set(paths.hyprlandLua, 'require("hypr.bindings")\n');
    h.files.delete(`/home/john/.local/share/omarchy/bin/${OMARCHY_COMMANDS[0]}`);
    h.files.set(paths.shellJson, '{"bar":{}}');
    h.runs.set('systemctl --user show-environment', { code: 0, stdout: 'HOME=/home/john\n' });
    const c = await byName(h.probes);
    expect(c.Kiosk).toMatchObject({ status: 'fail', fix: expect.stringContaining('setup --kiosk') });
    expect(c.Kiosk!.detail).toContain('Omarchy update');
    expect(c['Omarchy commands']).toMatchObject({ status: 'fail', detail: `missing: ${OMARCHY_COMMANDS[0]}` });
    expect(c['Top bar button']).toMatchObject({ status: 'warn' });
    expect(c['Desktop session']).toMatchObject({ status: 'fail', detail: expect.stringContaining('WAYLAND_DISPLAY and HYPRLAND_INSTANCE_SIGNATURE') });
  });

  it('finds a stopped service, a moved Node and a page that does not answer', async () => {
    const h = healthy();
    h.runs.set('systemctl --user is-active astra.service', { code: 3, stdout: 'failed\n' });
    h.files.delete('/usr/bin/node');
    h.down();
    const c = await byName(h.probes);
    expect(c.Service).toMatchObject({ status: 'fail', detail: 'astra is failed and enabled' });
    expect(c['Service paths']).toMatchObject({ status: 'fail', detail: expect.stringContaining('/usr/bin/node') });
    expect(c['Chat page']).toMatchObject({ status: 'fail', detail: 'nothing answers on 127.0.0.1:7777' });
  });

  it('names missing secrets by reference only, and says when secret-tool is gone', async () => {
    const h = healthy();
    h.secrets.delete('keyring:mail');
    const c = await byName(h.probes);
    expect(c.Keyring).toMatchObject({ status: 'fail', detail: 'not stored: keyring:mail' });
    h.runs.delete('secret-tool');
    expect((await byName(h.probes)).Keyring).toMatchObject({ status: 'fail', detail: 'secret-tool is not installed' });
  });

  it('stops at a missing or broken config, without guessing the rest', async () => {
    const h = healthy();
    h.files.delete(join(HOME, '.config', 'astra', 'config.toml'));
    const c = await byName(h.probes);
    expect(c.Config).toMatchObject({ status: 'fail', fix: 'run `astra setup`' });
    expect(c.Keyring).toBeUndefined();
    expect(c['Chat page']).toBeUndefined();
    h.files.set(join(HOME, '.config', 'astra', 'config.toml'), '[user\n');
    expect((await byName(h.probes)).Config).toMatchObject({ status: 'fail' });
  });

  it('warns about Claude Code and the Word and Excel programs only when they are turned on', async () => {
    const h = healthy();
    h.files.set(join(HOME, '.config', 'astra', 'config.toml'), CONFIG.replace('[builder]\nenabled = false', '[builder]\nenabled = true').replace('[docs]\nenabled = false', '[docs]\nenabled = true'));
    const c = await byName(h.probes);
    expect(c['Claude Code']).toMatchObject({ status: 'warn' });
    expect(c['Word and Excel']).toMatchObject({ status: 'warn' });
  });

  it('formats one line per check and reads the unit setup wrote', () => {
    expect(formatChecks([
      { name: 'A', status: 'ok', detail: 'fine', fix: 'never shown' },
      { name: 'B', status: 'fail', detail: 'broken', fix: 'do this' },
    ])).toEqual(['✓ A: fine', '✗ B: broken. Fix: do this']);
    expect(unitTargets(UNIT)).toEqual({ node: '/usr/bin/node', dir: '/home/john/.local/share/aios/app/packages/core' });
    expect(parseCommand('/doctor')).toEqual({ name: 'doctor' });
  });
});
