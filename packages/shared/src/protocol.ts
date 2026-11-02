/**
 * WebSocket protocol between aios-core and the chat UI. Both sides validate with
 * these schemas; the reducer at the bottom is the UI's single source of chat state.
 */
import { z } from 'zod';
import { WindowMode } from './window.js';

// ── Chat items (what the UI renders) ─────────────────────────────────────────

/** One triaged email in a new-mail notification. from/subject/summary come from email: show as plain text only. */
export const MailRow = z.strictObject({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  summary: z.string(),
  urgency: z.enum(['low', 'normal', 'high']),
  needsReply: z.boolean(),
  ignored: z.boolean().optional(),
});
export type MailRow = z.infer<typeof MailRow>;

/** L1: one file the morning review suggests removing. Names come from anywhere: plain text only. */
export const CleanupFile = z.strictObject({
  n: z.int().min(1),
  name: z.string(),
  folder: z.string(),
  /** Written by code, e.g. "2.4 GB" and "last used 14 Mar". */
  size: z.string(),
  lastUsed: z.string(),
  /** Why, from the local model (or code): plain text only. */
  reason: z.string(),
  /** sha256 of the file's path, size and modification time; the click echoes it back. */
  hash: z.string(),
  state: z.enum(['pending', 'running', 'trashed', 'kept', 'failed']),
  result: z.string().optional(),
});
export type CleanupFile = z.infer<typeof CleanupFile>;

/** L1: one open window the morning review suggests closing. Titles come from web pages and apps: plain text only. */
export const CleanupApp = z.strictObject({
  n: z.int().min(1),
  name: z.string(),
  title: z.string(),
  /** Written by code, e.g. "1.2 GB" and "not used for 3 days". */
  memory: z.string().optional(),
  idle: z.string(),
  reason: z.string(),
  /** sha256 of the window's address, class and process; the click echoes it back. */
  hash: z.string(),
  state: z.enum(['pending', 'running', 'closed', 'kept', 'failed']),
  result: z.string().optional(),
});
export type CleanupApp = z.infer<typeof CleanupApp>;

export const ChatItem = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), id: z.string(), text: z.string(), at: z.number() }),
  z.strictObject({
    kind: z.literal('assistant'),
    id: z.string(),
    text: z.string(),
    at: z.number(),
    /** True while tokens are still streaming in. */
    streaming: z.boolean(),
    /** Set when generation was stopped by the user. */
    stopped: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('tool'),
    id: z.string(),
    /** Short human label, e.g. "Checking the time…". */
    label: z.string(),
    state: z.enum(['running', 'done', 'failed']),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('notice'),
    id: z.string(),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('memory'),
    id: z.string(),
    /** The fact or profile line the assistant suggests remembering. */
    text: z.string(),
    target: z.enum(['facts', 'profile']),
    /** 'email' when untrusted email content was in the model's context at the time. */
    source: z.enum(['chat', 'email']),
    /** Only a Save click from the user turns 'pending' into 'saved'. */
    state: z.enum(['pending', 'saved', 'skipped']),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('notification'),
    id: z.string(),
    /** Written by code, never by a model; mail-derived text only appears in `mails`. */
    text: z.string(),
    at: z.number(),
    mails: z.array(MailRow).optional(),
  }),
  z.strictObject({
    kind: z.literal('draft'),
    /** Also the draft id the model sees. */
    id: z.string(),
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    /** Mail id (e.g. INBOX:37) this replies to. */
    inReplyTo: z.string().optional(),
    /** sha256 of exactly what is shown; Send echoes it back and only that text is sent. */
    hash: z.string(),
    /** Only a Send click moves 'pending' to 'sending'; editing gives a new hash. */
    state: z.enum(['pending', 'sending', 'sent', 'discarded', 'failed']),
    /** Written by code, e.g. a recipient that came from neither the user nor the original email. */
    warnings: z.array(z.string()),
    error: z.string().optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('action'),
    /** A change to this computer that waits for a click (S1): Wi-Fi off, switching networks, pairing, forgetting. */
    id: z.string(),
    /** Written by code. Network and device names in it came over the air: show as plain text only. */
    title: z.string(),
    /** Label of the confirm button, e.g. "Turn off". */
    confirm: z.string(),
    /** sha256 of the action and its arguments; the click echoes it back. */
    hash: z.string(),
    /** Only a confirm click moves 'pending' to 'running'. */
    state: z.enum(['pending', 'running', 'done', 'cancelled', 'failed']),
    /** Outcome written by code after it ran. */
    result: z.string().optional(),
    /** S4: a line under the title written by code, e.g. what similar builds cost. */
    note: z.string().optional(),
    /** S4: confirm buttons that each pick an option (a build's spending cap); shown instead of `confirm`. */
    choices: z.array(z.strictObject({ label: z.string(), value: z.string().max(20) })).max(4).optional(),
    /** S4: while running, what it is doing now; the card can be stopped while this is set. */
    progress: z.strictObject({ step: z.string(), startedAt: z.number(), capUsd: z.number().optional() }).optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('event'),
    /** C1: a calendar change that waits for a click: create, change or cancel one event. */
    id: z.string(),
    change: z.enum(['create', 'update', 'cancel']),
    /** The event's title. May come from someone else's invite: show as plain text only. */
    title: z.string(),
    /** When, written by code in the user's timezone, e.g. "Mon 2 Nov, 15:00–15:30". */
    when: z.string(),
    /** update: when it was before the change, if the time changes. */
    before: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    /** Everyone who gets an invite, update or cancellation email from this click. */
    attendees: z.array(z.string()),
    /** Written by code: an attendee who came from neither the user nor the event, an email in view... */
    warnings: z.array(z.string()),
    /** sha256 of exactly what the card shows; the click echoes it back. */
    hash: z.string(),
    /** Only a confirm click moves 'pending' (or 'failed', to retry) to 'running'. */
    state: z.enum(['pending', 'running', 'done', 'discarded', 'failed']),
    /** Outcome written by code after it ran. */
    result: z.string().optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('build_result'),
    /** S4: posted when an app build finishes or fails. */
    id: z.string(),
    /** The Build card it came from; Open sends this back. */
    actionId: z.string(),
    /** Written by code. */
    text: z.string(),
    ok: z.boolean(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('attachment'),
    /** Random; the only way to fetch the file (GET /attachments/<id>). */
    id: z.string(),
    /** The file name from the email: show as plain text only. */
    name: z.string(),
    /** What the sender says it is; the server checks the bytes again before serving it. 'other' (F1) can be saved but not opened. */
    fileKind: z.enum(['pdf', 'text', 'image', 'other']),
    /** Which attachment of which message, for the server. */
    mailId: z.string().optional(),
    n: z.int().min(1).optional(),
    /** F1: a file on disk instead (file_show), resolved inside an allowed folder; checked again on every open. */
    path: z.string().optional(),
    /** F1: the folders the Save button offers, as the user would write them; the click names one by its index. */
    folders: z.array(z.string()).optional(),
    /** F1: where the Save click saved it. */
    saved: z.string().optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('document'),
    /** D1: a Word or Excel file the user can open. Random; the only way to fetch it (GET /documents/<id>). */
    id: z.string(),
    /** The file's name. Files can come from anywhere: show as plain text only. */
    name: z.string(),
    fileKind: z.enum(['word', 'sheet']),
    /** The file, as the server resolved it inside an allowed folder; checked again on every open. */
    path: z.string(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('file_change'),
    /** F1: renaming or copying a file, a new folder or a new note, waiting for a click. F2: tags for a file. */
    id: z.string(),
    change: z.enum(['rename', 'copy', 'folder', 'note', 'tag']),
    /** The file it starts from (rename, copy), as the user would write it. Names can come from anyone: plain text only. */
    from: z.string().optional(),
    /** What the click creates or renames to. */
    to: z.string(),
    /** The start of a new note's text, as written by the model: plain text only. */
    preview: z.string().optional(),
    /** F2: the file's tags after the click (tag). */
    tags: z.array(z.string()).optional(),
    warnings: z.array(z.string()),
    hash: z.string(),
    state: z.enum(['pending', 'running', 'done', 'discarded', 'failed']),
    result: z.string().optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('resource_alert'),
    /** L1: the system assistant saw a drive fill up, memory run low or the CPU stay busy. */
    id: z.string(),
    resource: z.enum(['disk', 'memory', 'cpu']),
    /** Written by code, e.g. "Your home drive is almost full: 4.1 GB of 512 GB free." */
    headline: z.string(),
    /** Written by code: the biggest users. Process names are chosen by programs: plain text only. */
    details: z.array(z.string()),
    /** Advice from the local model, added when it answers: plain text only. */
    advice: z.string().optional(),
    /** Set by code when the resource is back to normal. */
    resolved: z.string().optional(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('cleanup'),
    /** L1: the morning review: big unused files and idle windows, each with click-only buttons. */
    id: z.string(),
    /** A line above the lists, from the local model or code: plain text only. */
    intro: z.string(),
    /** 'code' when the local model wasn't available and code picked the suggestions. */
    by: z.enum(['local', 'code']),
    files: z.array(CleanupFile),
    apps: z.array(CleanupApp),
    /** Whether files get a Move to Trash button. */
    trash: z.boolean(),
    at: z.number(),
  }),
  z.strictObject({
    kind: z.literal('doc_change'),
    /** D2: a change to a Word or Excel file, or a new one, that waits for a click. */
    id: z.string(),
    change: z.enum(['edit', 'create']),
    fileKind: z.enum(['word', 'sheet']),
    /** The file it changes (edit), as the user would write it. File names can come from anyone: plain text only. */
    file: z.string().optional(),
    /** The file the click writes, e.g. "~/Documents/report-edited.docx". */
    output: z.string(),
    /** True when the click replaces the original (a backup is kept). */
    overwrite: z.boolean(),
    /** Written by code from the changes; text in them may come from a document: plain text only. */
    lines: z.array(z.strictObject({ what: z.string(), before: z.string().optional(), after: z.string().optional() })),
    /** Written by code: suggested while a document was open, may not save cleanly, … */
    warnings: z.array(z.string()),
    /** sha256 of exactly what the card shows; the click echoes it back. */
    hash: z.string(),
    /** Only a confirm click moves 'pending' (or 'failed', to retry) to 'running'. */
    state: z.enum(['pending', 'running', 'done', 'discarded', 'failed']),
    /** Outcome written by code after it ran. */
    result: z.string().optional(),
    at: z.number(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

// ── Status strip ─────────────────────────────────────────────────────────────

export const Status = z.strictObject({
  battery: z.strictObject({ percent: z.number(), charging: z.boolean() }).nullable(),
  wifi: z.strictObject({ connected: z.boolean(), ssid: z.string().nullable() }).nullable(),
  mail: z.enum(['not_configured', 'connecting', 'connected', 'error']),
  agent: z.enum(['idle', 'working', 'paused']),
  costTodayUsd: z.number(),
  costCapUsd: z.number(),
  model: z.string(),
});
export type Status = z.infer<typeof Status>;

export const Theme = z.record(z.string(), z.string());
export type Theme = z.infer<typeof Theme>;

// ── Messages ─────────────────────────────────────────────────────────────────

export const ClientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('send'), text: z.string().min(1).max(20_000) }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('memory'), id: z.string().max(100), decision: z.enum(['save', 'skip']) }),
  z.strictObject({ type: z.literal('mail_ignore'), itemId: z.string().max(100), mailId: z.string().max(100) }),
  z.strictObject({ type: z.literal('draft_send'), id: z.string().max(100), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('draft_discard'), id: z.string().max(100) }),
  z.strictObject({ type: z.literal('action_confirm'), id: z.string().max(100), hash: z.string().regex(/^[0-9a-f]{64}$/), choice: z.string().max(20).optional() }),
  z.strictObject({ type: z.literal('action_cancel'), id: z.string().max(100) }),
  /** C1: the confirm button on a calendar card, echoing the card's hash. */
  z.strictObject({ type: z.literal('event_confirm'), id: z.string().max(100), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('event_discard'), id: z.string().max(100) }),
  /** D2: Save on a document change card, echoing the card's hash. */
  z.strictObject({ type: z.literal('doc_change_confirm'), id: z.string().max(100), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('doc_change_discard'), id: z.string().max(100) }),
  /** F1: clicks on a file change card. */
  z.strictObject({ type: z.literal('file_change_confirm'), id: z.string().max(100), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ type: z.literal('file_change_discard'), id: z.string().max(100) }),
  /** F1: Save on an attachment card, into one of the folders the card offers (by index). */
  z.strictObject({ type: z.literal('attachment_save'), id: z.string().max(100), folder: z.int().min(0).max(20) }),
  /** L1: a button on one row of the morning review, echoing that row's hash. */
  z.strictObject({
    type: z.literal('cleanup_action'),
    id: z.string().max(100),
    list: z.enum(['file', 'app']),
    n: z.int().min(1).max(100),
    action: z.enum(['trash', 'close', 'keep']),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  /** S4: Stop on a running build card. */
  z.strictObject({ type: z.literal('action_stop'), id: z.string().max(100) }),
  /** S4: Open on a finished build; names the Build card, never an app or command. */
  z.strictObject({ type: z.literal('app_open'), actionId: z.string().max(100) }),
  z.strictObject({
    type: z.literal('draft_edit'),
    id: z.string().max(100),
    to: z.array(z.email()).min(1).max(20),
    subject: z.string().max(500),
    body: z.string().max(50_000),
  }),
  /** S3: the orb was clicked (half), or a button asked for the orb or full screen. */
  z.strictObject({ type: z.literal('window'), mode: WindowMode }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), userName: z.string(), items: z.array(ChatItem), status: Status, theme: Theme, window: WindowMode.optional() }),
  z.strictObject({ type: z.literal('item'), item: ChatItem }),
  z.strictObject({ type: z.literal('delta'), id: z.string(), text: z.string() }),
  z.strictObject({ type: z.literal('patch'), id: z.string(), item: ChatItem }),
  z.strictObject({ type: z.literal('status'), status: Status }),
  z.strictObject({ type: z.literal('theme'), theme: Theme }),
  /** S3: where the chat window now is; the UI draws the orb or the chat to match. */
  z.strictObject({ type: z.literal('window'), mode: WindowMode }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// ── Reducer ──────────────────────────────────────────────────────────────────

export interface ChatState {
  userName: string;
  items: ChatItem[];
  status: Status | null;
  theme: Theme;
  window: WindowMode;
}

export const initialChatState: ChatState = { userName: '', items: [], status: null, theme: {}, window: 'full' };

export function applyEvent(state: ChatState, ev: ServerEvent): ChatState {
  switch (ev.type) {
    case 'hello':
      return { userName: ev.userName, items: ev.items, status: ev.status, theme: ev.theme, window: ev.window ?? 'full' };
    case 'item':
      return { ...state, items: [...state.items.filter((i) => i.id !== ev.item.id), ev.item] };
    case 'patch':
      return { ...state, items: state.items.map((i) => (i.id === ev.id ? ev.item : i)) };
    case 'delta':
      return {
        ...state,
        items: state.items.map((i) => (i.id === ev.id && i.kind === 'assistant' ? { ...i, text: i.text + ev.text } : i)),
      };
    case 'status':
      return { ...state, status: ev.status };
    case 'theme':
      return { ...state, theme: ev.theme };
    case 'window':
      return { ...state, window: ev.mode };
  }
}
