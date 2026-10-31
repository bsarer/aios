import type { ChatItem, MailRow } from '@aios/shared/protocol';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { AttachmentViewer } from './AttachmentViewer';
import { DocumentViewer } from './DocumentViewer';

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
          Suggested while an email or document was being read. They can try to plant false memories, so only save this if you know it is true.
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
  /** Send echoes the hash of what the card shows; the server sends only that. */
  onDraftSend: (id: string, hash: string) => void;
  onDraftDiscard: (id: string) => void;
  onDraftEdit: (id: string, edit: { to: string[]; subject: string; body: string }) => void;
  /** A system change (S1) runs only on this click, which echoes the card's hash and the choice clicked. */
  onActionConfirm: (id: string, hash: string, choice?: string) => void;
  onActionCancel: (id: string) => void;
  /** A calendar change (C1) happens only on this click, which echoes the card's hash. */
  onEventConfirm: (id: string, hash: string) => void;
  onEventDiscard: (id: string) => void;
  /** A document change (D2) is saved only on this click, which echoes the card's hash. */
  onDocChangeConfirm: (id: string, hash: string) => void;
  onDocChangeDiscard: (id: string) => void;
  /** Stop on a running build (S4). */
  onActionStop: (id: string) => void;
  /** Open on a finished build's message (S4); names the Build card, not the app. */
  onAppOpen: (actionId: string) => void;
}

type ActionItem = Extract<ChatItem, { kind: 'action' }>;

const ACTION_STATE_TEXT: Record<ActionItem['state'], string> = {
  pending: '',
  running: 'Working…',
  done: '✓ Done',
  cancelled: 'Cancelled. Nothing changed.',
  failed: '',
};

/** A system change waiting for a click. The title can hold network or device names: plain text only. */
/** "0:42", "3:05", "1:02:09". */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** What a running build is doing, how long it has run and its cap, with Stop. */
function ActionProgress({ item, progress, onStop }: { item: ActionItem; progress: NonNullable<ActionItem['progress']>; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="mt-3 flex items-center gap-3 text-sm" style={{ color: 'var(--muted)' }}>
      <span className="spin inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent" />
      <span data-testid="action-progress" className="min-w-0 flex-1 truncate">
        {progress.step}
      </span>
      <span data-testid="action-elapsed" className="tabular-nums">
        {clock(now - progress.startedAt)}
        {progress.capUsd !== undefined && ` · stops at $${progress.capUsd}`}
      </span>
      <button
        type="button"
        data-testid="action-stop"
        className="glass rounded-lg px-3 py-0.5"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          onStop();
        }}
        aria-label={`Stop: ${item.title}`}
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}

function ActionCard({ item, actions }: { item: ActionItem; actions: MessageActions }) {
  const primary = { background: 'var(--accent)', color: 'var(--bg)' };
  return (
    <div data-kind="action" data-state={item.state} className="glass rounded-xl px-4 py-3" style={{ borderLeft: '3px solid var(--warning)' }}>
      <div data-testid="action-title">{item.title}</div>
      {item.note && item.state === 'pending' && (
        <div data-testid="action-note" className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          {item.note}
        </div>
      )}
      {item.state === 'pending' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.choices ? (
            item.choices.map((c) => (
              <button key={c.value} type="button" data-testid="action-choice" data-value={c.value} className="rounded-lg px-3 py-1" style={primary} onClick={() => actions.onActionConfirm(item.id, item.hash, c.value)}>
                {c.label}
              </button>
            ))
          ) : (
            <button type="button" data-testid="action-confirm" className="rounded-lg px-3 py-1" style={primary} onClick={() => actions.onActionConfirm(item.id, item.hash)}>
              {item.confirm}
            </button>
          )}
          <button type="button" data-testid="action-cancel" className="glass rounded-lg px-3 py-1" onClick={() => actions.onActionCancel(item.id)}>
            Cancel
          </button>
        </div>
      ) : item.state === 'running' && item.progress ? (
        <ActionProgress item={item} progress={item.progress} onStop={() => actions.onActionStop(item.id)} />
      ) : (
        <div data-testid="action-state" className="mt-2 text-sm" style={{ color: item.state === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
          {item.result ?? ACTION_STATE_TEXT[item.state]}
        </div>
      )}
    </div>
  );
}

type DraftItem = Extract<ChatItem, { kind: 'draft' }>;

const DRAFT_STATE_TEXT: Record<DraftItem['state'], string> = {
  pending: '',
  sending: 'Sending…',
  sent: '✓ Sent',
  discarded: 'Discarded',
  failed: '',
};

/** The approval card (plan §7). Draft text is plain text, never Markdown or HTML. */
function DraftCard({ item, actions }: { item: DraftItem; actions: MessageActions }) {
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const open = item.state === 'pending' || item.state === 'failed';
  const startEdit = () => {
    setTo(item.to.join(', '));
    setSubject(item.subject);
    setBody(item.body);
    setEditing(true);
  };
  const recipients = to.split(/[,;\s]+/).filter(Boolean);
  const validTo = recipients.length > 0 && recipients.every((r) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(r));
  const field = 'w-full rounded-lg bg-transparent px-2 py-1 outline-none';
  const fieldStyle = { border: '1px solid var(--muted)' };
  return (
    <div data-kind="draft" data-state={item.state} className="glass rounded-xl px-4 py-3" style={{ borderLeft: `3px solid ${item.warnings.length ? 'var(--warning)' : 'var(--accent)'}` }}>
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {item.inReplyTo ? 'Reply draft' : 'Email draft'}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-sm" style={{ color: 'var(--muted)' }}>
            To
            <input data-testid="draft-to" className={field} style={fieldStyle} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="text-sm" style={{ color: 'var(--muted)' }}>
            Subject
            <input data-testid="draft-subject" className={field} style={fieldStyle} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <textarea data-testid="draft-body" className={`${field} min-h-40 font-[inherit]`} style={fieldStyle} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="draft-save"
              disabled={!validTo}
              className="rounded-lg px-3 py-1 disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}
              onClick={() => {
                actions.onDraftEdit(item.id, { to: recipients, subject, body });
                setEditing(false);
              }}
            >
              Save changes
            </button>
            <button type="button" className="glass rounded-lg px-3 py-1" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[15px]">
            <dt style={{ color: 'var(--muted)' }}>To</dt>
            <dd data-testid="draft-to-text">{item.to.join(', ')}</dd>
            <dt style={{ color: 'var(--muted)' }}>Subject</dt>
            <dd>{item.subject}</dd>
          </dl>
          <div data-testid="draft-body-text" className="mt-2 whitespace-pre-wrap rounded-lg px-3 py-2" style={{ background: 'rgba(127,127,127,0.08)' }}>
            {item.body}
          </div>
        </>
      )}
      {item.warnings.map((w) => (
        <div key={w} data-testid="draft-warning" className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          {w}
        </div>
      ))}
      {item.error && (
        <div className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {item.error}
        </div>
      )}
      {open && !editing ? (
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="draft-send" className="rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => actions.onDraftSend(item.id, item.hash)}>
            {item.state === 'failed' ? 'Try again' : 'Send'}
          </button>
          <button type="button" data-testid="draft-edit" className="glass rounded-lg px-3 py-1" onClick={startEdit}>
            Edit
          </button>
          <button type="button" data-testid="draft-discard" className="glass rounded-lg px-3 py-1" onClick={() => actions.onDraftDiscard(item.id)}>
            Discard
          </button>
        </div>
      ) : (
        !open && (
          <div data-testid="draft-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {DRAFT_STATE_TEXT[item.state]}
          </div>
        )
      )}
    </div>
  );
}

type EventItem = Extract<ChatItem, { kind: 'event' }>;

const EVENT_TEXT: Record<EventItem['change'], { heading: string; confirm: string; guests: string }> = {
  create: { heading: 'Add to your calendar?', confirm: 'Add', guests: 'Invites go to' },
  update: { heading: 'Change this event?', confirm: 'Change', guests: 'An update goes to' },
  cancel: { heading: 'Cancel this event?', confirm: 'Cancel event', guests: 'A cancellation goes to' },
};

const EVENT_STATE_TEXT: Record<EventItem['state'], string> = {
  pending: '',
  running: 'Working…',
  done: '✓ Done',
  discarded: 'Discarded. Nothing changed.',
  failed: '',
};

type DocChangeItem = Extract<ChatItem, { kind: 'doc_change' }>;

const DOC_CHANGE_STATE_TEXT: Record<DocChangeItem['state'], string> = {
  pending: '',
  running: 'Saving…',
  done: '✓ Saved',
  discarded: 'Discarded. Nothing was saved.',
  failed: '',
};

/** Changes to a Word or Excel file waiting for a click (D2). Quoted text can come from the file: plain text only. */
function DocChangeCard({ item, actions }: { item: DocChangeItem; actions: MessageActions }) {
  const open = item.state === 'pending' || item.state === 'failed';
  const app = item.fileKind === 'word' ? 'Word' : 'Excel';
  const heading = item.change === 'create' ? `Create a new ${app} file?` : item.overwrite ? `Change this ${app} file and save over it?` : `Change this ${app} file?`;
  const confirm = item.overwrite ? 'Overwrite' : item.change === 'create' ? 'Create' : 'Save as new file';
  const quote = (text: string, testid: string, strike = false) => (
    <div data-testid={testid} className="mt-1 whitespace-pre-wrap break-words rounded-md px-2 py-1 text-[14px]" style={{ background: 'var(--panel)', textDecoration: strike ? 'line-through' : undefined, opacity: strike ? 0.75 : 1 }}>
      {text}
    </div>
  );
  return (
    <div data-kind="doc_change" data-change={item.change} data-state={item.state} data-overwrite={item.overwrite} className="glass rounded-xl px-4 py-3" style={{ borderLeft: `3px solid ${item.overwrite ? 'var(--danger)' : 'var(--accent)'}` }}>
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {heading}
      </div>
      {item.file && (
        <div data-testid="doc-change-file" className="mt-1 break-all font-medium">
          {item.file}
        </div>
      )}
      <ol className="mt-2 space-y-2">
        {item.lines.map((l, i) => (
          <li key={i} data-testid="doc-change-line" className="text-[15px]">
            <div>{l.what}</div>
            {l.before !== undefined && quote(l.before, 'doc-change-before', l.after !== undefined || /^Delete/.test(l.what))}
            {l.after !== undefined && quote(l.after, 'doc-change-after')}
          </li>
        ))}
      </ol>
      <div data-testid="doc-change-output" className="mt-2 text-sm" style={{ color: item.overwrite ? 'var(--danger)' : 'var(--muted)' }}>
        {item.overwrite ? `Saves over ${item.output}. The original is copied to the backups folder first.` : item.change === 'create' ? `Creates ${item.output}.` : `Saves to ${item.output}. The original stays as it is.`}
      </div>
      {item.warnings.map((w) => (
        <div key={w} data-testid="doc-change-warning" className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          {w}
        </div>
      ))}
      {item.state === 'failed' && item.result && (
        <div data-testid="doc-change-state" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {item.result}
        </div>
      )}
      {open ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="doc-change-confirm"
            className="rounded-lg px-3 py-1"
            style={{ background: item.overwrite ? 'var(--danger)' : 'var(--accent)', color: 'var(--bg)' }}
            onClick={() => actions.onDocChangeConfirm(item.id, item.hash)}
          >
            {item.state === 'failed' ? `Try again: ${confirm}` : confirm}
          </button>
          <button type="button" data-testid="doc-change-discard" className="glass rounded-lg px-3 py-1" onClick={() => actions.onDocChangeDiscard(item.id)}>
            Discard
          </button>
        </div>
      ) : (
        <div data-testid="doc-change-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.result ?? DOC_CHANGE_STATE_TEXT[item.state]}
        </div>
      )}
    </div>
  );
}

/** A calendar change waiting for a click (C1). Titles and notes can come from other people's invites: plain text only. */
function EventCard({ item, actions }: { item: EventItem; actions: MessageActions }) {
  const t = EVENT_TEXT[item.change];
  const open = item.state === 'pending' || item.state === 'failed';
  const row = (label: string, value: string, testid: string) => (
    <div className="flex gap-2 text-[15px]">
      <span className="w-16 shrink-0" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span data-testid={testid} className="min-w-0 whitespace-pre-wrap break-words">
        {value}
      </span>
    </div>
  );
  return (
    <div data-kind="event" data-change={item.change} data-state={item.state} className="glass rounded-xl px-4 py-3" style={{ borderLeft: `3px solid ${item.change === 'cancel' ? 'var(--danger)' : 'var(--accent)'}` }}>
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {t.heading}
      </div>
      <div data-testid="event-title" className="mt-1 font-medium">
        {item.title}
      </div>
      <div className="mt-1 space-y-0.5">
        {item.before && row('Was', item.before, 'event-before')}
        {row(item.before ? 'Now' : 'When', item.when, 'event-when')}
        {item.location !== undefined && row('Where', item.location || '(none)', 'event-location')}
        {item.description !== undefined && row('Notes', item.description || '(none)', 'event-description')}
      </div>
      {item.attendees.length > 0 && (
        <div data-testid="event-attendees" className="mt-2 text-sm">
          {t.guests}: {item.attendees.join(', ')}
        </div>
      )}
      {item.warnings.map((w) => (
        <div key={w} data-testid="event-warning" className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          {w}
        </div>
      ))}
      {item.state === 'failed' && item.result && (
        <div data-testid="event-state" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {item.result}
        </div>
      )}
      {open ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="event-confirm"
            className="rounded-lg px-3 py-1"
            style={{ background: item.change === 'cancel' ? 'var(--danger)' : 'var(--accent)', color: 'var(--bg)' }}
            onClick={() => actions.onEventConfirm(item.id, item.hash)}
          >
            {item.state === 'failed' ? `Try again: ${t.confirm}` : t.confirm}
          </button>
          <button type="button" data-testid="event-discard" className="glass rounded-lg px-3 py-1" onClick={() => actions.onEventDiscard(item.id)}>
            Discard
          </button>
        </div>
      ) : (
        <div data-testid="event-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.result ?? EVENT_STATE_TEXT[item.state]}
        </div>
      )}
    </div>
  );
}

type DocumentItem = Extract<ChatItem, { kind: 'document' }>;

/** A Word or Excel file the user can open (D1). File names can come from anyone: plain text only. */
function DocumentCard({ item }: { item: DocumentItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-kind="document" className="glass flex items-center gap-3 rounded-xl px-4 py-3" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="min-w-0 flex-1">
        <div data-testid="document-name" className="break-all">
          {item.name}
        </div>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {item.fileKind === 'word' ? 'Word document' : 'Excel spreadsheet'}
        </div>
      </div>
      <button type="button" data-testid="document-open" className="rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <DocumentViewer item={item} onClose={() => setOpen(false)} />}
    </div>
  );
}

type AttachmentItem = Extract<ChatItem, { kind: 'attachment' }>;

const FILE_KIND_TEXT: Record<AttachmentItem['fileKind'], string> = { pdf: 'PDF', text: 'Text file', image: 'Picture' };

/** An email attachment the user can open (S2). The name came from the email: plain text only. */
function AttachmentCard({ item }: { item: AttachmentItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-kind="attachment" className="glass flex items-center gap-3 rounded-xl px-4 py-3" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="min-w-0 flex-1">
        <div data-testid="attachment-name" className="break-all">
          {item.name}
        </div>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {FILE_KIND_TEXT[item.fileKind]} from an email
        </div>
      </div>
      <button type="button" data-testid="attachment-open" className="rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <AttachmentViewer item={item} onClose={() => setOpen(false)} />}
    </div>
  );
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
          <button type="button" data-testid="mail-draft-reply" className="glass rounded-lg px-2.5 py-0.5" onClick={() => actions.onSend(`Draft a reply to email ${r.id}`)}>
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
        // Low priority mail keeps its buttons, so each one can still be read, answered or opened.
        <div data-testid="mail-digest" className="mt-2 text-sm">
          <div style={{ color: 'var(--muted)' }}>Low priority</div>
          <ul>{low.map(row)}</ul>
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
    case 'draft':
      return <DraftCard item={item} actions={actions} />;
    case 'action':
      return <ActionCard item={item} actions={actions} />;
    case 'event':
      return <EventCard item={item} actions={actions} />;
    case 'doc_change':
      return <DocChangeCard item={item} actions={actions} />;
    case 'attachment':
      return <AttachmentCard item={item} />;
    case 'document':
      return <DocumentCard item={item} />;
    case 'build_result':
      return (
        <div data-kind="build_result" data-ok={item.ok} className="glass rounded-xl px-4 py-3" style={{ borderLeft: `3px solid ${item.ok ? 'var(--accent)' : 'var(--danger)'}` }}>
          <div data-testid="build-result-text">{item.text}</div>
          {item.ok && (
            <button type="button" data-testid="build-open" className="mt-3 rounded-lg px-3 py-1" style={{ background: 'var(--accent)', color: 'var(--bg)' }} onClick={() => actions.onAppOpen(item.actionId)}>
              Open
            </button>
          )}
        </div>
      );
  }
}
