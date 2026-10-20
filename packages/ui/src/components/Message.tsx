import type { ChatItem, MailRow } from '@aios/shared/protocol';
import Markdown from 'react-markdown';

/** react-markdown renders no raw HTML by default, which matters: replies can quote email text. */
function MemoryCard({ item, onDecide }: { item: Extract<ChatItem, { kind: 'memory' }>; onDecide: (decision: 'save' | 'skip') => void }) {
  const fromEmail = item.source === 'email';
  return (
    <div data-kind="memory" data-state={item.state} className="glass rounded-xl px-4 py-3" style={{ borderLeft: `3px solid ${fromEmail ? 'var(--warning)' : 'var(--accent)'}` }}>
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {item.target === 'profile' ? 'Add to your profile?' : 'Remember this?'}
      </div>
      <div className="mt-1">{item.text}</div>
      {fromEmail && (
        <div className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          Suggested while an email was being read. Emails can try to plant false memories, so only save this if you know it is true.
        </div>
      )}
      {item.state === 'pending' ? (
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="memory-save" className="rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => onDecide('save')}>
            Save
          </button>
          <button type="button" data-testid="memory-skip" className="glass rounded-lg px-3 py-1" onClick={() => onDecide('skip')}>
            Skip
          </button>
        </div>
      ) : (
        <div className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.state === 'saved' ? '✓ Saved' : 'Skipped'}
        </div>
      )}
    </div>
  );
}

export interface MessageActions {
  onMemoryDecision: (id: string, decision: 'save' | 'skip') => void;
  /** Sends a chat message as if typed; only ever with text the UI wrote, never mail content. */
  onSend: (text: string) => void;
  onIgnoreMail: (itemId: string, mailId: string) => void;
}

const URGENCY_COLOR = { high: 'var(--danger)', normal: 'var(--accent)', low: 'var(--muted)' } as const;

/** Mail-derived text (from, subject, summary) is rendered as plain text, never Markdown or HTML. */
function MailNotification({ item, actions }: { item: Extract<ChatItem, { kind: 'notification' }>; actions: MessageActions }) {
  const rows = item.mails ?? [];
  const main = rows.filter((r) => r.urgency !== 'low');
  const low = rows.filter((r) => r.urgency === 'low');
  const row = (r: MailRow) => (
    <li key={r.id} data-testid="mail-row" data-urgency={r.urgency} className={`py-2 ${r.ignored ? 'opacity-40' : ''}`}>
      <div className="flex items-baseline gap-2">
        <span style={{ color: URGENCY_COLOR[r.urgency] }}>●</span>
        <span className="font-medium">{r.from.replace(/\s*<[^>]*>$/, '')}</span>
        <span style={{ color: 'var(--muted)' }}>· {r.subject}</span>
      </div>
      <div className="ml-5 text-[15px]">{r.summary}</div>
      {!r.ignored && (
        <div className="ml-5 mt-1 flex gap-2 text-sm">
          <button type="button" data-testid="mail-read" className="glass rounded-lg px-2.5 py-0.5" onClick={() => actions.onSend(`Read email ${r.id}`)}>
            Read
          </button>
          <button type="button" disabled title="Replies arrive in the next milestone" className="glass rounded-lg px-2.5 py-0.5 opacity-40">
            Draft reply
          </button>
          <button type="button" data-testid="mail-ignore" className="glass rounded-lg px-2.5 py-0.5" onClick={() => actions.onIgnoreMail(item.id, r.id)}>
            Ignore
          </button>
        </div>
      )}
    </li>
  );
  return (
    <div data-kind="notification" className="glass rounded-xl px-4 py-3" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="font-medium">{item.text}</div>
      {main.length > 0 && <ul className="mt-1">{main.map(row)}</ul>}
      {low.length > 0 && (
        <div data-testid="mail-digest" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Low priority: {low.map((r) => `${r.from.replace(/\s*<[^>]*>$/, '')} (${r.subject})`).join(', ')}
        </div>
      )}
    </div>
  );
}

export function Message({ item, actions }: { item: ChatItem; actions: MessageActions }) {
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
    case 'memory':
      return <MemoryCard item={item} onDecide={(d) => actions.onMemoryDecision(item.id, d)} />;
    case 'notification':
      return <MailNotification item={item} actions={actions} />;
  }
}
