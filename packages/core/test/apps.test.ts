import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it, vi } from 'vitest';
import { type DesktopApp, appFromEntry, findApp, parseDesktopEntry, scanApps, searchApps } from '../src/apps/desktop.js';
import { type HyprClient, type HyprEvent, type HyprIpc, type HyprMonitor, hyprlandIpc, parseHyprEvent } from '../src/apps/hyprland.js';
import { createLauncher } from '../src/apps/launcher.js';
import { appTools } from '../src/apps/tools.js';
import { UnseenFlag, unseenPath } from '../src/apps/bar.js';
import { type AppsAt, ChatWindow, type ScreenInfo, appTarget, focusDispatch, homeMonitor, moveDispatches, positionOf, restoreDispatches } from '../src/apps/window.js';
import { AuditLog } from '../src/audit.js';
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

const monitor = (over: Partial<HyprMonitor> = {}): HyprMonitor => ({ id: 0, name: 'eDP-1', disabled: false, width: 2880, height: 1800, x: 0, y: 0, scale: 1.5, transform: 0, focused: true, reserved: [0, 26, 0, 0], ...over });
const chat = (over: Partial<HyprClient> = {}): HyprClient => ({ address: '0xabc123', class: 'org.aios.home', floating: false, pinned: false, fullscreen: 2, monitor: 0, ...over });

describe('Hyprland', () => {
  it('parses the window events it needs', () => {
    expect(parseHyprEvent('openwindow>>55d0c1f4a2b0,1,firefox,Mozilla Firefox, with commas')).toEqual({ name: 'openwindow', address: '0x55d0c1f4a2b0', className: 'firefox' });
    expect(parseHyprEvent('closewindow>>55d0c1f4a2b0')).toEqual({ name: 'closewindow', address: '0x55d0c1f4a2b0' });
    expect(parseHyprEvent('activewindowv2>>55d0c1f4a2b0')).toEqual({ name: 'activewindow', address: '0x55d0c1f4a2b0' });
    expect(parseHyprEvent('activewindowv2>>')).toEqual({ name: 'activewindow', address: '' });
    expect(parseHyprEvent('monitoraddedv2>>1,DP-2,Dell')).toEqual({ name: 'monitors' });
    expect(parseHyprEvent('monitorremovedv2>>1,DP-2,Dell')).toEqual({ name: 'monitors' });
    for (const l of ['activewindow>>firefox,x', 'closewindow>>zz; rm', 'openwindow>>,1,x,y', 'workspacev2>>2,2', 'nonsense']) expect(parseHyprEvent(l)).toBeNull();
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

describe('app tools', () => {
  const APPS: DesktopApp[] = [
    { id: 'firefox.desktop', name: 'Firefox', comment: 'Browse the web', keywords: ['internet'], categories: ['WebBrowser'], terminal: false },
    { id: 'btop.desktop', name: 'btop', comment: 'Resource monitor', keywords: [], categories: ['System'], terminal: true },
    { id: 'org.gnome.Nautilus.desktop', name: 'Files', comment: '', keywords: [], categories: [], terminal: false },
    { id: 'files-2.desktop', name: 'Files', comment: '', keywords: [], categories: [], terminal: false },
  ];

  function rig(o: { failLaunch?: boolean; screens?: ScreenInfo[] } = {}) {
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
      window: {
        appStarting: async (n, at) => {
          steps.push(`workspace 2 for ${n}`);
          return at;
        },
        appFailed: async (n) => void steps.push(`back from ${n}`),
        target: async () => ({ workspace: 2 }),
        screens: async () => o.screens ?? [],
        moveApp: async () => 'x',
      },
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

  it('focuses where the app should open first, then starts it by its id, and audits it', async () => {
    const { call, launched, steps, log } = rig();
    const r = await call('open_app', { app: 'Firefox' });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^Started Firefox on workspace 2, next to the chat's own, and switched the screen there; Super\+Shift\+H/);
    expect(steps).toEqual(['workspace 2 for Firefox', 'launch firefox.desktop']);
    expect(launched).toEqual(['firefox.desktop']);
    expect(log().at(-1)).toMatchObject({ kind: 'tool', tool: 'open_app', tier: 'device', decision: 'allowed', ok: true, app: 'firefox.desktop', name: 'Firefox', workspace: 2 });
  });

  it('brings the chat back and says why when the app fails to start', async () => {
    const { call, steps } = rig({ failLaunch: true });
    const r = await call('open_app', { app: 'firefox' });
    expect(r).toMatchObject({ ok: false, content: "Error: Firefox didn't start: gtk-launch could not start it (exit code 1)" });
    expect(steps).toEqual(['workspace 2 for Firefox', 'launch firefox.desktop', 'back from Firefox']);
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
    expect(cards()[0]).toMatchObject({ state: 'pending', confirm: 'Do it', title: "Open “firefox”? This was asked for while I was reading an email or document, so I'm checking with you first." });
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


// ── S7: the chat keeps its own full screen; apps open elsewhere ──

/** A pretend Hyprland: the chat and whatever the test opens; dispatches are recorded and applied. */
class FakeHypr implements HyprIpc {
  dispatched: string[] = [];
  windows: HyprClient[] = [chat({ workspace: ws(1) })];
  mons: HyprMonitor[] = [monitor()];
  refuse = false;
  private listener: ((e: HyprEvent) => void) | null = null;
  window(address: string): HyprClient | undefined {
    return this.windows.find((c) => c.address === address);
  }
  async clients() {
    return this.windows;
  }
  async monitors() {
    return this.mons;
  }
  async dispatch(expr: string) {
    if (this.refuse) throw new Error('Hyprland refused hl.dsp.focus: nope');
    this.dispatched.push(expr);
    const addr = /address:(0x[0-9a-f]+)/.exec(expr)?.[1];
    const i = this.windows.findIndex((c) => c.address === addr);
    if (i < 0) return;
    const set = (p: Partial<HyprClient>) => (this.windows[i] = { ...this.windows[i]!, ...p });
    if (expr.includes('float({ action = "off"')) set({ floating: false });
    if (expr.includes('pin({ action = "off"')) set({ pinned: false });
    if (expr.includes('action = "set"') && expr.includes('fullscreen(')) set({ fullscreen: 2 });
    const to = this.mons.find((m) => m.name === /move\(\{ monitor = "([^"]+)"/.exec(expr)?.[1]);
    if (to) set({ monitor: to.id, workspace: to.activeWorkspace?.id !== undefined ? ws(to.activeWorkspace.id) : undefined });
    const n = /move\(\{ workspace = "(\d+)"/.exec(expr)?.[1];
    if (n) set({ workspace: ws(Number(n)) });
  }
  events(on: (e: HyprEvent) => void) {
    this.listener = on;
    return () => (this.listener = null);
  }
  emit(e: HyprEvent) {
    this.listener?.(e);
  }
  /** A window opens: added, then announced, as Hyprland does. */
  open(c: Partial<HyprClient>): HyprClient {
    const w = chat({ address: '0xf00', class: 'kitty', fullscreen: 0, workspace: ws(1), ...c });
    this.windows.push(w);
    this.emit({ name: 'openwindow', address: w.address, className: w.class });
    return w;
  }
}

function ws(id: number) {
  return { id, name: String(id) };
}

/** The laptop (eDP-1, 1920×1200 in layout pixels) with a 2560×1440 screen to its right and one to its left. */
const laptop = monitor({ activeWorkspace: ws(1) });
const right = monitor({ id: 1, name: 'DP-2', x: 1920, width: 2560, height: 1440, scale: 1, focused: false, reserved: [0, 0, 0, 0], activeWorkspace: ws(11) });
const left = monitor({ id: 2, name: 'HDMI-A-1', x: -1920, width: 1920, height: 1080, scale: 1, focused: false, reserved: [0, 0, 0, 0], activeWorkspace: ws(21) });

function windowRig(hypr: FakeHypr | null = new FakeHypr(), home = '') {
  const dir = tmp('window');
  const auditPath = join(dir, 'audit.jsonl');
  const notices: string[] = [];
  const focus: boolean[] = [];
  const appsAt: AppsAt[] = [];
  const w = new ChatWindow({ hypr, home, audit: new AuditLog(auditPath), notice: (_l, t) => notices.push(t), onFocus: (f) => focus.push(f), onAppsAt: (a) => appsAt.push(a) });
  w.start();
  const log = () => {
    try {
      return readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  // Lets queued window moves finish.
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  return { w, hypr, notices, focus, appsAt, log, settle };
}

const twoScreens = () => {
  const h = new FakeHypr();
  h.mons = [laptop, right];
  return h;
};

describe('S7: where things go', () => {
  it('sends apps to the first other screen, else the workspace after the chat’s', () => {
    expect(appTarget(chat({ workspace: ws(1) }), [laptop, right, left])).toEqual({ screen: 'HDMI-A-1' });
    expect(appTarget(chat({ workspace: ws(1) }), [laptop, right])).toEqual({ screen: 'DP-2' });
    expect(appTarget(chat({ workspace: ws(1) }), [laptop, { ...right, disabled: true }])).toEqual({ workspace: 2 });
    // Omarchy 4: the second screen's workspaces are 11-20, so the chat there is followed by 12.
    expect(appTarget(chat({ workspace: ws(11), monitor: 1 }), [{ ...right, focused: true }])).toEqual({ workspace: 12 });
    expect(appTarget(undefined, [laptop])).toEqual({ workspace: 2 });
    expect(appTarget(chat({ workspace: { id: -98, name: 'special:x' } }), [laptop])).toEqual({ workspace: 2 });
    // The configured home screen is the chat's, even when the chat is elsewhere for now.
    expect(appTarget(chat({ monitor: 1, workspace: ws(11) }), [laptop, right], 'DP-2')).toEqual({ screen: 'eDP-1' });
  });

  it('tells where a screen is, and picks the configured one, else the chat’s, the focused one, the first', () => {
    expect(positionOf(laptop, right)).toBe('right');
    expect(positionOf(laptop, left)).toBe('left');
    expect(positionOf(laptop, monitor({ id: 3, name: 'DP-3', y: -1440 }))).toBe('above');
    const mons = [laptop, right, left];
    expect(homeMonitor(mons, chat({ monitor: 2 }), 'DP-2')).toBe(right);
    expect(homeMonitor(mons, chat({ monitor: 2 }), 'DP-9')).toBe(left);
    expect(homeMonitor(mons, undefined)).toBe(laptop);
    expect(homeMonitor([{ ...right, disabled: true }, left], chat({ monitor: 1 }), 'DP-2')).toBe(left);
  });

  it('focuses a screen or a workspace, and moves a window there and follows it', () => {
    expect(focusDispatch({ screen: 'DP-2' })).toBe('hl.dsp.focus({ monitor = "DP-2" })');
    expect(focusDispatch({ workspace: 2 })).toBe('hl.dsp.focus({ workspace = "2" })');
    const kitty = chat({ address: '0xf00', class: 'kitty' });
    expect(moveDispatches(kitty, { screen: 'DP-2' })).toEqual(['hl.dsp.window.move({ monitor = "DP-2", follow = true, window = "address:0xf00" })', 'hl.dsp.focus({ window = "address:0xf00" })']);
    expect(moveDispatches(kitty, { workspace: 2 })).toEqual(['hl.dsp.window.move({ workspace = "2", follow = true, window = "address:0xf00" })', 'hl.dsp.focus({ window = "address:0xf00" })']);
  });

  it('puts an orb or half-screen chat left by an older version back to full screen on its own screen', () => {
    expect(restoreDispatches(chat(), laptop)).toEqual([]);
    expect(restoreDispatches(chat({ floating: true, pinned: true, fullscreen: 0, monitor: 1 }), laptop)).toEqual([
      'hl.dsp.window.move({ monitor = "eDP-1", window = "address:0xabc123" })',
      'hl.dsp.window.pin({ action = "off", window = "address:0xabc123" })',
      'hl.dsp.window.set_prop({ prop = "rounding", value = "unset", window = "address:0xabc123" })',
      'hl.dsp.window.set_prop({ prop = "border_size", value = "unset", window = "address:0xabc123" })',
      'hl.dsp.window.set_prop({ prop = "no_shadow", value = "unset", window = "address:0xabc123" })',
      'hl.dsp.window.set_prop({ prop = "no_blur", value = "unset", window = "address:0xabc123" })',
      'hl.dsp.window.float({ action = "off", window = "address:0xabc123" })',
      'hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", window = "address:0xabc123" })',
    ]);
  });

  it('never builds a dispatch around an address, monitor name or workspace that is not one', () => {
    expect(() => focusDispatch({ screen: 'DP-2" }) hl.exec_cmd("x' })).toThrow(/bad monitor name/);
    expect(() => focusDispatch({ workspace: 0 })).toThrow(/bad workspace/);
    expect(() => focusDispatch({ workspace: 1.5 })).toThrow(/bad workspace/);
    expect(() => moveDispatches(chat({ address: '0xabc" }) x' }), { workspace: 2 })).toThrow(/bad window address/);
    expect(() => restoreDispatches(chat({ monitor: 1 }), { ...laptop, name: 'eDP-1"; x' })).toThrow(/bad monitor name/);
  });
});

describe('S7: the chat window', () => {
  it('restores the chat to full screen at start, and tells where apps go', async () => {
    const h = twoScreens();
    h.windows = [chat({ floating: true, pinned: true, fullscreen: 0, workspace: ws(1) })];
    const { settle, appsAt, w } = windowRig(h);
    await settle();
    expect(h.windows[0]).toMatchObject({ floating: false, pinned: false, fullscreen: 2 });
    expect(appsAt).toEqual(['screen']);
    expect(w.appsAt).toBe('screen');
    h.mons = [laptop];
    h.emit({ name: 'monitors' });
    await settle();
    expect(appsAt).toEqual(['screen', 'workspace']);
  });

  it('with two screens, opens an app on the other one and leaves the chat where it is', async () => {
    const { w, hypr, log, settle } = windowRig(twoScreens());
    await settle();
    expect(await w.appStarting('Firefox')).toEqual({ screen: 'DP-2' });
    expect(hypr!.dispatched).toEqual(['hl.dsp.focus({ monitor = "DP-2" })']);
    hypr!.open({ address: '0xf00', class: 'firefox', monitor: 1, workspace: ws(11) });
    await settle();
    expect(hypr!.dispatched).toHaveLength(1);
    expect(hypr!.window('0xabc123')).toMatchObject({ fullscreen: 2, workspace: ws(1) });
    expect(log().find((e) => e.step === 'open there')).toMatchObject({ kind: 'window', app: 'Firefox', screen: 'DP-2', ok: true });
    expect((await w.screens())[1]!.windows).toEqual([{ address: '0xf00', className: 'firefox', app: 'Firefox' }]);
  });

  it('with one screen, opens an app on the next workspace and switches there', async () => {
    const { w, hypr, settle } = windowRig();
    await settle();
    expect(await w.appStarting('Firefox')).toEqual({ workspace: 2 });
    expect(hypr!.dispatched).toEqual(['hl.dsp.focus({ workspace = "2" })']);
    hypr!.open({ class: 'firefox', workspace: ws(2) });
    await settle();
    expect(hypr!.dispatched).toHaveLength(1);
  });

  it('moves a tiled window that lands on the chat’s workspace to where apps go, and follows it', async () => {
    const one = windowRig();
    await one.settle();
    one.hypr!.open({ class: 'kitty' });
    await one.settle();
    expect(one.hypr!.dispatched).toEqual(['hl.dsp.window.move({ workspace = "2", follow = true, window = "address:0xf00" })', 'hl.dsp.focus({ window = "address:0xf00" })']);
    expect(one.hypr!.window('0xf00')!.workspace).toEqual(ws(2));
    const two = windowRig(twoScreens());
    await two.settle();
    two.hypr!.open({ class: 'kitty' });
    await two.settle();
    expect(two.hypr!.dispatched[0]).toBe('hl.dsp.window.move({ monitor = "DP-2", follow = true, window = "address:0xf00" })');
    expect(two.hypr!.window('0xf00')).toMatchObject({ monitor: 1, workspace: ws(11) });
  });

  it('also moves an app the chat started that was slow and opened after the user came back', async () => {
    const { w, hypr, settle } = windowRig();
    await settle();
    await w.appStarting('GridCraft');
    hypr!.open({ class: 'gridcraft', workspace: ws(1) });
    await settle();
    expect(hypr!.window('0xf00')!.workspace).toEqual(ws(2));
    expect((await w.screens())[0]!.windows[0]).toMatchObject({ app: 'GridCraft' });
  });

  it('leaves dialogs, other workspaces, special workspaces and the chat itself alone', async () => {
    const { hypr, settle } = windowRig();
    await settle();
    hypr!.open({ address: '0x1', floating: true });
    hypr!.open({ address: '0x2', workspace: ws(3) });
    hypr!.open({ address: '0x3', workspace: { id: -98, name: 'special:scratch' } });
    hypr!.windows.push(chat({ address: '0x4', workspace: ws(1) }));
    hypr!.emit({ name: 'openwindow', address: '0x4', className: 'org.aios.home' });
    await settle();
    expect(hypr!.dispatched).toEqual([]);
  });

  it('brings the chat forward for a Change card and after a failed start', async () => {
    const { w, hypr, settle } = windowRig();
    await settle();
    await w.bringForward('Snake');
    await w.appStarting('Firefox');
    await w.appFailed('Firefox');
    expect(hypr!.dispatched).toEqual(['hl.dsp.focus({ window = "address:0xabc123" })', 'hl.dsp.focus({ workspace = "2" })', 'hl.dsp.focus({ window = "address:0xabc123" })']);
  });

  it('finds a named screen by name or side, and never offers the chat’s own', async () => {
    const h = twoScreens();
    h.mons = [laptop, right, left];
    const { w } = windowRig(h);
    expect(await w.target()).toEqual({ screen: 'HDMI-A-1' });
    expect(await w.target('dp-2')).toEqual({ screen: 'DP-2' });
    expect(await w.target('left')).toEqual({ screen: 'HDMI-A-1' });
    expect(await w.target('other')).toEqual({ screen: 'HDMI-A-1' });
    expect(await w.target('eDP-1')).toMatch(/^Error: eDP-1 is the chat's own screen and nothing else opens there/);
    expect(await w.target('here')).toMatch(/^Error: eDP-1 is the chat's own screen/);
    expect(await w.target('above')).toMatch(/^Error: no screen is called "above"\. The other screens are: HDMI-A-1 \(left\), DP-2 \(right\)\./);
    expect(await windowRig().w.target('right')).toMatch(/^Error: only one screen is connected \(eDP-1\)/);
  });

  it('moves an open app to another screen by the name it was started under or its class', async () => {
    const h = twoScreens();
    h.windows.push(chat({ address: '0xf00', class: 'spotify', fullscreen: 0, workspace: ws(2), focusHistoryID: 3 }));
    const { w, settle } = windowRig(h);
    await settle();
    expect(await w.moveApp({ names: ['Spotify'], classes: ['spotify'] }, { screen: 'DP-2' })).toBe('Spotify');
    expect(h.window('0xf00')!.monitor).toBe(1);
    await expect(w.moveApp({ names: ['Firefox'], classes: ['firefox'] }, { screen: 'DP-2' })).rejects.toThrow(/no window of that app is open/);
  });

  it('tracks whether the chat has focus', async () => {
    const { hypr, focus, w, settle } = windowRig();
    hypr!.emit({ name: 'activewindow', address: '0xf00' });
    await settle();
    expect(w.focused).toBe(false);
    hypr!.emit({ name: 'activewindow', address: '0xabc123' });
    await settle();
    hypr!.emit({ name: 'activewindow', address: '0xabc123' });
    await settle();
    expect(focus).toEqual([false, true]);
  });

  it('lists the screens and what is open on each, by class, without titles', async () => {
    const h = twoScreens();
    h.windows.push(chat({ address: '0xf00', class: 'firefox', monitor: 1, title: 'Bank – secret' } as Partial<HyprClient>));
    const s = await windowRig(h).w.screens();
    expect(s).toEqual([
      { name: 'eDP-1', home: true, focused: true, w: 1920, h: 1174, position: null, windows: [] },
      { name: 'DP-2', home: false, focused: false, w: 2560, h: 1440, position: 'right', windows: [{ address: '0xf00', className: 'firefox' }] },
    ]);
  });

  it('says so when Hyprland refuses, and outside Hyprland nothing moves', async () => {
    const h = new FakeHypr();
    h.refuse = true;
    const { w, notices, log, settle } = windowRig(h);
    await settle();
    await w.appStarting('Firefox');
    expect(notices.at(-1)).toBe("I couldn't move Firefox's window: Hyprland refused hl.dsp.focus: nope");
    expect(log().at(-1)).toMatchObject({ kind: 'window', app: 'Firefox', ok: false });
    const none = windowRig(null);
    expect(await none.w.appStarting('Firefox')).toBeUndefined();
    await none.w.bringForward('Snake');
    expect(await none.w.screens()).toEqual([]);
    expect(none.notices).toEqual([]);
  });
});

describe('S7: screens tools', () => {
  const APPS: DesktopApp[] = [
    { id: 'firefox.desktop', name: 'Firefox', comment: '', keywords: [], categories: [], terminal: false },
    { id: 'spotify.desktop', name: 'Spotify', comment: '', keywords: [], categories: [], terminal: false },
  ];
  function rig(screens: ScreenInfo[] = []) {
    const audit = new AuditLog(join(tmp('screens'), 'audit.jsonl'));
    const steps: string[] = [];
    const tools = new ToolRegistry(audit, { isPaused: () => false });
    const shown: ChatItem[] = [];
    const run: Run = async () => ({ stdout: '', code: 0 });
    const actions = new SystemActions({ store: new Store(':memory:'), controls: new SystemControls(run), audit, show: (i) => shown.push(i), notice: () => undefined, isPaused: () => false });
    const apps = appTools({
      scan: async () => APPS,
      launch: async (id) => void steps.push(`launch ${id}`),
      window: {
        appStarting: async (n, at) => {
          steps.push(`${at && 'screen' in at ? at.screen : 'default'} ${n}`);
          return at;
        },
        appFailed: async () => undefined,
        target: async (screen) => (screen === 'nowhere' ? 'Error: no screen is called "nowhere".' : { screen: screen === 'other' || !screen ? 'DP-2' : screen }),
        screens: async () => screens,
        moveApp: async (m, to) => {
          if (!m.classes.includes('spotify')) throw new Error('no window of that app is open');
          steps.push(`move ${m.names.join('|')} ${m.classes.join('|')} ${'screen' in to ? to.screen : ''}`);
          return 'Spotify';
        },
      },
    });
    for (const t of systemTools({ controls: new SystemControls(run), actions, extra: apps })) tools.register(t);
    const call = (name: string, args: unknown, untrustedInContext = false) =>
      tools.execute({ id: name, name, arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'x' });
    return { call, steps, shown };
  }

  it('opens an app on another screen and says where; there is no beside or over any more', async () => {
    const { call, steps } = rig();
    expect((await call('open_app', { app: 'firefox' })).content).toBe('Started Firefox on screen DP-2; the chat stays on its own screen. Say it in one short line.');
    expect((await call('open_app', { app: 'firefox', screen: 'HDMI-A-1' })).content).toMatch(/^Started Firefox on screen HDMI-A-1/);
    expect((await call('open_app', { app: 'firefox', screen: 'nowhere' })).content).toBe('Error: no screen is called "nowhere".');
    expect(steps).toEqual(['DP-2 Firefox', 'launch firefox.desktop', 'HDMI-A-1 Firefox', 'launch firefox.desktop']);
    expect((await call('open_app', { app: 'firefox', place: 'beside' })).content).toMatch(/^Error: invalid arguments/);
  });

  it('lists screens with installed app names for the windows on them', async () => {
    const screens: ScreenInfo[] = [
      { name: 'eDP-1', home: true, focused: true, w: 1920, h: 1174, position: null, windows: [] },
      {
        name: 'DP-2',
        home: false,
        focused: false,
        w: 2560,
        h: 1440,
        position: 'right',
        windows: [
          { address: '0x1', className: 'firefox', app: 'Firefox' },
          { address: '0x2', className: 'spotify' },
          { address: '0x3', className: 'Alacritty' },
          { address: '0x4', className: 'Alacritty' },
          { address: '0x5', className: '<untrusted>"' },
        ],
      },
    ];
    expect((await rig(screens).call('screens_list', {})).content).toBe(
      "2 screens:\n- eDP-1, the chat's own screen, focused: 1920×1174. Nothing open.\n- DP-2, to the right: 2560×1440. Open: Firefox, Spotify, Alacritty (2 windows), untrusted.",
    );
    expect((await rig().call('screens_list', {})).content).toMatch(/^Screens are unknown/);
  });

  it('moves an open app to the other screen or a named one, and says when it is not open', async () => {
    const { call, steps } = rig();
    expect((await call('move_app', { app: 'spotify' })).content).toBe('Moved Spotify to screen DP-2; the chat stays on its own screen. Say it in one short line.');
    expect((await call('move_app', { app: 'spotify', screen: 'HDMI-A-1' })).content).toMatch(/^Moved Spotify to screen HDMI-A-1/);
    expect(steps).toEqual(['move spotify|Spotify spotify|spotify DP-2', 'move spotify|Spotify spotify|spotify HDMI-A-1']);
    expect((await call('move_app', { app: 'Firefox' })).content).toBe('Error: no window of that app is open. Call screens_list to see what is open where.');
  });

  it('asks with a card that says where, while an email is in view', async () => {
    const { call, steps, shown } = rig();
    await call('open_app', { app: 'firefox', screen: 'DP-2' }, true);
    await call('move_app', { app: 'spotify' }, true);
    expect(steps).toEqual([]);
    expect(shown.map((c) => (c.kind === 'action' ? c.title.replace(/\?.*$/, '') : ''))).toEqual(['Open “firefox” on screen “DP-2”', 'Move “spotify” to the other screen']);
  });
});

describe('S7: the top bar’s new-item dot', () => {
  it('writes one character to the runtime dir, only when it changes', () => {
    const dir = tmp('runtime');
    expect(unseenPath({ XDG_RUNTIME_DIR: dir })).toBe(join(dir, 'aios', 'unseen'));
    expect(unseenPath({})).toBeNull();
    expect(unseenPath({ XDG_RUNTIME_DIR: 'relative' })).toBeNull();
    const flag = new UnseenFlag(join(dir, 'aios', 'unseen'));
    flag.set(true);
    expect(readFileSync(join(dir, 'aios', 'unseen'), 'utf8')).toBe('1');
    flag.set(false);
    expect(readFileSync(join(dir, 'aios', 'unseen'), 'utf8')).toBe('0');
    expect(() => new UnseenFlag(null).set(true)).not.toThrow();
  });
});
