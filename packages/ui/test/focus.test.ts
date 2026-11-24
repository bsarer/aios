/** Focus sounds made in the page (focus.ts): each is a clean loop, the same loudness, never clipping. */
import { FOCUS_SOUNDS } from '@aios/shared/protocol';
import { describe, expect, it } from 'vitest';
import { LOOP_SECONDS, TARGET_RMS, renderFocusSound, seeded, volumeGain } from '../src/focus';

const RATE = 16_000;
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe('focus sounds', () => {
  for (const sound of FOCUS_SOUNDS) {
    describe(sound, () => {
      const a = renderFocusSound(sound, RATE);

      it('is one loop, all real numbers, inside ±1', () => {
        expect(a.length).toBe(RATE * LOOP_SECONDS);
        expect(a.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.95 + 1e-6)).toBe(true);
      });

      it('is about the same loudness as the others', () => {
        // Capped by the peak first only if a sound is very spiky; none of these should be.
        expect(rms(a)).toBeGreaterThan(TARGET_RMS * 0.8);
        expect(rms(a)).toBeLessThanOrEqual(TARGET_RMS * 1.001);
      });

      it('runs from its end into its start without a jump', () => {
        const steps = Array.from({ length: a.length - 1 }, (_, i) => Math.abs(a[i + 1]! - a[i]!)).sort((x, y) => x - y);
        const typical = steps[Math.floor(steps.length * 0.99)]!;
        expect(Math.abs(a[0]! - a[a.length - 1]!)).toBeLessThanOrEqual(typical);
      });

      it('comes out the same every time', () => {
        expect(renderFocusSound(sound, RATE, 2)).toEqual(renderFocusSound(sound, RATE, 2));
      });
    });
  }

  it('sounds different from each other', () => {
    const [x, y, z] = FOCUS_SOUNDS.map((s) => renderFocusSound(s, RATE, 2));
    expect(x).not.toEqual(y);
    expect(y).not.toEqual(z);
  });

  it('the volume slider is gentle at the bottom and full at the top', () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(50)).toBeCloseTo(0.25);
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(250)).toBe(1);
    expect(volumeGain(-5)).toBe(0);
  });

  it('the noise is seeded', () => {
    const r1 = seeded(3);
    const r2 = seeded(3);
    for (let i = 0; i < 10; i++) expect(r1()).toBe(r2());
  });
});
