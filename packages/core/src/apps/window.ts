/**
 * Where the chat window sits (S3). Core drives it through Hyprland, so the UI only asks:
 *
 *   full ──an app starts──▶ orb ──orb clicked──▶ half ──"back to orb" / Esc──▶ orb
 *     ▲                      │                    │
 *     └─the last app the chat started has closed──┴──────── "full screen" ──▶ full
 *
 * The orb is the chat window itself, shrunk to a small circle pinned at the top centre
 * of the screen, above every workspace. Half is the right half of the screen, pinned and
 * floating over the app. Full is the kiosk's own fullscreen.
 *
 * Which apps "the chat started" is decided by Hyprland's openwindow events: the first
 * new window after a start belongs to it. When the last of those closes, the chat comes
 * back full screen. An app that opens no new window (one that was already running and
 * only raised itself) leaves the chat as the orb.
 *
 * S6 makes one screen the chat's own (the home screen: config [screen] monitor, else the one
 * the chat is on) and lets an app open in one of three places:
 *
 *   over    on the home screen; the chat becomes the orb, as above.
 *   beside  the home screen is split: the chat floats on the left half ("side"), and the
 *           app's first window is floated onto the right half when it opens.
 *   screen  on another screen: that screen is focused before the start, so the app opens
 *           there, and its window is moved there if it opened elsewhere. The chat stays put.
 *
 * Only apps over or beside the chat bring it back full screen when they close. Windows
 * already open can be moved between the three places too (moveApp).
 */
import { type AppPlace, type WindowMode, CHAT_CLASS_PATTERN, MONITOR_NAME } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { HyprClient, HyprEvent, HyprIpc, HyprMonitor } from './hyprland.js';

const CHAT_CLASS = new RegExp(CHAT_CLASS_PATTERN);
export const ORB_SIZE = 56;
const GAP = 12;
/** How long after a start its first window still counts as that app's. */
const OPEN_WINDOW_MS = 20_000;

export interface ChatWindowOptions {
  /** Null outside Hyprland: nothing can move, so the chat stays full screen. */
  hypr: HyprIpc | null;
  /** S6: the monitor the chat owns (config [screen] monitor); empty for the one it is on. */
  home?: string;
  /** S6: where an app opens when the user didn't say. auto: another screen if there is one, else over. */
  defaultPlace?: AppPlace | 'auto';
  /**
   * S6 keep: the chat never gives up its screen. It never becomes the orb (apps go to another
   * screen, or beside it with one screen), windows that open on its screen are moved off it,
   * and with two or more screens, a workspace switched onto its screen moves to another one.
   */
  keep?: boolean;
  audit: AuditLog;
  onMode: (mode: WindowMode) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  openWindowMs?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The monitor's usable area in layout coordinates (what move and resize take). */
export function usableArea(m: HyprMonitor): Rect {
  const rotated = m.transform % 2 === 1;
  const w = Math.round((rotated ? m.height : m.width) / m.scale);
  const h = Math.round((rotated ? m.width : m.height) / m.scale);
  const [left, top, right, bottom] = m.reserved;
  return { x: m.x + left, y: m.y + top, w: w - left - right, h: h - top - bottom };
}

export function orbRect(m: HyprMonitor): Rect {
  const a = usableArea(m);
  return { x: a.x + Math.round((a.w - ORB_SIZE) / 2), y: a.y + 8, w: ORB_SIZE, h: ORB_SIZE };
}

export function halfRect(m: HyprMonitor): Rect {
  const a = usableArea(m);
  const w = Math.round(a.w / 2) - Math.round(GAP * 1.5);
  return { x: a.x + a.w - GAP - w, y: a.y + GAP, w, h: a.h - 2 * GAP };
}

/** S6: the left half, where the chat sits with an app beside it (which gets halfRect). */
export function sideRect(m: HyprMonitor): Rect {
  const r = halfRect(m);
  return { ...r, x: usableArea(m).x + GAP };
}

export type Position = 'left' | 'right' | 'above' | 'below';

/** Where a monitor is, seen from the home one, by the centres of their usable areas. */
export function positionOf(home: HyprMonitor, m: HyprMonitor): Position {
  const a = usableArea(home);
  const b = usableArea(m);
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'above' : 'below';
}

/** The chat's screen: the configured one if it is connected, else the chat's own, the focused one, the first. */
export function homeMonitor(monitors: HyprMonitor[], win: HyprClient | undefined, configured = ''): HyprMonitor | undefined {
  const on = monitors.filter((m) => !m.disabled);
  return (
    (configured ? on.find((m) => m.name === configured) : undefined) ??
    (win ? on.find((m) => m.id === win.monitor) : undefined) ??
    on.find((m) => m.focused) ??
    on[0]
  );
}

const addressOf = (c: HyprClient) => {
  if (!/^0x[0-9a-f]+$/.test(c.address)) throw new Error('bad window address');
  return `window = "address:${c.address}"`;
};
const monitorName = (m: HyprMonitor) => {
  if (!MONITOR_NAME.test(m.name)) throw new Error('bad monitor name');
  return m.name;
};
const toMonitor = (m: HyprMonitor, w: string) => `hl.dsp.window.move({ monitor = "${monitorName(m)}", ${w} })`;

/** The Lua dispatches that put the chat window in a mode, in order. Pure, for tests. */
export function dispatchesFor(mode: WindowMode, win: HyprClient, mon: HyprMonitor): string[] {
  const w = addressOf(win);
  const prop = (p: string, v: string | number) => `hl.dsp.window.set_prop({ prop = "${p}", value = "${v}", ${w} })`;
  const out: string[] = [];
  // S6: the chat always goes back to its own screen first.
  if (win.monitor !== mon.id && mon.name) out.push(toMonitor(mon, w));
  if (mode === 'full') {
    if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
    for (const p of ['rounding', 'border_size', 'no_shadow', 'no_blur']) out.push(prop(p, 'unset'));
    if (win.floating) out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
    out.push(`hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  const r = mode === 'orb' ? orbRect(mon) : mode === 'side' ? sideRect(mon) : halfRect(mon);
  if (win.fullscreen > 0) out.push(`hl.dsp.window.fullscreen({ mode = "${win.fullscreen === 1 ? 'maximized' : 'fullscreen'}", action = "unset", ${w} })`);
  if (!win.floating) out.push(`hl.dsp.window.float({ action = "on", ${w} })`);
  if (mode === 'orb') {
    out.push(prop('rounding', ORB_SIZE / 2), prop('border_size', 0), prop('no_shadow', 1), prop('no_blur', 1));
  } else {
    for (const p of ['rounding', 'border_size', 'no_shadow', 'no_blur']) out.push(prop(p, 'unset'));
  }
  out.push(`hl.dsp.window.resize({ x = ${r.w}, y = ${r.h}, ${w} })`);
  out.push(`hl.dsp.window.move({ x = ${r.x}, y = ${r.y}, ${w} })`);
  // Side shares the screen with an app instead of floating over every workspace.
  if (mode === 'side') {
    if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  if (!win.pinned) out.push(`hl.dsp.window.pin({ action = "on", ${w} })`);
  out.push(`hl.dsp.window.alter_zorder({ mode = "top", ${w} })`);
  // The orb leaves focus with the app; half is for typing.
  if (mode === 'half') out.push(`hl.dsp.focus({ ${w} })`);
  return out;
}

/**
 * S6: the dispatches that put an app's window in a place, in order. Pure, for tests.
 * `target` is the other screen for "screen"; `unfloat` drops the floating that "beside" gave it.
 */
export function placeDispatches(place: AppPlace, app: HyprClient, home: HyprMonitor, o: { target?: HyprMonitor; unfloat?: boolean } = {}): string[] {
  const w = addressOf(app);
  const out: string[] = [];
  if (place === 'screen') {
    const t = o.target;
    if (!t) throw new Error('no screen to move it to');
    if (app.monitor !== t.id) out.push(toMonitor(t, w));
    if (o.unfloat && app.floating) out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  if (app.monitor !== home.id) out.push(toMonitor(home, w));
  if (place === 'over') {
    if (o.unfloat && app.floating) out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  const r = halfRect(home);
  if (app.fullscreen > 0) out.push(`hl.dsp.window.fullscreen({ mode = "${app.fullscreen === 1 ? 'maximized' : 'fullscreen'}", action = "unset", ${w} })`);
  if (!app.floating) out.push(`hl.dsp.window.float({ action = "on", ${w} })`);
  out.push(`hl.dsp.window.resize({ x = ${r.w}, y = ${r.h}, ${w} })`);
  out.push(`hl.dsp.window.move({ x = ${r.x}, y = ${r.y}, ${w} })`);
  out.push(`hl.dsp.focus({ ${w} })`);
  return out;
}

/** Where an app goes: the place and, for "screen", the monitor's name. */
export interface Placement {
  place: AppPlace;
  screen?: string;
}

/** One screen as screens_list shows it. Window classes are the apps' own; no titles, which pages set. */
export interface ScreenInfo {
  name: string;
  home: boolean;
  focused: boolean;
  /** Size in layout pixels. */
  w: number;
  h: number;
  position: Position | null;
  windows: { address: string; className: string; app?: string; place?: AppPlace }[];
}

/** What identifies an open app's window: names the chat started it under, and window classes. */
export interface WindowMatch {
  names: string[];
  classes: string[];
}

const lower = (s: string) => s.toLowerCase().trim();

export class ChatWindow {
  private current: WindowMode = 'full';
  /** Windows of apps the chat started or placed: address → app name and where it is. */
  private readonly apps = new Map<string, { name: string; place: AppPlace }>();
  /** Starts still waiting for their first window, oldest first. */
  private pending: { name: string; at: Placement; timer: NodeJS.Timeout }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private stopEvents: (() => void) | null = null;

  constructor(private readonly o: ChatWindowOptions) {}

  get mode(): WindowMode {
    return this.current;
  }

  start(): void {
    if (this.o.hypr && !this.stopEvents) this.stopEvents = this.o.hypr.events((ev) => this.onEvent(ev));
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending = [];
    if (this.keepRecheck) clearTimeout(this.keepRecheck);
    this.keepRecheck = null;
  }

  /** The UI asked (orb clicked, back to orb, full screen). */
  request(mode: WindowMode): Promise<void> {
    return this.set(mode, 'user');
  }

  /**
   * S5: an app's Change button posted a card. The orb opens to half screen beside the app so the
   * card can be clicked; a full-screen chat already shows it.
   */
  async bringForward(app: string): Promise<void> {
    if (this.current === 'orb') await this.set('half', 'app_change', app);
  }

  /**
   * S6: where an app should go, from what the model asked (or the default), checked against
   * the screens connected now. A string is an error to hand back to the model.
   */
  async placement(want?: AppPlace, screen?: string): Promise<Placement | string> {
    const at = await this.choosePlace(want, screen);
    if (typeof at === 'string' || at.place !== 'over' || !this.o.keep || !this.o.hypr) return at;
    // S6 keep: the chat never gives up its screen, so "over" becomes another screen, or beside with one screen.
    const other = await this.otherScreen();
    return other ? { place: 'screen', screen: other } : { place: 'beside' };
  }

  /** The first other screen, left to right, or null with one screen. */
  private async otherScreen(): Promise<string | null> {
    const hypr = this.o.hypr;
    if (!hypr) return null;
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const home = homeMonitor(monitors, clients.find((c) => CHAT_CLASS.test(c.class)), this.o.home);
    const others = monitors.filter((m) => !m.disabled && m.id !== home?.id && MONITOR_NAME.test(m.name)).sort((a, b) => a.x - b.x || a.y - b.y);
    return others[0]?.name ?? null;
  }

  private async choosePlace(want?: AppPlace, screen?: string): Promise<Placement | string> {
    const hypr = this.o.hypr;
    if (!hypr) return { place: 'over' };
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const home = homeMonitor(monitors, clients.find((c) => CHAT_CLASS.test(c.class)), this.o.home);
    if (!home) return { place: 'over' };
    const others = monitors.filter((m) => !m.disabled && m.id !== home.id && MONITOR_NAME.test(m.name)).sort((a, b) => a.x - b.x || a.y - b.y);
    const def = this.o.defaultPlace ?? 'auto';
    const place = want ?? (screen ? 'screen' : def === 'auto' ? (others.length ? 'screen' : 'over') : def);
    if (place !== 'screen') return { place };
    const list = others.map((m) => `${m.name} (${positionOf(home, m)})`).join(', ');
    if (!others.length) return `Error: only one screen is connected (${home.name || 'this one'}), the chat's own. Open it over the chat or beside it instead.`;
    if (!screen) {
      if (others.length === 1 || !want) return { place, screen: others[0]!.name };
      return `Error: there are several other screens: ${list}. Ask the user which one, then give its name or side as screen.`;
    }
    const s = lower(screen);
    if (s === lower(home.name) || ['this', 'here', 'home', 'main'].includes(s)) return { place: 'over' };
    const byName = others.find((m) => lower(m.name) === s);
    if (byName) return { place, screen: byName.name };
    const bySide = s === 'other' ? others : others.filter((m) => positionOf(home, m) === s);
    if (bySide.length === 1) return { place, screen: bySide[0]!.name };
    if (bySide.length > 1) return `Error: more than one screen fits ${JSON.stringify(screen)}: ${list}. Ask the user which one.`;
    return `Error: no screen is called ${JSON.stringify(screen.slice(0, 40))}. The other screens are: ${list}.`;
  }

  /** Called just before an app starts: the chat steps aside first, so the app opens in its place. */
  async appStarting(name: string, at: Placement = { place: 'over' }): Promise<void> {
    // Starts that don't choose a place (documents, built apps) still respect keep.
    if (at.place === 'over' && this.o.keep) {
      const p = await this.placement('over');
      at = typeof p === 'string' ? { place: 'beside' } : p;
    }
    const timer = setTimeout(() => {
      this.pending = this.pending.filter((p) => p.timer !== timer);
    }, this.o.openWindowMs ?? OPEN_WINDOW_MS);
    timer.unref();
    this.pending.push({ name, at, timer });
    if (at.place === 'over') await this.set('orb', 'app_started');
    else if (at.place === 'beside') await this.set('side', 'app_beside');
    // Apps open on the focused screen, so focus the one it should open on.
    else if (at.screen) await this.run(`focus ${at.screen}`, name, async (h) => h.dispatch(`hl.dsp.focus({ monitor = "${checkedName(at.screen!)}" })`), { place: 'screen', screen: at.screen });
  }

  /** The start failed: nothing will open, so the chat comes back unless another app is open. */
  async appFailed(name: string): Promise<void> {
    const i = this.pending.findIndex((p) => p.name === name);
    if (i >= 0) {
      clearTimeout(this.pending[i]!.timer);
      this.pending.splice(i, 1);
    }
    if (!this.homeApps()) await this.set('full', 'app_failed');
  }

  /** S6: the screens and what is open on each, for screens_list. */
  async screens(): Promise<ScreenInfo[]> {
    const hypr = this.o.hypr;
    if (!hypr) return [];
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const home = homeMonitor(monitors, clients.find((c) => CHAT_CLASS.test(c.class)), this.o.home);
    return monitors
      .filter((m) => !m.disabled)
      .map((m) => {
        const a = usableArea(m);
        return {
          name: m.name,
          home: m.id === home?.id,
          focused: m.focused,
          w: a.w,
          h: a.h,
          position: home && m.id !== home.id ? positionOf(home, m) : null,
          windows: clients
            .filter((c) => c.monitor === m.id && !CHAT_CLASS.test(c.class) && (c.workspace?.id ?? 1) > 0 && c.mapped !== false && c.hidden !== true)
            .map((c) => ({ address: c.address, className: c.class, ...(this.apps.has(c.address) ? { app: this.apps.get(c.address)!.name, place: this.apps.get(c.address)!.place } : {}) })),
        };
      });
  }

  /**
   * S6: moves an app's open window to a place. The window is one the chat started under one of
   * `match.names`, else one whose class is one of `match.classes`, the most recently used first.
   * Returns the app's name; throws when there is no such window.
   */
  async moveApp(match: WindowMatch, at: Placement): Promise<string> {
    const hypr = this.o.hypr;
    if (!hypr) throw new Error("windows can't be moved here: AI OS isn't running inside Hyprland");
    const names = new Set(match.names.map(lower));
    const classes = new Set(match.classes.map(lower));
    const clients = (await hypr.clients()).filter((c) => !CHAT_CLASS.test(c.class) && c.mapped !== false);
    const ranked = clients
      .map((c) => ({ c, tracked: this.apps.get(c.address) }))
      .filter(({ c, tracked }) => (tracked && names.has(lower(tracked.name))) || classes.has(lower(c.class)))
      .sort((a, b) => Number(!!b.tracked) - Number(!!a.tracked) || (a.c.focusHistoryID ?? 1e9) - (b.c.focusHistoryID ?? 1e9));
    const hit = ranked[0];
    if (!hit) throw new Error('no window of that app is open');
    const name = hit.tracked?.name ?? match.names[0] ?? hit.c.class;
    const was = hit.tracked?.place;
    if (at.place === 'over') await this.set('orb', 'app_moved', name);
    if (at.place === 'beside') await this.set('side', 'app_moved', name);
    await this.placeWindow(hit.c.address, name, at, was === 'beside');
    if (at.place === 'screen' && !this.homeApps() && this.current !== 'full') await this.set('full', 'app_moved', name);
    return name;
  }

  /** Apps over or beside the chat, open or still starting: while there are any, the chat stays aside. */
  private homeApps(): number {
    return [...this.apps.values()].filter((a) => a.place !== 'screen').length + this.pending.filter((p) => p.at.place !== 'screen').length;
  }

  private onEvent(ev: HyprEvent): void {
    if (ev.name === 'workspace') {
      if (this.o.keep) void this.keepWorkspace().catch(() => undefined);
      return;
    }
    if (ev.name === 'openwindow') {
      if (CHAT_CLASS.test(ev.className)) return;
      const p = this.pending.shift();
      if (!p) {
        if (this.o.keep) void this.keepWindow(ev.address, ev.className).catch(() => undefined);
        return;
      }
      clearTimeout(p.timer);
      this.apps.set(ev.address, { name: p.name, place: p.at.place });
      if (p.at.place !== 'over') void this.placeWindow(ev.address, p.name, p.at, false).catch(() => undefined);
      return;
    }
    const app = this.apps.get(ev.address);
    if (app === undefined) return;
    this.apps.delete(ev.address);
    if (app.place !== 'screen' && !this.homeApps() && this.current !== 'full') void this.set('full', 'app_closed', app.name);
  }

  /**
   * S6 keep: a window nobody asked the chat for opened. If it landed on the chat's screen (tiled,
   * on a normal workspace, and not a second window of an app beside the chat), move it to another
   * screen, or beside the chat when there is no other screen.
   */
  private async keepWindow(address: string, className: string): Promise<void> {
    const hypr = this.o.hypr!;
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const c = clients.find((x) => x.address === address);
    const chat = clients.find((x) => CHAT_CLASS.test(x.class));
    const home = homeMonitor(monitors, chat, this.o.home);
    if (!c || !home || c.floating || c.monitor !== home.id || (c.workspace?.id ?? 1) < 0) return;
    const besidePids = new Set(clients.filter((x) => this.apps.get(x.address)?.place === 'beside').map((x) => x.pid));
    if (c.pid !== undefined && besidePids.has(c.pid)) return;
    const name = cleanLabel(className);
    const other = await this.otherScreen();
    if (other) return this.placeWindow(address, name, { place: 'screen', screen: other }, false);
    await this.set('side', 'keep', name);
    await this.placeWindow(address, name, { place: 'beside' }, false);
  }

  private lastKeepWorkspace = 0;
  private keepRecheck: NodeJS.Timeout | null = null;

  /**
   * S6 keep: the chat's screen shows another workspace (Super+2 while on it, say). That workspace
   * moves to the first other screen, the chat's workspace comes back, and focus goes to the
   * moved one, so the user still lands where they asked. At most once a second, so it can't loop.
   */
  private async keepWorkspace(): Promise<void> {
    const hypr = this.o.hypr!;
    const now = Date.now();
    if (now - this.lastKeepWorkspace < 1000) {
      // Look again once the second is up, so a quick second switch isn't missed.
      if (!this.keepRecheck) {
        this.keepRecheck = setTimeout(() => {
          this.keepRecheck = null;
          void this.keepWorkspace().catch(() => undefined);
        }, 1000 - (now - this.lastKeepWorkspace));
        this.keepRecheck.unref();
      }
      return;
    }
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const chat = clients.find((x) => CHAT_CLASS.test(x.class));
    const home = homeMonitor(monitors, chat, this.o.home);
    const mine = chat?.workspace?.id;
    const shown = home?.activeWorkspace?.id;
    if (!chat || !home || chat.monitor !== home.id || mine === undefined || shown === undefined) return;
    if (shown === mine || mine < 0 || shown < 0 || !Number.isInteger(mine) || !Number.isInteger(shown)) return;
    const other = monitors.filter((m) => !m.disabled && m.id !== home.id && MONITOR_NAME.test(m.name)).sort((a, b) => a.x - b.x || a.y - b.y)[0];
    if (!other) return;
    this.lastKeepWorkspace = now;
    await this.run('keep workspace', `workspace ${shown}`, async (h) => {
      await h.dispatch(`hl.dsp.workspace.move({ monitor = "${checkedName(other.name)}", workspace = "${shown}" })`);
      await h.dispatch(`hl.dsp.focus({ workspace = "${mine}" })`);
      await h.dispatch(`hl.dsp.focus({ workspace = "${shown}" })`);
    }, { place: 'screen', screen: other.name });
  }

  /** Puts one app window in a place and remembers it there. Audited; a refusal is a notice. */
  private placeWindow(address: string, name: string, at: Placement, unfloat: boolean): Promise<void> {
    return this.run(`place ${at.place}`, name, async (hypr) => {
      const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
      const app = clients.find((c) => c.address === address);
      // Closed before it could be placed.
      if (!app) return;
      const home = homeMonitor(monitors, clients.find((c) => CHAT_CLASS.test(c.class)), this.o.home);
      if (!home) throw new Error('Hyprland reports no monitor');
      const target = at.screen ? monitors.find((m) => m.name === at.screen && !m.disabled) : undefined;
      if (at.place === 'screen' && !target) throw new Error(`screen ${at.screen ?? ''} is no longer connected`);
      for (const expr of placeDispatches(at.place, app, home, { ...(target ? { target } : {}), unfloat })) await hypr.dispatch(expr);
      this.apps.set(address, { name, place: at.place });
    }, at);
  }

  /** Runs one Hyprland job in the window queue, audits it, and turns a failure into a notice. */
  private run(what: string, app: string, job: (hypr: HyprIpc) => Promise<void>, at: Placement): Promise<void> {
    const hypr = this.o.hypr;
    if (!hypr) return Promise.resolve();
    const next = this.queue.then(async () => {
      let error: string | undefined;
      try {
        await job(hypr);
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
      }
      this.o.audit.append({ kind: 'window', app, place: at.place, ...(at.screen ? { screen: at.screen } : {}), step: what, ok: !error, ...(error ? { error } : {}) });
      if (error) this.o.notice('warning', `I couldn't move ${app}'s window: ${error}`);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Changes run one at a time, in the order asked. */
  private set(mode: WindowMode, reason: string, app?: string): Promise<void> {
    if (!this.o.hypr) return Promise.resolve();
    const next = this.queue.then(() => this.apply(mode, reason, app));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(mode: WindowMode, reason: string, app?: string): Promise<void> {
    if (mode === this.current) return;
    const from = this.current;
    let error: string | undefined;
    try {
      await this.move(mode);
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    // The UI follows even when Hyprland refused, so the orb is always there to click.
    this.current = mode;
    this.o.audit.append({ kind: 'window', from, to: mode, reason, ...(app ? { app } : {}), ok: !error, ...(error ? { error } : {}) });
    this.o.onMode(mode);
    if (error) this.o.notice('warning', `I couldn't move the chat window: ${error}`);
  }

  private async move(mode: WindowMode): Promise<void> {
    const hypr = this.o.hypr!;
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const win = clients.find((c) => CHAT_CLASS.test(c.class));
    // Opened in a normal browser (development): nothing to move.
    if (!win) return;
    const mon = homeMonitor(monitors, win, this.o.home);
    if (!mon) throw new Error('Hyprland reports no monitor');
    for (const expr of dispatchesFor(mode, win, mon)) await hypr.dispatch(expr);
  }
}

/** A window class as a name in notices and the audit log. */
const cleanLabel = (c: string) => c.replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 40) || 'a window';

function checkedName(name: string): string {
  if (!MONITOR_NAME.test(name)) throw new Error('bad monitor name');
  return name;
}
