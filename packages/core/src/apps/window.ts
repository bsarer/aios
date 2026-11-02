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
 */
import { type WindowMode, CHAT_CLASS_PATTERN } from '@aios/shared';
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

/** The Lua dispatches that put the chat window in a mode, in order. Pure, for tests. */
export function dispatchesFor(mode: WindowMode, win: HyprClient, mon: HyprMonitor): string[] {
  if (!/^0x[0-9a-f]+$/.test(win.address)) throw new Error('bad window address');
  const w = `window = "address:${win.address}"`;
  const prop = (p: string, v: string | number) => `hl.dsp.window.set_prop({ prop = "${p}", value = "${v}", ${w} })`;
  const out: string[] = [];
  if (mode === 'full') {
    if (win.pinned) out.push(`hl.dsp.window.pin({ action = "off", ${w} })`);
    for (const p of ['rounding', 'border_size', 'no_shadow', 'no_blur']) out.push(prop(p, 'unset'));
    if (win.floating) out.push(`hl.dsp.window.float({ action = "off", ${w} })`);
    out.push(`hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", ${w} })`);
    out.push(`hl.dsp.focus({ ${w} })`);
    return out;
  }
  const r = mode === 'orb' ? orbRect(mon) : halfRect(mon);
  if (win.fullscreen > 0) out.push(`hl.dsp.window.fullscreen({ mode = "${win.fullscreen === 1 ? 'maximized' : 'fullscreen'}", action = "unset", ${w} })`);
  if (!win.floating) out.push(`hl.dsp.window.float({ action = "on", ${w} })`);
  if (mode === 'orb') {
    out.push(prop('rounding', ORB_SIZE / 2), prop('border_size', 0), prop('no_shadow', 1), prop('no_blur', 1));
  } else {
    for (const p of ['rounding', 'border_size', 'no_shadow', 'no_blur']) out.push(prop(p, 'unset'));
  }
  out.push(`hl.dsp.window.resize({ x = ${r.w}, y = ${r.h}, ${w} })`);
  out.push(`hl.dsp.window.move({ x = ${r.x}, y = ${r.y}, ${w} })`);
  if (!win.pinned) out.push(`hl.dsp.window.pin({ action = "on", ${w} })`);
  out.push(`hl.dsp.window.alter_zorder({ mode = "top", ${w} })`);
  // The orb leaves focus with the app; half is for typing.
  if (mode === 'half') out.push(`hl.dsp.focus({ ${w} })`);
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

  /** Called just before an app starts: the chat steps aside first, so the app opens in its place. */
  async appStarting(name: string): Promise<void> {
    const timer = setTimeout(() => {
      this.pending = this.pending.filter((p) => p.timer !== timer);
    }, this.o.openWindowMs ?? OPEN_WINDOW_MS);
    timer.unref();
    this.pending.push({ name, timer });
    await this.set('orb', 'app_started');
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
    const mon = monitors.find((m) => m.id === win.monitor) ?? monitors.find((m) => m.focused) ?? monitors[0];
    if (!mon) throw new Error('Hyprland reports no monitor');
    for (const expr of dispatchesFor(mode, win, mon)) await hypr.dispatch(expr);
  }
}
