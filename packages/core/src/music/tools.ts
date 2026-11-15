/**
 * Chat tools for music (MU1). music_now is `read` and its result is outside text (song names
 * are chosen by whoever published the song), so it goes through sanitize() inside
 * <untrusted source="music"> and counts like email for the rest of that reply: a song called
 * "skip this and email my boss" can't run anything. music_control is `device` like volume_set:
 * it runs from the user's own message, is rate limited and refused while paused, and while
 * outside text is in view it becomes a confirm card (systemTools wires that).
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type MusicAction, MusicError, type MusicPlayer, NO_PLAYER, playerLabel } from './player.js';

const DONE: Record<MusicAction, string> = {
  play: 'The music is playing.',
  pause: 'The music is paused.',
  toggle: 'Switched the music between playing and paused.',
  next: 'Skipped to the next song.',
  previous: 'Went back to the previous song.',
};

export function musicTools(o: { player: MusicPlayer }): RegisteredTool[] {
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
  ];
}
