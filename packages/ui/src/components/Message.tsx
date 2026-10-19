import type { ChatItem } from '@aios/shared/protocol';
import Markdown from 'react-markdown';

/** react-markdown renders no raw HTML by default, which matters: replies can quote email text. */
export function Message({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end" data-kind="user">
          <div className="glass max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div data-kind="assistant" data-streaming={item.streaming || undefined} className="max-w-[92%]">
          <div className={`md ${item.streaming ? 'caret' : ''}`}>
            <Markdown>{item.text}</Markdown>
          </div>
          {item.stopped && <div className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>Stopped</div>}
        </div>
      );
    case 'tool':
      return (
        <div data-kind="tool" className="flex items-center gap-2 text-[15px]" style={{ color: 'var(--muted)' }}>
          {item.state === 'running' ? (
            <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <span style={{ color: item.state === 'failed' ? 'var(--danger)' : 'var(--accent)' }}>{item.state === 'failed' ? '✕' : '✓'}</span>
          )}
          <span>{item.state === 'running' ? item.label : item.label.replace(/…$/, '')}</span>
        </div>
      );
    case 'notice': {
      const color = item.level === 'error' ? 'var(--danger)' : item.level === 'warning' ? 'var(--warning)' : 'var(--accent)';
      return (
        <div data-kind="notice" className="glass whitespace-pre-wrap rounded-xl px-4 py-2.5 text-[15px]" style={{ borderLeft: `3px solid ${color}` }}>
          {item.text}
        </div>
      );
    }
    case 'notification':
      return (
        <div data-kind="notification" className="glass rounded-xl px-4 py-3" style={{ borderLeft: '3px solid var(--accent)' }}>
          {item.text}
        </div>
      );
  }
}
