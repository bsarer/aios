import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Message, type MessageActions } from './components/Message';
import { Orb } from './components/Orb';
import { StatusStrip } from './components/StatusStrip';
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
    onDraftEdit: (id, edit) => send({ type: 'draft_edit', id, ...edit }),
  };

  // Braced bodies: an effect may only return a cleanup function, and newer Chromium
  // returns a Promise from scrollIntoView(), which React would then try to call.
  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.items, state.window]);

  // S3: how many items there were when the chat became the orb, so the orb can say something new came in.
  const [seen, setSeen] = useState(0);
  const itemCount = state.items.length;
  const mode = state.window;
  useEffect(() => {
    if (mode === 'orb') setSeen(itemCount);
    // Only on entering the orb (itemCount is left out on purpose): what comes after is what it reports.
  }, [mode]);
  // Esc at half screen puts the chat back to the orb, unless it is stopping a reply (Composer).
  useEffect(() => {
    if (mode !== 'half') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !working) send({ type: 'window', mode: 'orb' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, working, send]);

  if (mode === 'orb') return <Orb working={working} unseen={itemCount > seen} onOpen={() => send({ type: 'window', mode: 'half' })} />;

  return (
    <div className="flex h-full flex-col">
      <StatusStrip status={state.status} conn={conn} />
      {(mode === 'half' || mode === 'side') && (
        <div className="mx-auto mt-2 flex gap-2" data-testid="window-controls">
          {/* S6: beside an app the chat has its own half; only half floats over one and can shrink back. */}
          {mode === 'half' && (
            <button type="button" data-testid="window-orb" className="glass rounded-lg px-3 py-1 text-[14px]" onClick={() => send({ type: 'window', mode: 'orb' })}>
              Back to the orb
            </button>
          )}
          <button type="button" data-testid="window-full" className="glass rounded-lg px-3 py-1 text-[14px]" onClick={() => send({ type: 'window', mode: 'full' })}>
            Full screen
          </button>
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
      <Composer working={working} disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} onStop={() => send({ type: 'stop' })} />
    </div>
  );
}
