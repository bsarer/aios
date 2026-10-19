import { useEffect, useRef, useState } from 'react';

interface Props {
  working: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

const Disabled = ({ label, icon }: { label: string; icon: string }) => (
  <button type="button" disabled title={`${label} (not available yet)`} aria-label={label} className="cursor-not-allowed px-1.5 text-lg opacity-35">
    {icon}
  </button>
);

export function Composer({ working, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('');
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
  };

  return (
    <div className="glass mx-auto mb-4 w-[min(820px,calc(100%-24px))] rounded-2xl px-3 py-2">
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
        <Disabled label="Voice" icon="🎙" />
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
      <div className="px-1 pt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Enter to send · Shift+Enter for a new line · Esc to stop · /help for commands
      </div>
    </div>
  );
}
