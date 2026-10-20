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
}

export function fieldsHash(f: OutgoingFields): string {
  const canonical = JSON.stringify([f.from.name, f.from.address, f.to, f.subject, f.body, f.reply?.inReplyTo ?? null, f.reply?.references ?? []]);
  return createHash('sha256').update(canonical).digest('hex');
}

export const newMessageId = (from: Sender) => `<${randomUUID()}@${from.address.split('@')[1] ?? 'aios.local'}>`;

/** Plain-text RFC 822 message; nothing in it is taken from anywhere but `f`. */
export async function buildMessage(f: OutgoingFields, messageId: string, date: Date): Promise<Buffer> {
  return new MailComposer({
    from: { name: f.from.name, address: f.from.address },
    to: f.to,
    subject: f.subject,
    text: f.body,
    messageId,
    date,
    ...(f.reply ? { inReplyTo: f.reply.inReplyTo, references: [...f.reply.references, f.reply.inReplyTo] } : {}),
  })
    .compile()
    .build();
}
