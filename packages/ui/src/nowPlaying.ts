/**
 * MU2: the words of the quiet now-playing line. The title and artist are the song publisher's
 * words, already cleaned by core; they are shown as plain React text only, never as markup.
 */
import type { NowPlaying } from '@aios/shared';

export function nowPlayingText(n: NonNullable<NowPlaying>): string {
  const song = [n.title, n.artist].filter(Boolean).join(' · ');
  return n.playing ? song : `Paused · ${song}`;
}

/** The line's label for screen readers and its hover text, e.g. "Playing in Spotify". */
export function nowPlayingLabel(n: NonNullable<NowPlaying>): string {
  return `${n.playing ? 'Playing' : 'Paused'} in ${n.app}`;
}
