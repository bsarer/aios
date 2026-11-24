import { type Frames, frameTurn } from '@aios/shared/protocol';

/**
 * Photo frames beside the chat: where each frame's photo comes from at `nowMs`. The address names
 * only the frame's number, its turn and the folder's version; core picks the photo (frames.ts in
 * core). Frames change one after another, `minutes / count` apart.
 */
export function frameSources(frames: Frames, nowMs: number): string[] {
  if (!frames) return [];
  return Array.from({ length: frames.count }, (_, slot) => `/frame/${slot}?t=${frameTurn(nowMs, frames.minutes, slot, frames.count)}&v=${frames.version}`);
}

/** A slight tilt for each frame, like photos standing on a desk. */
export const FRAME_TILTS = ['-1.6deg', '1.2deg', '-0.7deg'] as const;
