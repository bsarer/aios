/**
 * Read-tier mail tools (plan §4). Every result is sanitize()d and wrapped in
 * <untrusted> tags, and the tools are registered with untrustedOutput so anything
 * the model does after reading mail is marked as possibly steered by it.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import type { Address, FullMessage, MailClient, MessageSummary } from './imap.js';

const who = (a: Address | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'unknown');
const when = (d: Date | null) => d?.toISOString().replace(/:\d\d\.\d+Z$/, 'Z') ?? 'unknown date';
const clean = (s: string, maxChars: number) => sanitize({ text: s }, { maxChars });

function summaryBlock(m: MessageSummary): string {
  return wrapUntrusted('email', m.id, clean(`From: ${who(m.from)}\nDate: ${when(m.date)}\nSubject: ${m.subject}`, 600));
}

function messageBlock(m: FullMessage, maxChars: number): string {
  const head = [
    `From: ${who(m.from)}`,
    `To: ${m.to.map(who).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(who).join(', ')}`] : []),
    `Date: ${when(m.date)}`,
    `Subject: ${m.subject}`,
    ...(m.attachments.length ? [`Attachments (names only): ${m.attachments.join(', ')}`] : []),
  ].join('\n');
  const body = sanitize({ text: m.text || undefined, html: m.html ?? undefined }, { maxChars });
  return wrapUntrusted('email', m.id, `${clean(head, 1500)}\n\n${body}`);
}

export function mailTools(mail: Pick<MailClient, 'search' | 'read' | 'thread'>): RegisteredTool[] {
  return [
    {
      def: toolByName('mail_search')!,
      label: 'Searching mail…',
      untrustedOutput: true,
      async handler(args) {
        const { query, since, limit } = args as { query: string; since?: string; limit?: number };
        const sinceDate = since ? new Date(`${since}T00:00:00Z`) : undefined;
        if (sinceDate && Number.isNaN(sinceDate.getTime())) return 'Error: since must be a date like 2026-10-19.';
        const found = await mail.search(query, { limit: limit ?? 10, ...(sinceDate ? { since: sinceDate } : {}) });
        if (!found.length) return 'No messages found.';
        return `${found.length} message(s), newest first. Use the id with mail_read or mail_thread.\n\n${found.map((m) => `id: ${m.id}\n${summaryBlock(m)}`).join('\n\n')}`;
      },
    },
    {
      def: toolByName('mail_read')!,
      label: 'Reading the email…',
      untrustedOutput: true,
      async handler(args) {
        const { id } = args as { id: string };
        const m = await mail.read(id);
        return m ? `id: ${m.id}\n${messageBlock(m, 8000)}` : `Error: no message with id ${id}.`;
      },
    },
    {
      def: toolByName('mail_thread')!,
      label: 'Reading the thread…',
      untrustedOutput: true,
      async handler(args) {
        const { id } = args as { id: string };
        const msgs = await mail.thread(id);
        if (!msgs.length) return `Error: no message with id ${id}.`;
        return `${msgs.length} message(s), oldest first.\n\n${msgs.map((m) => `id: ${m.id}\n${messageBlock(m, 1500)}`).join('\n\n')}`;
      },
    },
  ];
}
