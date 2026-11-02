/**
 * Outgoing mail: the fields a draft card shows, their hash, and the RFC 822 message
 * built from exactly those fields. Sending checks the hash of the fields it builds
 * from against the hash the user approved (plan §4, send integrity).
 */
import { createHash, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';

export interface Sender {
  name: string;
  address: string;
}

/** Threading headers taken from the message being replied to. */
export interface ReplyHeaders {
  inReplyTo: string;
  references: string[];
}

/** Everything that decides what the recipient gets, apart from Date and Message-ID. */
export interface OutgoingFields {
  from: Sender;
  to: string[];
  subject: string;
  body: string;
  reply: ReplyHeaders | null;
  /** Files to attach, with the exact bytes that are sent. Left out or empty: none. */
  attachments?: AttachmentContent[] | undefined;
}

/** One attached file as it goes out: the name the recipient sees, its type and its bytes. */
export interface AttachmentContent {
  name: string;
  contentType: string;
  content: Buffer;
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function fieldsHash(f: OutgoingFields): string {
  const parts: unknown[] = [f.from.name, f.from.address, f.to, f.subject, f.body, f.reply?.inReplyTo ?? null, f.reply?.references ?? []];
  // Attachments join the hash only when there are some, so drafts made before them keep their hash.
  // Their bytes are in it, so a file that changes after the card was shown can't be sent.
  if (f.attachments?.length) parts.push(f.attachments.map((a) => [a.name, a.contentType, a.content.length, sha256(a.content)]));
  return sha256(JSON.stringify(parts));
}

export const newMessageId = (from: Sender) => `<${randomUUID()}@${from.address.split('@')[1] ?? 'aios.local'}>`;

/** Plain-text RFC 822 message (multipart when files are attached); nothing in it is taken from anywhere but `f`. */
export async function buildMessage(f: OutgoingFields, messageId: string, date: Date): Promise<Buffer> {
  return new MailComposer({
    from: { name: f.from.name, address: f.from.address },
    to: f.to,
    subject: f.subject,
    text: f.body,
    ...(f.attachments?.length
      ? { attachments: f.attachments.map((a) => ({ filename: a.name, contentType: a.contentType, content: a.content, contentDisposition: 'attachment' as const })) }
      : {}),
    messageId,
    date,
    ...(f.reply ? { inReplyTo: f.reply.inReplyTo, references: [...f.reply.references, f.reply.inReplyTo] } : {}),
  })
    .compile()
    .build();
}
