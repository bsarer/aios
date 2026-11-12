/**
 * V2: voice to text in the chat. The chat records a short WAV and posts it to /speech; this checks
 * it and asks the local whisper.cpp server for the words. The words go back to that chat's text box
 * only: they are never sent, never reach the chat model from here, and nothing is run because of
 * them. The user reads them and presses Send, as with typed text. Audio stays in memory for the one
 * request and is never written to disk or the audit log; the log gets only the length and outcome.
 */
import { SPEECH_SAMPLE_RATE, type SpeechAnswer, readWav } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { ModelError, type ModelClient } from '../model.js';

export type DictationResult = SpeechAnswer;

export interface DictationOptions {
  model: Pick<ModelClient, 'transcribe'>;
  audit: Pick<AuditLog, 'append'>;
  /** [models.speech] maxSeconds. */
  maxSeconds: number;
}

/** The largest body /speech accepts: maxSeconds of 16 kHz 16-bit mono, the header and a second of slack. */
export function speechBodyLimit(maxSeconds: number): number {
  return (maxSeconds + 1) * SPEECH_SAMPLE_RATE * 2 + 1024;
}

const SHORTEST_SECONDS = 0.3;

export class Dictation {
  constructor(private readonly o: DictationOptions) {}

  get maxSeconds(): number {
    return this.o.maxSeconds;
  }

  async transcribe(bytes: Uint8Array, signal?: AbortSignal): Promise<DictationResult> {
    const wav = readWav(bytes);
    if (!wav || wav.channels !== 1 || wav.bitsPerSample !== 16 || wav.sampleRate !== SPEECH_SAMPLE_RATE) {
      this.o.audit.append({ kind: 'speech', event: 'rejected', reason: 'format', bytes: bytes.length });
      return { ok: false, message: "That recording wasn't in a format I can read. Reload the chat and try again." };
    }
    const seconds = Math.round(wav.seconds * 10) / 10;
    if (wav.seconds > this.o.maxSeconds + 1) {
      this.o.audit.append({ kind: 'speech', event: 'rejected', reason: 'too_long', seconds });
      return { ok: false, message: `That recording was longer than ${this.o.maxSeconds} seconds.` };
    }
    if (wav.seconds < SHORTEST_SECONDS) return { ok: false, message: "I didn't catch anything. Hold on a moment longer and try again." };
    const started = Date.now();
    try {
      const text = await this.o.model.transcribe(bytes, signal);
      this.o.audit.append({ kind: 'speech', event: 'transcribed', seconds, chars: text.length, latencyMs: Date.now() - started });
      return text ? { ok: true, text } : { ok: false, message: "I didn't hear any words. Try again a little closer to the microphone." };
    } catch (err) {
      const kind = err instanceof ModelError ? err.kind : 'network';
      this.o.audit.append({ kind: 'speech', event: 'error', seconds, errorKind: kind });
      return { ok: false, message: friendly(kind) };
    }
  }
}

function friendly(kind: string): string {
  if (kind === 'paused') return 'AI OS is paused. Type /resume to use the microphone again.';
  if (kind === 'aborted') return 'Stopped.';
  if (kind === 'timeout') return 'The speech model took too long to answer. Try a shorter recording.';
  if (kind === 'network' || kind === 'unavailable') return "I can't reach the speech model on this computer. Is whisper-server running? See the README's voice section.";
  return "The speech model couldn't turn that into text. Try again.";
}
