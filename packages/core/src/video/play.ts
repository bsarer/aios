/**
 * Watching videos in mpv (V1). Code decides everything mpv gets: a fixed set of options,
 * then `--` (the end of options, so nothing after it can be read as one), then exactly one
 * absolute path that F1's FileRoots resolved or one https link checked by checkVideoLink().
 * Started the way S3 starts apps, through `uwsm-app --` when Omarchy has it, so the window
 * outlives aios-core.
 */
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { onPath } from '../apps/desktop.js';

/** The name the window rules (apps/window.ts) know mpv's start by. */
export const PLAYER_NAME = 'mpv';

export type VideoSource = { kind: 'file'; path: string } | { kind: 'link'; url: string };
export type PlayVideo = (source: VideoSource) => Promise<void>;

export class VideoError extends Error {}

const EARLY_EXIT_MS = 1500;
const MAX_LINK_CHARS = 2000;

/**
 * Options for every start. `--force-window=immediate` opens the window at once, even while a
 * link is still loading; `--no-terminal` keeps mpv from reading the service's stdin.
 */
const BASE_OPTIONS = ['--force-window=immediate', '--no-terminal'];
/** A local file never goes through yt-dlp. */
const FILE_OPTIONS = [...BASE_OPTIONS, '--ytdl=no'];

/** The arguments mpv gets for a source (exported for tests). */
export function playerArgs(source: VideoSource): string[] {
  if (source.kind === 'file') {
    if (!isAbsolute(source.path)) throw new VideoError('internal: video paths must be absolute');
    return [...FILE_OPTIONS, '--', source.path];
  }
  return [...BASE_OPTIONS, '--', checkVideoLink(source.url).href];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.home.arpa', '.localdomain'];

/**
 * A link mpv may open: https only, a site's name (no IP address, no local name), no user name
 * or password, no port. So a link can't reach aios-core, the router or anything else on this
 * computer or network, and can't hand mpv another protocol (file://, av://, lavfi://...).
 */
export function checkVideoLink(input: string): URL {
  const raw = input.trim();
  if (!raw || raw.length > MAX_LINK_CHARS || /[\s\p{Cc}\p{Cf}]/u.test(raw)) throw new VideoError('that is not a link');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new VideoError('that is not a link');
  }
  if (u.protocol !== 'https:') throw new VideoError('only https:// links can be played');
  if (u.username || u.password) throw new VideoError('links with a user name or password are not played');
  if (u.port) throw new VideoError('links with a port number are not played');
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4.test(host)) throw new VideoError("links to an IP address are not played; use the site's name");
  if (!host.includes('.') || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) throw new VideoError('links to this computer or the local network are not played');
  return u;
}

/** ISO media brands that are pictures (HEIC, AVIF), not videos. */
const PICTURE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

/** The container of a video file by its first bytes, or null when it isn't one mpv should get. */
export function videoFormat(b: Buffer): string | null {
  const at = (i: number, s: number[]) => s.every((x, j) => b[i + j] === x);
  const text = (i: number, n: number) => b.subarray(i, i + n).toString('latin1');
  if (text(4, 4) === 'ftyp') return PICTURE_BRANDS.has(text(8, 4).trim().toLowerCase()) ? null : 'MP4';
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return 'Matroska/WebM';
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'AVI ') return 'AVI';
  if (text(0, 3) === 'FLV') return 'FLV';
  if (at(0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return 'WMV';
  if (at(0, [0x00, 0x00, 0x01, 0xba]) || at(0, [0x00, 0x00, 0x01, 0xb3])) return 'MPEG';
  if (b.length > 188 && b[0] === 0x47 && b[188] === 0x47) return 'MPEG-TS';
  if (text(0, 4) === 'OggS') return 'Ogg';
  return null;
}

/** Reads a file's first bytes and names its video container, or null. */
export async function videoFormatOf(path: string): Promise<string | null> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    return videoFormat(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function createVideoPlayer(player: string, env: NodeJS.ProcessEnv = process.env): PlayVideo {
  return async (source) => {
    const args = playerArgs(source);
    const [cmd, all] = (await onPath('uwsm-app', env)) ? ['uwsm-app', ['--', player, ...args]] : [player, args];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, all, { shell: false, detached: true, stdio: 'ignore', env });
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, EARLY_EXIT_MS);
      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new VideoError(err.code === 'ENOENT' ? `${player} is not installed (or not on the service's PATH)` : `${cmd} could not start: ${err.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new VideoError(`mpv could not play it (exit code ${code ?? 'unknown'})`));
      });
    });
  };
}
