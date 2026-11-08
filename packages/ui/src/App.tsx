import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Message, type MessageActions } from './components/Message';
import { StatusStrip } from './components/StatusStrip';
import { Icon, type IconName } from './components/ui';
import { applyTheme } from './theme';
import { useChat } from './useChat';

export function App() {
  const { state, conn, send, outdated } = useChat();
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
    onDraftSend: (id, hash) => send({ type: 'draft_send', id, hash }),
    onDraftDiscard: (id) => send({ type: 'draft_discard', id }),
    onActionConfirm: (id, hash, choice) => send({ type: 'action_confirm', id, hash, ...(choice === undefined ? {} : { choice }) }),
    onActionCancel: (id) => send({ type: 'action_cancel', id }),
    onEventConfirm: (id, hash) => send({ type: 'event_confirm', id, hash }),
    onEventDiscard: (id) => send({ type: 'event_discard', id }),
    onDocChangeConfirm: (id, hash) => send({ type: 'doc_change_confirm', id, hash }),
    onDocChangeDiscard: (id) => send({ type: 'doc_change_discard', id }),
    onFileChangeConfirm: (id, hash) => send({ type: 'file_change_confirm', id, hash }),
    onFileChangeDiscard: (id) => send({ type: 'file_change_discard', id }),
    onAttachmentSave: (id, folder) => send({ type: 'attachment_save', id, folder }),
    onActionStop: (id) => send({ type: 'action_stop', id }),
    onAppOpen: (actionId) => send({ type: 'app_open', actionId }),
    onCleanup: (id, list, n, action, hash) => send({ type: 'cleanup_action', id, list, n, action, hash }),
    onTodo: (id, todoId, action, hash) => send({ type: 'todo_action', id, todoId, action, hash }),
    onDraftEdit: (id, edit) => send({ type: 'draft_edit', id, ...edit }),
  };

  // Braced bodies: an effect may only return a cleanup function, and newer Chromium
  // returns a Promise from scrollIntoView(), which React would then try to call.
  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.items]);

  // Before the first message of the session, the greeting sits mid-screen with a few starters.
  const fresh = !state.items.some((i) => i.kind === 'user');

  return (
    <div className="flex h-full flex-col">
      <StatusStrip status={state.status} conn={conn} />
      {/* S7: the chat keeps its own screen; this says where apps are and how to come back. */}
      {state.status?.appsAt && (
        <div data-testid="apps-hint" className="mx-auto -mt-1 px-4 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {state.status.appsAt === 'screen' ? 'Your apps open on the other screen.' : 'Your apps open on the next workspace (Super+2).'} Super+Shift+H or the AI button in the top bar brings this back.
        </div>
      )}
      {outdated && (
        <div data-testid="outdated" role="status" className="card mx-auto mt-3 flex items-center gap-3 rounded-[14px] py-2.5 pl-4 pr-3 text-[15px]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
          AI OS was updated. Reload to see everything.
          <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {offline && (
        <div data-testid="offline" role="status" data-tone="danger" className="card mx-auto mt-3 flex max-w-[calc(100%-24px)] items-center gap-3 rounded-[14px] px-4 py-2.5 text-[15px]">
          <span className="spin inline-block h-4 w-4 shrink-0 rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--danger)', borderTopColor: 'transparent' }} />
          <span>
            I can't reach the AI OS service. Retrying… If this lasts, leave the chat with Super+Shift+Escape and run <code className="inset px-1.5 py-0.5 text-[13px]">journalctl --user -u aios-core -n 20</code> to see why.
          </span>
        </div>
      )}
      <main className="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_28px)]" data-testid="chat">
        <div className={`mx-auto flex w-[min(760px,calc(100%-24px))] flex-col gap-6 py-10 ${fresh ? 'min-h-full justify-center' : ''}`}>
          {state.items.map((item) => (
            // Everything but the two sides of the conversation lines up with the assistant's text.
            <div key={item.id} className={item.kind === 'user' || item.kind === 'assistant' ? '' : 'pl-10'}>
              <Message item={item} actions={actions} />
            </div>
          ))}
          {fresh && state.items.length > 0 && <Starters mail={state.status?.mail === 'connected'} disabled={conn !== 'open'} onSend={actions.onSend} />}
          <div ref={bottom} />
        </div>
      </main>
      <Composer working={working} disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} onStop={() => send({ type: 'stop' })} />
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
