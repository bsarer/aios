/**
 * WebSocket protocol between aios-core and the chat UI. Both sides validate with
 * these schemas; the reducer at the bottom is the UI's single source of chat state.
 */
import { z } from 'zod';

// ── Chat items (what the UI renders) ─────────────────────────────────────────

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
  // Reserved for A3–A5; the UI already knows how to show them.
  z.strictObject({ kind: z.literal('notification'), id: z.string(), text: z.string(), at: z.number() }),
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
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), userName: z.string(), items: z.array(ChatItem), status: Status, theme: Theme }),
  z.strictObject({ type: z.literal('item'), item: ChatItem }),
  z.strictObject({ type: z.literal('delta'), id: z.string(), text: z.string() }),
  z.strictObject({ type: z.literal('patch'), id: z.string(), item: ChatItem }),
  z.strictObject({ type: z.literal('status'), status: Status }),
  z.strictObject({ type: z.literal('theme'), theme: Theme }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// ── Reducer ──────────────────────────────────────────────────────────────────

export interface ChatState {
  userName: string;
  items: ChatItem[];
  status: Status | null;
  theme: Theme;
}

export const initialChatState: ChatState = { userName: '', items: [], status: null, theme: {} };

export function applyEvent(state: ChatState, ev: ServerEvent): ChatState {
  switch (ev.type) {
    case 'hello':
      return { userName: ev.userName, items: ev.items, status: ev.status, theme: ev.theme };
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
  }
}
