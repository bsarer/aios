import { SPEECH_SAMPLE_RATE, SpeechAnswer, SpeechSegmenter, encodeWav } from '@aios/shared/audio';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * V2: the chat's microphone button. Records 16 kHz mono from the microphone and shows the words
 * while the user talks: the recording is split at pauses (SpeechSegmenter), each finished piece is
 * posted as a WAV to aios-core's /speech and its words go into the text box (onText), and about
 * every 1.5 seconds the piece still being spoken is sent too, for a grey preview (interim) that is
 * replaced when the piece ends. The words only ever go into the text box; sending stays the user's
 * own Enter or Send. Audio lives in memory until its answer arrives and is never stored.
 */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'working';

// Copies each block of microphone samples to the page. Runs on the audio thread; it has no outputs.
const WORKLET = `registerProcessor('aios-capture', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

const PREVIEW_EVERY_MS = 1500;
/** The open piece is previewed once it holds this much audio. */
const PREVIEW_MIN_SAMPLES = SPEECH_SAMPLE_RATE / 2;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  segmenter: SpeechSegmenter;
  stopTimer: number;
  previewTimer: number;
  /** Aborts every request of this session (Esc). */
  abort: AbortController;
  /** Finished pieces are turned into text one after another, in order. */
  finals: Promise<void>;
  pendingFinals: number;
  previewing: boolean;
  /** Bumped when a piece ends, so a late preview of an earlier piece is dropped. */
  piece: number;
  heardWords: boolean;
  failed: boolean;
}

export function useVoice(o: { maxSeconds: number | null; onText: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState('');
  const session = useRef<Session | null>(null);
  const onText = useRef(o.onText);
  onText.current = o.onText;
  const stopRef = useRef<() => void>(() => {});

  /** The words in some audio, or null after a failure (shown once per session, unless cancelled). */
  const transcribe = useCallback(async (s: Session, samples: Float32Array, quiet: boolean): Promise<string | null> => {
    try {
      const res = await fetch('/speech', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(samples), signal: s.abort.signal });
      const answer = SpeechAnswer.safeParse(await res.json());
      if (answer.success && answer.data.ok) return answer.data.text;
      if (!quiet && !s.failed && !s.abort.signal.aborted) {
        s.failed = true;
        setError(answer.success && !answer.data.ok ? answer.data.message : 'The speech answer was not understood.');
      }
    } catch {
      if (!quiet && !s.failed && !s.abort.signal.aborted) {
        s.failed = true;
        setError("I can't reach the Astra service.");
      }
    }
    return null;
  }, []);

  const finish = useCallback(
    (s: Session, samples: Float32Array) => {
      s.piece++;
      s.pendingFinals++;
      setInterim('');
      s.finals = s.finals.then(async () => {
        const text = await transcribe(s, samples, false);
        s.pendingFinals--;
        if (text && !s.abort.signal.aborted) {
          s.heardWords = true;
          onText.current(text);
        }
      });
    },
    [transcribe],
  );

  const preview = useCallback(
    (s: Session) => {
      // Finished pieces go first; one preview at a time.
      if (s.previewing || s.pendingFinals > 0 || s.failed) return;
      const open = s.segmenter.current();
      if (!open || open.length < PREVIEW_MIN_SAMPLES) return;
      const piece = s.piece;
      s.previewing = true;
      void transcribe(s, open, true).then((text) => {
        s.previewing = false;
        if (text !== null && s.piece === piece && session.current === s) setInterim(text);
      });
    },
    [transcribe],
  );

  /** Stops the microphone and timers; requests already sent carry on unless aborted. */
  const release = useCallback((s: Session) => {
    window.clearTimeout(s.stopTimer);
    window.clearInterval(s.previewTimer);
    for (const t of s.stream.getTracks()) t.stop();
    void s.ctx.close().catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (o.maxSeconds === null || session.current) return;
    setError(null);
    setInterim('');
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      setState('idle');
      const name = (err as Error | undefined)?.name;
      setError(
        name === 'NotAllowedError'
          ? "The microphone isn't allowed for Astra. Click the microphone again and choose Allow."
          : name === 'NotFoundError'
            ? 'No microphone found. Plug one in and try again.'
            : "I couldn't open the microphone.",
      );
      return;
    }
    try {
      // Chromium resamples the microphone to the context's rate.
      const ctx = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'aios-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      const s: Session = {
        stream,
        ctx,
        segmenter: new SpeechSegmenter(),
        stopTimer: window.setTimeout(() => stopRef.current(), o.maxSeconds * 1000),
        previewTimer: 0,
        abort: new AbortController(),
        finals: Promise.resolve(),
        pendingFinals: 0,
        previewing: false,
        piece: 0,
        heardWords: false,
        failed: false,
      };
      s.previewTimer = window.setInterval(() => preview(s), PREVIEW_EVERY_MS);
      node.port.onmessage = (m: MessageEvent<Float32Array>) => {
        if (session.current !== s) return;
        const piece = s.segmenter.push(m.data);
        if (piece) finish(s, piece);
      };
      ctx.createMediaStreamSource(stream).connect(node);
      session.current = s;
      setState('listening');
    } catch {
      for (const t of stream.getTracks()) t.stop();
      setState('idle');
      setError("I couldn't start recording.");
    }
  }, [o.maxSeconds, preview, finish]);

  /** Stop listening, turn the last piece into text, and wait for every piece's words. */
  const stop = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    release(s);
    const last = s.segmenter.flush();
    if (last) finish(s, last);
    setState('working');
    await s.finals;
    if (session.current !== s) return;
    session.current = null;
    setInterim('');
    if (!s.heardWords && !s.failed) setError("I didn't hear any words. Is the microphone muted? Try again a little closer to it.");
    setState('idle');
  }, [release, finish]);
  stopRef.current = () => void stop();

  /** Drop the recording and any answers on their way. Words already in the box stay. */
  const cancel = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (s) {
      s.abort.abort();
      release(s);
    }
    setInterim('');
    setState('idle');
  }, [release]);

  // Nothing keeps listening after the page or the button goes away.
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (o.maxSeconds === null) cancel();
  }, [o.maxSeconds, cancel]);
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(t);
  }, [error]);

  const toggle = useCallback(() => {
    if (state === 'listening') void stop();
    else if (state === 'idle') void start();
  }, [state, start, stop]);

  return { state, error, interim, toggle, cancel };
}
