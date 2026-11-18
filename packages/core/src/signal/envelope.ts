/**
 * SG1: one `receive` notification from signal-cli, checked and turned into a message Astra
 * keeps. Field names from signal-cli's JSON output (signal-cli-jsonrpc(5), v0.14.9): an
 * `envelope` with source, sourceNumber, sourceUuid, sourceName and timestamp, and either a
 * `dataMessage` (someone wrote) or a `syncMessage.sentMessage` (the user wrote, on their phone).
 * Group messages carry `groupInfo.groupId`. Anything else (receipts, typing, calls) is dropped.
 *
 * Everything in a message, the sender's name included, is chosen by whoever sent it: the
 * text is only ever shown to a model sanitized inside <untrusted source="signal"> (tools.ts).
 * Chat ids are checked here, so only plain numbers, uuids and base64 group ids get through.
 */
import { SIGNAL_CHAT_ID, SIGNAL_NUMBER } from '@aios/shared';
import { z } from 'zod';

export const SIGNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_ID = /^[A-Za-z0-9+/_-]{8,120}={0,2}$/;

/** A chat: "+905551234567", "u:<uuid>" (no number shared) or "g:<group id>". */
export type ChatId = string;
export const CHAT_ID = SIGNAL_CHAT_ID;

export function personChat(number: string | null | undefined, uuid: string | null | undefined): ChatId | null {
  if (number && SIGNAL_NUMBER.test(number)) return number;
  if (uuid && SIGNAL_UUID.test(uuid)) return `u:${uuid.toLowerCase()}`;
  return null;
}

export function groupChat(groupId: string | null | undefined): ChatId | null {
  return groupId && GROUP_ID.test(groupId) ? `g:${groupId}` : null;
}

/** What signal-cli's send takes for a chat: `recipient` or `groupId` (exported for tests). */
export function sendTarget(chat: ChatId): { recipient: string[] } | { groupId: string } {
  if (!CHAT_ID.test(chat)) throw new Error('internal: bad chat id');
  if (chat.startsWith('g:')) return { groupId: chat.slice(2) };
  return { recipient: [chat.startsWith('u:') ? chat.slice(2) : chat] };
}

export interface SignalMessage {
  chat: ChatId;
  kind: 'person' | 'group';
  /** A group's name, when the message says it. Chosen by the group: plain text only. */
  groupName: string;
  /** Who wrote it: a chat id, or "me". */
  from: ChatId | 'me';
  /** The sender's Signal name. Chosen by the sender: plain text only. */
  fromName: string;
  text: string;
  /** signal-cli's timestamp (ms), which with the chat and sender names the message. */
  ts: number;
  attachments: number;
  mine: boolean;
}

const str = z.string().max(20_000).nullable().optional();
const Group = z.looseObject({ groupId: z.string().max(200), groupName: z.string().max(500).nullable().optional() });
const Data = z.looseObject({
  timestamp: z.number().optional(),
  message: str,
  groupInfo: Group.nullable().optional(),
  attachments: z.array(z.unknown()).max(100).nullable().optional(),
});
const Sent = Data.extend({ destination: str, destinationNumber: str, destinationUuid: str });
const Envelope = z.looseObject({
  source: str,
  sourceNumber: str,
  sourceUuid: str,
  sourceName: str,
  timestamp: z.number(),
  dataMessage: Data.nullable().optional(),
  syncMessage: z.looseObject({ sentMessage: Sent.nullable().optional() }).nullable().optional(),
});
const Params = z.looseObject({ envelope: Envelope });

const MAX_TEXT = 8000;
const oneLine = (s: string | null | undefined, max = 120) => (s ?? '').replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').trim().slice(0, max);

/** The message in a `receive` notification, or null for anything that isn't one. */
export function parseReceive(params: unknown): SignalMessage | null {
  const p = Params.safeParse(params);
  if (!p.success) return null;
  const e = p.data.envelope;
  const sent = e.syncMessage?.sentMessage;
  const data = sent ?? e.dataMessage;
  if (!data) return null;
  const text = (data.message ?? '').slice(0, MAX_TEXT);
  const attachments = data.attachments?.length ?? 0;
  if (!text.trim() && !attachments) return null;
  const group = groupChat(data.groupInfo?.groupId);
  const ts = data.timestamp ?? e.timestamp;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (sent) {
    const to = group ?? personChat(sent.destinationNumber ?? sent.destination, sent.destinationUuid);
    if (!to) return null;
    return { chat: to, kind: group ? 'group' : 'person', groupName: oneLine(data.groupInfo?.groupName), from: 'me', fromName: '', text, ts, attachments, mine: true };
  }
  const from = personChat(e.sourceNumber ?? e.source, e.sourceUuid);
  if (!from) return null;
  return { chat: group ?? from, kind: group ? 'group' : 'person', groupName: oneLine(data.groupInfo?.groupName), from, fromName: oneLine(e.sourceName), text, ts, attachments, mine: false };
}

/** A contact from listContacts, leniently: signal-cli's fields have changed between versions. */
const Contact = z.looseObject({
  number: str,
  uuid: str,
  name: str,
  givenName: str,
  familyName: str,
  isBlocked: z.boolean().optional(),
  profile: z.looseObject({ givenName: str, familyName: str }).nullable().optional(),
});
const GroupInfo = z.looseObject({ id: z.string().max(200), name: str, isMember: z.boolean().optional(), isBlocked: z.boolean().optional() });

export interface KnownChat {
  chat: ChatId;
  kind: 'person' | 'group';
  name: string;
}

/** listContacts' answer as chats, skipping blocked ones and ones with no usable id. */
export function parseContacts(result: unknown): KnownChat[] {
  if (!Array.isArray(result)) return [];
  const out: KnownChat[] = [];
  for (const raw of result.slice(0, 5000)) {
    const c = Contact.safeParse(raw);
    if (!c.success || c.data.isBlocked) continue;
    const chat = personChat(c.data.number, c.data.uuid);
    if (!chat) continue;
    const d = c.data;
    const name = oneLine(d.name) || oneLine([d.givenName, d.familyName].filter(Boolean).join(' ')) || oneLine([d.profile?.givenName, d.profile?.familyName].filter(Boolean).join(' '));
    out.push({ chat, kind: 'person', name });
  }
  return out;
}

/** listGroups' answer as chats: only groups the user is in and hasn't blocked. */
export function parseGroups(result: unknown): KnownChat[] {
  if (!Array.isArray(result)) return [];
  const out: KnownChat[] = [];
  for (const raw of result.slice(0, 1000)) {
    const g = GroupInfo.safeParse(raw);
    if (!g.success || g.data.isMember === false || g.data.isBlocked) continue;
    const chat = groupChat(g.data.id);
    if (chat) out.push({ chat, kind: 'group', name: oneLine(g.data.name) });
  }
  return out;
}
