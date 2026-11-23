/**
 * The chat's wallpaper: a picture behind the chat, chosen by the user, never by the model.
 * Only Shell (for /wallpaper typed in the chat) and the setup window's Finish (Settings) change
 * it; there is no tool for it, so nothing in an email, invite or document can set or remove one
 * (test: packages/core/test/wallpaper.test.ts).
 *
 * The chosen picture is copied into the config folder (`wallpaper.img`, with `wallpaper.json`
 * for its type, version and dim), so it keeps working if the original moves, and the chat page
 * fetches only that one file from /wallpaper. A picture is PNG, JPEG, WebP or GIF by its bytes
 * (never SVG, which can carry script), at most WALLPAPER_MAX_BYTES.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type Wallpaper as WallpaperState, WallpaperDim } from '@aios/shared';
import { z } from 'zod';

export const WALLPAPER_MAX_BYTES = 15 * 1024 * 1024;
export const WALLPAPER_IMAGE = 'wallpaper.img';
export const WALLPAPER_META = 'wallpaper.json';

export type WallpaperMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** The picture's type by its first bytes, or null when it isn't one the chat shows. */
export function wallpaperType(b: Uint8Array): WallpaperMime | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  return null;
}

const Meta = z.strictObject({
  version: z.string().regex(/^[0-9a-f]{12}$/),
  type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dim: WallpaperDim,
});
type Meta = z.infer<typeof Meta>;

/** A refusal in words for the chat or the setup window. */
export type WallpaperResult = { ok: true; state: NonNullable<WallpaperState> } | { ok: false; error: string };

/** Checks picked bytes; the same check for the chat and the setup window. */
export function checkWallpaperBytes(bytes: Uint8Array): { ok: true; type: WallpaperMime } | { ok: false; error: string } {
  if (bytes.byteLength === 0) return { ok: false, error: 'That file is empty.' };
  if (bytes.byteLength > WALLPAPER_MAX_BYTES) return { ok: false, error: `That picture is too big (over ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB).` };
  const type = wallpaperType(bytes);
  if (!type) return { ok: false, error: 'That isn’t a picture I can use. Pick a PNG, JPEG, WebP or GIF.' };
  return { ok: true, type };
}

/**
 * A path the user typed: `~/…`, an absolute path, or one relative to the home folder, with
 * surrounding quotes and a file:// prefix taken off.
 */
export function wallpaperPath(text: string, home: string = homedir()): string | null {
  let t = text.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (t.startsWith('file://')) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
    } catch {
      return null;
    }
  }
  if (!t || t.includes('\0')) return null;
  if (t === '~' || t.startsWith('~/')) return join(home, t.slice(1));
  return isAbsolute(t) ? resolve(t) : resolve(home, t);
}

export class Wallpaper {
  constructor(
    /** The config folder. */
    private readonly dir: string,
  ) {}

  private get imagePath(): string {
    return join(this.dir, WALLPAPER_IMAGE);
  }

  private get metaPath(): string {
    return join(this.dir, WALLPAPER_META);
  }

  private meta(): Meta | null {
    try {
      const m = Meta.safeParse(JSON.parse(readFileSync(this.metaPath, 'utf8')));
      return m.success && existsSync(this.imagePath) ? m.data : null;
    } catch {
      return null;
    }
  }

  /** What the chat page needs, or null for no wallpaper. */
  current(): WallpaperState {
    const m = this.meta();
    return m ? { version: m.version, dim: m.dim } : null;
  }

  /** The picture for GET /wallpaper, checked again by its bytes. */
  file(): { bytes: Buffer; type: WallpaperMime } | null {
    const m = this.meta();
    if (!m) return null;
    try {
      const bytes = readFileSync(this.imagePath);
      const type = wallpaperType(bytes);
      return type && bytes.byteLength <= WALLPAPER_MAX_BYTES ? { bytes, type } : null;
    } catch {
      return null;
    }
  }

  /** Copies a picture in (the user's own choice). Keeps the current dim unless one is given. */
  set(bytes: Uint8Array, dim?: WallpaperDim): WallpaperResult {
    const c = checkWallpaperBytes(bytes);
    if (!c.ok) return c;
    const meta: Meta = { version: createHash('sha256').update(bytes).digest('hex').slice(0, 12), type: c.type, dim: dim ?? this.meta()?.dim ?? 'medium' };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.write(this.imagePath, bytes);
    this.write(this.metaPath, `${JSON.stringify(meta)}\n`);
    return { ok: true, state: { version: meta.version, dim: meta.dim } };
  }

  /** Reads a picture from a path the user typed. Only a regular file that is a picture by its bytes. */
  setFromPath(text: string, home: string = homedir()): WallpaperResult {
    const path = wallpaperPath(text, home);
    if (!path) return { ok: false, error: 'Tell me where the picture is, for example /wallpaper ~/Pictures/beach.jpg' };
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return { ok: false, error: `${path} isn’t a file.` };
      size = st.size;
    } catch {
      return { ok: false, error: `I can’t find ${path}.` };
    }
    if (size > WALLPAPER_MAX_BYTES) return { ok: false, error: `That picture is too big (over ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB).` };
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return { ok: false, error: `I can’t read ${path}.` };
    }
    return this.set(bytes);
  }

  /** How strongly the background covers the picture. */
  setDim(dim: WallpaperDim): WallpaperResult {
    const m = this.meta();
    if (!m) return { ok: false, error: 'There is no wallpaper yet. Set one first, for example /wallpaper ~/Pictures/beach.jpg' };
    this.write(this.metaPath, `${JSON.stringify({ ...m, dim })}\n`);
    return { ok: true, state: { version: m.version, dim } };
  }

  /** Takes the wallpaper away. Only the copy in the config folder is removed, never the original. */
  remove(): boolean {
    const had = this.meta() !== null;
    rmSync(this.metaPath, { force: true });
    rmSync(this.imagePath, { force: true });
    return had;
  }

  private write(path: string, data: Uint8Array | string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
