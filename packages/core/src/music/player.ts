/**
 * The music that is playing (MU1): Spotify, or any MPRIS player, through playerctl. Code
 * decides every argument: the `--player` list from `[music] players` (checked by the config
 * schema and again here), then one command from MUSIC_ACTIONS or the fixed metadata format.
 * Nothing the model or a song says reaches playerctl.
 *
 * Song titles, artists and album names are chosen by whoever published the song (or named the
 * file, or the web page playing in a browser), so they are outside text: music/tools.ts hands
 * them to the model only sanitized and inside <untrusted source="music">.
 */
import type { Run } from '../system/run.js';
import { TRACK_ID } from './spotify.js';

export const MUSIC_ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous'] as const;
export type MusicAction = (typeof MUSIC_ACTIONS)[number];

/** playerctl's command for each action. */
const COMMAND: Record<MusicAction, string> = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', previous: 'previous' };

export type PlayStatus = 'Playing' | 'Paused' | 'Stopped';

export interface NowPlaying {
  status: PlayStatus;
  /** playerctl's name for the player, e.g. "spotify" or "chromium.instance1234". */
  player: string;
  artist: string;
  title: string;
  album: string;
}

export class MusicError extends Error {}

/** No player is running, or none of `[music] players` is. */
export const NO_PLAYER = 'no music player is open (start Spotify, or any player that works with playerctl)';

const SEP = '\u001f';
/** Fields are split on the unit separator, which song names don't use; a name that does only garbles its own line. */
const FORMAT = ['{{status}}', '{{playerName}}', '{{artist}}', '{{title}}', '{{album}}'].join(SEP);
const PLAYER_NAME = /^(%any|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** `--player=…` from `[music] players` (exported for tests). */
export function playerArg(players: readonly string[]): string {
  if (!players.length || players.some((p) => !PLAYER_NAME.test(p))) throw new MusicError('internal: bad [music] players');
  return `--player=${players.join(',')}`;
}

/** The arguments playerctl gets for an action (exported for tests). */
export function controlArgs(players: readonly string[], action: MusicAction): string[] {
  const command = COMMAND[action];
  if (!command) throw new MusicError(`internal: unknown action ${String(action)}`);
  return [playerArg(players), command];
}

/**
 * MU2: the arguments that make Spotify play one track: always the Spotify app itself (a
 * spotify: URI means nothing to other players), then `open` and a URI code builds from an id
 * of 22 letters and digits (exported for tests).
 */
export function openTrackArgs(trackId: string): string[] {
  if (!TRACK_ID.test(trackId)) throw new MusicError('internal: bad track id');
  return ['--player=spotify', 'open', `spotify:track:${trackId}`];
}

/** Spotify isn't running, so playerctl has nothing to open the song in. */
export const NO_SPOTIFY = "Spotify isn't open. Open it first (it has to be running to play a song), then ask again";

export function statusArgs(players: readonly string[]): string[] {
  return [playerArg(players), 'metadata', `--format=${FORMAT}`];
}

/** One line of `playerctl metadata --format`, or null when it isn't one. */
export function parseNowPlaying(stdout: string): NowPlaying | null {
  const line = stdout.split('\n').find((l) => l.includes(SEP));
  if (!line) return null;
  const [status = '', player = '', artist = '', title = '', album = ''] = line.split(SEP);
  if (status !== 'Playing' && status !== 'Paused' && status !== 'Stopped') return null;
  return { status, player, artist, title, album };
}

export interface MusicPlayer {
  /** What is playing, or null when no player is open. */
  nowPlaying(signal?: AbortSignal): Promise<NowPlaying | null>;
  /** Throws MusicError(NO_PLAYER) when no player is open. */
  control(action: MusicAction, signal?: AbortSignal): Promise<void>;
  /** MU2: plays one Spotify track. Throws MusicError(NO_SPOTIFY) when Spotify isn't running. */
  playTrack(trackId: string, signal?: AbortSignal): Promise<void>;
}

export function createMusicPlayer(run: Run, players: readonly string[]): MusicPlayer {
  // Checked once at start, so a bad config fails loudly instead of on the first song.
  playerArg(players);
  const opts = (signal?: AbortSignal) => ({ timeoutMs: 4000, ...(signal ? { signal } : {}) });
  return {
    async nowPlaying(signal) {
      const r = await run('playerctl', statusArgs(players), opts(signal));
      // playerctl exits non-zero with "No players found" (on stderr) when nothing is open.
      if (r.code !== 0) return null;
      return parseNowPlaying(r.stdout);
    },
    async control(action, signal) {
      const r = await run('playerctl', controlArgs(players, action), opts(signal));
      if (r.code !== 0) throw new MusicError(NO_PLAYER);
    },
    async playTrack(trackId, signal) {
      const r = await run('playerctl', openTrackArgs(trackId), opts(signal));
      if (r.code !== 0) throw new MusicError(NO_SPOTIFY);
    },
  };
}

/** A short plain line about what is playing, for the user's own /music (shown as text, never sent to a model). */
export function describeNowPlaying(n: NowPlaying | null): string {
  if (!n) return `Nothing is playing: ${NO_PLAYER}.`;
  const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').trim().slice(0, 200);
  const song = [clean(n.title) || 'an unnamed track', clean(n.artist) && `by ${clean(n.artist)}`].filter(Boolean).join(' ');
  const where = playerLabel(n.player);
  if (n.status === 'Stopped') return `${where} is stopped.`;
  return `${n.status === 'Playing' ? 'Playing' : 'Paused'}: ${song}${clean(n.album) ? ` (${clean(n.album)})` : ''}, in ${where}.`;
}

/** "spotify" → "Spotify"; "chromium.instance123" → "Chromium". Written by code from the player's bus name. */
export function playerLabel(player: string): string {
  const base = player.split('.')[0]?.replace(/[^A-Za-z0-9_-]/g, '') ?? '';
  return base ? base.charAt(0).toUpperCase() + base.slice(1, 40) : 'the music player';
}
