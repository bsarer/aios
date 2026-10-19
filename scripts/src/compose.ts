import nodemailer from 'nodemailer';
import { type FixtureMail, type Person, messageId } from '../../fixtures/mail.js';

const DAY_MS = 86_400_000;

const fmt = (p: Person) => ({ name: p.name, address: p.address });

/** Build the raw RFC 822 message for a fixture, dated relative to `now`. */
export async function composeFixture(
  mail: FixtureMail,
  byKey: ReadonlyMap<string, FixtureMail>,
  now: Date,
): Promise<{ raw: Buffer; date: Date }> {
  const date = new Date(now.getTime() - mail.daysAgo * DAY_MS);

  // Walk up the reply chain to build References.
  const references: string[] = [];
  for (let k = mail.inReplyTo; k; k = byKey.get(k)?.inReplyTo) references.unshift(messageId(k));

  // streamTransport + buffer only renders the message; nothing is sent.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await transport.sendMail({
    messageId: messageId(mail.key),
    date,
    from: fmt(mail.from),
    to: mail.to.map(fmt),
    ...(mail.cc ? { cc: mail.cc.map(fmt) } : {}),
    subject: mail.subject,
    ...(mail.text !== undefined ? { text: mail.text } : {}),
    ...(mail.html !== undefined ? { html: mail.html } : {}),
    ...(mail.inReplyTo ? { inReplyTo: messageId(mail.inReplyTo), references } : {}),
    attachments: (mail.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : a.content,
    })),
    headers: mail.hostile ? { 'X-AIOS-Fixture-Hostile': mail.hostile.kind } : {},
  });
  return { raw: info.message as Buffer, date };
}
