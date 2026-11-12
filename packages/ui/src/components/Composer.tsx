import { useEffect, useRef, useState } from 'react';
import { useVoice } from '../useVoice';

interface Props {
  working: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** W1: less space below when the widget row follows. */
  tight?: boolean;
  /** V2: the microphone button, when aios-core has a speech model; null keeps it off. */
  voiceMaxSeconds?: number | null;
}

const Disabled = ({ label, icon }: { label: string; icon: string }) => (
  <button type="button" disabled title={`${label} (not available yet)`} aria-label={label} className="cursor-not-allowed px-1.5 text-lg opacity-35">
    {icon}
  </button>
);

export function Composer({ working, disabled, onSend, onStop, tight = false, voiceMaxSeconds = null }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // V2: what was said goes into the text box, after anything already typed. It is never sent from here.
  const voice = useVoice({
    maxSeconds: disabled ? null : voiceMaxSeconds,
    onText: (words) => {
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${words}` : words));
      ref.current?.focus();
    },
  });
  const voiceBusy = voice.state !== 'idle';

  // Kiosk: the input should always have focus.
  useEffect(() => {
    const refocus = () => ref.current?.focus();
    refocus();
    window.addEventListener('focus', refocus);
    return () => window.removeEventListener('focus', refocus);
  }, []);

  // Esc cancels the microphone first, else stops generation, from anywhere on the page. Ctrl+M starts or stops listening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && voiceBusy) {
        e.preventDefault();
        voice.cancel();
      } else if (e.key === 'Escape' && working) {
        e.preventDefault();
        onStop();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M') && voiceMaxSeconds !== null && !disabled) {
        e.preventDefault();
        voice.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onStop, voiceBusy, voice, voiceMaxSeconds, disabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div data-testid="composer" className={`glass mx-auto ${tight ? 'mb-2' : 'mb-4'} w-[min(820px,calc(100%-24px))] rounded-2xl px-3 py-2`}>
      <div className="flex items-end gap-2">
        <Disabled label="Attach" icon="📎" />
        <textarea
          ref={ref}
          data-testid="input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Reconnecting…' : 'Ask anything'}
          className="max-h-[220px] flex-1 resize-none bg-transparent px-1 py-1.5 outline-none placeholder:opacity-50"
        />
        <Disabled label="Image" icon="🖼" />
        {voiceMaxSeconds === null ? (
          <Disabled label="Voice" icon="🎙" />
        ) : (
          <button
            type="button"
            data-testid="mic"
            data-state={voice.state}
            onClick={voice.toggle}
            disabled={disabled || voice.state === 'starting' || voice.state === 'working'}
            title={voice.state === 'listening' ? 'Stop and turn it into text (Ctrl+M)' : 'Speak instead of typing (Ctrl+M)'}
            aria-label={voice.state === 'listening' ? 'Stop listening' : 'Voice'}
            aria-pressed={voice.state === 'listening'}
            className={`rounded-lg px-1.5 text-lg disabled:opacity-50 ${voice.state === 'listening' ? 'animate-pulse' : ''}`}
            style={voice.state === 'listening' ? { background: 'var(--danger)', color: 'var(--bg)' } : undefined}
          >
            🎙
          </button>
        )}
        {working ? (
          <button type="button" onClick={onStop} data-testid="stop" className="rounded-xl px-3 py-1.5 text-[15px]" style={{ background: 'var(--panel)', color: 'var(--fg)' }}>
            Stop
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={!text.trim() || disabled} className="rounded-xl px-3 py-1.5 text-[15px] font-medium disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
            Send
          </button>
        )}
      </div>
      {voice.error ? (
        <div data-testid="voice-error" role="status" className="px-1 pt-1 text-xs" style={{ color: 'var(--danger)' }}>
          {voice.error}
        </div>
      ) : voiceBusy ? (
        <div data-testid="voice-status" role="status" className="px-1 pt-1 text-xs" style={{ color: 'var(--muted)' }}>
          {voice.state === 'working' ? 'Turning it into text…' : voice.state === 'starting' ? 'Opening the microphone…' : `Listening… click the microphone or press Ctrl+M when you're done (up to ${voiceMaxSeconds} seconds) · Esc to cancel`}
        </div>
      ) : (
        <div className="px-1 pt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Enter to send · Shift+Enter for a new line · Esc to stop{voiceMaxSeconds === null ? '' : ' · Ctrl+M to speak'} · /help for commands
        </div>
      )}
    </div>
  );
}
