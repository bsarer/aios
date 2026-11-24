/** Photo frames: the page asks only for a frame's number, its turn and the folder's version (frames.ts). */
import { describe, expect, it } from 'vitest';
import { frameSources } from '../src/frames';

describe('frameSources', () => {
  it('names only the frame, its turn and the version, and the frames change one after another', () => {
    const period = 15 * 60_000;
    const f = { count: 2, minutes: 15, version: 'abcdefabcdef' };
    expect(frameSources(f, 100 * period)).toEqual(['/frame/0?t=100&v=abcdefabcdef', '/frame/1?t=99&v=abcdefabcdef']);
    expect(frameSources(f, 100 * period + period / 2)).toEqual(['/frame/0?t=100&v=abcdefabcdef', '/frame/1?t=100&v=abcdefabcdef']);
    expect(frameSources(null, 0)).toEqual([]);
  });
});
