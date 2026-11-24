/**
 * Focus sounds, made in the page with Web Audio: no audio files, nothing downloaded, nothing to
 * license. Each sound is worked out once from seeded noise into a loop of LOOP_SECONDS whose end
 * runs smoothly into its start, then played on repeat. aios-core only says which sound and how
 * loud (the `focus` event); this file never sends anything back.
 *
 * - rain: soft hiss with many small drops, a few louder, and a slow rise and fall.
 * - waves: a deep rumble with swells that build and break, and a wash at each crest.
 * - brown: brown noise, the deep steady kind (white noise with the highs rolled off).
 */
import type { Focus, FocusSound } from '@aios/shared/protocol';

export const LOOP_SECONDS = 24;
/** Samples taken from the end of the render and blended into the start, so the loop has no seam. */
const BLEND_SECONDS = 1;
/** Every sound is brought to this loudness (RMS), so switching doesn't jump. */
export const TARGET_RMS = 0.12;
const PEAK = 0.95;

/** mulberry32: a small seeded generator, so a sound is the same each time it is made. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass coefficient for a cutoff in Hz. */
const lowpassK = (hz: number, rate: number) => 1 - Math.exp((-2 * Math.PI * hz) / rate);

function brown(out: Float32Array, rand: () => number, rate: number): void {
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    b = (b + 0.02 * (rand() * 2 - 1)) / 1.02;
    out[i] = b;
  }
  // Take out the slow drift (a gentle high-pass at about 20 Hz) so the speaker isn't pushed.
  let lp = 0;
  const k = lowpassK(20, rate);
  for (let i = 0; i < out.length; i++) {
    lp += k * (out[i]! - lp);
    out[i] = out[i]! - lp;
  }
}

function rain(out: Float32Array, rand: () => number, rate: number, loopLen: number): void {
  // Pink noise (Paul Kellet's filter), high-passed: the steady hiss of rain in the distance.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let lp = 0;
  const hp = lowpassK(300, rate);
  let top = 0;
  const air = lowpassK(7000, rate);
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    lp += hp * (pink - lp);
    top += air * (pink - lp - top);
    // A slow rise and fall, a whole number of times per loop so the loop closes.
    const t = (i % loopLen) / loopLen;
    const swell = 0.8 + 0.12 * Math.sin(2 * Math.PI * 2 * t) + 0.08 * Math.sin(2 * Math.PI * 5 * t + 1);
    out[i] = top * swell;
  }
  // Drops: short ringing taps at random times, most of them faint.
  const perSecond = 140;
  const drops = Math.round((out.length / rate) * perSecond);
  for (let d = 0; d < drops; d++) {
    const at = Math.floor(rand() * out.length);
    const amp = 0.05 + 0.6 * rand() ** 4;
    const hz = 1200 + rand() * 3300;
    const decay = (0.0015 + rand() * 0.004) * rate;
    const len = Math.min(Math.floor(decay * 5), out.length - at);
    const step = (2 * Math.PI * hz) / rate;
    for (let j = 0; j < len; j++) out[at + j]! += amp * Math.exp(-j / decay) * Math.sin(step * j);
  }
}

/** Wave lengths in seconds; they add up to LOOP_SECONDS so the swells line up when the loop repeats. */
const WAVES = [7, 5.5, 6.5, 5];

function waves(out: Float32Array, rand: () => number, rate: number, loopLen: number): void {
  const total = WAVES.reduce((a, b) => a + b, 0);
  let b = 0;
  let wash = 0;
  for (let i = 0; i < out.length; i++) {
    // Where this sample falls in the set of waves.
    let s = ((i % loopLen) / loopLen) * total;
    let p = 0;
    for (const len of WAVES) {
      if (s < len) {
        p = s / len;
        break;
      }
      s -= len;
    }
    // Builds slowly, breaks, then drains away.
    const swell = p < 0.4 ? (p / 0.4) ** 2 : Math.exp(-(p - 0.4) * 6);
    const w = rand() * 2 - 1;
    b = (b + 0.02 * w) / 1.02;
    // The wash gets brighter as the wave breaks.
    wash += lowpassK(300 + 2200 * swell, rate) * (w - wash);
    out[i] = b * 3 * (0.25 + 0.75 * swell) + wash * 0.35 * swell * swell;
  }
}

/**
 * The sound as one loop of `seconds` at `rate`: its end runs into its start, its loudness is
 * TARGET_RMS and no sample goes past ±PEAK.
 */
export function renderFocusSound(sound: FocusSound, rate: number, seconds = LOOP_SECONDS, seed = 7): Float32Array<ArrayBuffer> {
  const n = Math.round(rate * seconds);
  const blend = Math.min(Math.round(rate * BLEND_SECONDS), Math.floor(n / 2));
  const raw = new Float32Array(new ArrayBuffer((n + blend) * 4));
  const rand = seeded(seed + FOCUS_SOUND_SEEDS[sound]);
  if (sound === 'brown') brown(raw, rand, rate);
  else if (sound === 'rain') rain(raw, rand, rate, n);
  else waves(raw, rand, rate, n);
  // The loop: the render's last `blend` samples, which carry on from sample n - 1, fade out over
  // the start while the start fades in (equal power), so sample n - 1 runs straight into sample 0.
  const out = raw.slice(0, n);
  for (let i = 0; i < blend; i++) {
    const x = i / blend;
    out[i] = raw[i]! * Math.sin((x * Math.PI) / 2) + raw[n + i]! * Math.cos((x * Math.PI) / 2);
  }
  let sum = 0;
  let peak = 0;
  for (const v of out) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = Math.sqrt(sum / n);
  const gain = rms > 0 ? Math.min(TARGET_RMS / rms, PEAK / peak) : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * gain;
  return out;
}

const FOCUS_SOUND_SEEDS: Record<FocusSound, number> = { rain: 11, waves: 23, brown: 37 };

/** The slider's 0-100 as a gain: squared, because ears hear loudness that way. */
export const volumeGain = (volume: number) => (Math.max(0, Math.min(100, volume)) / 100) ** 2;

const FADE_IN = 1.5;
const FADE_OUT = 0.8;

/**
 * Plays what aios-core says. The browser only lets a page make sound after the user has clicked
 * or typed in it; Astra's own chat always has (a /focus or a tile click), and otherwise the sound
 * starts at the next key or click.
 */
export class FocusPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private playing: { sound: FocusSound; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly buffers = new Map<FocusSound, AudioBuffer>();
  private unlock: (() => void) | null = null;

  apply(focus: Focus | null): void {
    const want = focus?.sound ?? null;
    if (!want) return this.stop();
    const ctx = this.context();
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(volumeGain(focus!.volume), ctx.currentTime, 0.08);
    if (this.playing?.sound === want) return;
    this.stop();
    let buffer = this.buffers.get(want);
    if (!buffer) {
      const data = renderFocusSound(want, ctx.sampleRate);
      buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buffer.copyToChannel(data, 0);
      this.buffers.set(want, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_IN);
    src.connect(gain).connect(this.master);
    src.start();
    this.playing = { sound: want, src, gain };
  }

  private stop(): void {
    const p = this.playing;
    if (!p || !this.ctx) return;
    this.playing = null;
    const t = this.ctx.currentTime;
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.setValueAtTime(p.gain.gain.value, t);
    p.gain.gain.linearRampToValueAtTime(0, t + FADE_OUT);
    p.src.stop(t + FADE_OUT + 0.05);
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return null;
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
      if (!this.unlock) {
        const ctx = this.ctx;
        const unlock = () => {
          void ctx.resume().catch(() => undefined);
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('keydown', unlock);
          this.unlock = null;
        };
        this.unlock = unlock;
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', unlock);
      }
    }
    return this.ctx;
  }

  close(): void {
    this.stop();
    if (this.unlock) {
      window.removeEventListener('pointerdown', this.unlock);
      window.removeEventListener('keydown', this.unlock);
      this.unlock = null;
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.buffers.clear();
  }
}
