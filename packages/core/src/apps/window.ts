/**
 * Where the chat window sits and where apps open (S7, replacing S3's orb and S6's places).
 *
 * One rule: the chat is always full screen on its own workspace, and nothing else stays there.
 *
 * - The chat's workspace is the one its window is on (the kiosk opens it on its home screen,
 *   config [screen] monitor). Omarchy 4 gives every screen its own workspaces 1-10 (laptop
 *   1-10, the next screen 11-20), so AI OS never pins workspace numbers to screens; it only
 *   reads where the chat is.
 * - Apps go elsewhere. With another screen, they open there (that screen is focused first, so
 *   the app opens on the workspace it shows). With one screen, they open on the next workspace
 *   (the chat's + 1, Omarchy's slot 2), and the screen switches there.
 * - A tiled window that still lands on the chat's workspace (one the user opened from the
 *   launcher, an app that was slow to start) is moved to the same place. Floating windows
 *   (dialogs, pickers) and special workspaces are left alone.
 * - Getting back is the kiosk's job: `aios-kiosk open` (Super+Shift+H, the AI button in the top
 *   bar) focuses the chat window, which brings its workspace and screen back.
 *
 * Also: the chat window is put back to full screen when core starts (an older version may have
 * left it as the S3 orb), and core tracks whether the chat has focus, so the top bar's AI button
 * can show a dot when something new came in while it didn't.
 */
import { CHAT_CLASS_PATTERN, MONITOR_NAME } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { HyprClient, HyprEvent, HyprIpc, HyprMonitor } from './hyprland.js';

const CHAT_CLASS = new RegExp(CHAT_CLASS_PATTERN);

export interface ChatWindowOptions {
  /** Null outside Hyprland: nothing can move, so the chat stays as it is. */
  hypr: HyprIpc | null;
  /** The monitor the chat owns (config [screen] monitor); empty for the one it is on. */
  home?: string;
  audit: AuditLog;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  /** The chat window gained (true) or lost (false) focus; for the top bar's new-item dot. */
  onFocus?: (focused: boolean) => void;
  /** Where apps go changed (a screen was plugged in or out); for the status strip's hint. */
  onAppsAt?: (at: AppsAt) => void;
}

/** Where apps open now: on another screen, or on the next workspace of the only one. */
export type AppsAt = 'screen' | 'workspace';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The monitor's usable area in layout coordinates. */
export function usableArea(m: HyprMonitor): Rect {
  const rotated = m.transform % 2 === 1;
  const w = Math.round((rotated ? m.height : m.width) / m.scale);
  const h = Math.round((rotated ? m.width : m.height) / m.scale);
  const [left, top, right, bottom] = m.reserved;
  return { x: m.x + left, y: m.y + top, w: w - left - right, h: h - top - bottom };
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

/** The other enabled screens, left to right. */
export function otherMonitors(monitors: HyprMonitor[], home: HyprMonitor | undefined): HyprMonitor[] {
  return monitors.filter((m) => !m.disabled && m.id !== home?.id && MONITOR_NAME.test(m.name)).sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Where an app goes: a screen by name, or a workspace by number. */
export type AppTarget = { screen: string } | { workspace: number };

/**
 * Where apps go when nobody named a screen: the first other screen, else the workspace after
 * the chat's (2 when the chat's is unknown). Pure, for tests.
 */
export function appTarget(chat: HyprClient | undefined, monitors: HyprMonitor[], configured = ''): AppTarget {
  const home = homeMonitor(monitors, chat, configured);
  const other = otherMonitors(monitors, home)[0];
  if (other) return { screen: other.name };
  const ws = chat?.workspace?.id;
  return { workspace: ws !== undefined && Number.isInteger(ws) && ws > 0 ? ws + 1 : 2 };
}

const addressOf = (c: HyprClient) => {
  if (!/^0x[0-9a-f]+$/.test(c.address)) throw new Error('bad window address');
  return `window = "address:${c.address}"`;
};

function checkedName(name: string): string {
  if (!MONITOR_NAME.test(name)) throw new Error('bad monitor name');
  return name;
}

function checkedWorkspace(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error('bad workspace');
  return String(n);
}

/** The dispatch that makes the next app open at a target: focus that screen or workspace. Pure. */
export function focusDispatch(t: AppTarget): string {
  return 'screen' in t ? `hl.dsp.focus({ monitor = "${checkedName(t.screen)}" })` : `hl.dsp.focus({ workspace = "${checkedWorkspace(t.workspace)}" })`;
}

/** The dispatches that move an open window to a target and follow it there. Pure. */
export function moveDispatches(app: HyprClient, t: AppTarget): string[] {
  const w = addressOf(app);
  const move =
    'screen' in t
      ? `hl.dsp.window.move({ monitor = "${checkedName(t.screen)}", follow = true, ${w} })`
      : `hl.dsp.window.move({ workspace = "${checkedWorkspace(t.workspace)}", follow = true, ${w} })`;
  return [move, `hl.dsp.focus({ ${w} })`];
}

/**
 * The dispatches that put the chat window back to full screen on its home screen, from whatever
 * an older version (the S3 orb, S6's halves) left it as. Empty when it already is. Pure.
 */
export function restoreDispatches(win: HyprClient, home: HyprMonitor | undefined): string[] {
  const w = addressOf(win);
  const out: string[] = [];
  if (home && win.monitor !== home.id) out.push(`hl.dsp.window.move({ monitor = "${checkedName(home.name)}", ${w} })`);
  if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
  if (win.floating) {
    for (const p of ['rounding', 'border_size', 'no_shadow', 'no_blur']) out.push(`hl.dsp.window.set_prop({ prop = "${p}", value = "unset", ${w} })`);
    out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
  }
  if (win.fullscreen !== 2) out.push(`hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", ${w} })`);
  return out;
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
  windows: { address: string; className: string; app?: string }[];
}

/** What identifies an open app's window: names the chat started it under, and window classes. */
export interface WindowMatch {
  names: string[];
  classes: string[];
}

const lower = (s: string) => s.toLowerCase().trim();

export class ChatWindow {
  /** Windows of apps the chat started: address → the name it started them under. */
  private readonly apps = new Map<string, string>();
  /** Names of starts still waiting for their first window, oldest first. */
  private pending: { name: string; timer: NodeJS.Timeout }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private stopEvents: (() => void) | null = null;
  private chatFocused = true;
  private lastAppsAt: AppsAt | null = null;

  constructor(private readonly o: ChatWindowOptions) {}

  /** Whether the chat window has focus, as far as Hyprland's events tell. True outside Hyprland. */
  get focused(): boolean {
    return this.chatFocused;
  }

  /** Where apps open now; null until known (or outside Hyprland). */
  get appsAt(): AppsAt | null {
    return this.lastAppsAt;
  }

  start(): void {
    const hypr = this.o.hypr;
    if (!hypr || this.stopEvents) return;
    this.stopEvents = hypr.events((ev) => this.onEvent(ev));
    void this.run('restore the chat', 'Astra', async (h) => {
      const [clients, monitors] = await Promise.all([h.clients(), h.monitors()]);
      const chat = clients.find((c) => CHAT_CLASS.test(c.class));
      this.noteAppsAt(monitors, chat);
      if (!chat) return;
      for (const expr of restoreDispatches(chat, homeMonitor(monitors, chat, this.o.home))) await h.dispatch(expr);
    });
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending = [];
  }

  /**
   * Checks a screen the user named ("DP-2", "left", "other") against the screens connected now.
   * Undefined means the default place. A string is an error to hand back to the model.
   */
  async target(screen?: string): Promise<AppTarget | string> {
    const hypr = this.o.hypr;
    if (!hypr) return { workspace: 2 };
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const chat = clients.find((c) => CHAT_CLASS.test(c.class));
    if (!screen) return appTarget(chat, monitors, this.o.home);
    const home = homeMonitor(monitors, chat, this.o.home);
    const others = otherMonitors(monitors, home);
    if (!home || !others.length) return `Error: only one screen is connected (${home?.name || 'this one'}), and it is the chat's own. There is no other screen to open or move an app to.`;
    const list = others.map((m) => `${m.name} (${positionOf(home, m)})`).join(', ');
    const s = lower(screen);
    if (s === lower(home.name) || ['this', 'here', 'home', 'main'].includes(s)) return `Error: ${home.name} is the chat's own screen and nothing else opens there. The other screens are: ${list}.`;
    const byName = others.find((m) => lower(m.name) === s);
    if (byName) return { screen: byName.name };
    if (s === 'other' || s === 'another') return { screen: others[0]!.name };
    const bySide = others.filter((m) => positionOf(home, m) === s);
    if (bySide.length === 1) return { screen: bySide[0]!.name };
    if (bySide.length > 1) return `Error: more than one screen fits ${JSON.stringify(screen)}: ${list}. Ask the user which one.`;
    return `Error: no screen is called ${JSON.stringify(screen.slice(0, 40))}. The other screens are: ${list}.`;
  }

  /** Called just before an app starts: focus where it should open, so it opens there. */
  async appStarting(name: string, at?: AppTarget): Promise<AppTarget | undefined> {
    const hypr = this.o.hypr;
    if (!hypr) return undefined;
    const t = at ?? (await this.target());
    if (typeof t === 'string') return undefined;
    const timer = setTimeout(() => {
      this.pending = this.pending.filter((p) => p.timer !== timer);
    }, 20_000);
    timer.unref();
    this.pending.push({ name, timer });
    await this.run('open there', name, (h) => h.dispatch(focusDispatch(t)), t);
    return t;
  }

  /** The start failed: nothing will open, so the user is taken back to the chat, where the error is. */
  async appFailed(name: string): Promise<void> {
    const i = this.pending.findIndex((p) => p.name === name);
    if (i >= 0) {
      clearTimeout(this.pending[i]!.timer);
      this.pending.splice(i, 1);
    }
    await this.showChat('app_failed', name);
  }

  /** S5: an app's Change button posted a card; the chat comes forward so it can be clicked. */
  async bringForward(app: string): Promise<void> {
    await this.showChat('app_change', app);
  }

  /** Focuses the chat window, which brings its workspace and screen back. */
  private showChat(reason: string, app: string): Promise<void> {
    return this.run(`show the chat (${reason})`, app, async (h) => {
      const chat = (await h.clients()).find((c) => CHAT_CLASS.test(c.class));
      if (chat) await h.dispatch(`hl.dsp.focus({ ${addressOf(chat)} })`);
    });
  }

  /** The screens and what is open on each, for screens_list. */
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
            .map((c) => ({ address: c.address, className: c.class, ...(this.apps.has(c.address) ? { app: this.apps.get(c.address)! } : {}) })),
        };
      });
  }

  /**
   * Moves an app's open window to another screen. The window is one the chat started under one
   * of `match.names`, else one whose class is one of `match.classes`, the most recently used
   * first. Returns the app's name; throws when there is no such window.
   */
  async moveApp(match: WindowMatch, to: AppTarget): Promise<string> {
    const hypr = this.o.hypr;
    if (!hypr) throw new Error("windows can't be moved here: Astra isn't running inside Hyprland");
    const names = new Set(match.names.map(lower));
    const classes = new Set(match.classes.map(lower));
    const clients = (await hypr.clients()).filter((c) => !CHAT_CLASS.test(c.class) && c.mapped !== false);
    const ranked = clients
      .map((c) => ({ c, tracked: this.apps.get(c.address) }))
      .filter(({ c, tracked }) => (tracked !== undefined && names.has(lower(tracked))) || classes.has(lower(c.class)))
      .sort((a, b) => Number(b.tracked !== undefined) - Number(a.tracked !== undefined) || (a.c.focusHistoryID ?? 1e9) - (b.c.focusHistoryID ?? 1e9));
    const hit = ranked[0];
    if (!hit) throw new Error('no window of that app is open');
    const name = hit.tracked ?? match.names[0] ?? hit.c.class;
    await this.moveWindow(hit.c.address, name, to);
    return name;
  }

  private onEvent(ev: HyprEvent): void {
    if (ev.name === 'activewindow') {
      void this.o.hypr!
        .clients()
        .then((clients) => {
          const chat = clients.find((c) => CHAT_CLASS.test(c.class));
          const focused = !!chat && chat.address === ev.address;
          if (focused !== this.chatFocused) {
            this.chatFocused = focused;
            this.o.onFocus?.(focused);
          }
        })
        .catch(() => undefined);
      return;
    }
    if (ev.name === 'monitors') {
      void Promise.all([this.o.hypr!.clients(), this.o.hypr!.monitors()])
        .then(([clients, monitors]) => this.noteAppsAt(monitors, clients.find((c) => CHAT_CLASS.test(c.class))))
        .catch(() => undefined);
      return;
    }
    if (ev.name === 'openwindow') {
      if (CHAT_CLASS.test(ev.className)) return;
      const p = this.pending.shift();
      if (p) {
        clearTimeout(p.timer);
        this.apps.set(ev.address, p.name);
      }
      void this.keepOff(ev.address, p?.name ?? cleanLabel(ev.className)).catch(() => undefined);
      return;
    }
    if (ev.name === 'closewindow') this.apps.delete(ev.address);
  }

  private noteAppsAt(monitors: HyprMonitor[], chat: HyprClient | undefined): void {
    const at: AppsAt = otherMonitors(monitors, homeMonitor(monitors, chat, this.o.home)).length ? 'screen' : 'workspace';
    if (at === this.lastAppsAt) return;
    this.lastAppsAt = at;
    this.o.onAppsAt?.(at);
  }

  /** A tiled window opened on the chat's workspace: move it where apps go, and follow it. */
  private async keepOff(address: string, name: string): Promise<void> {
    const hypr = this.o.hypr!;
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const c = clients.find((x) => x.address === address);
    const chat = clients.find((x) => CHAT_CLASS.test(x.class));
    const ws = chat?.workspace?.id;
    if (!c || !chat || c.floating || ws === undefined || ws < 1 || c.workspace?.id !== ws) return;
    await this.moveWindow(address, name, appTarget(chat, monitors, this.o.home));
  }

  /** Moves one window to a target. Audited; a refusal is a notice. */
  private moveWindow(address: string, name: string, to: AppTarget): Promise<void> {
    return this.run('move', name, async (hypr) => {
      const app = (await hypr.clients()).find((c) => c.address === address);
      // Closed before it could be moved.
      if (!app) return;
      for (const expr of moveDispatches(app, to)) await hypr.dispatch(expr);
    }, to);
  }

  /** Runs one Hyprland job in the window queue, in the order asked, audits it, and turns a failure into a notice. */
  private run(what: string, app: string, job: (hypr: HyprIpc) => Promise<void>, to?: AppTarget): Promise<void> {
    const hypr = this.o.hypr;
    if (!hypr) return Promise.resolve();
    const next = this.queue.then(async () => {
      let error: string | undefined;
      try {
        await job(hypr);
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
      }
      this.o.audit.append({ kind: 'window', app, step: what, ...(to ? to : {}), ok: !error, ...(error ? { error } : {}) });
      if (error) this.o.notice('warning', `I couldn't move ${app === 'Astra' ? 'the chat' : `${app}'s`} window: ${error}`);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** A window class as a name in notices and the audit log. */
const cleanLabel = (c: string) => c.replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 40) || 'a window';
