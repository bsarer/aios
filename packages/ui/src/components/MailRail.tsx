import type { ChatItem } from '@aios/shared/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type InboxRow,
  PEEK_MS,
  QUIET_MS,
  counts,
  groups,
  inboxRows,
  isNew,
  loadQuietUntil,
  loadSeenAt,
  peekFor,
  saveQuietUntil,
  saveSeenAt,
  senderName,
} from '../inbox';

/**
 * Calm mail alerts. New mail waits on the right edge instead of landing in the chat:
 * - the rail shows a count on the envelope, and nothing moves;
 * - urgent mail peeks out beside the rail for a few seconds (not while quiet);
 * - the envelope opens the inbox panel, with the same Read, Draft reply and Ignore buttons the
 *   chat card had. Read and Draft reply send the same words as before, so the conversation about
 *   an email still happens in the chat.
 * Email text (sender, subject, summary) is shown as plain text only.
 */

const URGENCY_COLOR = { high: 'var(--danger)', normal: 'var(--accent)', low: 'var(--muted)' } as const;
const SOLID = { background: 'color-mix(in srgb, var(--bg) 95%, var(--fg))' } as const;

export interface Inbox {
  rows: InboxRow[];
  fresh: number;
  urgent: number;
  open: boolean;
  /** Rows newer than this were new when the panel was opened; they keep their marker while it is open. */
  newSince: number;
  setOpen: (open: boolean) => void;
  quietUntil: number;
  toggleQuiet: () => void;
  peek: InboxRow | null;
  dismissPeek: () => void;
}

/** The inbox's state, kept in App so the status strip and the chat's catch-up line can open it too. */
export function useInbox(items: ChatItem[]): Inbox {
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(openedAt);
  const [seenAt, setSeenAt] = useState(() => loadSeenAt(openedAt));
  const [newSince, setNewSince] = useState(seenAt);
  const [open, setOpenState] = useState(false);
  const [quietUntil, setQuietUntil] = useState(loadQuietUntil);
  const [peek, setPeek] = useState<InboxRow | null>(null);
  const peeked = useRef(new Set<string>());

  // A minute's tick: rows older than a day drop off, and quiet ends on time.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const rows = useMemo(() => inboxRows(items, Math.max(now, Date.now())), [items, now]);
  const { fresh, urgent } = counts(rows, seenAt);

  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      if (!v) return;
      // Opening the inbox is seeing it: the badge clears, the rows keep their "new" marker until it closes.
      const t = Date.now();
      setNewSince(seenAt);
      setSeenAt(t);
      saveSeenAt(t);
      setPeek(null);
    },
    [seenAt],
  );

  // Urgent mail that arrives while the page is open peeks out once.
  useEffect(() => {
    if (open) return;
    const p = peekFor(items, openedAt, peeked.current, quietUntil, Date.now());
    if (!p) return;
    peeked.current.add(p.itemId);
    setPeek(p);
  }, [items, open, openedAt, quietUntil]);
  useEffect(() => {
    if (!peek) return;
    const t = window.setTimeout(() => setPeek(null), PEEK_MS);
    return () => window.clearTimeout(t);
  }, [peek]);

  const toggleQuiet = useCallback(() => {
    const v = Date.now() < quietUntil ? 0 : Date.now() + QUIET_MS;
    setQuietUntil(v);
    saveQuietUntil(v);
    if (v) setPeek(null);
  }, [quietUntil]);

  return { rows, fresh, urgent, open, newSince, setOpen, quietUntil: quietUntil > now ? quietUntil : 0, toggleQuiet, peek, dismissPeek: () => setPeek(null) };
}

const MailIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3.5 6.5 12 13l8.5-6.5" />
  </svg>
);
const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface RailProps {
  inbox: Inbox;
  disabled: boolean;
  onSend: (text: string) => void;
  onIgnoreMail: (itemId: string, mailId: string) => void;
}

export function MailRail({ inbox, disabled, onSend, onIgnoreMail }: RailProps) {
  const { fresh, urgent, open, setOpen, quietUntil, toggleQuiet, peek } = inbox;
  const quiet = quietUntil > 0;
  const hot = urgent > 0 && !open;
  const label = fresh ? `Inbox: ${fresh} new${urgent ? `, ${urgent} urgent` : ''}` : 'Inbox';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return (
    <>
      <nav data-testid="mail-rail" aria-label="Mail" className="glass fixed right-2 top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-full p-1.5">
        <button
          type="button"
          data-testid="rail-mail"
          data-fresh={fresh}
          aria-label={label}
          aria-expanded={open}
          title={`${label} (Esc closes it)`}
          onClick={() => setOpen(!open)}
          className="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors"
          style={{
            color: hot ? 'var(--warning)' : fresh || open ? 'var(--fg)' : 'var(--muted)',
            background: hot ? 'color-mix(in srgb, var(--warning) 16%, transparent)' : fresh || open ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
            boxShadow: hot ? '0 0 0 1px color-mix(in srgb, var(--warning) 45%, transparent), 0 0 18px color-mix(in srgb, var(--warning) 30%, transparent)' : undefined,
          }}
        >
          <MailIcon />
          {fresh > 0 && (
            <span
              data-testid="rail-badge"
              className="absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold leading-[18px]"
              style={{ background: quiet ? 'color-mix(in srgb, var(--fg) 30%, transparent)' : urgent ? 'var(--warning)' : 'var(--accent)', color: quiet ? 'var(--fg)' : 'var(--bg)' }}
            >
              {fresh > 99 ? '99+' : fresh}
            </span>
          )}
        </button>
        <span className="h-px w-5" style={{ background: 'var(--border)' }} />
        <button
          type="button"
          data-testid="rail-quiet"
          aria-pressed={quiet}
          aria-label={quiet ? `Quiet until ${clock(quietUntil)}. Click to end it.` : 'Quiet for 1 hour'}
          title={quiet ? `Quiet until ${clock(quietUntil)}: urgent mail waits here without peeking out. Click to end it.` : 'Quiet for 1 hour: urgent mail waits here without peeking out.'}
          onClick={toggleQuiet}
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ color: quiet ? 'var(--fg)' : 'var(--muted)', background: quiet ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent' }}
        >
          <MoonIcon />
        </button>
      </nav>

      {/* Beside the rail, in the margin next to the chat; on a narrow screen it covers the chat's edge for a few seconds. */}
      {peek && !open && (
        <div
          data-testid="mail-peek"
          role="status"
          className="fixed right-[68px] top-1/2 z-30 w-[clamp(200px,calc((100vw-820px)/2-80px),260px)] -translate-y-1/2 rounded-2xl px-3.5 py-2.5 text-sm"
          style={{ ...SOLID, border: '1px solid var(--border)', borderLeft: '3px solid var(--warning)', boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}
        >
          <div className="flex items-center text-[12.5px]" style={{ color: 'var(--warning)' }}>
            ● Looks urgent<span className="ml-auto" style={{ color: 'var(--muted)' }}>now</span>
          </div>
          <div className="mt-0.5 truncate text-[15px] font-semibold">{senderName(peek.from)}</div>
          <div className="line-clamp-2" style={{ color: 'var(--muted)' }}>{peek.subject}</div>
          <div className="mt-2 flex gap-1.5">
            <button type="button" data-testid="peek-open" className="rounded-lg px-2.5 py-0.5 font-medium" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => setOpen(true)}>
              Open
            </button>
            <button type="button" data-testid="peek-later" className="glass rounded-lg px-2.5 py-0.5" onClick={inbox.dismissPeek}>
              Later
            </button>
          </div>
          <div className="mt-2 h-0.5 overflow-hidden rounded" style={{ background: 'var(--border)' }}>
            <div className="h-full" style={{ background: 'var(--warning)', animation: `peek-time ${PEEK_MS}ms linear forwards` }} />
          </div>
        </div>
      )}

      {open && <InboxPanel inbox={inbox} disabled={disabled} onSend={onSend} onIgnoreMail={onIgnoreMail} />}
    </>
  );
}

function InboxPanel({ inbox, disabled, onSend, onIgnoreMail }: RailProps) {
  const { rows, newSince, setOpen, quietUntil, toggleQuiet } = inbox;
  const [showLow, setShowLow] = useState(false);
  const g = groups(rows);
  const fresh = rows.filter((r) => isNew(r, newSince)).length;
  const go = (text: string) => {
    onSend(text);
    setOpen(false);
  };

  const row = (r: InboxRow) => (
    <li
      key={r.id}
      data-testid="mail-row"
      data-urgency={r.urgency}
      data-new={isNew(r, newSince) || undefined}
      className={`glass mb-1.5 rounded-xl px-3 py-2 text-sm ${r.ignored ? 'opacity-40' : ''}`}
      style={isNew(r, newSince) ? { borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' } : undefined}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px]" style={{ color: URGENCY_COLOR[r.urgency] }}>●</span>
        <span className="truncate text-[14.5px] font-semibold">{senderName(r.from)}</span>
        <span className="ml-auto shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
          {clock(r.at)}
        </span>
      </div>
      <div style={{ color: 'var(--muted)' }}>{r.subject}</div>
      <div className="mt-0.5">{r.summary}</div>
      {!r.ignored && (
        <div className="mt-1.5 flex gap-1.5 text-[12.5px]">
          <button type="button" data-testid="mail-read" disabled={disabled} className="glass rounded-lg px-2 py-px disabled:opacity-40" onClick={() => go(`Read email ${r.id}`)}>
            Read
          </button>
          <button type="button" data-testid="mail-draft-reply" disabled={disabled} className="glass rounded-lg px-2 py-px disabled:opacity-40" onClick={() => go(`Draft a reply to email ${r.id}`)}>
            Draft reply
          </button>
          <button type="button" data-testid="mail-ignore" disabled={disabled} className="glass rounded-lg px-2 py-px disabled:opacity-40" onClick={() => onIgnoreMail(r.itemId, r.id)}>
            Ignore
          </button>
        </div>
      )}
    </li>
  );
  const section = (title: string, list: InboxRow[], testid: string) =>
    list.length > 0 && (
      <section data-testid={testid}>
        <h4 className="mb-1 mt-3 text-xs uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
          {title}
        </h4>
        <ul>{list.map(row)}</ul>
      </section>
    );

  return (
    <aside
      data-testid="inbox"
      role="dialog"
      aria-label="Inbox"
      className="fixed bottom-3 right-[68px] top-16 z-40 flex w-[min(400px,calc(100vw-96px))] flex-col rounded-2xl px-4 py-3.5"
      style={{ ...SOLID, border: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,.35)' }}
    >
      <header className="flex items-center gap-2">
        <MailIcon />
        <h3 className="text-lg font-semibold">Inbox</h3>
        <span className="text-[15px]" style={{ color: 'var(--muted)' }}>
          · {fresh ? `${fresh} new` : 'nothing new'}
        </span>
        <button type="button" data-testid="inbox-close" aria-label="Close the inbox" className="ml-auto px-1 text-xl leading-none" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="-mr-2 flex-1 overflow-y-auto pr-2">
        {rows.length === 0 && (
          <p className="mt-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
            No mail in the last day.
          </p>
        )}
        {section('Needs you', g.needs, 'mail-needs')}
        {section('Others', g.others, 'mail-others')}
        {g.low.length > 0 && (
          // Low priority mail keeps its buttons, so each one can still be read, answered or ignored.
          <section data-testid="mail-digest">
            <h4 className="mb-1 mt-3 text-xs uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
              Low priority
            </h4>
            {showLow ? (
              <ul>{g.low.map(row)}</ul>
            ) : (
              <button type="button" data-testid="mail-low-show" className="glass flex w-full justify-between rounded-xl px-3 py-2 text-left text-[13.5px]" style={{ color: 'var(--muted)' }} onClick={() => setShowLow(true)}>
                <span>
                  {g.low.length} low-priority email{g.low.length === 1 ? '' : 's'}
                </span>
                <span>Show</span>
              </button>
            )}
          </section>
        )}
      </div>
      <footer className="mt-2 flex items-center gap-2 border-t pt-2.5 text-[13px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
        <button type="button" data-testid="inbox-quiet" className="glass rounded-lg px-2.5 py-0.5" onClick={toggleQuiet}>
          {quietUntil ? `Quiet until ${clock(quietUntil)} · End` : 'Quiet for 1 hour'}
        </button>
        <span className="ml-auto">Esc to close</span>
      </footer>
    </aside>
  );
}
