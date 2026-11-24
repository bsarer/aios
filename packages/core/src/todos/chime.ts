/**
 * T1: the short sound a reminder plays when it fires. The chime is made here in code (two soft
 * bell notes, under a second), written once to the data folder as a WAV file (its name carries a number to change with the
 * sound, so an update never plays an old copy), and played with
 * PipeWire's `pw-play`, or `paplay` if that is missing. Both are started without a shell with
 * code's arguments only; no text from the list or anywhere else reaches them. If neither can
 * play, nothing happens: the card and the desktop notification are still there.
 *
 * Quiet hours and pause hold reminders back before this is reached (`Todos.tick`), and
 * `[todos] sound = false` turns the sound off.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RATE = 22_050;
/** Two notes a fourth apart (E5, then A5), each a sine with a quiet overtone and a bell-like fade. */
const NOTES = [
  { hz: 659.25, start: 0, length: 0.45 },
  { hz: 880, start: 0.16, length: 0.6 },
] as const;
const VOLUME = 0.32;

/** The chime as a 16-bit mono WAV file. */
export function chimeWav(): Buffer {
  const seconds = Math.max(...NOTES.map((n) => n.start + n.length));
  const count = Math.ceil(seconds * RATE);
  const out = Buffer.alloc(44 + count * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + count * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    let v = 0;
    for (const n of NOTES) {
      const u = t - n.start;
      if (u < 0 || u > n.length) continue;
      // 8 ms rise, then an exponential fade that reaches silence at the note's end.
      const env = Math.min(1, u / 0.008) * Math.exp((-5 * u) / n.length) * (1 - u / n.length);
      v += env * (Math.sin(2 * Math.PI * n.hz * u) + 0.25 * Math.sin(4 * Math.PI * n.hz * u));
    }
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * VOLUME)) * 32_767), 44 + i * 2);
  }
  return out;
}

type Spawn = (cmd: string, args: string[]) => { once(event: 'error', cb: (err: Error) => void): unknown; unref?(): void };

/** The players tried in order; each gets the file path as its only argument. */
export const CHIME_PLAYERS = ['pw-play', 'paplay'] as const;

/** Plays the reminder chime from `file` (written there first if it isn't yet). Never throws. */
export function playChime(file: string, spawn: Spawn = (cmd, args) => nodeSpawn(cmd, args, { shell: false, stdio: 'ignore' })): void {
  try {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, chimeWav(), { mode: 0o644 });
    }
  } catch {
    return;
  }
  const play = (i: number): void => {
    const cmd = CHIME_PLAYERS[i];
    if (!cmd) return;
    try {
      const child = spawn(cmd, [file]);
      child.once('error', () => play(i + 1));
      child.unref?.();
    } catch {
      play(i + 1);
    }
  };
  play(0);
}
