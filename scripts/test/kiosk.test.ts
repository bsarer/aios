/**
 * A6 kiosk files: install and uninstall undo each other, the launcher closes a hung
 * window within a second, and the generated Lua runs against a stub of Hyprland's API.
 * Tests that need bash tools, lua5.4 or systemd-analyze skip when those are missing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRE_LINE, addRequire, hyprlandModule, installKiosk, kioskPaths, launcherScript, pinTrayIcon, removeRequire, trayIconPinned, uninstallKiosk, unitFile } from '../src/kiosk.js';

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

/** Shaped like Omarchy 4's ~/.config/hypr/hyprland.lua. */
const OMARCHY_HYPRLAND_LUA = `-- Learn how to configure Hyprland: https://wiki.hypr.land/Configuring/Start/
dofile((os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/default/hypr/bootstrap.lua")
require("default.hypr.omarchy")
require("hypr.monitors")
require("hypr.bindings")

-- Add any other personal Hyprland configuration below.
-- o.window("qemu", { workspace = "5" })
`;

/** Shaped like Omarchy 4's config/omarchy/shell.json (October 2026), trimmed. */
const OMARCHY_SHELL_JSON = {
  version: 1,
  bar: {
    position: 'top',
    layout: {
      left: [{ id: 'omarchy.menu' }, { id: 'omarchy.workspaces' }],
      center: [{ id: 'omarchy.clock', format: 'dddd HH:mm' }],
      right: [{ id: 'omarchy.tray' }, { id: 'omarchy.network' }, { id: 'omarchy.power' }],
    },
  },
  idle: { lock: 300 },
  plugins: [],
};

function home(withLua = true) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-kiosk-'));
  // OMARCHY_PATH points inside the test dir, so no real Omarchy install is read.
  const env = { HOME: dir, OMARCHY_PATH: join(dir, 'omarchy') };
  const p = kioskPaths(env);
  mkdirSync(p.hyprDir, { recursive: true });
  if (withLua) writeFileSync(p.hyprlandLua, OMARCHY_HYPRLAND_LUA);
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => void calls.push([cmd, ...args].join(' '));
  return { dir, p, calls, run };
}

const opts = { node: process.execPath, coreDir: '/opt/aios/packages/core', port: 7777, autostart: true, hyprland: true, pinTray: true };

describe('install and uninstall', () => {
  it('installs the service, launcher and Hyprland module, adds one line, and is idempotent', async () => {
    const h = home();
    const first = await installKiosk(h.p, opts, h.run);
    expect(first.written.sort()).toEqual([h.p.aiosLua, h.p.hyprlandLua, h.p.launcher, h.p.unit].sort());
    expect(readFileSync(`${h.p.hyprlandLua}.aios-backup`, 'utf8')).toBe(OMARCHY_HYPRLAND_LUA);
    expect(readFileSync(h.p.hyprlandLua, 'utf8')).toBe(`${OMARCHY_HYPRLAND_LUA}\n${REQUIRE_LINE}\n`);
    expect(h.calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable aios-core.service']);

    const second = await installKiosk(h.p, opts, h.run);
    expect(second.written).toEqual([]);
    expect(readFileSync(h.p.hyprlandLua, 'utf8').split(REQUIRE_LINE)).toHaveLength(2);
  });

  it('uninstall restores hyprland.lua exactly and removes every file', async () => {
    const h = home();
    await installKiosk(h.p, opts, h.run);
    h.calls.length = 0;
    const removed = await uninstallKiosk(h.p, h.run);
    expect(readFileSync(h.p.hyprlandLua, 'utf8')).toBe(OMARCHY_HYPRLAND_LUA);
    for (const f of [h.p.aiosLua, h.p.launcher, h.p.unit]) expect(existsSync(f)).toBe(false);
    expect(removed).toHaveLength(4);
    expect(h.calls).toEqual([`${h.p.launcher} exit`, 'systemctl --user disable --now aios-core.service', 'systemctl --user daemon-reload']);
    expect(await uninstallKiosk(h.p, h.run)).toEqual([]);
  });

  it('leaves hyprland.lua alone when asked to, and says what line to add', async () => {
    const h = home();
    const r = await installKiosk(h.p, { ...opts, hyprland: false }, h.run);
    expect(readFileSync(h.p.hyprlandLua, 'utf8')).toBe(OMARCHY_HYPRLAND_LUA);
    expect(r.notes.join('\n')).toContain(REQUIRE_LINE);
  });

  it('skips Hyprland on an old hyprland.conf setup but still installs the service', async () => {
    const h = home(false);
    writeFileSync(join(h.p.hyprDir, 'hyprland.conf'), 'source = ~/.config/hypr/bindings.conf\n');
    const r = await installKiosk(h.p, opts, h.run);
    expect(existsSync(h.p.unit) && existsSync(h.p.launcher)).toBe(true);
    expect(existsSync(h.p.aiosLua)).toBe(false);
    expect(r.notes.join(' ')).toMatch(/needs Hyprland 0\.55\+/);
  });

  it('adds and removes the line around user edits made in between', () => {
    const added = addRequire(OMARCHY_HYPRLAND_LUA);
    const edited = `${added}o.window("qemu", { workspace = "5" })\n`;
    expect(removeRequire(edited)).toBe(`${OMARCHY_HYPRLAND_LUA}o.window("qemu", { workspace = "5" })\n`);
  });
});

describe.skipIf(!has('lua5.4'))('generated Lua against a stub of the Hyprland API', () => {
  const STUB = `
calls = {}
hl = {
  window_rule = function(r) table.insert(calls, "rule " .. r.name .. " " .. r.match.class .. " fullscreen=" .. tostring(r.fullscreen) .. " ws=" .. r.workspace) end,
  on = function(ev, fn) table.insert(calls, "on " .. ev); fn() end,
  exec_cmd = function(c) table.insert(calls, "exec " .. c) end,
  bind = function(keys, d, o) table.insert(calls, "bind " .. keys .. " -> " .. d .. " (" .. o.description .. ")") end,
  dsp = { exec_cmd = function(c) return "exec_cmd:" .. c end },
}
package.path = os.getenv("HOME") .. "/.config/?.lua;" .. package.path
`;
  const runLua = (dir: string, body: string) =>
    execFileSync('lua5.4', ['-e', `${STUB}\n${body}\nfor _, c in ipairs(calls) do print(c) end`], { env: { ...process.env, HOME: dir }, encoding: 'utf8' }).trim().split('\n');

  it('the require line loads aios.lua, which sets the rule, autostart and keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-lua-'));
    mkdirSync(join(dir, '.config', 'hypr'), { recursive: true });
    writeFileSync(join(dir, '.config', 'hypr', 'aios.lua'), hyprlandModule({ launcher: '/home/j/.local/bin/aios-kiosk', autostart: true }));
    expect(runLua(dir, REQUIRE_LINE)).toEqual([
      'rule aios-kiosk ^(org\\.aios\\.home|(chrome|chromium|brave)-127\\.0\\.0\\.1__.*)$ fullscreen=true ws=1',
      'on hyprland.start',
      'exec /home/j/.local/bin/aios-kiosk open',
      'bind SUPER + SHIFT + ESCAPE -> exec_cmd:/home/j/.local/bin/aios-kiosk exit (Exit AI OS)',
      'bind SUPER + SHIFT + H -> exec_cmd:/home/j/.local/bin/aios-kiosk open (Open AI OS)',
    ]);
  });

  it('a deleted aios.lua does not break hyprland.lua, and kiosk = false skips autostart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-lua-'));
    mkdirSync(join(dir, '.config', 'hypr'), { recursive: true });
    expect(runLua(dir, REQUIRE_LINE)).toEqual(['']);
    writeFileSync(join(dir, '.config', 'hypr', 'aios.lua'), hyprlandModule({ launcher: '/x/aios-kiosk', autostart: false }));
    expect(runLua(dir, REQUIRE_LINE).some((l) => l.startsWith('on '))).toBe(false);
  });
});

describe.skipIf(!has('bash') || !has('jq'))('the aios-kiosk launcher', () => {
  /** Runs the launcher with fake hyprctl, curl, pgrep, pkill and chromium (first on PATH) that log their arguments. */
  function launcher(o: { windowOpen: boolean; hung: boolean; down?: boolean; env?: Record<string, string> }) {
    const dir = mkdtempSync(join(tmpdir(), 'aios-launch-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'log');
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${log}\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const clients = o.windowOpen ? '[{"class":"org.aios.home","address":"0x1"}]' : '[{"class":"Alacritty"}]';
    fake('hyprctl', `[ "$1" = clients ] && echo '${clients}'; exit 0`);
    fake('curl', o.down ? 'exit 7' : 'exit 0');
    fake('notify-send', 'exit 0');
    fake('journalctl', "printf '%s\\n' 'aios-core failed to start: old' 'aios-core failed to start: config is invalid:' '✖ mail.address: Invalid email'");
    if (o.down) fake('sleep', 'exit 0');
    fake('pgrep', o.hung ? 'exit 0' : 'exit 1');
    fake('pkill', 'exit 0');
    fake('chromium', 'exit 0');
    const script = join(dir, 'aios-kiosk');
    writeFileSync(script, launcherScript({ port: 7777, profileDir: '/home/j/.local/share/aios/chromium' }));
    chmodSync(script, 0o755);
    return (arg: string) => {
      const started = Date.now();
      const r = spawnSync('bash', [script, arg], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...o.env }, encoding: 'utf8' });
      const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
      rmSync(log, { force: true });
      return { status: r.status, ms: Date.now() - started, lines, stderr: r.stderr };
    };
  }

  it('opens the chat as a fullscreen-rule app window with its own profile', () => {
    const r = launcher({ windowOpen: false, hung: false })('open');
    expect(r.status).toBe(0);
    const chromium = r.lines.find((l) => l.startsWith('chromium '))!;
    expect(chromium).toContain('--user-data-dir=/home/j/.local/share/aios/chromium');
    expect(chromium).toContain('--class=org.aios.home');
    expect(chromium).toContain('--app=http://127.0.0.1:7777/');
  });

  it('focuses the window instead of opening a second one', () => {
    const r = launcher({ windowOpen: true, hung: false })('open');
    expect(r.lines.some((l) => l.startsWith('chromium'))).toBe(false);
    expect(r.lines).toContain('hyprctl dispatch hl.dsp.focus({ window = [[class:^(org\\.aios\\.home|(chrome|chromium|brave)-127\\.0\\.0\\.1__.*)$]] })');
  });

  it('AIOS_KIOSK=0 opens a normal window', () => {
    const r = launcher({ windowOpen: false, hung: false, env: { AIOS_KIOSK: '0' } })('open');
    expect(r.lines.find((l) => l.startsWith('chromium '))).toContain('--new-window http://127.0.0.1:7777/');
  });

  it('when the service never comes up, says why in a notification and opens no error page', () => {
    const r = launcher({ windowOpen: false, hung: false, down: true, env: { AIOS_KIOSK_WAIT: '3' } })('open');
    expect(r.status).toBe(1);
    expect(r.lines.filter((l) => l.startsWith('curl'))).toHaveLength(3);
    expect(r.lines.some((l) => l.startsWith('chromium'))).toBe(false);
    // Only the latest failure, with its detail lines.
    expect(r.lines.find((l) => l.startsWith('notify-send'))).toBe('notify-send -u critical AI OS aios-core failed to start: config is invalid:');
    expect(r.stderr).toContain('mail.address: Invalid email');
    expect(r.stderr).not.toContain('old');
  });

  it('exit closes the window and kills nothing when it closes', () => {
    const r = launcher({ windowOpen: true, hung: false })('exit');
    expect(r.lines[0]).toMatch(/^hyprctl dispatch hl\.dsp\.window\.close/);
    expect(r.lines.some((l) => l.startsWith('pkill'))).toBe(false);
  });

  it('exit kills a hung chat within a second', () => {
    const r = launcher({ windowOpen: true, hung: true })('exit');
    expect(r.lines.at(-1)).toBe('pkill -KILL -f -- --user-data-dir=/home/j/.local/share/aios/chromium');
    expect(r.ms).toBeLessThan(1000);
  });
});

describe.skipIf(!has('systemd-analyze'))('systemd unit', () => {
  it('passes systemd-analyze verify', () => {
    const dir = mkdtempSync('/tmp/aios-unit-');
    const unit = join(dir, 'aios-core.service');
    writeFileSync(unit, unitFile({ node: process.execPath, coreDir: join(import.meta.dirname, '..', '..', 'packages', 'core') }));
    // A short runtime dir: some systems' own user units fail on long socket paths, which is noise here.
    const r = spawnSync('systemd-analyze', ['--user', 'verify', '--man=no', unit], { env: { ...process.env, XDG_RUNTIME_DIR: dir }, encoding: 'utf8' });
    const ours = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('aios-core'));
    expect(ours).toEqual([]);
  });
});

describe("the tray circle pinned in Omarchy's bar", () => {
  it('adds the AI OS id to the tray entry and keeps everything else', () => {
    const pinned = pinTrayIcon(OMARCHY_SHELL_JSON, true)!;
    expect(pinned).toEqual({ ...OMARCHY_SHELL_JSON, bar: { ...OMARCHY_SHELL_JSON.bar, layout: { ...OMARCHY_SHELL_JSON.bar.layout, right: [{ id: 'omarchy.tray', pinned: ['aios'] }, { id: 'omarchy.network' }, { id: 'omarchy.power' }] } } });
    expect(trayIconPinned(pinned)).toBe(true);
    expect(pinTrayIcon(pinned, true)).toBeNull();
    expect(pinTrayIcon(pinned, false)).toEqual({ ...OMARCHY_SHELL_JSON, bar: { ...OMARCHY_SHELL_JSON.bar, layout: { ...OMARCHY_SHELL_JSON.bar.layout, right: [{ id: 'omarchy.tray', pinned: [] }, { id: 'omarchy.network' }, { id: 'omarchy.power' }] } } });
  });

  it("keeps the user's own pins, takes a bare tray id, and leaves odd files alone", () => {
    const own = { version: 1, bar: { layout: { right: [{ id: 'omarchy.tray', pinned: ['nm-applet'], hidden: ['steam'] }] } } };
    expect(pinTrayIcon(own, true)).toEqual({ version: 1, bar: { layout: { right: [{ id: 'omarchy.tray', pinned: ['nm-applet', 'aios'], hidden: ['steam'] }] } } });
    expect(pinTrayIcon({ version: 1, bar: { layout: { right: ['omarchy.tray'] } } }, true)).toEqual({ version: 1, bar: { layout: { right: [{ id: 'omarchy.tray', pinned: ['aios'] }] } } });
    for (const odd of [undefined, 'text', [], { version: 2, bar: { layout: {} } }, { bar: { layout: { right: [{ id: 'omarchy.clock' }] } } }]) expect(pinTrayIcon(odd, true)).toBeNull();
  });

  it("install pins it in the user's shell.json with a backup, once; uninstall unpins it", async () => {
    const h = home();
    mkdirSync(dirname(h.p.shellJson), { recursive: true });
    const original = `${JSON.stringify(OMARCHY_SHELL_JSON, null, 2)}\n`;
    writeFileSync(h.p.shellJson, original);
    const first = await installKiosk(h.p, opts, h.run);
    expect(first.written).toContain(h.p.shellJson);
    expect(readFileSync(`${h.p.shellJson}.aios-backup`, 'utf8')).toBe(original);
    expect(trayIconPinned(JSON.parse(readFileSync(h.p.shellJson, 'utf8')))).toBe(true);
    expect((await installKiosk(h.p, opts, h.run)).written).toEqual([]);
    const removed = await uninstallKiosk(h.p, h.run);
    expect(removed).toContain(`AI OS circle pinned in ${h.p.shellJson}`);
    expect(trayIconPinned(JSON.parse(readFileSync(h.p.shellJson, 'utf8')))).toBe(false);
  });

  it("starts the user's shell.json from Omarchy's defaults when there is none, and says so when there is no bar", async () => {
    const h = home();
    const defaults = h.p.shellDefaults[0]!;
    expect(defaults).toBe(join(h.dir, 'omarchy', 'config', 'omarchy', 'shell.json'));
    const none = await installKiosk(h.p, opts, h.run);
    expect(none.notes.join('\n')).toMatch(/No Omarchy bar settings found; pin AI OS by hand/);
    mkdirSync(dirname(defaults), { recursive: true });
    writeFileSync(defaults, JSON.stringify(OMARCHY_SHELL_JSON));
    expect((await installKiosk(h.p, { ...opts, pinTray: false }, h.run)).written).toEqual([]);
    expect(existsSync(h.p.shellJson)).toBe(false);
    const report = await installKiosk(h.p, opts, h.run);
    expect(report.written).toEqual([h.p.shellJson]);
    expect(JSON.parse(readFileSync(h.p.shellJson, 'utf8'))).toEqual(pinTrayIcon(OMARCHY_SHELL_JSON, true));
    expect(JSON.parse(readFileSync(defaults, 'utf8'))).toEqual(OMARCHY_SHELL_JSON);
  });
});
