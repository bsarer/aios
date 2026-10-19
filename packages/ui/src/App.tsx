import { useEffect, useRef } from 'react';
import { Composer } from './components/Composer';
import { Message } from './components/Message';
import { StatusStrip } from './components/StatusStrip';
import { applyTheme } from './theme';
import { useChat } from './useChat';

export function App() {
  const { state, conn, send } = useChat();
  const bottom = useRef<HTMLDivElement>(null);
  const working = state.status?.agent === 'working';

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
      <main className="flex-1 overflow-y-auto" data-testid="chat">
        <div className="mx-auto flex w-[min(820px,calc(100%-24px))] flex-col gap-4 py-8">
          {state.items.map((item) => (
            <Message key={item.id} item={item} onMemoryDecision={(id, decision) => send({ type: 'memory', id, decision })} />
          ))}
          <div ref={bottom} />
        </div>
      </main>
      <Composer working={working} disabled={conn !== 'open'} onSend={(text) => send({ type: 'send', text })} onStop={() => send({ type: 'stop' })} />
    </div>
  );
}
