import { type ChatState, ClientMessage, ServerEvent, applyEvent, initialChatState } from '@aios/shared/protocol';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

export type Connection = 'connecting' | 'open' | 'closed';

/** Keeps a WebSocket to aios-core open (reconnecting with backoff) and folds its events into chat state. */
export function useChat() {
  const [state, dispatch] = useReducer(applyEvent, initialChatState as ChatState);
  const [conn, setConn] = useState<Connection>('connecting');
  // Set when the server sends something this build of the page can't read: aios-core was updated and the page wasn't reloaded.
  const [outdated, setOutdated] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: number | undefined;
    const open = () => {
      setConn('connecting');
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConn('open');
      };
      sock.onmessage = (m) => {
        const ev = ServerEvent.safeParse(JSON.parse(String(m.data)));
        if (ev.success) dispatch(ev.data);
        else setOutdated(true);
      };
      sock.onclose = () => {
        setConn('closed');
        if (!stopped) timer = window.setTimeout(open, Math.min(500 * 2 ** retry++, 5000));
      };
    };
    open();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(ClientMessage.parse(msg)));
  }, []);

  return { state, conn, send, outdated };
}
