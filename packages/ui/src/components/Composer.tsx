import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

interface Props {
  working: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Messages the user sent, oldest first; Up and Down step through them like a shell. */
  history: readonly string[];
}

/**
 * Up recalls the previous message when the box is empty or already shows a recalled one,
 * so it never takes over the arrow keys while you edit a message of your own. Down steps
 * forward again and, past the newest, brings back what you had typed.
 */
export function stepHistory(history: readonly string[], at: number | null, key: 'up' | 'down'): number | null | undefined {
  if (key === 'up') {
    const next = (at ?? history.length) - 1;
    return next >= 0 ? next : undefined;
  }
  if (at === null) return undefined;
  return at + 1 < history.length ? at + 1 : null;
}

export function Composer({ working, disabled, onSend, onStop, history }: Props) {
  const [text, setText] = useState('');
  // Which history entry the box shows (null: the user's own text), and that text to come back to.
  const [at, setAt] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Kiosk: the input should always have focus.
  useEffect(() => {
    const refocus = () => ref.current?.focus();
    refocus();
    window.addEventListener('focus', refocus);
    return () => window.removeEventListener('focus', refocus);
  }, []);

  // Esc stops generation from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && working) {
        e.preventDefault();
        onStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onStop]);

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
    setAt(null);
  };

  const recall = (e: React.KeyboardEvent<HTMLTextAreaElement>, key: 'up' | 'down') => {
    const showingRecalled = at !== null && text === history[at];
    if (key === 'up' && text !== '' && !showingRecalled) return;
    if (key === 'down' && !showingRecalled) return;
    const next = stepHistory(history, showingRecalled ? at : null, key);
    if (next === undefined) return;
    e.preventDefault();
    if (at === null) setDraft(text);
    setAt(next);
    const value = next === null ? draft : (history[next] ?? '');
    setText(value);
    // Caret at the end, as a shell does.
    requestAnimationFrame(() => ref.current?.setSelectionRange(value.length, value.length));
  };

  return (
    <div className="mx-auto w-[min(760px,calc(100%-24px))] pb-5">
      {/* Attach, image and voice come back here when they work. */}
      <div className="flex items-end gap-2.5 rounded-3xl border py-2.5 pl-5 pr-2.5 shadow-[0_8px_30px_rgb(0_0_0/0.35)]" style={{ background: 'var(--surface)', borderColor: 'var(--line-strong)' }}>
        <textarea
          ref={ref}
          data-testid="input"
          aria-label="Message"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAt(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) recall(e, e.key === 'ArrowUp' ? 'up' : 'down');
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Reconnecting…' : 'Ask anything'}
          className="max-h-[220px] flex-1 resize-none bg-transparent py-2 outline-none placeholder:opacity-50"
        />
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
      <div className="pt-2 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
        Enter to send · Shift+Enter for a new line · ↑ for earlier messages · Esc to stop · /help for commands
      </div>
    </div>
  );
}
