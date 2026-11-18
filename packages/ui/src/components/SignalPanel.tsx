import type { ChatItem } from '@aios/shared/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { timeLabel } from '../inbox';
import {
  SIGNAL_PEEK_MS,
  type SignalChatRow,
  type SignalMessageRow,
  hasSignal,
  isNewSignal,
  loadSignalSeenAt,
  saveSignalSeenAt,
  signalAsk,
  signalChats,
  signalCounts,
  signalLine,
  signalPeekFor,
} from '../signals';

/**
 * SG1 in the side rail: when Signal is linked, new messages wait under their own button on the
 * rail, like mail. A person's message peeks out for a few seconds (not while quiet); groups wait.
 * The panel lists chats with their newest message, and Read and Reply send words naming only the
 * chat id, so the conversation still happens in the chat. Names and text are plain text only.
 */

const SOLID = { background: 'color-mix(in srgb, var(--bg) 95%, var(--fg))' } as const;

export interface Signals {
  /** False until a Signal message has come in on this screen: the rail shows no button. */
  shown: boolean;
  chats: SignalChatRow[];
  fresh: number;
  open: boolean;
  newSince: number;
  setOpen: (open: boolean) => void;
  peek: SignalMessageRow | null;
  dismissPeek: () => void;
}

export function useSignals(items: ChatItem[], quietUntil: number): Signals {
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(openedAt);
  const [seenAt, setSeenAt] = useState(() => loadSignalSeenAt(openedAt));
  const [newSince, setNewSince] = useState(seenAt);
  const [open, setOpenState] = useState(false);
  const [peek, setPeek] = useState<SignalMessageRow | null>(null);
  const peeked = useRef(new Set<string>());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const chats = useMemo(() => signalChats(items, Math.max(now, Date.now())), [items, now]);
  const shown = useMemo(() => hasSignal(items), [items]);
  const { fresh } = signalCounts(chats, seenAt);

  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      if (!v) return;
      const t = Date.now();
      setNewSince(seenAt);
      setSeenAt(t);
      saveSignalSeenAt(t);
      setPeek(null);
    },
    [seenAt],
  );

  useEffect(() => {
    if (open) return;
    const p = signalPeekFor(items, openedAt, peeked.current, quietUntil, Date.now());
    if (!p) return;
    peeked.current.add(p.id);
    // One peek per notification: the rest of its messages wait under the button.
    for (const n of items) if (n.kind === 'notification' && n.signals?.some((s) => s.id === p.id)) peeked.current.add(n.id);
    setPeek(p);
  }, [items, open, openedAt, quietUntil]);
  useEffect(() => {
    if (!peek) return;
    const t = window.setTimeout(() => setPeek(null), SIGNAL_PEEK_MS);
    return () => window.clearTimeout(t);
  }, [peek]);
  useEffect(() => {
    if (quietUntil > Date.now()) setPeek(null);
  }, [quietUntil]);

  return { shown, chats, fresh, open, newSince, setOpen, peek, dismissPeek: () => setPeek(null) };
}

export const SignalIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5c4.7 0 8.5 3.4 8.5 7.7s-3.8 7.7-8.5 7.7c-1.2 0-2.3-.2-3.3-.6L4 19.8l1.3-3.9c-1.1-1.3-1.8-2.9-1.8-4.7 0-4.3 3.8-7.6 8.5-7.6z" />
  </svg>
);

interface ButtonProps {
  signals: Signals;
  quiet: boolean;
  onToggle: () => void;
}

/** The rail's Signal button, with the count of new messages. */
export function SignalRailButton({ signals, quiet, onToggle }: ButtonProps) {
  const { fresh, open } = signals;
  const label = fresh ? `Signal: ${fresh} new message${fresh === 1 ? '' : 's'}` : 'Signal';
  return (
    <button
      type="button"
      data-testid="rail-signal"
      data-fresh={fresh}
      aria-label={label}
      aria-expanded={open}
      title={`${label} (Esc closes it)`}
      onClick={onToggle}
      className="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors"
      style={{ color: fresh || open ? 'var(--fg)' : 'var(--muted)', background: fresh || open ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent' }}
    >
      <SignalIcon />
      {fresh > 0 && (
        <span
          data-testid="signal-badge"
          className="absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold leading-[18px]"
          style={{ background: quiet ? 'color-mix(in srgb, var(--fg) 30%, transparent)' : 'var(--accent)', color: quiet ? 'var(--fg)' : 'var(--bg)' }}
        >
          {fresh > 99 ? '99+' : fresh}
        </span>
      )}
    </button>
  );
}

/** A person's new message, beside the rail for a few seconds. */
export function SignalPeek({ signals, onOpen }: { signals: Signals; onOpen: () => void }) {
  const p = signals.peek;
  if (!p || signals.open) return null;
  return (
    <div
      data-testid="signal-peek"
      role="status"
      className="fixed right-[68px] top-1/2 z-30 w-[clamp(200px,calc((100vw-760px)/2-80px),260px)] -translate-y-1/2 rounded-2xl px-3.5 py-2.5 text-sm"
      style={{ ...SOLID, border: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}
    >
      <div className="flex items-center text-[12.5px]" style={{ color: 'var(--accent)' }}>
        ● Signal<span className="ml-auto" style={{ color: 'var(--muted)' }}>now</span>
      </div>
      <div className="mt-0.5 truncate text-[15px] font-semibold">{p.name}</div>
      <div className="line-clamp-2" style={{ color: 'var(--muted)' }}>
        {signalLine(p)}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button type="button" data-testid="signal-peek-open" className="btn btn-primary btn-sm" onClick={onOpen}>
          Open
        </button>
        <button type="button" data-testid="signal-peek-later" className="btn btn-secondary btn-sm" onClick={signals.dismissPeek}>
          Later
        </button>
      </div>
      <div className="mt-2 h-0.5 overflow-hidden rounded" style={{ background: 'var(--border)' }}>
        <div className="h-full" style={{ background: 'var(--accent)', animation: `peek-time ${SIGNAL_PEEK_MS}ms linear forwards` }} />
      </div>
    </div>
  );
}

interface PanelProps {
  signals: Signals;
  disabled: boolean;
  onSend: (text: string) => void;
}

/** The Signal panel: one row per chat, newest first, from the last day. */
export function SignalPanel({ signals, disabled, onSend }: PanelProps) {
  const { chats, newSince, setOpen } = signals;
  const fresh = chats.reduce((n, c) => n + c.messages.filter((m) => isNewSignal(m, newSince)).length, 0);
  const go = (what: 'read' | 'reply', chat: string) => {
    const text = signalAsk(what, chat);
    if (!text) return;
    onSend(text);
    setOpen(false);
  };

  return (
    <aside
      data-testid="signal-panel"
      role="dialog"
      aria-label="Signal"
      className="fixed bottom-3 right-[68px] top-16 z-40 flex w-[min(400px,calc(100vw-96px))] flex-col rounded-2xl px-4 py-3.5"
      style={{ ...SOLID, border: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,.35)' }}
    >
      <header className="flex items-center gap-2">
        <SignalIcon />
        <h3 className="text-lg font-semibold">Signal</h3>
        <span className="text-[15px]" style={{ color: 'var(--muted)' }}>
          · {fresh ? `${fresh} new` : 'nothing new'}
        </span>
        <button type="button" data-testid="signal-close" aria-label="Close Signal" className="ml-auto px-1 text-xl leading-none" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="-mr-2 flex-1 overflow-y-auto pr-2">
        {chats.length === 0 && (
          <p className="mt-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
            No Signal messages in the last day.
          </p>
        )}
        <ul className="mt-3">
          {chats.map((c) => {
            const n = c.messages.filter((m) => isNewSignal(m, newSince)).length;
            return (
              <li
                key={c.chat}
                data-testid="signal-row"
                data-kind={c.kind}
                data-new={n > 0 || undefined}
                className="glass mb-1.5 rounded-xl px-3 py-2 text-sm"
                style={n > 0 ? { borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' } : undefined}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[14.5px] font-semibold">{c.name}</span>
                  {c.kind === 'group' && (
                    <span className="shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
                      group
                    </span>
                  )}
                  {n > 1 && (
                    <span data-testid="signal-row-count" className="shrink-0 text-xs" style={{ color: 'var(--accent)' }}>
                      {n} new
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
                    {timeLabel(c.latest.date, Date.now())}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-3">{signalLine(c.latest)}</div>
                <div className="mt-1.5 flex gap-1.5 text-[12.5px]">
                  <button type="button" data-testid="signal-read" disabled={disabled} className="btn btn-secondary btn-sm" onClick={() => go('read', c.chat)}>
                    Read
                  </button>
                  <button type="button" data-testid="signal-reply" disabled={disabled} className="btn btn-secondary btn-sm" onClick={() => go('reply', c.chat)}>
                    Reply
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <footer className="mt-2 flex items-center gap-2 border-t pt-2.5 text-[13px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
        <span className="ml-auto">Esc to close</span>
      </footer>
    </aside>
  );
}
