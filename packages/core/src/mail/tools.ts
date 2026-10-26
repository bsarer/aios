/**
 * Read-tier mail tools (plan §4). Every result is sanitize()d and wrapped in
 * <untrusted> tags, and the tools are registered with untrustedOutput so anything
 * the model does after reading mail is marked as possibly steered by it.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import { type AttachmentFiles, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CHARS, declaredKind, extractPdfText, listAttachments, sizeText, sniff } from './attachments.js';
import type { Address, FullMessage, MailClient, MessageSummary } from './imap.js';
import type { MailState } from './state.js';

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
  ].join('\n');
  const attachments = m.attachments.length ? `\n\nAttachments:\n${listAttachments(m.attachments)}` : '';
  const body = sanitize({ text: m.text || undefined, html: m.html ?? undefined }, { maxChars });
  return wrapUntrusted('email', m.id, `${clean(head + attachments, 3000)}\n\n${body}`);
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

/**
 * The mail behind recent notifications, so "that low-priority email" can be found. Sender,
 * subject and the triage summary all come from email (the summary was written by a model
 * reading it), so the whole result is untrusted.
 */
export function recentMailTool(state: Pick<MailState, 'recent'>): RegisteredTool {
  return {
    def: toolByName('mail_recent')!,
    label: 'Checking recent mail…',
    untrustedOutput: true,
    async handler(args) {
      const { limit } = args as { limit?: number };
      const events = state.recent(limit ?? 10);
      if (!events.length) return 'No recent new-mail notifications.';
      const block = (e: (typeof events)[number]) => {
        const t = e.triage;
        const lines = [
          `From: ${e.from}`,
          `Subject: ${e.subject}`,
          `Received: ${when(new Date(e.receivedAt))}`,
          ...(t ? [`Priority: ${t.urgency}`, `Category: ${t.category}`, `Suggested action: ${t.suggested_action}`, `Needs reply: ${t.needs_reply ? 'yes' : 'no'}`, `Summary: ${t.summary}`] : []),
          ...(e.status === 'ignored' ? ['The user clicked Ignore on it.'] : []),
        ];
        return `id: ${e.mailId}\n${wrapUntrusted('email', e.mailId, clean(lines.join('\n'), 1500))}`;
      };
      return `${events.length} email(s) from recent notifications, newest first. Priority comes from the triage model's reading of each email. Use the id with mail_read or the attachment tools.\n\n${events.map(block).join('\n\n')}`;
    },
  };
}

/**
 * Attachments (S2). mail_attachment_read hands the model a PDF's or text file's text, as
 * untrusted email content; mail_attachment_show only posts a card the user can open, so its
 * result carries no email text at all.
 */
export function attachmentTools(o: { mail: Pick<MailClient, 'read' | 'attachment'>; files: Pick<AttachmentFiles, 'show'> }): RegisteredTool[] {
  return [
    {
      def: toolByName('mail_attachment_read')!,
      label: 'Reading the attachment…',
      untrustedOutput: true,
      async handler(args, ctx) {
        const { id, attachment: n } = args as { id: string; attachment: number };
        const got = await o.mail.attachment(id, n, MAX_ATTACHMENT_BYTES);
        if (!got) return `Error: message ${id} has no attachment ${n}. mail_read lists its attachments.`;
        if (got.bytes === 'too_large') return `Error: attachment ${n} is larger than ${sizeText(MAX_ATTACHMENT_BYTES)}, too large to read.`;
        const s = sniff(got.bytes, declaredKind(got.info));
        if (!s) return `Error: attachment ${n} is not a PDF, text file or image, so it can't be opened.`;
        const audit = { fileKind: s.kind, bytes: got.bytes.length };
        if (s.kind === 'image') {
          return { content: `Attachment ${n} of ${id} is an image. You cannot see images; call mail_attachment_show so the user can open it.`, audit };
        }
        let text: string;
        let note = '';
        if (s.kind === 'pdf') {
          const pdf = await extractPdfText(got.bytes, { signal: ctx.signal });
          if (!pdf.text.trim()) {
            return { content: `Attachment ${n} of ${id} is a PDF with no text to read (it may be scanned pages). Call mail_attachment_show so the user can open it.`, audit };
          }
          text = pdf.text;
          if (pdf.readPages < pdf.pages) note = ` Only the first ${pdf.readPages} of ${pdf.pages} pages were read.`;
        } else {
          text = got.bytes.toString('utf8');
        }
        const body = clean(`Attachment: ${got.info.name}\n\n${text}`, MAX_ATTACHMENT_CHARS);
        return { content: `id: ${id}, attachment ${n}.${note}\n${wrapUntrusted('email', id, body)}`, audit };
      },
    },
    {
      def: toolByName('mail_attachment_show')!,
      label: 'Getting the attachment…',
      async handler(args) {
        const { id, attachment: n } = args as { id: string; attachment: number };
        const m = await o.mail.read(id);
        if (!m) return `Error: no message with id ${id}.`;
        const info = m.attachments[n - 1];
        if (!info) return `Error: message ${id} has no attachment ${n}. mail_read lists its attachments.`;
        const card = o.files.show(id, n, info);
        if (!card) return `Error: attachment ${n} is not a PDF, text file or image, so it can't be opened here.`;
        return { content: `A card for attachment ${n} is in the chat; the user opens it with its Open button.`, audit: { fileKind: card.fileKind, itemId: card.id } };
      },
    },
  ];
}
