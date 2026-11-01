/**
 * L1: which windows are open and when each was last used, for the morning review. Hyprland
 * says which window has focus (`focusHistoryID` 0 in `hyprctl -j clients`); polling that once
 * a minute gives "not used for N hours" without hooking into the event socket the chat
 * window uses. Times are kept in memory, so after a restart every window counts from then.
 *
 * Closing goes through `hl.dsp.window.close`, the same as clicking a window's close button:
 * the app is asked to close and may ask about unsaved work (checked against Hyprland's
 * src/config/lua/bindings/LuaBindingsDispatchers.cpp and src/ipc/s1/Commands.cpp, 2026-11-01).
 */
import { CHAT_CLASS_PATTERN } from '@aios/shared';
import { z } from 'zod';
import type { HyprIpc } from '../apps/hyprland.js';

const CHAT_CLASS = new RegExp(CHAT_CLASS_PATTERN);

/** The fields of a `hyprctl -j clients` entry this needs; the rest is ignored. */
const ClientFields = z.looseObject({
  address: z.string().regex(/^0x[0-9a-f]+$/),
  class: z.string(),
  title: z.string().catch(''),
  pid: z.number().int().catch(-1),
  focusHistoryID: z.number().int().catch(-1),
  mapped: z.boolean().catch(true),
});

export interface OpenWindow {
  address: string;
  className: string;
  title: string;
  pid: number;
  /** When it last had focus, or when it was first seen if it hasn't since. */
  lastUsedAt: number;
}

export class WindowTracker {
  private readonly seen = new Map<string, { firstSeen: number; lastFocus: number | null; className: string; pid: number }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(
    private readonly hypr: HyprIpc,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  start(everyMs = 60_000): void {
    if (this.timer) return;
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => void this.poll().catch(() => undefined), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the windows once and updates when each was last used. Returns the open ones, chat left out. */
  async poll(): Promise<OpenWindow[]> {
    const now = this.now();
    const raw: unknown[] = await this.hypr.clients();
    const out: OpenWindow[] = [];
    const live = new Set<string>();
    for (const r of raw) {
      const c = ClientFields.safeParse(r);
      if (!c.success || !c.data.mapped || CHAT_CLASS.test(c.data.class)) continue;
      live.add(c.data.address);
      let s = this.seen.get(c.data.address);
      // An address reused by another program is a new window.
      if (!s || s.className !== c.data.class || s.pid !== c.data.pid) {
        s = { firstSeen: now, lastFocus: null, className: c.data.class, pid: c.data.pid };
        this.seen.set(c.data.address, s);
      }
      if (c.data.focusHistoryID === 0) s.lastFocus = now;
      out.push({ address: c.data.address, className: c.data.class, title: c.data.title.slice(0, 200), pid: c.data.pid, lastUsedAt: s.lastFocus ?? s.firstSeen });
    }
    for (const a of [...this.seen.keys()]) if (!live.has(a)) this.seen.delete(a);
    return out;
  }

  /** Asks the window to close, as its close button would. Only after checking it is still the same window. */
  async close(w: { address: string; className: string; pid: number }): Promise<'closed' | 'gone'> {
    if (!/^0x[0-9a-f]+$/.test(w.address)) throw new Error('bad window address');
    const now = await this.poll();
    const cur = now.find((x) => x.address === w.address);
    if (!cur || cur.className !== w.className || cur.pid !== w.pid) return 'gone';
    await this.hypr.dispatch(`hl.dsp.window.close({ window = "address:${w.address}" })`);
    return 'closed';
  }
}
