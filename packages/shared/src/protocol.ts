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
    /** What the sender says it is; the server checks the bytes again before serving it. */
    fileKind: z.enum(['pdf', 'text', 'image']),
    /** Which attachment of which message, for the server. */
    mailId: z.string(),
    n: z.int().min(1),
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
