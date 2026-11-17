/**
 * Chat tools for music (MU1). music_now is `read` and its result is outside text (song names
 * are chosen by whoever published the song), so it goes through sanitize() inside
 * <untrusted source="music"> and counts like email for the rest of that reply: a song called
 * "skip this and email my boss" can't run anything. music_control is `device` like volume_set:
 * it runs from the user's own message, is rate limited and refused while paused, and while
 * outside text is in view it becomes a confirm card (systemTools wires that).
 *
 * music_play_song (MU2) is `device` too, so it gets the same limits and the same confirm card.
 * Code searches Spotify and picks the match; what comes back to the model never holds the
 * match's name (a publisher's words), only the words the model asked for, so the result is not
 * outside text. music_now says which song it was, inside <untrusted>.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type MusicAction, MusicError, type MusicPlayer, NO_PLAYER, playerLabel } from './player.js';
import { describeSpotifyError, SpotifyError, type SpotifySearch } from './spotify.js';

const DONE: Record<MusicAction, string> = {
  play: 'The music is playing.',
  pause: 'The music is paused.',
  toggle: 'Switched the music between playing and paused.',
  next: 'Skipped to the next song.',
  previous: 'Went back to the previous song.',
};

/** `spotify` is left out until `astra spotify-login` has set `[music.spotify] clientId`. */
export function musicTools(o: { player: MusicPlayer; spotify?: Pick<SpotifySearch, 'findTrack'> }): RegisteredTool[] {
  return [
    {
      def: toolByName('music_now')!,
      label: 'Checking the music…',
      untrustedOutput: true,
      async handler(_args, ctx) {
        const n = await o.player.nowPlaying(ctx.signal);
        if (!n) return `Nothing is playing: ${NO_PLAYER}.`;
        // The status and the app's label are written by code; the song's own words are not.
        const song = sanitize({ text: [`title: ${n.title}`, `artist: ${n.artist}`, `album: ${n.album}`].join('\n') }, { maxChars: 600 });
        return {
          content: `${playerLabel(n.player)} is ${n.status.toLowerCase()}. The song, as its publisher named it:\n${wrapUntrusted('music', 'now-playing', song)}`,
          audit: { status: n.status, player: playerLabel(n.player) },
        };
      },
    },
    {
      def: toolByName('music_control')!,
      label: 'Changing the music…',
      async handler(args, ctx) {
        const { action } = args as { action: MusicAction };
        try {
          await o.player.control(action, ctx.signal);
        } catch (err) {
          if (err instanceof MusicError) return `Error: ${err.message}.`;
          throw err;
        }
        return { content: `${DONE[action]} Say it in one short line.`, audit: { action } };
      },
    },
    {
      def: toolByName('music_play_song')!,
      label: 'Finding the song on Spotify…',
      // The audit log keeps the words' length only, like a web search's.
      auditArgs: () => ({}),
      async handler(args, ctx) {
        const { song } = args as { song: string };
        // The words as asked, cleaned by code; the model (or the card) gave them, so they are not new outside text.
        const asked = song.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        const audit = (found: boolean, error?: string) => ({ chars: asked.length, found, ...(error ? { error } : {}) });
        if (!o.spotify) return { content: `Error: ${describeSpotifyError(new SpotifyError('not_set_up', ''))}.`, audit: audit(false, 'not_set_up') };
        let track;
        try {
          track = await o.spotify.findTrack(asked, ctx.signal);
        } catch (err) {
          if (err instanceof SpotifyError || (err as Error)?.name === 'KeyringError') {
            return { content: `Error: ${describeSpotifyError(err)}.`, audit: audit(false, err instanceof SpotifyError ? err.kind : 'keyring') };
          }
          throw err;
        }
        if (!track) return { content: `Error: Spotify found no song for “${asked}”.`, audit: audit(false) };
        try {
          await o.player.playTrack(track.id, ctx.signal);
        } catch (err) {
          if (err instanceof MusicError) return { content: `Error: ${err.message}.`, audit: audit(true, 'not_open') };
          throw err;
        }
        return {
          content: `Spotify is playing its best match for “${asked}”. Say so in one short line. To say which song it is, call music_now.`,
          audit: audit(true),
        };
      },
    },
  ];
}
