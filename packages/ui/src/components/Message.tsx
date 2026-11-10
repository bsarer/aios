import type { ChatItem, MailRow } from '@aios/shared/protocol';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { AttachmentViewer } from './AttachmentViewer';
import { DocumentViewer } from './DocumentViewer';
import { Card, CardActions, Icon, Mark, NEEDS_OK } from './ui';

/** react-markdown renders no raw HTML by default, which matters: replies can quote email text. */
function MemoryCard({ item, onDecide }: { item: Extract<ChatItem, { kind: 'memory' }>; onDecide: (decision: 'save' | 'skip') => void }) {
  const fromEmail = item.source === 'email';
  return (
    <Card
      data-kind="memory"
      data-state={item.state}
      icon="memory"
      title={item.target === 'profile' ? 'Add to your profile?' : 'Remember this?'}
      badge={fromEmail ? { text: 'From an email or document', tone: 'warning' } : false}
    >
      <div>{item.text}</div>
      {fromEmail && (
        <div className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          Suggested while an email or document was being read. They can try to plant false memories, so only save this if you know it is true.
        </div>
      )}
      {item.state === 'pending' ? (
        <CardActions>
          <button type="button" data-testid="memory-save" className="btn btn-primary" onClick={() => onDecide('save')}>
            Save
          </button>
          <button type="button" data-testid="memory-skip" className="btn btn-secondary" onClick={() => onDecide('skip')}>
            Skip
          </button>
        </CardActions>
      ) : (
        <div className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.state === 'saved' ? '✓ Saved' : 'Skipped'}
        </div>
      )}
    </Card>
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
  onDraftEdit: (id: string, edit: { to: string[]; subject: string; body: string; keep?: number[] }) => void;
  /** A system change (S1) runs only on this click, which echoes the card's hash and the choice clicked. */
  onActionConfirm: (id: string, hash: string, choice?: string) => void;
  onActionCancel: (id: string) => void;
  /** A calendar change (C1) happens only on this click, which echoes the card's hash. */
  onEventConfirm: (id: string, hash: string) => void;
  onEventDiscard: (id: string) => void;
  /** A document change (D2) is saved only on this click, which echoes the card's hash. */
  onDocChangeConfirm: (id: string, hash: string) => void;
  onDocChangeDiscard: (id: string) => void;
  /** F1: a file change happens only on this click, which echoes the card's hash. */
  onFileChangeConfirm: (id: string, hash: string) => void;
  onFileChangeDiscard: (id: string) => void;
  /** F1: Save on an attachment card, into the folder picked (by its index on the card). */
  onAttachmentSave: (id: string, folder: number) => void;
  /** D3: Edit on a document card or its viewer; opens the card's file in WordCraft or GridCraft. */
  onDocumentEdit: (id: string) => void;
  /** Stop on a running build (S4). */
  onActionStop: (id: string) => void;
  /** Open on a finished build's message (S4); names the Build card, not the app. */
  onAppOpen: (actionId: string) => void;
  /** L1: a button on one row of the morning review, echoing that row's hash. */
  onCleanup: (id: string, list: 'file' | 'app', n: number, action: 'trash' | 'close' | 'keep', hash: string) => void;
  /** T1: a button on one row of a to-do card, echoing that row's hash. */
  onTodo: (id: string, todoId: string, action: 'done' | 'reopen' | 'remove' | 'snooze', hash: string) => void;
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
        className="btn btn-secondary btn-sm"
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
  // S4 builds use this card too; only they carry spending-cap choices or progress.
  const build = item.choices !== undefined || item.progress !== undefined;
  const badge =
    item.state === 'pending' ? { text: NEEDS_OK, tone: 'warning' as const } : item.state === 'running' ? { text: 'Running', tone: 'accent' as const } : item.state === 'failed' ? { text: "Didn't work", tone: 'danger' as const } : false;
  return (
    <Card data-kind="action" data-state={item.state} icon={build ? 'box' : 'system'} tone={item.state === 'failed' ? 'danger' : build ? 'accent' : 'warning'} title={build ? 'App build' : 'System change'} badge={badge}>
      <div data-testid="action-title">{item.title}</div>
      {item.note && item.state === 'pending' && (
        <div data-testid="action-note" className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          {item.note}
        </div>
      )}
      {item.state === 'pending' ? (
        <CardActions>
          {item.choices ? (
            item.choices.map((c) => (
              <button key={c.value} type="button" data-testid="action-choice" data-value={c.value} className="btn btn-primary" onClick={() => actions.onActionConfirm(item.id, item.hash, c.value)}>
                {c.label}
              </button>
            ))
          ) : (
            <button type="button" data-testid="action-confirm" className="btn btn-primary" onClick={() => actions.onActionConfirm(item.id, item.hash)}>
              {item.confirm}
            </button>
          )}
          <button type="button" data-testid="action-cancel" className="btn btn-secondary" onClick={() => actions.onActionCancel(item.id)}>
            Cancel
          </button>
        </CardActions>
      ) : item.state === 'running' && item.progress ? (
        <ActionProgress item={item} progress={item.progress} onStop={() => actions.onActionStop(item.id)} />
      ) : (
        <div data-testid="action-state" className="mt-2 text-sm" style={{ color: item.state === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
          {item.result ?? ACTION_STATE_TEXT[item.state]}
        </div>
      )}
    </Card>
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

const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** M1: the files on a draft. Names come from disk: plain text only. While editing, each can be removed. */
function DraftFiles({ files, removed, onToggle }: { files: NonNullable<DraftItem['attachments']>; removed?: Set<number>; onToggle?: (i: number) => void }) {
  return (
    <ul data-testid="draft-files" className="mt-2 flex flex-col gap-1 text-sm">
      {files.map((f, i) => (
        <li key={`${i}-${f.path}`} data-testid="draft-file" className="flex items-center gap-2" style={removed?.has(i) ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}>
          <span aria-hidden>📎</span>
          <span className="truncate" title={f.path}>
            {f.name}
          </span>
          <span style={{ color: 'var(--muted)' }}>{fileSize(f.bytes)}</span>
          {onToggle && (
            <button type="button" data-testid="draft-file-remove" className="btn btn-secondary btn-sm ml-auto" onClick={() => onToggle(i)}>
              {removed?.has(i) ? 'Keep' : 'Remove'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The approval card (plan §7). Draft text is plain text, never Markdown or HTML. */
function DraftCard({ item, actions }: { item: DraftItem; actions: MessageActions }) {
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const files = item.attachments ?? [];
  const open = item.state === 'pending' || item.state === 'failed';
  const startEdit = () => {
    setTo(item.to.join(', '));
    setSubject(item.subject);
    setBody(item.body);
    setRemoved(new Set());
    setEditing(true);
  };
  const toggleFile = (i: number) =>
    setRemoved((r) => {
      const next = new Set(r);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const recipients = to.split(/[,;\s]+/).filter(Boolean);
  const validTo = recipients.length > 0 && recipients.every((r) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(r));
  const field = 'w-full rounded-lg bg-transparent px-2 py-1 outline-none';
  const fieldStyle = { border: '1px solid var(--muted)' };
  return (
    <Card
      data-kind="draft"
      data-state={item.state}
      icon="mail"
      tone={item.warnings.length ? 'warning' : 'accent'}
      title={item.inReplyTo ? 'Reply draft' : 'Email draft'}
      badge={open ? { text: item.state === 'failed' ? "Didn't send" : NEEDS_OK, tone: item.state === 'failed' ? 'danger' : 'warning' } : false}
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="text-sm" style={{ color: 'var(--muted)' }}>
            To
            <input data-testid="draft-to" className={field} style={fieldStyle} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="text-sm" style={{ color: 'var(--muted)' }}>
            Subject
            <input data-testid="draft-subject" className={field} style={fieldStyle} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <textarea data-testid="draft-body" className={`${field} min-h-40 font-[inherit]`} style={fieldStyle} value={body} onChange={(e) => setBody(e.target.value)} />
          {files.length > 0 && <DraftFiles files={files} removed={removed} onToggle={toggleFile} />}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="draft-save"
              disabled={!validTo}
              className="btn btn-primary"
              onClick={() => {
                actions.onDraftEdit(item.id, { to: recipients, subject, body, ...(removed.size ? { keep: files.flatMap((_, i) => (removed.has(i) ? [] : [i])) } : {}) });
                setEditing(false);
              }}
            >
              Save changes
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
            <dt style={{ color: 'var(--muted)' }}>To</dt>
            <dd data-testid="draft-to-text">{item.to.join(', ')}</dd>
            <dt style={{ color: 'var(--muted)' }}>Subject</dt>
            <dd>{item.subject}</dd>
          </dl>
          <div data-testid="draft-body-text" className="inset mt-3 whitespace-pre-wrap px-3.5 py-3 text-[15px]">
            {item.body}
          </div>
          {files.length > 0 && <DraftFiles files={files} />}
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
        <CardActions>
          <button type="button" data-testid="draft-send" className="btn btn-primary" onClick={() => actions.onDraftSend(item.id, item.hash)}>
            {item.state === 'failed' ? 'Try again' : 'Send'}
          </button>
          <button type="button" data-testid="draft-edit" className="btn btn-secondary" onClick={startEdit}>
            Edit
          </button>
          <button type="button" data-testid="draft-discard" className="btn btn-quiet" onClick={() => actions.onDraftDiscard(item.id)}>
            Discard
          </button>
        </CardActions>
      ) : (
        !open && (
          <div data-testid="draft-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {DRAFT_STATE_TEXT[item.state]}
          </div>
        )
      )}
    </Card>
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
    <div data-testid={testid} className="inset mt-1 whitespace-pre-wrap break-words px-2.5 py-1.5 text-[14px]" style={{ textDecoration: strike ? 'line-through' : undefined, opacity: strike ? 0.75 : 1 }}>
      {text}
    </div>
  );
  return (
    <Card
      data-kind="doc_change"
      data-change={item.change}
      data-state={item.state}
      data-overwrite={item.overwrite}
      icon="file"
      tone={item.overwrite ? 'danger' : 'accent'}
      title={heading}
      badge={open ? { text: NEEDS_OK, tone: item.overwrite ? 'danger' : 'warning' } : false}
    >
      {item.file && (
        <div data-testid="doc-change-file" className="break-all font-medium">
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
        <CardActions>
          <button
            type="button"
            data-testid="doc-change-confirm"
            className={item.overwrite ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => actions.onDocChangeConfirm(item.id, item.hash)}
          >
            {item.state === 'failed' ? `Try again: ${confirm}` : confirm}
          </button>
          <button type="button" data-testid="doc-change-discard" className="btn btn-quiet" onClick={() => actions.onDocChangeDiscard(item.id)}>
            Discard
          </button>
        </CardActions>
      ) : (
        <div data-testid="doc-change-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.result ?? DOC_CHANGE_STATE_TEXT[item.state]}
        </div>
      )}
    </Card>
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
    <Card
      data-kind="event"
      data-change={item.change}
      data-state={item.state}
      icon="calendar"
      tone={item.change === 'cancel' ? 'danger' : 'accent'}
      title={t.heading}
      badge={open ? { text: NEEDS_OK, tone: item.change === 'cancel' ? 'danger' : 'warning' } : false}
    >
      <div data-testid="event-title" className="font-medium">
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
        <CardActions>
          <button
            type="button"
            data-testid="event-confirm"
            className={item.change === 'cancel' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => actions.onEventConfirm(item.id, item.hash)}
          >
            {item.state === 'failed' ? `Try again: ${t.confirm}` : t.confirm}
          </button>
          <button type="button" data-testid="event-discard" className="btn btn-quiet" onClick={() => actions.onEventDiscard(item.id)}>
            Discard
          </button>
        </CardActions>
      ) : (
        <div data-testid="event-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.result ?? EVENT_STATE_TEXT[item.state]}
        </div>
      )}
    </Card>
  );
}

type DocumentItem = Extract<ChatItem, { kind: 'document' }>;

/** A Word or Excel file the user can open (D1) or edit in its app (D3). File names can come from anyone: plain text only. */
function DocumentCard({ item, actions }: { item: DocumentItem; actions: MessageActions }) {
  const [open, setOpen] = useState(false);
  const app = item.fileKind === 'word' ? 'WordCraft' : 'GridCraft';
  const edit = () => {
    setOpen(false);
    actions.onDocumentEdit(item.id);
  };
  return (
    <div data-kind="document" className="card flex items-center gap-3 px-4 py-3">
      <span className="tile">
        <Icon name="file" />
      </span>
      <div className="min-w-0 flex-1">
        <div data-testid="document-name" className="break-all">
          {item.name}
        </div>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {item.fileKind === 'word' ? 'Word document' : 'Excel spreadsheet'}
        </div>
      </div>
      <button type="button" data-testid="document-open" className="btn btn-primary" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" data-testid="document-edit" className="btn btn-secondary" title={`Edit in ${app}`} onClick={edit}>
        Edit
      </button>
      {open && <DocumentViewer item={item} onClose={() => setOpen(false)} onEdit={edit} />}
    </div>
  );
}

type AttachmentItem = Extract<ChatItem, { kind: 'attachment' }>;

const FILE_KIND_TEXT: Record<AttachmentItem['fileKind'], string> = { pdf: 'PDF', text: 'Text file', image: 'Picture', other: 'File' };

/** An email attachment (S2) or a file from disk (F1) the user can open, and save (F1). Names can come from anyone: plain text only. */
function AttachmentCard({ item, actions }: { item: AttachmentItem; actions: MessageActions }) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState(0);
  const [saving, setSaving] = useState(false);
  const fromMail = item.mailId !== undefined;
  const canSave = fromMail && !!item.folders?.length && !item.saved;
  return (
    <div data-kind="attachment" data-file-kind={item.fileKind} className="card px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="tile">
          <Icon name="clip" />
        </span>
        <div className="min-w-0 flex-1">
          <div data-testid="attachment-name" className="break-all">
            {item.name}
          </div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {FILE_KIND_TEXT[item.fileKind]}
            {fromMail ? ' from an email' : ' in your folders'}
            {item.fileKind === 'other' ? " (can't be opened here)" : ''}
          </div>
        </div>
        {item.fileKind !== 'other' && (
          <button type="button" data-testid="attachment-open" className="btn btn-primary" onClick={() => setOpen(true)}>
            Open
          </button>
        )}
      </div>
      {canSave && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-10 text-sm">
          <span style={{ color: 'var(--muted)' }}>Save to</span>
          <select data-testid="attachment-folder" className="h-8 rounded-lg border px-2" style={{ background: 'var(--surface)', borderColor: 'var(--line-strong)' }} value={folder} onChange={(e) => setFolder(Number(e.target.value))}>
            {item.folders!.map((f, i) => (
              <option key={f} value={i}>
                {f}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="attachment-save"
            disabled={saving}
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setSaving(true);
              actions.onAttachmentSave(item.id, folder);
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {item.saved && (
        <div data-testid="attachment-saved" className="mt-2 pl-10 text-sm" style={{ color: item.saved.startsWith("Didn't") ? 'var(--danger)' : 'var(--muted)' }}>
          {item.saved.startsWith("Didn't") ? item.saved : `✓ Saved as ${item.saved}`}
        </div>
      )}
      {open && <AttachmentViewer item={item} onClose={() => setOpen(false)} />}
    </div>
  );
}

type FileChangeItem = Extract<ChatItem, { kind: 'file_change' }>;

const FILE_CHANGE_TEXT: Record<FileChangeItem['change'], { heading: string; confirm: string }> = {
  rename: { heading: 'Rename this file?', confirm: 'Rename' },
  copy: { heading: 'Copy this file?', confirm: 'Copy' },
  folder: { heading: 'Create this folder?', confirm: 'Create' },
  note: { heading: 'Create this file?', confirm: 'Create' },
  tag: { heading: 'Change the tags of this file?', confirm: 'Save tags' },
};

const FILE_CHANGE_STATE_TEXT: Record<FileChangeItem['state'], string> = { pending: '', running: 'Working…', done: '✓ Done', discarded: 'Discarded. Nothing changed.', failed: '' };

/** A file change waiting for a click (F1). Names and note text can come from files or the model: plain text only. */
function FileChangeCard({ item, actions }: { item: FileChangeItem; actions: MessageActions }) {
  const t = FILE_CHANGE_TEXT[item.change];
  const open = item.state === 'pending' || item.state === 'failed';
  const row = (label: string, value: string, testid: string) => (
    <div className="flex gap-2 text-[15px]">
      <span className="w-12 shrink-0" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span data-testid={testid} className="min-w-0 break-all">
        {value}
      </span>
    </div>
  );
  return (
    <Card data-kind="file_change" data-change={item.change} data-state={item.state} icon="folder" title={t.heading} badge={open ? { text: NEEDS_OK, tone: 'warning' } : false}>
      <div className="space-y-0.5">
        {item.from !== undefined && row('From', item.from, 'file-change-from')}
        {row(item.change === 'tag' ? 'File' : item.from !== undefined ? 'To' : 'New', item.to, 'file-change-to')}
        {item.tags !== undefined && row('Tags', item.tags.length ? item.tags.join(', ') : '(none)', 'file-change-tags')}
      </div>
      {item.preview !== undefined && (
        <div data-testid="file-change-preview" className="inset mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 text-[14px]">
          {item.preview || '(empty)'}
        </div>
      )}
      {item.warnings.map((w) => (
        <div key={w} data-testid="file-change-warning" className="mt-2 text-sm" style={{ color: 'var(--warning)' }}>
          {w}
        </div>
      ))}
      {item.state === 'failed' && item.result && (
        <div data-testid="file-change-state" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {item.result}
        </div>
      )}
      {open ? (
        <CardActions>
          <button type="button" data-testid="file-change-confirm" className="btn btn-primary" onClick={() => actions.onFileChangeConfirm(item.id, item.hash)}>
            {item.state === 'failed' ? `Try again: ${t.confirm}` : t.confirm}
          </button>
          <button type="button" data-testid="file-change-discard" className="btn btn-quiet" onClick={() => actions.onFileChangeDiscard(item.id)}>
            Discard
          </button>
        </CardActions>
      ) : (
        <div data-testid="file-change-state" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {item.result ?? FILE_CHANGE_STATE_TEXT[item.state]}
        </div>
      )}
    </Card>
  );
}

const RESOURCE_TITLE = { disk: 'Drive space', memory: 'Memory', cpu: 'Processor' } as const;

/** L1: a resource alert. Headline and details are written by code; advice by the local model. Plain text only. */
function ResourceAlert({ item }: { item: Extract<ChatItem, { kind: 'resource_alert' }> }) {
  return (
    <Card
      data-kind="resource_alert"
      data-resource={item.resource}
      data-resolved={item.resolved ? true : undefined}
      icon="gauge"
      tone={item.resolved ? 'muted' : 'warning'}
      title={RESOURCE_TITLE[item.resource]}
    >
      <div data-testid="alert-headline" className="font-medium">
        {item.headline}
      </div>
      {item.details.map((d) => (
        <div key={d} className="mt-1 break-words text-[15px]">
          {d}
        </div>
      ))}
      {item.advice && (
        <div data-testid="alert-advice" className="mt-2 text-[15px]">
          {item.advice}
          <span className="ml-1 text-sm" style={{ color: 'var(--muted)' }}>
            (local model)
          </span>
        </div>
      )}
      {item.resolved && (
        <div data-testid="alert-resolved" className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          ✓ {item.resolved}
        </div>
      )}
    </Card>
  );
}

type CleanupItem = Extract<ChatItem, { kind: 'cleanup' }>;

/** L1: the morning review. Names, titles and reasons come from files, web pages and the local model: plain text only. */
function CleanupCard({ item, actions }: { item: CleanupItem; actions: MessageActions }) {
  const btn = (testid: string, label: string, onClick: () => void, primary = false) => (
    <button type="button" data-testid={testid} className={primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={onClick}>
      {label}
    </button>
  );
  const open = (s: string) => s === 'pending' || s === 'failed';
  const result = (state: string, text: string | undefined) =>
    text || state === 'running' ? (
      <div data-testid="cleanup-result" className="mt-1 text-sm" style={{ color: state === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
        {state === 'running' ? 'Working…' : text}
      </div>
    ) : null;
  return (
    <Card data-kind="cleanup" icon="sweep" title="Morning tidy-up" aside={item.by === 'local' ? <span className="text-[13px]" style={{ color: 'var(--muted)' }}>picked by the local model</span> : undefined}>
      <div data-testid="cleanup-intro">
        {item.intro}
      </div>
      {item.files.length > 0 && (
        <ul className="mt-2 divide-y" style={{ borderColor: 'var(--line)' }}>
          {item.files.map((f) => (
            <li key={f.n} data-testid="cleanup-file" data-state={f.state} className={`py-2 ${f.state === 'trashed' || f.state === 'kept' ? 'opacity-50' : ''}`}>
              <div className="break-all font-medium">{f.name}</div>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                {f.size} · {f.folder} · {f.lastUsed}
              </div>
              <div className="text-[15px]">{f.reason}</div>
              {open(f.state) && (
                <div className="mt-2 flex gap-2">
                  {item.trash && btn('cleanup-trash', f.state === 'failed' ? 'Try again: Move to Trash' : 'Move to Trash', () => actions.onCleanup(item.id, 'file', f.n, 'trash', f.hash), true)}
                  {btn('cleanup-keep', 'Keep', () => actions.onCleanup(item.id, 'file', f.n, 'keep', f.hash))}
                </div>
              )}
              {result(f.state, f.result)}
            </li>
          ))}
        </ul>
      )}
      {item.apps.length > 0 && (
        <ul className="mt-2 divide-y" style={{ borderColor: 'var(--line)' }}>
          {item.apps.map((a) => (
            <li key={a.n} data-testid="cleanup-app" data-state={a.state} className={`py-2 ${a.state === 'closed' || a.state === 'kept' ? 'opacity-50' : ''}`}>
              <div className="font-medium">
                {a.name}
                {a.title && <span style={{ color: 'var(--muted)' }}> · {a.title}</span>}
              </div>
              <div className="text-sm" style={{ color: 'var(--muted)' }}>
                {[a.memory, a.idle].filter(Boolean).join(' · ')}
              </div>
              <div className="text-[15px]">{a.reason}</div>
              {open(a.state) && (
                <div className="mt-2 flex gap-2">
                  {btn('cleanup-close', a.state === 'failed' ? 'Try again: Close' : 'Close', () => actions.onCleanup(item.id, 'app', a.n, 'close', a.hash), true)}
                  {btn('cleanup-keep', 'Keep open', () => actions.onCleanup(item.id, 'app', a.n, 'keep', a.hash))}
                </div>
              )}
              {result(a.state, a.result)}
            </li>
          ))}
        </ul>
      )}
    </Card>
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
        <div className="ml-5 mt-2 flex flex-wrap gap-2">
          <button type="button" data-testid="mail-read" className="btn btn-secondary btn-sm" onClick={() => actions.onSend(`Read email ${r.id}`)}>
            Read
          </button>
          <button type="button" data-testid="mail-draft-reply" className="btn btn-secondary btn-sm" onClick={() => actions.onSend(`Draft a reply to email ${r.id}`)}>
            Draft reply
          </button>
          <button type="button" data-testid="mail-ignore" className="btn btn-secondary btn-sm" onClick={() => actions.onIgnoreMail(item.id, r.id)}>
            Ignore
          </button>
        </div>
      )}
    </li>
  );
  return (
    <Card data-kind="notification" icon="mail" title={item.text}>
      {main.length > 0 && <ul className="-my-2">{main.map(row)}</ul>}
      {low.length > 0 && (
        // Low priority mail keeps its buttons, so each one can still be read, answered or opened.
        <div data-testid="mail-digest" className="mt-2 text-sm">
          <div style={{ color: 'var(--muted)' }}>Low priority</div>
          <ul>{low.map(row)}</ul>
        </div>
      )}
    </Card>
  );
}

type TodoItem = Extract<ChatItem, { kind: 'todo' }>;

/** A drawn check box (display only: the buttons beside it do the work). */
function Box({ done = false }: { done?: boolean }) {
  return (
    <span
      aria-hidden
      className="mr-2.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] align-[-3px]"
      style={done ? { background: 'var(--accent)', color: 'var(--bg)' } : { border: '1.5px solid var(--line-strong)' }}
    >
      {done && <Icon name="check" size={12} strokeWidth={3} />}
    </span>
  );
}

/** T1: what was just saved, in code's words, with click-only buttons. Item text is shown as plain text. */
function TodoCard({ item, actions }: { item: TodoItem; actions: MessageActions }) {
  const btn = (testid: string, label: string, onClick: () => void, primary = false) => (
    <button type="button" data-testid={testid} className={primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <Card data-kind="todo" data-event={item.event} icon="todo" tone={item.event === 'reminder' ? 'warning' : 'accent'} title={item.title} badge={item.event === 'reminder' ? { text: 'Reminder', tone: 'warning' } : false}>
      <ul className="-my-1.5">
        {item.rows.map((r) => (
          <li key={r.todoId} data-testid="todo-row" data-state={r.state} className={`py-1.5 ${r.state === 'removed' ? 'opacity-50' : ''}`}>
            <div className={r.state === 'done' ? 'line-through opacity-60' : ''}>
              <Box done={r.state === 'done'} />
              {r.text}
            </div>
            {(r.when || r.due) && (
              <div data-testid="todo-when" className="ml-6 text-sm" style={{ color: 'var(--muted)' }}>
                {r.when ? `Reminder: ${r.when}` : `Due: ${r.due}`}
              </div>
            )}
            {r.state !== 'removed' && (
              <div className="ml-6 mt-1.5 flex flex-wrap gap-2">
                {r.state === 'open' && btn('todo-done', 'Done', () => actions.onTodo(item.id, r.todoId, 'done', r.hash), item.event === 'reminder')}
                {r.state === 'open' && item.event === 'reminder' && btn('todo-snooze', 'Later', () => actions.onTodo(item.id, r.todoId, 'snooze', r.hash))}
                {r.state === 'done' && btn('todo-reopen', 'Not done', () => actions.onTodo(item.id, r.todoId, 'reopen', r.hash))}
                {(item.event === 'added' || item.event === 'updated') && btn('todo-remove', 'Remove', () => actions.onTodo(item.id, r.todoId, 'remove', r.hash))}
              </div>
            )}
            {r.result && (
              <div data-testid="todo-result" className="ml-6 mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                {r.result}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

type BriefItem = Extract<ChatItem, { kind: 'brief' }>;

/** T2: the morning brief. Read only; mail and event text is shown as plain text. */
function BriefCard({ item, actions }: { item: BriefItem; actions: MessageActions }) {
  const head = (t: string) => (
    <div className="mb-1 mt-4 text-[13px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
      {t}
    </div>
  );
  return (
    <Card data-kind="brief" icon="sun" title={item.title} aside={item.by === 'local' ? <span className="text-[13px]" style={{ color: 'var(--muted)' }}>written by the local model</span> : undefined}>
      <div data-testid="brief-intro">
        {item.intro}
      </div>
      {head(item.mails.length ? 'Urgent mail' : 'Mail')}
      {item.mails.length > 0 ? (
        <ul data-testid="brief-mails">
          {item.mails.map((m) => (
            <li key={m.id} className="py-1">
              <div className="flex items-baseline gap-2">
                <span style={{ color: URGENCY_COLOR[m.urgency] }}>●</span>
                <span className="font-medium">{m.from.replace(/\s*<[^>]*>$/, '')}</span>
                <span style={{ color: 'var(--muted)' }}>· {m.subject}</span>
                <button type="button" data-testid="brief-mail-read" className="btn btn-secondary btn-sm ml-auto" onClick={() => actions.onSend(`Read email ${m.id}`)}>
                  Read
                </button>
              </div>
              <div className="ml-5 text-[15px]">{m.summary}</div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="text-[15px]" style={{ color: 'var(--muted)' }}>
        {item.mails.length ? (item.moreMail ? `And ${item.moreMail} other new email${item.moreMail === 1 ? '' : 's'}.` : '') : item.moreMail ? `Nothing urgent among ${item.moreMail} new email${item.moreMail === 1 ? '' : 's'}.` : 'No new mail.'}
      </div>
      {item.calendar !== 'off' && (
        <>
          {head('Today')}
          {item.calendar === 'error' ? (
            <div className="text-[15px]" style={{ color: 'var(--warning)' }}>
              I couldn't read your calendar just now.
            </div>
          ) : item.events.length ? (
            <ul data-testid="brief-events">
              {item.events.map((e, i) => (
                <li key={i} className="py-0.5 text-[15px]">
                  <span className="mr-2 tabular-nums" style={{ color: 'var(--muted)' }}>
                    {e.when}
                  </span>
                  {e.title}
                  {e.location && <span style={{ color: 'var(--muted)' }}> · {e.location}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[15px]">No events.</div>
          )}
          {item.free.length > 0 && (
            <div data-testid="brief-free" className="text-sm" style={{ color: 'var(--muted)' }}>
              Free: {item.free.join(', ')}
            </div>
          )}
        </>
      )}
      {(item.todos.length > 0 || item.moreTodos > 0) && head('Due')}
      {item.todos.length > 0 && (
        <ul data-testid="brief-todos">
          {item.todos.map((t, i) => (
            <li key={i} className="py-0.5 text-[15px]">
              <Box />
              {t.text}
              {t.when && <span style={{ color: t.overdue ? 'var(--warning)' : 'var(--muted)' }}> · {t.when}</span>}
              {t.overdue && !t.when && <span style={{ color: 'var(--warning)' }}> · overdue</span>}
            </li>
          ))}
        </ul>
      )}
      {item.moreTodos > 0 && (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {item.moreTodos} more on your list without a date.
        </div>
      )}
    </Card>
  );
}

export function Message({ item, actions }: { item: ChatItem; actions: MessageActions }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end" data-kind="user">
          <div
            className="max-w-[80%] whitespace-pre-wrap rounded-[20px] rounded-br-md px-4 py-3"
            style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 26%, transparent)' }}
          >
            {item.text}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div data-kind="assistant" data-streaming={item.streaming || undefined} className="flex items-start gap-3.5">
          <span className="mt-0.5 shrink-0">
            <Mark />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`md ${item.streaming ? 'caret' : ''}`}>
              <Markdown>{item.text}</Markdown>
            </div>
            {item.stopped && <div className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>Stopped</div>}
          </div>
        </div>
      );
    case 'tool':
      return (
        <div data-kind="tool" className="flex items-center gap-2 text-[15px]" style={{ color: 'var(--muted)' }}>
          {item.state === 'running' ? (
            <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <span style={{ color: item.state === 'failed' ? 'var(--danger)' : 'var(--accent)' }}>
              <Icon name={item.state === 'failed' ? 'cross' : 'check'} strokeWidth={2.2} />
            </span>
          )}
          <span>{item.state === 'running' ? item.label : item.label.replace(/…$/, '')}</span>
        </div>
      );
    case 'notice': {
      const tone = item.level === 'error' ? 'danger' : item.level === 'warning' ? 'warning' : 'accent';
      return (
        <div data-kind="notice" data-tone={tone === 'danger' ? 'danger' : undefined} className="card flex items-start gap-3 px-4 py-3 text-[15px]">
          <span className="tile" data-tone={tone}>
            <Icon name={tone === 'accent' ? 'info' : 'alert'} />
          </span>
          <div className="min-w-0 flex-1 whitespace-pre-wrap pt-0.5">{item.text}</div>
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
    case 'file_change':
      return <FileChangeCard item={item} actions={actions} />;
    case 'resource_alert':
      return <ResourceAlert item={item} />;
    case 'cleanup':
      return <CleanupCard item={item} actions={actions} />;
    case 'todo':
      return <TodoCard item={item} actions={actions} />;
    case 'brief':
      return <BriefCard item={item} actions={actions} />;
    case 'attachment':
      return <AttachmentCard item={item} actions={actions} />;
    case 'document':
      return <DocumentCard item={item} actions={actions} />;
    case 'build_result':
      return (
        <div data-kind="build_result" data-ok={item.ok} data-tone={item.ok ? undefined : 'danger'} className="card flex items-center gap-3 px-4 py-3">
          <span className="tile" data-tone={item.ok ? 'accent' : 'danger'}>
            <Icon name={item.ok ? 'box' : 'alert'} />
          </span>
          <div data-testid="build-result-text" className="min-w-0 flex-1">
            {item.text}
          </div>
          {item.ok && (
            <button type="button" data-testid="build-open" className="btn btn-primary" onClick={() => actions.onAppOpen(item.actionId)}>
              Open
            </button>
          )}
        </div>
      );
  }
}
