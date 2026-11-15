/**
 * Chat tools for Signal (SG1). signal_chats and signal_read are `read` and return outside
 * text: names and messages are chosen by whoever wrote them, so they go through sanitize()
 * inside one <untrusted source="signal"> wrapper and count like email for the rest of that
 * reply. Only chat ids (checked by envelope.ts) and times written by code sit outside it.
 *
 * signal_draft is `draft` like mail_create_draft: it only shows a card (SignalActions), and
 * the message goes out only from the user's Send click. signal_send is `write`, so the
 * registry refuses every call to it.
 */
import { SIGNAL_NUMBER } from '@aios/shared';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { auditChat, chatDetail, type SignalActions } from './actions.js';
import { CHAT_ID, type ChatId } from './envelope.js';
import type { ChatRow, SignalInbox } from './inbox.js';

const NO_MESSAGES =
  'No Signal messages yet. Messages that arrive while Astra runs are kept here; older ones stay on the phone. Contacts and groups appear once signal-cli has synced them from the phone.';

/** Recipients the user's own message doesn't name: the shape of an injected "also send this to …". Written by code. */
export function signalRecipientWarnings(chat: ChatId, name: string, ctx: Pick<ToolContext, 'userText' | 'untrustedInContext'>): string[] {
  const typed = ctx.userText.toLowerCase();
  const digits = ctx.userText.replace(/[^\d]/g, '');
  const number = chat.startsWith('+') ? chat.slice(1) : '';
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const named = (number && digits.length >= 6 && number.endsWith(digits.slice(-Math.min(digits.length, 9)))) || words.some((w) => typed.includes(w));
  const out: string[] = [];
  if (!named) out.push(`${name || chatDetail(chat)} is not named in your message. Check who this goes to before sending.`);
  if (ctx.untrustedInContext) out.push('Written while a message, email or other outside text was in view. Read it before sending.');
  return out;
}

function when(ts: number, timeZone: string, now: number): string {
  if (!ts) return 'no messages yet';
  const d = new Date(ts);
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  if (sameDay.format(d) === sameDay.format(new Date(now))) return `today ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${date} ${time}`;
}

function chatLine(c: ChatRow, timeZone: string, now: number): string {
  const unread = c.unread ? `, ${c.unread} unread` : '';
  return `- chat ${c.chat} (${c.kind === 'group' ? 'group' : 'person'}), last message ${when(c.lastAt, timeZone, now)}${unread}, name: ${c.name || '(no name)'}`;
}

export function signalTools(o: { inbox: SignalInbox; actions: SignalActions; timeZone: string; userName: string; now?: () => number }): RegisteredTool[] {
  const now = o.now ?? Date.now;
  const resolve = (a: { chat?: string; number?: string }): { chat: ChatId } | { error: string } => {
    if (a.chat) {
      if (!CHAT_ID.test(a.chat) || !o.inbox.chat(a.chat)) return { error: `there is no Signal chat ${a.chat}. Look it up with signal_chats` };
      return { chat: a.chat };
    }
    const n = (a.number ?? '').replace(/[\s().-]/g, '');
    if (!SIGNAL_NUMBER.test(n)) return { error: 'give chat (from signal_chats) or number in international form, such as +905551234567' };
    return { chat: n };
  };
  return [
    {
      def: toolByName('signal_chats')!,
      label: 'Checking Signal…',
      untrustedOutput: true,
      // A name the user typed stays out of the log; only that there was one.
      auditArgs: (args) => ({ query: (args as { query?: string }).query ? 'yes' : 'no', limit: (args as { limit?: number }).limit }),
      async handler(args) {
        const a = args as { query?: string; limit?: number };
        const rows = a.query ? o.inbox.find(a.query, a.limit ?? 10) : o.inbox.chats(a.limit ?? 15);
        if (!rows.length) return { content: a.query ? `No Signal chat or contact matches "${sanitize({ text: a.query }, { maxChars: 100 })}".` : NO_MESSAGES, audit: { found: 0 } };
        const t = now();
        const list = sanitize({ text: rows.map((c) => chatLine(c, o.timeZone, t)).join('\n') }, { maxChars: 6000 });
        return {
          content: `Signal chats (names are chosen by the people and groups themselves):\n${wrapUntrusted('signal', 'chats', list)}`,
          audit: { found: rows.length },
        };
      },
    },
    {
      def: toolByName('signal_read')!,
      label: 'Reading Signal…',
      untrustedOutput: true,
      auditArgs: (args) => {
        const a = args as { chat: string; limit?: number };
        return { chat: CHAT_ID.test(a.chat) ? auditChat(a.chat) : 'invalid', limit: a.limit };
      },
      async handler(args) {
        const a = args as { chat: string; limit?: number };
        const chat = CHAT_ID.test(a.chat) ? o.inbox.chat(a.chat) : null;
        if (!chat) return `Error: there is no Signal chat ${sanitize({ text: a.chat }, { maxChars: 200 })}. Look it up with signal_chats.`;
        const msgs = o.inbox.messages(chat.chat, a.limit ?? 30);
        o.inbox.markRead(chat.chat);
        if (!msgs.length) return { content: `No messages kept from chat ${chat.chat} yet. ${NO_MESSAGES}`, audit: { chat: auditChat(chat.chat), messages: 0 } };
        const t = now();
        const lines = msgs.map((m) => {
          const who = m.mine ? o.userName : m.fromName || (m.from.startsWith('+') ? m.from : 'someone');
          const files = m.attachments ? ` [${m.attachments} attachment${m.attachments === 1 ? '' : 's'}, not shown]` : '';
          return `[${when(m.ts, o.timeZone, t)}] ${who}: ${m.text}${files}`;
        });
        const body = sanitize({ text: [`chat name: ${chat.name || '(no name)'}`, ...lines].join('\n') }, { maxChars: 10_000 });
        return {
          content: `Signal chat ${chat.chat} (${chat.kind === 'group' ? 'group' : 'person'}), ${msgs.length} message${msgs.length === 1 ? '' : 's'}:\n${wrapUntrusted('signal', chat.chat, body)}`,
          audit: { chat: auditChat(chat.chat), messages: msgs.length },
        };
      },
    },
    {
      def: toolByName('signal_draft')!,
      label: 'Writing a Signal message…',
      // The words are the user's (or the model's); the log keeps who and how long only.
      auditArgs: (args) => {
        const a = args as { chat?: string; number?: string; text: string };
        const r = resolve(a);
        return { chat: 'chat' in r ? auditChat(r.chat) : 'invalid', chars: a.text.length };
      },
      async handler(args, ctx) {
        const a = args as { chat?: string; number?: string; text: string };
        const r = resolve(a);
        if ('error' in r) return `Error: ${r.error}. No message was written.`;
        const name = o.inbox.chat(r.chat)?.name ?? '';
        const card = o.actions.propose({ chat: r.chat, text: a.text }, signalRecipientWarnings(r.chat, name, ctx));
        return `Signal message ${card.id} is shown to ${o.userName} with Send and Discard buttons. It has NOT been sent. Only ${o.userName} can send it, by clicking Send.`;
      },
    },
    {
      def: toolByName('signal_send')!,
      label: 'Sending…',
      // The registry refuses write-tier calls before a handler runs; reaching this is a bug.
      handler: async () => {
        throw new Error('signal_send cannot run from a model call');
      },
      deniedMessage: `Error: you cannot send Signal messages. ${o.userName} sends one by clicking Send on its card. Tell them it is waiting there.`,
    },
  ];
}
