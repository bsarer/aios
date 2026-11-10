import { SPEECH_SAMPLE_RATE, SpeechAnswer, encodeWav } from '@aios/shared/audio';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * V2: the chat's microphone button. Records 16 kHz mono from the microphone, and on stop posts it
 * as a WAV to aios-core's /speech, which answers with the words. The words only ever go into the
 * text box (onText); sending stays the user's own Enter or Send. Audio lives in memory until the
 * answer arrives and is never stored.
 */
export type VoiceState = 'idle' | 'starting' | 'listening' | 'working';

// Copies each block of microphone samples to the page. Runs on the audio thread; it has no outputs.
const WORKLET = `registerProcessor('aios-capture', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  chunks: Float32Array[];
  timer: number;
}

export function useVoice(o: { maxSeconds: number | null; onText: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const request = useRef<AbortController | null>(null);
  const onText = useRef(o.onText);
  onText.current = o.onText;
  const stopRef = useRef<() => void>(() => {});

  const release = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return null;
    window.clearTimeout(r.timer);
    for (const t of r.stream.getTracks()) t.stop();
    void r.ctx.close().catch(() => {});
    return r;
  }, []);

  const start = useCallback(async () => {
    if (o.maxSeconds === null || rec.current || request.current) return;
    setError(null);
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      setState('idle');
      const name = (err as Error | undefined)?.name;
      setError(
        name === 'NotAllowedError'
          ? "The microphone isn't allowed for AI OS. Click the microphone again and choose Allow."
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
      const chunks: Float32Array[] = [];
      node.port.onmessage = (m: MessageEvent<Float32Array>) => chunks.push(m.data);
      ctx.createMediaStreamSource(stream).connect(node);
      rec.current = { stream, ctx, chunks, timer: window.setTimeout(() => stopRef.current(), o.maxSeconds * 1000) };
      setState('listening');
    } catch {
      for (const t of stream.getTracks()) t.stop();
      setState('idle');
      setError("I couldn't start recording.");
    }
  }, [o.maxSeconds]);

  /** Stop listening and turn what was said into text. */
  const stop = useCallback(async () => {
    const r = release();
    if (!r) return;
    const samples = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of r.chunks) {
      samples.set(c, at);
      at += c.length;
    }
    setState('working');
    const ac = new AbortController();
    request.current = ac;
    try {
      const res = await fetch('/speech', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(samples), signal: ac.signal });
      const answer = SpeechAnswer.safeParse(await res.json());
      if (!answer.success) setError('The speech answer was not understood.');
      else if (answer.data.ok) onText.current(answer.data.text);
      else setError(answer.data.message);
    } catch {
      if (!ac.signal.aborted) setError("I can't reach the AI OS service.");
    } finally {
      if (request.current === ac) request.current = null;
      setState('idle');
    }
  }, [release]);
  stopRef.current = () => void stop();

  /** Drop the recording, or the answer on its way, and put nothing in the text box. */
  const cancel = useCallback(() => {
    release();
    request.current?.abort();
    request.current = null;
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

  return { state, error, toggle, cancel };
}
