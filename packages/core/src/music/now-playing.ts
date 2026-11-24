/**
 * MU2: the quiet "now playing" line above the chat's message box. Code asks playerctl what is
 * playing every few seconds while a chat screen is open, and tells the screens only when it
 * changes. The title and artist are the song publisher's words, so they only ever go to the
 * screen, as plain text: never into a chat item, the store, the audit log or a model's context.
 * Code still strips control and direction characters and caps their length, so a strange name
 * can't break the line or flip its text.
 */
import type { NowPlaying as NowPlayingLine } from '@aios/shared';
import { type MusicPlayer, type NowPlaying, playerLabel } from './player.js';

/** Control characters, line and paragraph separators, and the bidi marks, embeddings, overrides and isolates. */
const STRIP = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g;
export const NOW_PLAYING_MAX = 120;

/** One field of the song, cleaned for the line (exported for tests). */
export function cleanSongText(s: string): string {
  const t = s.replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
  return t.length > NOW_PLAYING_MAX ? `${t.slice(0, NOW_PLAYING_MAX - 1).trimEnd()}…` : t;
}

/** What the line shows for playerctl's answer; null hides it (nothing open, stopped, or nothing named). */
export function nowPlayingLine(n: NowPlaying | null): NowPlayingLine {
  if (!n || n.status === 'Stopped') return null;
  const title = cleanSongText(n.title);
  const artist = cleanSongText(n.artist);
  if (!title && !artist) return null;
  return { playing: n.status === 'Playing', title, artist, app: playerLabel(n.player).slice(0, 40) };
}

const same = (a: NowPlayingLine, b: NowPlayingLine) =>
  a === b || (a !== null && b !== null && a.playing === b.playing && a.title === b.title && a.artist === b.artist && a.app === b.app);

export class NowPlayingWatch {
  private line: NowPlayingLine = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    private readonly o: {
      player: Pick<MusicPlayer, 'nowPlaying'>;
      /** Tells every open chat screen. */
      broadcast: (line: NowPlayingLine) => void;
      /** Whether a chat screen is open; nobody looking means playerctl isn't asked. */
      watched: () => boolean;
      intervalMs?: number;
    },
  ) {}

  current(): NowPlayingLine {
    return this.line;
  }

  /** Asks once, and tells the screens if the line changed. Never throws. */
  async check(): Promise<void> {
    if (this.busy || !this.o.watched()) return;
    this.busy = true;
    try {
      const next = nowPlayingLine(await this.o.player.nowPlaying(AbortSignal.timeout(5000)).catch(() => null));
      if (same(next, this.line)) return;
      this.line = next;
      this.o.broadcast(next);
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
