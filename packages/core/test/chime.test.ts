/**
 * T1: the reminder chime. Made in code, written once to the data folder, played with pw-play or
 * paplay (never a shell, only the file's path). Tests use a pretend spawn and a temporary folder.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chimeWav, playChime } from '../src/todos/chime.js';

function pretendSpawn(missing: string[] = []) {
  const calls: [string, string[]][] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const child = new EventEmitter();
    if (missing.includes(cmd)) queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  return { calls, spawn };
}

describe('the reminder chime', () => {
  it('is a short, quiet 16-bit mono WAV', () => {
    const wav = chimeWav();
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    const rate = wav.readUInt32LE(24);
    const samples = wav.readUInt32LE(40) / 2;
    expect(samples / rate).toBeGreaterThan(0.4);
    expect(samples / rate).toBeLessThan(1);
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)));
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThan(32_767 * 0.6);
    // It fades to silence, so it doesn't click at the end.
    expect(Math.abs(wav.readInt16LE(44 + (samples - 1) * 2))).toBeLessThan(50);
  });

  it('is written once and played with pw-play, with only its path', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aios-chime-')), 'sounds', 'reminder.wav');
    const p = pretendSpawn();
    playChime(file, p.spawn);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(chimeWav())).toBe(true);
    await Promise.resolve();
    expect(p.calls).toEqual([['pw-play', [file]]]);
  });

  it('falls back to paplay, and does nothing when neither is there', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aios-chime-')), 'reminder.wav');
    const p = pretendSpawn(['pw-play']);
    playChime(file, p.spawn);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.calls.map((c) => c[0])).toEqual(['pw-play', 'paplay']);
    const none = pretendSpawn(['pw-play', 'paplay']);
    expect(() => playChime(file, none.spawn)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(none.calls.map((c) => c[0])).toEqual(['pw-play', 'paplay']);
  });
});
