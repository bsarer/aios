import { describe, expect, it } from 'vitest';
import { SPEECH_SAMPLE_RATE, SpeechAnswer, encodeWav, readWav } from '../src/audio.js';

describe('WAV for voice to text (V2)', () => {
  it('encodes 16 kHz mono 16-bit PCM that reads back with the same format and length', () => {
    const wav = encodeWav(new Float32Array(SPEECH_SAMPLE_RATE * 2).fill(0.5));
    expect(wav.length).toBe(44 + SPEECH_SAMPLE_RATE * 4);
    expect(readWav(wav)).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, seconds: 2 });
  });

  it('clamps samples outside [-1, 1]', () => {
    const v = new DataView(encodeWav(Float32Array.from([2, -2, 0])).buffer);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([32767, -32768, 0]);
  });

  it('reads nothing that is not a PCM WAV, and does not trust sizes past the bytes it has', () => {
    expect(readWav(new Uint8Array(10))).toBeNull();
    expect(readWav(new TextEncoder().encode('RIFF....WAVEjunkjunkjunkjunkjunkjunkjunkjunkjunk'))).toBeNull();
    const wav = encodeWav(new Float32Array(16_000));
    new DataView(wav.buffer).setUint16(20, 3, true); // float, not PCM
    expect(readWav(wav)).toBeNull();
    const lying = encodeWav(new Float32Array(1600));
    new DataView(lying.buffer).setUint32(40, 0xffffffff, true);
    expect(readWav(lying)?.seconds).toBeCloseTo(0.1);
  });

  it("checks aios-core's answer", () => {
    expect(SpeechAnswer.safeParse({ ok: true, text: 'hi' }).success).toBe(true);
    expect(SpeechAnswer.safeParse({ ok: false, message: 'no' }).success).toBe(true);
    expect(SpeechAnswer.safeParse({ ok: true }).success).toBe(false);
  });
});
