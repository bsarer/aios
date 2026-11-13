import { describe, expect, it } from 'vitest';
import { SPEECH_SAMPLE_RATE, SpeechAnswer, SpeechSegmenter, encodeWav, readWav } from '../src/audio.js';

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

describe('SpeechSegmenter (V2 live words)', () => {
  const block = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin(i / 3)); // 0.1 s
  const feed = (s: SpeechSegmenter, amp: number, tenths: number) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < tenths; i++) {
      const piece = s.push(block(amp));
      if (piece) out.push(piece);
    }
    return out;
  };

  it('never makes a piece out of silence alone', () => {
    const s = new SpeechSegmenter();
    expect(feed(s, 0.001, 50)).toEqual([]);
    expect(s.current()).toBeNull();
    expect(s.flush()).toBeNull();
  });

  it('ends a piece at a pause after speech, with a short lead-in', () => {
    const s = new SpeechSegmenter();
    feed(s, 0.001, 10);
    expect(feed(s, 0.3, 15)).toEqual([]);
    expect(s.current()?.length).toBe((3 + 15) * 1600);
    const pieces = feed(s, 0.001, 10);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.length).toBe((3 + 15 + 6) * 1600);
    expect(s.current()).toBeNull();
  });

  it('keeps one piece across a short breath', () => {
    const s = new SpeechSegmenter();
    expect([...feed(s, 0.3, 5), ...feed(s, 0.001, 3), ...feed(s, 0.3, 5)]).toEqual([]);
  });

  it('cuts a piece that runs past maxSeconds without a pause', () => {
    const s = new SpeechSegmenter({ maxSeconds: 2 });
    expect(feed(s, 0.3, 45).map((p) => p.length)).toEqual([20 * 1600, 20 * 1600]);
  });

  it('flush returns the open piece once', () => {
    const s = new SpeechSegmenter();
    feed(s, 0.3, 5);
    expect(s.flush()?.length).toBe(5 * 1600);
    expect(s.flush()).toBeNull();
  });
});
