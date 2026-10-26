/**
 * Where the chat window is (S3). Core drives it through Hyprland, so the UI only asks:
 *
 *   full ──an app starts──▶ hidden ──tray circle clicked──▶ half ──circle / Hide / Esc──▶ hidden
 *     ▲                      │                               │
 *     └─the last app the chat started has closed─────────────┴──── "Full screen" ──▶ full
 *
 * Hidden puts the chat window on its own special workspace, out of sight, and a red
 * circle shows in the bar's tray (tray.ts) for as long as the chat isn't full screen.
 * Half is the right half of the screen, floating and pinned over the app. Full is the
 * kiosk's own fullscreen.
 *
 * Which apps "the chat started" is decided by Hyprland's openwindow events: the first
 * new window after a start belongs to it. When the last of those closes, the chat comes
 * back full screen. An app that opens no new window (one that was already running and
 * only raised itself) leaves the chat hidden, with the circle in the tray.
 */
import { type WindowMode, CHAT_CLASS_PATTERN } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { HyprClient, HyprEvent, HyprIpc, HyprMonitor } from './hyprland.js';

const CHAT_CLASS = new RegExp(CHAT_CLASS_PATTERN);
/** Where the hidden chat waits. Only this code ever shows it again. */
export const HIDDEN_WORKSPACE = 'special:aios';
const GAP = 12;
/** How long after a start its first window still counts as that app's. */
const OPEN_WINDOW_MS = 20_000;

export interface ChatWindowOptions {
  /** Null outside Hyprland: nothing can move, so the chat stays full screen. */
  hypr: HyprIpc | null;
  audit: AuditLog;
  onMode: (mode: WindowMode) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  /** The tray circle; shown whenever the chat isn't full screen. */
  tray?: { setVisible: (visible: boolean) => void };
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

export function halfRect(m: HyprMonitor): Rect {
  const a = usableArea(m);
  const w = Math.round(a.w / 2) - Math.round(GAP * 1.5);
  return { x: a.x + a.w - GAP - w, y: a.y + GAP, w, h: a.h - 2 * GAP };
}

/** The Lua dispatches that put the chat window in a mode, in order. Pure, for tests. */
export function dispatchesFor(mode: WindowMode, win: HyprClient, mon: HyprMonitor): string[] {
  if (!/^0x[0-9a-f]+$/.test(win.address)) throw new Error('bad window address');
  if (!Number.isInteger(mon.activeWorkspace.id)) throw new Error('bad workspace id');
  const w = `window = "address:${win.address}"`;
  const out: string[] = [];
  const unfullscreen = () => {
    if (win.fullscreen > 0) out.push(`hl.dsp.window.fullscreen({ mode = "${win.fullscreen === 1 ? 'maximized' : 'fullscreen'}", action = "unset", ${w} })`);
  };
  // Back from hiding: onto the workspace the user is looking at.
  const fetch = () => {
    if (win.workspace.name.startsWith('special:')) out.push(`hl.dsp.window.move({ workspace = "${mon.activeWorkspace.id}", follow = false, ${w} })`);
  };
  if (mode === 'hidden') {
    unfullscreen();
    // A pinned window shows on every workspace, so it is unpinned before it is put away.
    if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
    out.push(`hl.dsp.window.move({ workspace = "${HIDDEN_WORKSPACE}", follow = false, ${w} })`);
    return out;
  }
  fetch();
  if (mode === 'full') {
    if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
    if (win.floating) out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
    out.push(`hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  const r = halfRect(mon);
  unfullscreen();
  if (!win.floating) out.push(`hl.dsp.window.float({ action = "on", ${w} })`);
  out.push(`hl.dsp.window.resize({ x = ${r.w}, y = ${r.h}, ${w} })`);
  out.push(`hl.dsp.window.move({ x = ${r.x}, y = ${r.y}, ${w} })`);
  if (!win.pinned) out.push(`hl.dsp.window.pin({ action = "on", ${w} })`);
  out.push(`hl.dsp.window.alter_zorder({ mode = "top", ${w} })`);
  out.push(`hl.dsp.focus({ ${w} })`);
  return out;
}

export class ChatWindow {
  private current: WindowMode = 'full';
  /** Windows of apps the chat started: address → app name. */
  private readonly apps = new Map<string, string>();
  /** Starts still waiting for their first window, oldest first. */
  private pending: { name: string; timer: NodeJS.Timeout }[] = [];
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
  }

  /** The UI asked (Hide, Full screen, Esc). */
  request(mode: WindowMode): Promise<void> {
    return this.set(mode, 'user');
  }

  /** The tray circle was clicked: show the hidden chat at half screen, or hide it again. */
  trayClicked(): Promise<void> {
    if (this.current === 'full') return Promise.resolve();
    return this.set(this.current === 'hidden' ? 'half' : 'hidden', 'tray');
  }

  /** Called just before an app starts: the chat steps aside first, so the app opens in its place. */
  async appStarting(name: string): Promise<void> {
    const timer = setTimeout(() => {
      this.pending = this.pending.filter((p) => p.timer !== timer);
    }, this.o.openWindowMs ?? OPEN_WINDOW_MS);
    timer.unref();
    this.pending.push({ name, timer });
    await this.set('hidden', 'app_started');
  }

  /** The start failed: nothing will open, so the chat comes back unless another app is open. */
  async appFailed(name: string): Promise<void> {
    const i = this.pending.findIndex((p) => p.name === name);
    if (i >= 0) {
      clearTimeout(this.pending[i]!.timer);
      this.pending.splice(i, 1);
    }
    if (!this.apps.size && !this.pending.length) await this.set('full', 'app_failed');
  }

  private onEvent(ev: HyprEvent): void {
    if (ev.name === 'openwindow') {
      if (CHAT_CLASS.test(ev.className)) return;
      const p = this.pending.shift();
      if (!p) return;
      clearTimeout(p.timer);
      this.apps.set(ev.address, p.name);
      return;
    }
    const name = this.apps.get(ev.address);
    if (name === undefined) return;
    this.apps.delete(ev.address);
    if (!this.apps.size && !this.pending.length && this.current !== 'full') void this.set('full', 'app_closed', name);
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
      if (!(await this.move(mode))) {
        // Opened in a normal browser tab: nothing to move or bring back, so the chat stays as it is.
        this.o.audit.append({ kind: 'window', from, to: mode, reason, ...(app ? { app } : {}), ok: false, error: 'no chat window' });
        this.o.notice('warning', "I couldn't step aside: the chat isn't open in its own window. Press SUPER + SHIFT + H to open it that way.");
        return;
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    // The state follows even when Hyprland refused, so the tray circle is there to click.
    this.current = mode;
    this.o.tray?.setVisible(mode !== 'full');
    this.o.audit.append({ kind: 'window', from, to: mode, reason, ...(app ? { app } : {}), ok: !error, ...(error ? { error } : {}) });
    this.o.onMode(mode);
    if (error) this.o.notice('warning', `I couldn't move the chat window: ${error}`);
  }

  /** False when the chat has no window of its own to move. */
  private async move(mode: WindowMode): Promise<boolean> {
    const hypr = this.o.hypr!;
    const [clients, monitors] = await Promise.all([hypr.clients(), hypr.monitors()]);
    const win = clients.find((c) => CHAT_CLASS.test(c.class));
    if (!win) return false;
    // The monitor the user is on: a hidden chat comes back where they are looking.
    const mon = monitors.find((m) => m.focused) ?? monitors.find((m) => m.id === win.monitor) ?? monitors[0];
    if (!mon) throw new Error('Hyprland reports no monitor');
    for (const expr of dispatchesFor(mode, win, mon)) await hypr.dispatch(expr);
    return true;
  }
}
