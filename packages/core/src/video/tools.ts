/**
 * video_play (V1): plays one video in mpv, away from the chat like any app (S7). Device
 * tier, like open_app: it runs from the user's own message, is rate limited and refused
 * while paused, and while an email or other outside text is in view it becomes a confirm
 * card instead (systemTools wires that), so a link in an email never starts on its own.
 *
 * A file must be inside `[files] roots` (F1's FileRoots: real path, no link leading out, no
 * hidden files) and be a video by its first bytes. A link must pass checkVideoLink(). The
 * model gets no file name back: names come from the disk, and the user sees mpv's window.
 */
import type { ChatWindow } from '../apps/window.js';
import type { FileRoots } from '../files/roots.js';
import { FilePathError } from '../files/roots.js';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { checkVideoLink, PLAYER_NAME, type PlayVideo, type VideoSource, VideoError, videoFormatOf } from './play.js';

export interface VideoToolsOptions {
  play: PlayVideo;
  window: Pick<ChatWindow, 'appStarting' | 'appFailed'>;
  /** F1's folders; without them only links can be played. */
  roots?: FileRoots;
  /** `[video] links`. */
  links: boolean;
}

export interface VideoPlayArgs {
  path?: string;
  url?: string;
}

export function videoTools(o: VideoToolsOptions): RegisteredTool[] {
  return [
    {
      def: toolByName('video_play')!,
      label: 'Starting the video…',
      // A link's path and query can carry someone's tokens: the audit log keeps its site only.
      auditArgs: (args) => {
        const a = args as VideoPlayArgs;
        if (a.url === undefined) return { path: a.path };
        try {
          return { host: new URL(a.url).hostname };
        } catch {
          return { host: null };
        }
      },
      // Looking a video up (files_list, files_search) puts file names in view. Playing a file
      // from the user's own folders then is harmless, so it still runs at once; a link waits for a card.
      runWithDocuments: (args) => (args as VideoPlayArgs).url === undefined,
      async handler(args) {
        const a = args as VideoPlayArgs;
        let source: VideoSource;
        let audit: Record<string, unknown>;
        try {
          if (a.url !== undefined) {
            if (!o.links) return 'Error: playing links is turned off in config [video] links. Only video files in the allowed folders can be played.';
            const u = checkVideoLink(a.url);
            source = { kind: 'link', url: u.href };
            // The host only: a link's path and query can carry someone's tokens.
            audit = { host: u.hostname };
          } else {
            if (!o.roots) return 'Error: files are turned off in config [files], so only links can be played.';
            const f = await o.roots.resolve(a.path ?? '', 'file');
            const format = await videoFormatOf(f.path);
            if (!format) return 'Error: that file is not a video mpv can play here (MP4, MKV, WebM, AVI, MOV, WMV, FLV, MPEG or Ogg). Call files_list or files_search to find the right one.';
            source = { kind: 'file', path: f.path };
            audit = { path: f.path, format };
          }
        } catch (err) {
          if (err instanceof VideoError || err instanceof FilePathError) return `Error: ${err.message}.`;
          throw err;
        }
        const at = await o.window.appStarting(PLAYER_NAME);
        try {
          await o.play(source);
        } catch (err) {
          await o.window.appFailed(PLAYER_NAME);
          throw new Error(`mpv didn't start: ${(err as Error).message}`);
        }
        const where = at && 'screen' in at ? ` on screen ${at.screen}` : at ? ` on workspace ${at.workspace}; Super+Shift+H or the AI button in the top bar brings the chat back` : '';
        const wait = source.kind === 'link' ? ' A link can take a few seconds to load.' : '';
        return { content: `The video is playing in mpv${where}.${wait} Say it in one short line.`, audit: { ...audit, ...(at ?? {}) } };
      },
    },
  ];
}
