/**
 * V2: voice to text. The chat records 16 kHz mono 16-bit PCM and sends it as a WAV file, which
 * whisper.cpp's server reads without ffmpeg. The UI encodes with `encodeWav`; aios-core checks
 * the header with `readWav` before anything reaches the speech model. Audio is never stored.
 */
import { z } from 'zod';

/** Whisper's own rate (WHISPER_SAMPLE_RATE in whisper.cpp). */
export const SPEECH_SAMPLE_RATE = 16_000;

/** 16-bit PCM mono WAV from samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  seconds: number;
}

/**
 * The format of a PCM WAV file, or null when it isn't one. Walks the chunks, so it does not
 * trust the sizes in the RIFF header beyond the bytes it was given.
 */
export function readWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: Omit<WavInfo, 'seconds'> | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length || v.getUint16(body, true) !== 1) return null;
      fmt = { channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bitsPerSample: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.channels < 1 || fmt.bitsPerSample < 8 || fmt.sampleRate < 1) return null;
      const length = Math.min(size, bytes.length - body);
      return { ...fmt, seconds: length / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)) };
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** aios-core's answer to POST /speech: the words heard, or a plain message to show under the text box. */
export const SpeechAnswer = z.union([
  z.strictObject({ ok: z.literal(true), text: z.string().max(50_000) }),
  z.strictObject({ ok: z.literal(false), message: z.string().max(500) }),
]);
export type SpeechAnswer = z.infer<typeof SpeechAnswer>;
