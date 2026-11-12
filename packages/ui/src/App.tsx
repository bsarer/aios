import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Message, type MessageActions } from './components/Message';
import { StatusStrip } from './components/StatusStrip';
import { WidgetBar } from './components/WidgetBar';
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
    onDocumentEdit: (id) => send({ type: 'document_edit', id }),
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

  return (
    <div className="flex h-full flex-col">
      <StatusStrip status={state.status} conn={conn} />
      {/* S7: the chat keeps its own screen; this says where apps are and how to come back. */}
      {state.status?.appsAt && (
        <div data-testid="apps-hint" className="mx-auto mt-1 text-[13px] opacity-60">
          {state.status.appsAt === 'screen' ? 'Your apps open on the other screen.' : 'Your apps open on the next workspace (Super+2).'} Super+Shift+H or the AI button in the top bar brings this back.
        </div>
      )}
      {outdated && (
        <div data-testid="outdated" className="glass mx-auto mt-2 flex items-center gap-3 rounded-xl px-4 py-2 text-[15px]" style={{ borderLeft: '3px solid var(--warning)' }}>
          AI OS was updated. Reload to see everything.
          <button type="button" className="rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {offline && (
        <div data-testid="offline" className="glass mx-auto mt-2 rounded-xl px-4 py-2 text-[15px]" style={{ borderLeft: '3px solid var(--danger)' }}>
          I can't reach the AI OS service. Retrying… If this lasts, leave the chat with Super+Shift+Escape and run <code>journalctl --user -u aios-core -n 20</code> to see why.
        </div>
      )}
      <main className="flex-1 overflow-y-auto" data-testid="chat">
        <div className="mx-auto flex w-[min(820px,calc(100%-24px))] flex-col gap-4 py-8">
          {state.items.map((item) => (
            <Message key={item.id} item={item} actions={actions} />
          ))}
          <div ref={bottom} />
        </div>
      </main>
      <Composer tight={(state.widgets?.pinned.length ?? 0) > 0} working={working} disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} onStop={() => send({ type: 'stop' })} voiceMaxSeconds={state.status?.voice?.maxSeconds ?? null} />
      {/* W1: pinned system features along the bottom of the screen. */}
      <WidgetBar
        widgets={state.widgets}
        disabled={conn !== 'open'}
        onOpen={(widget) => send({ type: 'widget_open', widget })}
        onPin={(widget, pinned) => send({ type: 'widget_pin', widget, pinned })}
      />
    </div>
  );
}
