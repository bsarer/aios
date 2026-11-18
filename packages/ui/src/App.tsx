import { useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { FeedbackButton } from './components/FeedbackButton';
import { MailRail, useInbox } from './components/MailRail';
import { useSignals } from './components/SignalPanel';
import { Message, type MessageActions } from './components/Message';
import { StatusStrip } from './components/StatusStrip';
import { Icon, type IconName } from './components/ui';
import { WidgetBar } from './components/WidgetBar';
import { applyTheme } from './theme';
import { useChat } from './useChat';

export function App() {
  const { state, conn, send, outdated } = useChat();
  // Calm mail alerts: new mail waits in the side rail's inbox instead of the chat.
  const inbox = useInbox(state.items);
  // SG1: new Signal messages wait in the same rail, under their own button.
  const signals = useSignals(state.items, inbox.quietUntil, state.status?.signal === true);
  // One panel at a time.
  const openInbox = (v: boolean) => {
    if (v) signals.setOpen(false);
    inbox.setOpen(v);
  };
  // Up/Down in the message box: the user's own messages in the chat, oldest first.
  const earlier = useMemo(() => state.items.flatMap((i) => (i.kind === 'user' ? [i.text] : [])), [state.items]);
  const bottom = useRef<HTMLDivElement>(null);
  const working = state.status?.agent === 'working';
  // A short blip while the service restarts shows nothing; a lasting outage says what to do.
  // Keyed on open/not open: retries flip between closed and connecting and must not restart the timer.
  const [offline, setOffline] = useState(false);
  const open = conn === 'open';
  useEffect(() => {
    if (open) {
      setOffline(false);
      return;
    }
    const t = window.setTimeout(() => setOffline(true), 5000);
    return () => window.clearTimeout(t);
  }, [open]);
  const actions: MessageActions = {
    onMemoryDecision: (id, decision) => send({ type: 'memory', id, decision }),
    onSend: (text) => send({ type: 'send', text }),
    onIgnoreMail: (itemId, mailId) => send({ type: 'mail_ignore', itemId, mailId }),
    onOpenInbox: () => openInbox(true),
    onDraftSend: (id, hash) => send({ type: 'draft_send', id, hash }),
    onDraftDiscard: (id) => send({ type: 'draft_discard', id }),
    onActionConfirm: (id, hash, choice) => send({ type: 'action_confirm', id, hash, ...(choice === undefined ? {} : { choice }) }),
    onActionCancel: (id) => send({ type: 'action_cancel', id }),
    onEventConfirm: (id, hash) => send({ type: 'event_confirm', id, hash }),
    onEventDiscard: (id) => send({ type: 'event_discard', id }),
    onSignalSend: (id, hash) => send({ type: 'signal_send', id, hash }),
    onSignalDiscard: (id) => send({ type: 'signal_discard', id }),
    onDocChangeConfirm: (id, hash) => send({ type: 'doc_change_confirm', id, hash }),
    onDocChangeDiscard: (id) => send({ type: 'doc_change_discard', id }),
    onFileChangeConfirm: (id, hash) => send({ type: 'file_change_confirm', id, hash }),
    onFileChangeDiscard: (id) => send({ type: 'file_change_discard', id }),
    onAttachmentSave: (id, folder) => send({ type: 'attachment_save', id, folder }),
    onDocumentEdit: (id) => send({ type: 'document_edit', id }),
    onActionStop: (id) => send({ type: 'action_stop', id }),
    onAppOpen: (actionId) => send({ type: 'app_open', actionId }),
    onCleanup: (id, list, n, action, hash) => send({ type: 'cleanup_action', id, list, n, action, hash }),
    onTodo: (id, todoId, action, hash) => send({ type: 'todo_action', id, todoId, action, hash }),
    onDraftEdit: (id, edit) => send({ type: 'draft_edit', id, ...edit }),
    onUpdate: (id) => send({ type: 'update_start', id }),
    onKnowledgeSave: state.status?.knowledge ? (id) => send({ type: 'knowledge_save', id }) : undefined,
  };

  // Braced bodies: an effect may only return a cleanup function, and newer Chromium
  // returns a Promise from scrollIntoView(), which React would then try to call.
  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.items]);

  // After Clear, mail notifications from before it stay for the inbox but leave the chat.
  const shown = useMemo(() => {
    const cleared = state.clearedAt;
    return cleared === null ? state.items : state.items.filter((i) => i.kind !== 'notification' || i.at > cleared);
  }, [state.items, state.clearedAt]);
  // Before the first message of the session, the greeting sits mid-screen with a few starters.
  const fresh = !shown.some((i) => i.kind === 'user');

  return (
    // While the inbox is open on a wide screen, the chat moves aside for it (styles.css).
    <div className={`flex h-full flex-col ${inbox.open || signals.open ? 'inbox-open' : ''}`}>
      <StatusStrip status={state.status} conn={conn} onSettings={() => send({ type: 'settings_open' })} onClear={fresh ? undefined : () => send({ type: 'chat_clear' })} working={working} mail={{ fresh: inbox.fresh, urgent: inbox.urgent }} onMail={() => openInbox(!inbox.open)} />
      {/* S7: the chat keeps its own screen; this says where apps are and how to come back. */}
      {state.status?.appsAt && (
        <div data-testid="apps-hint" className="mx-auto -mt-1 px-4 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {state.status.appsAt === 'screen' ? 'Your apps open on the other screen.' : 'Your apps open on the next workspace (Super+2).'} Super+Shift+H or the AI button in the top bar brings this back.
        </div>
      )}
      {outdated && (
        <div data-testid="outdated" role="status" className="card mx-auto mt-3 flex items-center gap-3 rounded-[14px] py-2.5 pl-4 pr-3 text-[15px]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
          Astra was updated. Reload to see everything.
          <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {offline && (
        <div data-testid="offline" role="status" data-tone="danger" className="card mx-auto mt-3 flex max-w-[calc(100%-24px)] items-center gap-3 rounded-[14px] px-4 py-2.5 text-[15px]">
          <span className="spin inline-block h-4 w-4 shrink-0 rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--danger)', borderTopColor: 'transparent' }} />
          <span>
            I can't reach the Astra service. Retrying… If this lasts, leave the chat with Super+Shift+Escape and run <code className="inset px-1.5 py-0.5 text-[13px]">astra doctor</code> in a terminal to see why.
          </span>
        </div>
      )}
      <main className="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_28px)]" data-testid="chat">
        <div className={`mx-auto flex w-[min(760px,calc(100%-24px))] flex-col gap-6 py-10 ${fresh ? 'min-h-full justify-center' : ''}`}>
          {shown.map((item) => (
            // Everything but the two sides of the conversation lines up with the assistant's text.
            <div key={item.id} className={item.kind === 'user' || item.kind === 'assistant' ? '' : 'pl-10 empty:hidden'}>
              <Message item={item} actions={actions} />
            </div>
          ))}
          {fresh && shown.length > 0 && <Starters mail={state.status?.mail === 'connected'} disabled={conn !== 'open'} onSend={actions.onSend} />}
          <div ref={bottom} />
        </div>
      </main>
      <Composer tight={(state.widgets?.pinned.length ?? 0) > 0} working={working} disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} onStop={() => send({ type: 'stop' })} voiceMaxSeconds={state.status?.voice?.maxSeconds ?? null} earlier={earlier} />
      {/* W1: pinned system features along the bottom of the screen. */}
      <MailRail inbox={inbox} disabled={conn !== 'open'} onSend={actions.onSend} onIgnoreMail={actions.onIgnoreMail} signals={signals} />
      {/* The floating Feedback button: it only sends /feedback, the same as typing it. */}
      <FeedbackButton disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} />
      <WidgetBar
        widgets={state.widgets}
        disabled={conn !== 'open'}
        onOpen={(widget) => send({ type: 'widget_open', widget })}
        onPin={(widget, pinned) => send({ type: 'widget_pin', widget, pinned })}
      />
    </div>
  );
}

/** Starter prompts for a fresh chat. The text is written here, never taken from mail or files. */
const STARTERS: { icon: IconName; text: string; needsMail?: boolean }[] = [
  { icon: 'calendar', text: "What's on today?" },
  { icon: 'mail', text: 'Check my email', needsMail: true },
  { icon: 'todo', text: 'Show my to-dos' },
  { icon: 'folder', text: 'Find a file' },
];

function Starters({ mail, disabled, onSend }: { mail: boolean; disabled: boolean; onSend: (text: string) => void }) {
  return (
    <div data-testid="starters" className="grid grid-cols-1 gap-2.5 pl-10 sm:grid-cols-2">
      {STARTERS.filter((s) => mail || !s.needsMail).map((s) => (
        <button
          key={s.text}
          type="button"
          data-testid="starter"
          disabled={disabled}
          className="card flex min-h-14 items-center gap-3 rounded-[14px] px-4 text-left text-[15px] transition-colors hover:border-[var(--line-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          style={{ outlineColor: 'var(--accent)' }}
          onClick={() => onSend(s.text)}
        >
          <span style={{ color: 'var(--accent)' }}>
            <Icon name={s.icon} size={18} />
          </span>
          {s.text}
        </button>
      ))}
    </div>
  );
}
