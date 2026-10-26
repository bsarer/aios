import { useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { Message, type MessageActions } from './components/Message';
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
    onActionConfirm: (id, hash) => send({ type: 'action_confirm', id, hash }),
    onActionCancel: (id) => send({ type: 'action_cancel', id }),
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

  const mode = state.window;
  // Esc at half screen hides the chat again, unless it is stopping a reply (Composer).
  useEffect(() => {
    if (mode !== 'half') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !working) send({ type: 'window', mode: 'hidden' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, working, send]);

  return (
    <div className="flex h-full flex-col">
      <StatusStrip status={state.status} conn={conn} />
      {mode === 'half' && (
        <div className="mx-auto mt-2 flex gap-2" data-testid="window-controls">
          <button type="button" data-testid="window-hide" className="glass rounded-lg px-3 py-1 text-[14px]" onClick={() => send({ type: 'window', mode: 'hidden' })}>
            Hide
          </button>
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
