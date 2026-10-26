import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, ServerEvent, WindowMode } from '@aios/shared';
import { describe, expect, it, vi } from 'vitest';
import { type DesktopApp, appFromEntry, findApp, parseDesktopEntry, scanApps, searchApps } from '../src/apps/desktop.js';
import { type HyprClient, type HyprEvent, type HyprIpc, type HyprMonitor, hyprlandIpc, parseHyprEvent } from '../src/apps/hyprland.js';
import { createLauncher } from '../src/apps/launcher.js';
import { appTools } from '../src/apps/tools.js';
import { ChatWindow, dispatchesFor, halfRect } from '../src/apps/window.js';
import { AuditLog } from '../src/audit.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { SystemActions } from '../src/system/actions.js';
import { SystemControls } from '../src/system/controls.js';
import type { Run } from '../src/system/run.js';
import { systemTools } from '../src/system/tools.js';
import { ToolRegistry } from '../src/tools/registry.js';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `aios-${name}-`));
const entry = (fields: Record<string, string>, extra = '') =>
  `# a comment\n[Desktop Entry]\n${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n${extra}`;
const opts = { desktops: ['hyprland'], env: { PATH: '/nonexistent' } };

describe('desktop entries', () => {
  it('reads only the unlocalized keys of [Desktop Entry]', () => {
    const k = parseDesktopEntry(entry({ Name: 'Firefox', 'Name[de]': 'Feuerfuchs', Exec: 'firefox %u' }, '[Desktop Action new-window]\nName=New Window\n'));
    expect(k.get('Name')).toBe('Firefox');
    expect(k.has('Name[de]')).toBe(false);
    expect([...k.keys()]).toEqual(['Name', 'Exec']);
  });

  it('lists an application with its name, description, keywords and categories', async () => {
    const app = await appFromEntry('firefox.desktop', entry({ Type: 'Application', Name: 'Firefox', Comment: 'Browse the\\sweb', Keywords: 'web;internet\\;stuff;', Categories: 'Network;WebBrowser;' }), opts);
    expect(app).toEqual({ id: 'firefox.desktop', name: 'Firefox', comment: 'Browse the web', keywords: ['web', 'internet;stuff'], categories: ['Network', 'WebBrowser'], terminal: false });
  });

  it.each([
    ['not an application', { Type: 'Link', Name: 'x' }],
    ['NoDisplay', { Type: 'Application', Name: 'x', NoDisplay: 'true' }],
    ['Hidden', { Type: 'Application', Name: 'x', Hidden: 'true' }],
    ['only for GNOME', { Type: 'Application', Name: 'x', OnlyShowIn: 'GNOME;' }],
    ['not for Hyprland', { Type: 'Application', Name: 'x', NotShowIn: 'Hyprland;' }],
    ['its TryExec program is missing', { Type: 'Application', Name: 'x', TryExec: 'definitely-not-installed' }],
    ['no name', { Type: 'Application', Name: '  ' }],
  ])('skips an entry that is %s', async (_why, fields) => {
    expect(await appFromEntry('x.desktop', entry(fields), opts)).toBeNull();
  });

  it('cleans control characters out of names', async () => {
    const app = await appFromEntry('x.desktop', entry({ Type: 'Application', Name: 'Evil‮ppa\u0007 App' }), opts);
    expect(app?.name).toBe('Evilppa App');
  });

  it('scans user then system dirs; the user copy wins, even when it hides the app', async () => {
    const user = join(tmp('apps-user'), 'applications');
    const sys = join(tmp('apps-sys'), 'applications');
    mkdirSync(join(sys, 'kde'), { recursive: true });
    mkdirSync(user, { recursive: true });
    const app = (name: string, more: Record<string, string> = {}) => entry({ Type: 'Application', Name: name, ...more });
    writeFileSync(join(sys, 'firefox.desktop'), app('Firefox'));
    writeFileSync(join(user, 'firefox.desktop'), app('Firefox (mine)'));
    writeFileSync(join(sys, 'htop.desktop'), app('Htop', { Terminal: 'true' }));
    writeFileSync(join(user, 'htop.desktop'), app('Htop', { NoDisplay: 'true' }));
    writeFileSync(join(sys, 'kde', 'dolphin.desktop'), app('Dolphin'));
    writeFileSync(join(sys, '-rf.desktop'), app('Looks like an option'));
    writeFileSync(join(sys, 'big.desktop'), app('Big', { Comment: 'x'.repeat(70 * 1024) }));
    writeFileSync(join(sys, 'notes.txt'), app('Not a desktop file'));
    const apps = await scanApps({ dirs: [user, sys], env: { PATH: '', XDG_CURRENT_DESKTOP: 'Hyprland' } });
    expect(apps.map((a) => [a.id, a.name])).toEqual([
      ['firefox.desktop', 'Firefox (mine)'],
      ['kde-dolphin.desktop', 'Dolphin'],
    ].sort((a, b) => a[1]!.localeCompare(b[1]!)));
  });

  it('finds an app by id, short id or exact name, and reports ambiguity', () => {
    const a = (id: string, name: string, more: Partial<DesktopApp> = {}): DesktopApp => ({ id, name, comment: '', keywords: [], categories: [], terminal: false, ...more });
    const apps = [a('firefox.desktop', 'Firefox', { categories: ['WebBrowser'] }), a('org.gnome.Nautilus.desktop', 'Files'), a('files-2.desktop', 'Files'), a('spotify.desktop', 'Spotify', { keywords: ['music'] })];
    expect(findApp(apps, 'firefox')).toBe(apps[0]);
    expect(findApp(apps, 'FIREFOX.desktop')).toBe(apps[0]);
    expect(findApp(apps, 'org.gnome.nautilus')).toBe(apps[1]);
    expect(findApp(apps, ' spotify ')).toBe(apps[3]);
    expect(findApp(apps, 'files')).toEqual([apps[1], apps[2]]);
    expect(findApp(apps, 'fire')).toBeNull();
    expect(searchApps(apps, 'music')).toEqual([apps[3]]);
    expect(searchApps(apps, 'webbrowser')).toEqual([apps[0]]);
    expect(searchApps(apps, '')).toEqual(apps);
  });
});

describe('launcher', () => {
  const fakeBin = (names: string[], code = 0) => {
    const bin = tmp('bin');
    const out = join(bin, 'calls.txt');
    for (const n of names) {
      writeFileSync(join(bin, n), `#!/bin/sh\nprintf '%s ' "${n}" "$@" >> "${out}"\necho >> "${out}"\nexit ${code}\n`);
      chmodSync(join(bin, n), 0o755);
    }
    return { env: { PATH: bin }, calls: () => readFileSync(out, 'utf8').trim() };
  };

  it("starts an app by id through uwsm-app and gtk-launch, like Omarchy", async () => {
    const b = fakeBin(['uwsm-app', 'gtk-launch']);
    await createLauncher(b.env)('firefox.desktop');
    expect(b.calls()).toBe('uwsm-app -- gtk-launch firefox.desktop');
  });

  it('uses gtk-launch alone without uwsm', async () => {
    const b = fakeBin(['gtk-launch']);
    await createLauncher(b.env)('firefox.desktop');
    expect(b.calls()).toBe('gtk-launch firefox.desktop');
  });

  it('refuses ids that are not desktop ids, and says when gtk-launch is missing or fails', async () => {
    const b = fakeBin(['gtk-launch']);
    for (const bad of ['-rf.desktop', 'firefox', '../x.desktop', 'a b.desktop']) await expect(createLauncher(b.env)(bad)).rejects.toThrow(/not an installed app/);
    await expect(createLauncher({ PATH: tmp('empty') })('firefox.desktop')).rejects.toThrow(/doesn't have gtk-launch/);
    await expect(createLauncher(fakeBin(['gtk-launch'], 2).env)('firefox.desktop')).rejects.toThrow(/exit code 2/);
  });
});

const monitor = (over: Partial<HyprMonitor> = {}): HyprMonitor => ({ id: 0, width: 2880, height: 1800, x: 0, y: 0, scale: 1.5, transform: 0, focused: true, activeWorkspace: { id: 3 }, reserved: [0, 26, 0, 0], ...over });
const chat = (over: Partial<HyprClient> = {}): HyprClient => ({ address: '0xabc123', class: 'org.aios.home', floating: false, pinned: false, fullscreen: 2, monitor: 0, workspace: { name: '1' }, ...over });

describe('Hyprland', () => {
  it('parses the window events it needs', () => {
    expect(parseHyprEvent('openwindow>>55d0c1f4a2b0,1,firefox,Mozilla Firefox, with commas')).toEqual({ name: 'openwindow', address: '0x55d0c1f4a2b0', className: 'firefox' });
    expect(parseHyprEvent('closewindow>>55d0c1f4a2b0')).toEqual({ name: 'closewindow', address: '0x55d0c1f4a2b0' });
    for (const l of ['activewindow>>firefox,x', 'closewindow>>zz; rm', 'openwindow>>,1,x,y', 'nonsense']) expect(parseHyprEvent(l)).toBeNull();
  });

  it('is off outside Hyprland', () => {
    expect(hyprlandIpc({})).toBeNull();
    expect(hyprlandIpc({ HYPRLAND_INSTANCE_SIGNATURE: '../x', XDG_RUNTIME_DIR: '/run/user/1000' })).toBeNull();
  });

  it('runs dispatches through hyprctl and treats any answer but "ok" as a refusal', async () => {
    const calls: string[][] = [];
    let answer = 'ok';
    const run: Run = async (cmd, args) => (calls.push([cmd, ...args]), { stdout: args[0] === '-j' ? JSON.stringify([chat({ extra: 1 } as Partial<HyprClient>)]) : `${answer}\n`, code: 0 });
    const ipc = hyprlandIpc({ HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_RUNTIME_DIR: '/run/user/1000' }, run)!;
    await ipc.dispatch('hl.dsp.window.pin({ action = "on" })');
    expect(calls[0]).toEqual(['hyprctl', 'dispatch', 'hl.dsp.window.pin({ action = "on" })']);
    answer = 'Invalid prop name';
    await expect(ipc.dispatch('hl.dsp.window.set_prop({})')).rejects.toThrow(/Hyprland refused hl.dsp.window.set_prop: Invalid prop name/);
    expect((await ipc.clients())[0]!.address).toBe('0xabc123');
    expect(calls.at(-1)).toEqual(['hyprctl', '-j', 'clients']);
  });

  it('hears window events on the event socket and reconnects', async () => {
    const runtime = tmp('runtime');
    mkdirSync(join(runtime, 'hypr', 'sig'), { recursive: true });
    const path = join(runtime, 'hypr', 'sig', '.socket2.sock');
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(path, r));
    const got: HyprEvent[] = [];
    const stop = hyprlandIpc({ HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_RUNTIME_DIR: runtime })!.events((e) => got.push(e));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.write('workspace>>2\nopenwindow>>ab12,2,firefox,Fire');
    sockets[0]!.write('fox\nclosewin');
    sockets[0]!.write('dow>>ab12\n');
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got).toEqual([
      { name: 'openwindow', address: '0xab12', className: 'firefox' },
      { name: 'closewindow', address: '0xab12' },
    ]);
    sockets[0]!.destroy();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3000 });
    stop();
    server.close();
  });
});

describe('chat window geometry', () => {
  it('puts half screen on the right, below the bar, in layout pixels', () => {
    // 2880x1800 at scale 1.5 is 1920x1200 in layout pixels; the bar takes 26 at the top.
    expect(halfRect(monitor())).toEqual({ x: 1920 - 12 - 942, y: 38, w: 942, h: 1200 - 26 - 24 });
    // A second monitor to the right, rotated.
    expect(halfRect(monitor({ x: 1920, transform: 1, scale: 1, width: 1920, height: 1080, reserved: [0, 0, 0, 0] }))).toMatchObject({ x: 1920 + 1080 - 12 - 522, y: 12 });
  });

  it('hides a fullscreen chat on its own special workspace, unpinned', () => {
    expect(dispatchesFor('hidden', chat(), monitor())).toEqual([
      'hl.dsp.window.fullscreen({ mode = "fullscreen", action = "unset", window = "address:0xabc123" })',
      'hl.dsp.window.move({ workspace = "special:aios", follow = false, window = "address:0xabc123" })',
    ]);
    expect(dispatchesFor('hidden', chat({ fullscreen: 0, floating: true, pinned: true }), monitor())).toEqual([
      'hl.dsp.window.pin({ action = "off", window = "address:0xabc123" })',
      'hl.dsp.window.move({ workspace = "special:aios", follow = false, window = "address:0xabc123" })',
    ]);
  });

  it('brings a hidden chat to the workspace in view: half screen with focus, or full screen', () => {
    const hidden = chat({ fullscreen: 0, workspace: { name: 'special:aios' } });
    expect(dispatchesFor('half', hidden, monitor())).toEqual([
      'hl.dsp.window.move({ workspace = "3", follow = false, window = "address:0xabc123" })',
      'hl.dsp.window.float({ action = "on", window = "address:0xabc123" })',
      'hl.dsp.window.resize({ x = 942, y = 1150, window = "address:0xabc123" })',
      'hl.dsp.window.move({ x = 966, y = 38, window = "address:0xabc123" })',
      'hl.dsp.window.pin({ action = "on", window = "address:0xabc123" })',
      'hl.dsp.window.alter_zorder({ mode = "top", window = "address:0xabc123" })',
      'hl.dsp.focus({ window = "address:0xabc123" })',
    ]);
    expect(dispatchesFor('full', chat({ fullscreen: 0, floating: true, pinned: true, workspace: { name: '3' } }), monitor())).toEqual([
      'hl.dsp.window.pin({ action = "off", window = "address:0xabc123" })',
      'hl.dsp.window.float({ action = "off", window = "address:0xabc123" })',
      'hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", window = "address:0xabc123" })',
      'hl.dsp.focus({ window = "address:0xabc123" })',
    ]);
    expect(dispatchesFor('full', hidden, monitor())[0]).toBe('hl.dsp.window.move({ workspace = "3", follow = false, window = "address:0xabc123" })');
  });

  it('never builds a dispatch around an address or workspace that is not one', () => {
    expect(() => dispatchesFor('hidden', chat({ address: '0x1" }) hl.exec_cmd("x' }), monitor())).toThrow(/bad window address/);
    expect(() => dispatchesFor('half', chat(), monitor({ activeWorkspace: { id: 1.5 } }))).toThrow(/bad workspace id/);
  });
});

/** A pretend Hyprland: one chat window and whatever the test opens; dispatches are recorded. */
class FakeHypr implements HyprIpc {
  dispatched: string[] = [];
  win = chat();
  refuse = false;
  private listener: ((e: HyprEvent) => void) | null = null;
  async clients() {
    return [this.win, chat({ address: '0xf00', class: 'firefox' })];
  }
  async monitors() {
    return [monitor()];
  }
  async dispatch(expr: string) {
    if (this.refuse) throw new Error('Hyprland refused hl.dsp.window.move: nope');
    this.dispatched.push(expr);
    if (expr.includes('float({ action = "on"')) this.win = { ...this.win, floating: true };
    if (expr.includes('float({ action = "off"')) this.win = { ...this.win, floating: false };
    if (expr.includes('pin({ action = "on"')) this.win = { ...this.win, pinned: true };
    if (expr.includes('pin({ action = "off"')) this.win = { ...this.win, pinned: false };
    if (expr.includes('action = "unset"') && expr.includes('fullscreen(')) this.win = { ...this.win, fullscreen: 0 };
    if (expr.includes('action = "set"') && expr.includes('fullscreen(')) this.win = { ...this.win, fullscreen: 2 };
    const ws = /move\(\{ workspace = "([^"]+)"/.exec(expr)?.[1];
    if (ws) this.win = { ...this.win, workspace: { name: ws } };
  }
  events(on: (e: HyprEvent) => void) {
    this.listener = on;
    return () => (this.listener = null);
  }
  emit(e: HyprEvent) {
    this.listener?.(e);
  }
}

function windowRig(hypr: FakeHypr | null = new FakeHypr()) {
  const dir = tmp('window');
  const auditPath = join(dir, 'audit.jsonl');
  const modes: WindowMode[] = [];
  const notices: string[] = [];
  const tray: boolean[] = [];
  const w = new ChatWindow({ hypr, audit: new AuditLog(auditPath), onMode: (m) => modes.push(m), notice: (_l, t) => notices.push(t), tray: { setVisible: (v) => void tray.push(v) }, openWindowMs: 200 });
  w.start();
  const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  // Lets queued window moves finish.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { w, hypr, modes, notices, tray, log, settle };
}

describe('chat window', () => {
  it('hides when an app starts, with the tray circle, and comes back full screen when that app closes', async () => {
    const { w, hypr, modes, tray, log, settle } = windowRig();
    await w.appStarting('Firefox');
    expect(w.mode).toBe('hidden');
    expect(hypr!.win).toMatchObject({ workspace: { name: 'special:aios' }, pinned: false, fullscreen: 0 });
    expect(tray).toEqual([true]);
    // The chat's own window events and windows nobody started don't count.
    hypr!.emit({ name: 'openwindow', address: '0xabc123', className: 'org.aios.home' });
    hypr!.emit({ name: 'openwindow', address: '0xf00', className: 'firefox' });
    hypr!.emit({ name: 'closewindow', address: '0xdead' });
    await settle();
    expect(w.mode).toBe('hidden');
    hypr!.emit({ name: 'closewindow', address: '0xf00' });
    await settle();
    expect(w.mode).toBe('full');
    expect(hypr!.win).toMatchObject({ workspace: { name: '3' }, floating: false, pinned: false, fullscreen: 2 });
    expect(modes).toEqual(['hidden', 'full']);
    expect(tray).toEqual([true, false]);
    expect(log()).toEqual([
      expect.objectContaining({ kind: 'window', from: 'full', to: 'hidden', reason: 'app_started', ok: true }),
      expect.objectContaining({ kind: 'window', from: 'hidden', to: 'full', reason: 'app_closed', app: 'Firefox', ok: true }),
    ]);
  });

  it('waits for the last app it started to close', async () => {
    const { w, hypr, settle } = windowRig();
    await w.appStarting('Firefox');
    hypr!.emit({ name: 'openwindow', address: '0x1', className: 'firefox' });
    await w.appStarting('Spotify');
    hypr!.emit({ name: 'openwindow', address: '0x2', className: 'spotify' });
    // A window the user opened themselves is not one of the chat's.
    hypr!.emit({ name: 'openwindow', address: '0x3', className: 'kitty' });
    hypr!.emit({ name: 'closewindow', address: '0x1' });
    await settle();
    expect(w.mode).toBe('hidden');
    hypr!.emit({ name: 'closewindow', address: '0x2' });
    await settle();
    expect(w.mode).toBe('full');
  });

  it('a click on the tray circle shows the chat at half screen and the next one hides it; Hide and Full screen work too', async () => {
    const { w, hypr, modes, tray, log } = windowRig();
    await w.trayClicked();
    expect(modes).toEqual([]);
    await w.appStarting('Firefox');
    await w.trayClicked();
    expect(w.mode).toBe('half');
    expect(hypr!.win).toMatchObject({ workspace: { name: '3' }, floating: true, pinned: true });
    expect(hypr!.dispatched.at(-1)).toBe('hl.dsp.focus({ window = "address:0xabc123" })');
    await w.trayClicked();
    expect(w.mode).toBe('hidden');
    await w.trayClicked();
    await w.request('hidden');
    await w.request('full');
    expect(modes).toEqual(['hidden', 'half', 'hidden', 'half', 'hidden', 'full']);
    // The circle stays while the chat is half screen, so it can hide it again.
    expect(tray).toEqual([true, true, true, true, true, false]);
    expect(log().map((l) => l.reason)).toEqual(['app_started', 'tray', 'tray', 'tray', 'user', 'user']);
  });

  it('comes back full screen when the app closes while the chat is half screen', async () => {
    const { w, hypr, settle } = windowRig();
    await w.appStarting('Firefox');
    hypr!.emit({ name: 'openwindow', address: '0x9', className: 'firefox' });
    await w.trayClicked();
    hypr!.emit({ name: 'closewindow', address: '0x9' });
    await settle();
    expect(w.mode).toBe('full');
  });

  it('comes back when the start failed, and stays hidden when an app opened no new window', async () => {
    const { w, hypr, settle } = windowRig();
    await w.appStarting('Broken');
    await w.appFailed('Broken');
    expect(w.mode).toBe('full');
    await w.appStarting('Spotify');
    await new Promise((r) => setTimeout(r, 250));
    // Too late to be Spotify's: a window opened after the wait belongs to nobody.
    hypr!.emit({ name: 'openwindow', address: '0x5', className: 'kitty' });
    hypr!.emit({ name: 'closewindow', address: '0x5' });
    await settle();
    expect(w.mode).toBe('hidden');
  });

  it('still shows the tray circle and says so when Hyprland refuses', async () => {
    const hypr = new FakeHypr();
    hypr.refuse = true;
    const { w, modes, tray, notices, log } = windowRig(hypr);
    await w.appStarting('Firefox');
    expect(modes).toEqual(['hidden']);
    expect(tray).toEqual([true]);
    expect(notices).toEqual(["I couldn't move the chat window: Hyprland refused hl.dsp.window.move: nope"]);
    expect(log()[0]).toMatchObject({ ok: false, error: 'Hyprland refused hl.dsp.window.move: nope' });
  });

  it('stays full screen outside Hyprland, where nothing can move', async () => {
    const { w, modes, tray } = windowRig(null);
    await w.appStarting('Firefox');
    await w.trayClicked();
    await w.request('half');
    expect(w.mode).toBe('full');
    expect(modes).toEqual([]);
    expect(tray).toEqual([]);
  });
});

describe('app tools', () => {
  const APPS: DesktopApp[] = [
    { id: 'firefox.desktop', name: 'Firefox', comment: 'Browse the web', keywords: ['internet'], categories: ['WebBrowser'], terminal: false },
    { id: 'btop.desktop', name: 'btop', comment: 'Resource monitor', keywords: [], categories: ['System'], terminal: true },
    { id: 'org.gnome.Nautilus.desktop', name: 'Files', comment: '', keywords: [], categories: [], terminal: false },
    { id: 'files-2.desktop', name: 'Files', comment: '', keywords: [], categories: [], terminal: false },
  ];

  function rig(o: { failLaunch?: boolean } = {}) {
    const dir = tmp('apptools');
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const store = new Store(':memory:');
    const launched: string[] = [];
    const steps: string[] = [];
    let paused = false;
    const apps = appTools({
      scan: async () => APPS,
      launch: async (id) => {
        steps.push(`launch ${id}`);
        if (o.failLaunch) throw new Error('gtk-launch could not start it (exit code 1)');
        launched.push(id);
      },
      window: { appStarting: async (n) => void steps.push(`hide for ${n}`), appFailed: async (n) => void steps.push(`back from ${n}`) },
    });
    const shown: ChatItem[] = [];
    const run: Run = async () => ({ stdout: '', code: 0 });
    const actions = new SystemActions({ store, controls: new SystemControls(run), audit, show: (i, isNew) => (isNew ? shown.push(i) : shown.splice(shown.findIndex((x) => x.id === i.id), 1, i)), notice: () => undefined, isPaused: () => paused });
    const tools = new ToolRegistry(audit, { isPaused: () => paused });
    for (const t of systemTools({ controls: new SystemControls(run), actions, extra: apps })) tools.register(t);
    const call = (name: string, args: unknown, untrustedInContext = false) =>
      tools.execute({ id: name, name, arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'open it' });
    const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
    return { tools, call, launched, steps, log, cards, actions, setPaused: (p: boolean) => (paused = p) };
  }

  it('lists installed apps with the ids open_app takes, narrowed by a query', async () => {
    const { call } = rig();
    expect((await call('apps_list', {})).content).toBe(
      '4 apps installed:\n- Firefox (id: firefox): Browse the web\n- btop (id: btop), runs in a terminal: Resource monitor\n- Files (id: org.gnome.Nautilus)\n- Files (id: files-2)',
    );
    expect((await call('apps_list', { query: 'browser' })).content).toBe('1 app matching “browser”:\n- Firefox (id: firefox): Browse the web');
    expect((await call('apps_list', { query: 'spreadsheet' })).content).toMatch(/^No installed app matches “spreadsheet”/);
  });

  it('moves the chat aside first, then starts the app by its id, and audits it', async () => {
    const { call, launched, steps, log } = rig();
    const r = await call('open_app', { app: 'Firefox' });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^Started Firefox\. The chat is now out of the way, with a red circle in the bar's tray/);
    expect(steps).toEqual(['hide for Firefox', 'launch firefox.desktop']);
    expect(launched).toEqual(['firefox.desktop']);
    expect(log().at(-1)).toMatchObject({ kind: 'tool', tool: 'open_app', tier: 'device', decision: 'allowed', ok: true, app: 'firefox.desktop', name: 'Firefox' });
  });

  it('brings the chat back and says why when the app fails to start', async () => {
    const { call, steps } = rig({ failLaunch: true });
    const r = await call('open_app', { app: 'firefox' });
    expect(r).toMatchObject({ ok: false, content: "Error: Firefox didn't start: gtk-launch could not start it (exit code 1)" });
    expect(steps).toEqual(['hide for Firefox', 'launch firefox.desktop', 'back from Firefox']);
  });

  it('starts nothing for an unknown or ambiguous app, and takes no command, file or link', async () => {
    const { call, launched, steps } = rig();
    expect((await call('open_app', { app: 'firefox --new-window https://evil.example' })).content).toMatch(/no installed app is called/);
    expect((await call('open_app', { app: 'files' })).content).toBe('Error: several apps are called “files”: org.gnome.Nautilus, files-2. Ask the user which one, then use its id.');
    for (const args of [{ app: 'firefox', url: 'https://evil.example' }, { app: 'firefox', args: ['--private'] }, { command: 'rm -rf ~' }]) {
      expect((await call('open_app', args)).content).toMatch(/^Error: invalid arguments/);
    }
    expect(launched).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('while an email is in view it only asks with a card; paused refuses it', async () => {
    const { tools, call, launched, steps, cards, actions, setPaused, log } = rig();
    expect(tools.specs({ untrustedInContext: true }).map((t) => t.name)).toEqual(expect.arrayContaining(['apps_list', 'open_app']));
    const r = await call('open_app', { app: 'firefox' }, true);
    expect(r.content).toMatch(/card now asks the user to confirm/);
    expect(launched).toEqual([]);
    expect(steps).toEqual([]);
    expect(cards()[0]).toMatchObject({ state: 'pending', confirm: 'Do it', title: "Open “firefox”? This was asked for while I was reading an email, so I'm checking with you first." });
    expect(log().at(-1)).toMatchObject({ tool: 'open_app', decision: 'proposed', untrustedInContext: true });
    setPaused(true);
    expect((await call('open_app', { app: 'firefox' })).content).toMatch(/paused/);
    expect(await actions.confirm(cards()[0]!.id, cards()[0]!.hash)).toBe('refused');
    setPaused(false);
    expect(await actions.confirm(cards()[0]!.id, cards()[0]!.hash)).toBe('done');
    expect(launched).toEqual(['firefox.desktop']);
  });

  it('is rate limited with the other device changes', async () => {
    const { call, launched } = rig();
    for (let i = 0; i < 10; i++) await call('open_app', { app: 'btop' });
    expect((await call('open_app', { app: 'btop' })).content).toMatch(/more than 10 changes in a minute/);
    expect(launched).toHaveLength(10);
  });
});

describe('shell and the chat window', () => {
  it('tells a new UI where the window is, and passes Hide, Full screen and Esc to the window', async () => {
    const requests: WindowMode[] = [];
    let mode: WindowMode = 'hidden';
    const model = {
      async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
        throw new Error('not used');
      },
    };
    const store = new Store(':memory:');
    const shell = new Shell({
      store,
      model,
      tools: new ToolRegistry(new AuditLog(join(tmp('shell'), 'a.jsonl'))),
      audit: new AuditLog(join(tmp('shell'), 'b.jsonl')),
      userName: 'John',
      timeZone: 'UTC',
      modelName: 'm',
      costCapUsd: 1,
      readBattery: async () => null,
      readWifi: async () => null,
      chatWindow: {
        get mode() {
          return mode;
        },
        request: async (m) => void requests.push((mode = m)),
      },
    });
    const events: ServerEvent[] = [];
    shell.subscribe((e) => events.push(e));
    expect(events[0]).toMatchObject({ type: 'hello', window: 'hidden' });
    store.setSetting('paused', '1');
    // The user's own click, so it works while paused.
    await shell.handle({ type: 'window', mode: 'half' });
    expect(requests).toEqual(['half']);
  });
});
