import { useEffect, useRef, useState } from 'react';

/**
 * The floating Feedback button, bottom right. A click opens a small card for an idea, a problem or
 * something the user likes. Saving sends `/feedback <kind>: <text>` exactly like typing it, so the
 * words reach feedback.jsonl only through Shell's /feedback command and never the model.
 */
const KINDS = [
  { id: 'idea', label: 'Idea', icon: '💡', prefix: 'Idea', hint: 'What would make Astra better?' },
  { id: 'problem', label: 'Problem', icon: '🐞', prefix: 'Problem', hint: 'What went wrong, and what did you expect?' },
  { id: 'like', label: 'I like', icon: '💚', prefix: 'Like', hint: 'What works well for you?' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

export const FEEDBACK_MAX = 3900;

/** The command the card sends: one kind word, then the user's own text. */
export function feedbackCommand(kind: Kind, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const k = KINDS.find((x) => x.id === kind) ?? KINDS[0];
  return `/feedback ${k.prefix}: ${t.slice(0, FEEDBACK_MAX)}`;
}

export function FeedbackButton({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('idea');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open, kind]);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => {
      setSaved(false);
      setOpen(false);
    }, 1400);
    return () => window.clearTimeout(t);
  }, [saved]);

  const close = () => {
    setOpen(false);
    setSaved(false);
  };
  const save = () => {
    const cmd = feedbackCommand(kind, text);
    if (!cmd || disabled) return;
    onSend(cmd);
    setText('');
    setSaved(true);
  };
  const current = KINDS.find((k) => k.id === kind) ?? KINDS[0];

  return (
    // Bottom right, beside the chat column. On a screen too narrow for that, top right under the
    // status strip, opening downwards, so it never covers the message box.
    <div data-testid="feedback-dock" className="fixed right-5 bottom-5 z-30 flex flex-col items-end gap-3 max-[1199px]:top-16 max-[1199px]:bottom-auto max-[1199px]:flex-col-reverse">
      {open && (
        <div
          data-testid="feedback-card"
          role="dialog"
          aria-label="Share feedback"
          className="glass w-[min(360px,calc(100vw-40px))] rounded-2xl p-4 shadow-2xl"
          style={{ border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--bg) 90%, transparent)' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Close the card only: don't also stop a reply.
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          {saved ? (
            <div data-testid="feedback-saved" role="status" className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full text-2xl" style={{ background: 'color-mix(in srgb, var(--accent) 20%, transparent)', color: 'var(--accent)' }}>
                ✓
              </div>
              <div className="text-[16px] font-medium">Thanks, it's saved</div>
              <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
                It's on your list for the next review.
              </div>
            </div>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between">
                <div className="text-[16px] font-semibold">Share feedback</div>
                <button type="button" onClick={close} aria-label="Close" className="rounded-md px-1.5 text-lg leading-none" style={{ color: 'var(--muted)' }}>
                  ×
                </button>
              </div>
              <div className="mb-3 text-[13px]" style={{ color: 'var(--muted)' }}>
                Saved on this computer for your backlog. It isn't sent to the AI.
              </div>
              <div className="mb-3 flex gap-2" role="radiogroup" aria-label="Kind of feedback">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.id}
                    data-testid={`feedback-kind-${k.id}`}
                    onClick={() => setKind(k.id)}
                    className="flex-1 rounded-xl px-2 py-1.5 text-[14px] transition-colors"
                    style={kind === k.id ? { background: 'var(--accent)', color: 'var(--bg)' } : { background: 'var(--panel)', color: 'var(--fg)' }}
                  >
                    <span aria-hidden>{k.icon}</span> {k.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={box}
                data-testid="feedback-text"
                rows={4}
                value={text}
                maxLength={FEEDBACK_MAX}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    save();
                  }
                }}
                placeholder={current.hint}
                aria-label={current.hint}
                className="w-full resize-none rounded-xl px-3 py-2 text-[15px] outline-none placeholder:opacity-50"
                style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
              />
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  data-testid="feedback-list"
                  onClick={() => {
                    onSend('/feedback list');
                    close();
                  }}
                  disabled={disabled}
                  className="text-[13px] underline-offset-2 hover:underline disabled:opacity-40"
                  style={{ color: 'var(--muted)' }}
                >
                  See what I've saved
                </button>
                <button
                  type="button"
                  data-testid="feedback-save"
                  onClick={save}
                  disabled={!text.trim() || disabled}
                  className="rounded-xl px-4 py-1.5 text-[15px] font-medium disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'var(--bg)' }}
                >
                  Save
                </button>
              </div>
              <div className="mt-2 text-right text-[11px]" style={{ color: 'var(--muted)' }}>
                Enter saves · Shift+Enter for a new line · Esc closes
              </div>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="feedback"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-label="Feedback"
        title="Share an idea, a problem or something you like"
        className="glass flex items-center gap-2 rounded-full px-4 py-2.5 text-[15px] font-medium shadow-lg transition-transform hover:scale-105"
        style={{ border: '1px solid var(--border)', color: open ? 'var(--accent)' : 'var(--fg)' }}
      >
        <span aria-hidden className="text-lg leading-none">
          💡
        </span>
        Feedback
      </button>
    </div>
  );
}
