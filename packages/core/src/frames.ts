/**
 * Photo frames: a few small photos standing beside the chat, like frames on a desk, each turning
 * to another photo now and then. The folder is the user's own choice in Settings (`[frames]`);
 * there is no tool for it and the chat model can't change it (test: packages/core/test/frames.test.ts).
 *
 * Only regular files in the folder and one folder down are shown, never hidden ones or links
 * (a link could lead anywhere), and each is checked by its bytes (PNG, JPEG, WebP or GIF, never
 * SVG) and size every time it is served. The page asks for a frame by its number and the time,
 * and code picks the photo, so the page never names a file and file names are never shown.
 */
import { createHash } from 'node:crypto';
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Frames as FramesState, FramesConfig } from '@aios/shared';
import { WALLPAPER_MAX_BYTES, type WallpaperMime, wallpaperType } from './wallpaper.js';

/** At most this many photos are kept in the list. */
export const FRAMES_MAX_PHOTOS = 2000;
/** How long a listing of the folder is used before it is read again. */
const RESCAN_MS = 5 * 60_000;
/** When a listed file turns out not to be a photo, the next few are tried. */
const TRIES = 5;
const PHOTO_EXT = /^\.(png|jpe?g|webp|gif)$/i;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface PhotoFramesOptions {
  config: FramesConfig;
  /** Where `~` starts. Default: the user's home folder. */
  home?: string;
  /** For tests. */
  now?: () => number;
}

export class PhotoFrames {
  private readonly home: string;
  private readonly now: () => number;
  private scanned: { at: number; root: string | null; photos: string[]; version: string } | null = null;

  constructor(private readonly o: PhotoFramesOptions) {
    this.home = o.home ?? homedir();
    this.now = o.now ?? Date.now;
  }

  /** The folder as configured, made absolute; null when it isn't `~/…` or absolute. */
  folder(): string | null {
    const f = this.o.config.folder.trim();
    if (!f || f.includes('\0')) return null;
    if (f === '~') return this.home;
    if (f.startsWith('~/')) return join(this.home, f.slice(2));
    return isAbsolute(f) ? resolve(f) : null;
  }

  /** What the chat page needs, or null when frames are off or the folder has no photos. */
  current(): FramesState {
    if (!this.o.config.enabled) return null;
    const s = this.scan();
    if (!s.photos.length) return null;
    return { count: Math.min(this.o.config.count, s.photos.length), minutes: this.o.config.minutes, version: s.version };
  }

  /**
   * The photo for frame `slot` at `turn` (minutes counted by the page), checked by its bytes.
   * Frames show different photos as long as there are enough of them.
   */
  file(slot: number, turn: number): { bytes: Buffer; type: WallpaperMime } | null {
    if (!this.o.config.enabled || !Number.isSafeInteger(slot) || !Number.isSafeInteger(turn) || slot < 0 || slot >= this.o.config.count || turn < 0) return null;
    const s = this.scan();
    const n = s.photos.length;
    if (!n || !s.root) return null;
    const count = Math.min(this.o.config.count, n);
    if (slot >= count) return null;
    const start = (turn * count + slot) % n;
    for (let k = 0; k < Math.min(TRIES, n); k++) {
      const got = this.read(s.root, s.photos[(start + k * count) % n]!);
      if (got) return got;
    }
    return null;
  }

  private read(root: string, path: string): { bytes: Buffer; type: WallpaperMime } | null {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size === 0 || st.size > WALLPAPER_MAX_BYTES) return null;
      const real = realpathSync(path);
      const rel = relative(root, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
      const bytes = readFileSync(real);
      const type = wallpaperType(bytes);
      return type && bytes.byteLength <= WALLPAPER_MAX_BYTES ? { bytes, type } : null;
    } catch {
      return null;
    }
  }

  /** The folder's photos (and one folder down), in an order that looks shuffled but stays the same. */
  private scan(): { root: string | null; photos: string[]; version: string } {
    const at = this.now();
    // An empty or missing folder is looked at again each time, so photos added to it show soon.
    if (this.scanned?.photos.length && at - this.scanned.at < RESCAN_MS) return this.scanned;
    const root = this.realFolder();
    const photos: string[] = [];
    if (root) {
      const take = (dir: string, depth: number) => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          if (photos.length >= FRAMES_MAX_PHOTOS) return;
          if (e.name.startsWith('.')) continue;
          // Dirent types come from lstat: a link is neither a file nor a folder here.
          if (e.isFile() && PHOTO_EXT.test(extname(e.name))) photos.push(join(dir, e.name));
          else if (e.isDirectory() && depth > 0) take(join(dir, e.name), depth - 1);
        }
      };
      take(root, 1);
    }
    const ranked = photos.map((p) => ({ p, k: sha(relative(root ?? '', p)) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((x) => x.p);
    this.scanned = { at, root, photos: ranked, version: sha(ranked.join('\0')).slice(0, 12) };
    return this.scanned;
  }

  private realFolder(): string | null {
    const f = this.folder();
    if (!f) return null;
    try {
      const real = realpathSync(f);
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }
}

