/**
 * W1: system features pinned as tiles along the bottom of the chat screen (checkup, the brief,
 * to-dos). Each tile is a glance written by code from the feature's own numbers: no model, no
 * mail, invite or document text (the brief tile shows counts and times only; the to-do tile shows
 * the user's own items). A click on a tile opens the full card, like the matching command.
 *
 * Which tiles are pinned starts from `[widgets] pinned` and then follows the user's own choices:
 * /pin and /unpin typed in the chat, or a click on a tile's pin buttons. Both reach `setPinned`
 * only through Shell.handle with a UI message; there is no tool for it, so neither the model nor
 * text from outside can change what is pinned (test: packages/core/test/widgets.test.ts).
 */
import { WIDGET_KINDS, WidgetKind, type WidgetTile, type Widgets } from '@aios/shared';
import { z } from 'zod';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';

/** What a feature gives its tile: short lines written by code, and whether something wants a look. */
export interface Glance {
  lines: string[];
  attention: boolean;
}

export interface WidgetSources {
  checkup?: () => Promise<Glance>;
  brief?: () => Promise<Glance>;
  todos?: () => Glance | Promise<Glance>;
}

export interface WidgetBoardOptions {
  /** `[widgets] pinned`: where a fresh install starts. */
  defaults: readonly WidgetKind[];
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  audit: AuditLog;
  sources: WidgetSources;
  /** Sends the tiles to every open chat. */
  broadcast: (widgets: Widgets) => void;
}

const SETTING = 'widgets.pinned';
const Pinned = z.array(WidgetKind).max(WIDGET_KINDS.length);

export const WIDGET_TITLES: Record<WidgetKind, string> = { checkup: 'Checkup', brief: 'Today', todos: 'To-dos' };

/** How to turn a feature on, for its tile when it is off. */
const OFF_LINES: Record<WidgetKind, string> = {
  checkup: 'Off: [assistant] in your config',
  brief: 'Off: [brief] in your config',
  todos: 'Off: [todos] in your config',
};

/** The words /pin and /unpin take for each widget. */
const NAMES: Record<string, WidgetKind> = {
  checkup: 'checkup',
  'check-up': 'checkup',
  system: 'checkup',
  brief: 'brief',
  today: 'brief',
  'daily brief': 'brief',
  'morning brief': 'brief',
  todos: 'todos',
  todo: 'todos',
  'to-dos': 'todos',
  'to-do': 'todos',
  'to do': 'todos',
  'to-do list': 'todos',
  'todo list': 'todos',
  list: 'todos',
};

/** The widget a /pin or /unpin argument names, or null. */
export function widgetByName(text: string): WidgetKind | null {
  return NAMES[text.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

export class WidgetBoard {
  private last: Widgets;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private soonTimer: NodeJS.Timeout | undefined;

  constructor(private readonly o: WidgetBoardOptions) {
    this.last = { pinned: this.pinned(), tiles: [] };
  }

  /** The pinned widgets, in order: the user's saved choice, or the config's defaults. */
  pinned(): WidgetKind[] {
    const raw = this.o.store.getSetting(SETTING);
    if (raw !== null) {
      try {
        const parsed = Pinned.safeParse(JSON.parse(raw));
        if (parsed.success) return [...new Set(parsed.data)];
      } catch {
        // A damaged setting falls back to the defaults.
      }
    }
    return [...new Set(this.o.defaults)];
  }

  /**
   * Pins or unpins one widget. Only Shell calls this, for /pin, /unpin and the tile's own
   * buttons: the user's typing or clicks. Returns a line for the chat.
   */
  setPinned(widget: WidgetKind, pinned: boolean, via: 'command' | 'click'): string {
    const now = this.pinned();
    const has = now.includes(widget);
    const name = WIDGET_TITLES[widget];
    if (has === pinned) return pinned ? `${name} is already pinned.` : `${name} isn't pinned.`;
    const next = pinned ? [...now, widget] : now.filter((w) => w !== widget);
    this.o.store.setSetting(SETTING, JSON.stringify(next));
    this.o.audit.append({ kind: 'widgets', event: pinned ? 'pinned' : 'unpinned', widget, via });
    this.last = { pinned: next, tiles: this.last.tiles.filter((t) => next.includes(t.widget)) };
    this.o.broadcast(this.last);
    void this.refresh();
    return pinned ? `Pinned ${name} to the bottom of the screen.` : `Took ${name} off the bottom of the screen. /pin ${widget} brings it back.`;
  }

  /** The tiles as last worked out, for a chat that just connected. */
  current(): Widgets {
    return this.last;
  }

  private async tile(widget: WidgetKind): Promise<WidgetTile> {
    const title = WIDGET_TITLES[widget];
    const source = this.o.sources[widget];
    if (!source) return { widget, title, lines: [OFF_LINES[widget]], tone: 'off' };
    try {
      const g = await source();
      return { widget, title, lines: g.lines.slice(0, 4).map(clip), tone: g.attention ? 'attention' : 'normal' };
    } catch (err) {
      this.o.audit.append({ kind: 'widgets', event: 'tile_error', widget, error: (err as Error).message.slice(0, 200) });
      return { widget, title, lines: ["Couldn't read it just now"], tone: 'normal' };
    }
  }

  /** Works out every pinned tile again and sends them. Calls while one runs are folded into one more. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.again = false;
          const pinned = this.pinned();
          const tiles = await Promise.all(pinned.map((w) => this.tile(w)));
          this.last = { pinned, tiles };
          this.o.broadcast(this.last);
        } while (this.again);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** A refresh shortly, e.g. after a to-do changed; several in a row make one. */
  soon(ms = 300): void {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => void this.refresh(), ms);
    this.soonTimer.unref?.();
  }

  private timer: NodeJS.Timeout | undefined;

  start(intervalMs = 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soonTimer);
  }
}
