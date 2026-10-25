/**
 * The production MailOutbox: IMAP for the Drafts and Sent folders, SMTP for sending.
 * Only the approval broker holds one, so only a Send click reaches send().
 */
import nodemailer from 'nodemailer';
import type { MailOutbox } from './approvals.js';
import type { MailClient } from './imap.js';

export interface SmtpConnection {
  host: string;
  port: number;
  /** Port 465: TLS from the start. Any other port: STARTTLS, required. false: plain, local test stack only. */
  tls: boolean;
  user: string;
  /** Resolved from the keyring for each send; never stored. */
  password: () => Promise<string>;
}

/** nodemailer transport options for an SMTP endpoint. */
export function smtpOptions(c: SmtpConnection, pass: string) {
  return {
    host: c.host,
    port: c.port,
    secure: c.tls && c.port === 465,
    requireTLS: c.tls && c.port !== 465,
    ignoreTLS: !c.tls,
    auth: { user: c.user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export class ImapSmtpOutbox implements MailOutbox {
  constructor(
    private readonly imap: Pick<MailClient, 'specialFolder' | 'append' | 'deleteUid'>,
    private readonly smtp: SmtpConnection,
  ) {}

  async saveDraft(raw: Buffer, messageId: string): Promise<number | null> {
    return this.imap.append(await this.imap.specialFolder('drafts'), raw, ['\\Draft', '\\Seen'], messageId);
  }

  async deleteDraft(uid: number): Promise<void> {
    await this.imap.deleteUid(await this.imap.specialFolder('drafts'), uid);
  }

  async send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[]; rejected: string[] }> {
    const transport = nodemailer.createTransport(smtpOptions(this.smtp, await this.smtp.password()));
    try {
      const info = await transport.sendMail({ envelope, raw });
      const list = (xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : (x as { address: string }).address));
      return { accepted: list(info.accepted), rejected: list(info.rejected) };
    } finally {
      transport.close();
    }
  }

  async saveSent(raw: Buffer): Promise<void> {
    await this.imap.append(await this.imap.specialFolder('sent'), raw, ['\\Seen']);
  }
}
