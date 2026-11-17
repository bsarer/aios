import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { down, edited, emptyRecall, onFirstLine, onLastLine, type Recall, remember, seed, up } from '../history';
import { useVoice } from '../useVoice';
import { Icon } from './ui';

interface Props {
  working: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** W1: less space below when the widget row follows. */
  tight?: boolean;
  /** V2: the microphone button, when aios-core has a speech model; null keeps it off. */
  voiceMaxSeconds?: number | null;
  /** The user's own messages already in the chat, oldest first, for Up/Down. */
  earlier?: string[];
}

export function Composer({ working, disabled, onSend, onStop, tight = false, voiceMaxSeconds = null, earlier = [] }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Up/Down recall what was sent, like a shell (history.ts). Seeded once from the chat as loaded,
  // unless something was already sent from this page (that list then has it all).
  const recall = useRef<Recall>(emptyRecall());
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !earlier.length) return;
    seeded.current = true;
    if (!recall.current.entries.length) recall.current = seed(recall.current, earlier);
  }, [earlier]);
  const show = (next: { recall: Recall; text: string } | null, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!next) return;
    e.preventDefault();
    recall.current = next.recall;
    caretToEnd.current = true;
    setText(next.text);
  };
  // The caret goes to the end of a recalled entry, so Up again steps back once more on a one-line
  // entry. Done as the text renders, not later, so it can't land on whatever is typed next.
  const caretToEnd = useRef(false);
  useLayoutEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    ref.current?.setSelectionRange(text.length, text.length);
  }, [text]);
  // V2: what was said goes into the text box, after anything already typed. It is never sent from here.
  const voice = useVoice({
    maxSeconds: disabled ? null : voiceMaxSeconds,
    onText: (words) => {
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${words}` : words));
      ref.current?.focus();
    },
  });
  const voiceBusy = voice.state !== 'idle';
  // Esc puts the box back as it was before listening started.
  const beforeVoice = useRef('');
  const toggleVoice = () => {
    if (voice.state === 'idle') beforeVoice.current = text;
    voice.toggle();
  };
  const cancelVoice = () => {
    voice.cancel();
    setText(beforeVoice.current);
  };

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
        cancelVoice();
      } else if (e.key === 'Escape' && working) {
        e.preventDefault();
        onStop();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M') && voiceMaxSeconds !== null && !disabled) {
        e.preventDefault();
        toggleVoice();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onStop, voiceBusy, voice, voiceMaxSeconds, disabled, text]);

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
    recall.current = remember(recall.current, t);
    setText('');
  };

  return (
    <div data-testid="composer" className={`mx-auto w-[min(760px,calc(100%-24px))] ${tight ? 'pb-2' : 'pb-5'}`}>
      {/* Attach and image come back here when they work. */}
      <div className="flex items-end gap-2 rounded-3xl border py-2.5 pl-5 pr-2.5 shadow-[0_8px_30px_rgb(0_0_0/0.35)]" style={{ background: 'var(--surface)', borderColor: 'var(--line-strong)' }}>
        <textarea
          ref={ref}
          data-testid="input"
          aria-label="Message"
          rows={1}
          value={text}
          onChange={(e) => {
            recall.current = edited(recall.current);
            setText(e.target.value);
          }}
          readOnly={voiceBusy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
              return;
            }
            const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && !voiceBusy;
            const el = e.currentTarget;
            const caret = el.selectionStart;
            if (!plain || caret !== el.selectionEnd) return;
            if (e.key === 'ArrowUp' && onFirstLine(text, caret)) show(up(recall.current, text), e);
            else if (e.key === 'ArrowDown' && onLastLine(text, caret)) show(down(recall.current), e);
          }}
          placeholder={disabled ? 'Reconnecting…' : 'Ask anything'}
          className="max-h-[220px] flex-1 resize-none bg-transparent py-2 outline-none placeholder:opacity-50"
        />
        {voiceMaxSeconds !== null && (
          <button
            type="button"
            data-testid="mic"
            data-state={voice.state}
            onClick={toggleVoice}
            disabled={disabled || voice.state === 'starting' || voice.state === 'working'}
            title={voice.state === 'listening' ? 'Stop and turn it into text (Ctrl+M)' : 'Speak instead of typing (Ctrl+M)'}
            aria-label={voice.state === 'listening' ? 'Stop listening' : 'Voice'}
            aria-pressed={voice.state === 'listening'}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${voice.state === 'listening' ? 'animate-pulse' : 'hover:bg-[var(--panel)]'}`}
            style={voice.state === 'listening' ? { background: 'var(--danger)', color: 'var(--bg)', outlineColor: 'var(--accent)' } : { color: 'var(--muted)', outlineColor: 'var(--accent)' }}
          >
            <Icon name="mic" size={19} />
          </button>
        )}
        {working ? (
          <button
            type="button"
            onClick={onStop}
            data-testid="stop"
            aria-label="Stop"
            title="Stop (Esc)"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: 'var(--panel)', borderColor: 'var(--line-strong)', color: 'var(--fg)', outlineColor: 'var(--accent)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || disabled}
            data-testid="send"
            aria-label="Send"
            title="Send (Enter)"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 disabled:hover:brightness-100"
            style={{ background: 'var(--accent)', color: 'var(--bg)', outlineColor: 'var(--accent)' }}
          >
            <Icon name="arrowUp" size={20} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {/* V2: the words of the piece still being spoken, until it ends and joins the box. */}
      {voice.interim && (
        <div data-testid="voice-interim" aria-live="polite" className="px-5 pt-2 text-[15px] italic" style={{ color: 'var(--muted)' }}>
          {voice.interim.replace(/[.…\s]+$/, '')}…
        </div>
      )}
      {voice.error ? (
        <div data-testid="voice-error" role="status" className="pt-2 text-center text-[13px]" style={{ color: 'var(--danger)' }}>
          {voice.error}
        </div>
      ) : voiceBusy ? (
        <div data-testid="voice-status" role="status" className="pt-2 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {voice.state === 'working' ? 'Turning it into text…' : voice.state === 'starting' ? 'Opening the microphone…' : `Listening… click the microphone or press Ctrl+M when you're done (up to ${voiceMaxSeconds} seconds) · Esc to cancel`}
        </div>
      ) : (
        <div className="pt-2 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          Enter to send · Shift+Enter for a new line · ↑ for earlier messages · Esc to stop{voiceMaxSeconds === null ? '' : ' · Ctrl+M to speak'} · /help for commands
        </div>
      )}
    </div>
  );
}
