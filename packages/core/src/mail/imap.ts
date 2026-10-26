/**
 * IMAP access for the mail tools (plan §4): search, read and thread over INBOX and
 * Sent. Everything that came from a message (names, subjects, bodies) is untrusted;
 * callers sanitize() and wrap it before a model sees it.
 */
import type { Readable } from 'node:stream';
import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageAddressObject, type MessageStructureObject } from 'imapflow';
import { describeMailError } from './errors.js';

/** Folders as the model and UI name them. "Sent" is whatever the server calls it (Gmail: "[Gmail]/Sent Mail"). */
export const FOLDERS = ['INBOX', 'Sent'] as const;
export type Folder = (typeof FOLDERS)[number];

/** Stable id the model and UI use for a message: "<folder>:<uid>", e.g. "INBOX:42". */
export const mailId = (folder: Folder, uid: number) => `${folder}:${uid}`;

export function parseMailId(id: string): { folder: Folder; uid: number } | null {
  const m = /^(INBOX|Sent):(\d{1,10})$/.exec(id.trim());
  return m ? { folder: m[1] as Folder, uid: Number(m[2]) } : null;
}

export interface MailConnection {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  /** Resolved from the keyring for each new connection; never stored. */
  password: () => Promise<string>;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  messageId: string | null;
  from: Address | null;
  to: Address[];
  subject: string;
  date: Date | null;
}

export interface FullMessage extends MessageSummary {
  cc: Address[];
  replyTo: Address[];
  inReplyTo: string | null;
  references: string[];
  text: string;
  html: string | null;
  attachments: AttachmentPart[];
}

/** One attachment as listed in the message structure. Name and type are as the sender wrote them. */
export interface AttachmentPart {
  /** IMAP body part number, e.g. "2" or "1.3". */
  part: string;
  name: string;
  /** Declared MIME type, lower case. Only a hint: the bytes decide what it is (attachments.ts). */
  type: string;
  /** Size on the server, still transfer-encoded (base64 is about a third larger). */
  size: number | null;
}

const addr = (list?: MessageAddressObject[]): Address[] => (list ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));
const asDate = (d: Date | string | undefined) => (d ? new Date(d) : null);

export function summaryOf(folder: Folder, msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  return {
    id: mailId(folder, msg.uid),
    messageId: env?.messageId ?? null,
    from: addr(env?.from)[0] ?? null,
    to: addr(env?.to),
    subject: env?.subject ?? '',
    date: asDate(env?.date) ?? asDate(msg.internalDate),
  };
}

/** Parts worth reading: the first text/plain (else text/html) leaf, and the attachments. */
export function walkStructure(node: MessageStructureObject | undefined): { text?: string; html?: string; attachments: AttachmentPart[] } {
  const out: { text?: string; html?: string; attachments: AttachmentPart[] } = { attachments: [] };
  const visit = (n: MessageStructureObject) => {
    if (n.childNodes?.length) return n.childNodes.forEach(visit);
    const name = n.dispositionParameters?.filename ?? n.parameters?.name;
    const type = n.type.toLowerCase();
    if (n.disposition === 'attachment' || (name && !type.startsWith('text/'))) {
      out.attachments.push({ part: n.part ?? '1', name: name ?? type, type, size: n.size ?? null });
      return;
    }
    const part = n.part ?? '1';
    if (type === 'text/plain' && out.text === undefined) out.text = part;
    else if (type === 'text/html' && out.html === undefined) out.html = part;
  };
  if (node) visit(node);
  return out;
}

async function readStream(s: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of s) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
    chunks.push(b);
    size += b.length;
    if (size >= maxBytes) {
      s.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** Message-IDs in one header line (References or In-Reply-To) of a fetched header block. */
function headerIds(headers: Buffer | undefined, name: 'references' | 'in-reply-to'): string[] {
  const raw = headers?.toString('utf8') ?? '';
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const line = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)?.[1] ?? '';
  return line.match(/<[^<>\s]+>/g) ?? [];
}

const BODY_LIMIT = 256 * 1024;

/** Reads a whole stream into memory, or null once it passes maxBytes. */
async function readBytes(s: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of s) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
    size += b.length;
    if (size > maxBytes) {
      s.destroy();
      return null;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * UIDs where `text` appears in sender, recipients, subject or body. One SEARCH per
 * field, unioned: some servers (GreenMail among them) reject OR with quoted phrases.
 */
async function matchAnyField(client: ImapFlow, text: string, extra: { since?: Date }): Promise<number[]> {
  const all = new Set<number>();
  for (const field of ['from', 'to', 'subject', 'body'] as const) {
    for (const uid of (await client.search({ [field]: text, ...extra }, { uid: true })) || []) all.add(uid);
  }
  return [...all];
}

/** Headers, the readable body and attachment names of one message in the selected folder. */
export async function readFull(client: ImapFlow, folder: Folder, uid: number): Promise<FullMessage | null> {
  const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ['references', 'in-reply-to'] }, { uid: true });
  if (!msg) return null;
  const parts = walkStructure(msg.bodyStructure);
  const download = async (part: string | undefined) => {
    if (!part) return null;
    const d = await client.download(String(uid), part, { uid: true, maxBytes: BODY_LIMIT });
    return d.content ? readStream(d.content, BODY_LIMIT) : null;
  };
  const text = await download(parts.text);
  const html = text === null ? await download(parts.html) : null;
  return {
    ...summaryOf(folder, msg),
    cc: addr(msg.envelope?.cc),
    replyTo: addr(msg.envelope?.replyTo),
    // Some servers (GreenMail) leave In-Reply-To out of ENVELOPE, so read the header too.
    inReplyTo: msg.envelope?.inReplyTo || (headerIds(msg.headers, 'in-reply-to')[0] ?? null),
    references: headerIds(msg.headers, 'references'),
    text: text ?? '',
    html,
    attachments: parts.attachments,
  };
}

export function connect(c: MailConnection, password: string, opts: { idle: boolean }): ImapFlow {
  const client = new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.tls,
    auth: { user: c.user, pass: password },
    logger: false,
    disableAutoIdle: !opts.idle,
    // Start IDLE soon after each command so new mail is pushed within seconds.
    autoIdleDelay: 2000,
  });
  client.on('error', () => {
    // Surfaced through 'close'; the owner reconnects.
  });
  return client;
}

/**
 * The server's Drafts or Sent mailbox: the one with the special-use flag (RFC 6154, which
 * Gmail and most providers report, whatever the folder's name or language), else one named
 * Drafts or Sent. Null when there is none.
 */
export function findSpecial(list: Pick<ListResponse, 'path' | 'specialUse'>[], kind: 'drafts' | 'sent'): string | null {
  const flag = kind === 'drafts' ? '\\Drafts' : '\\Sent';
  const name = kind === 'drafts' ? 'drafts' : 'sent';
  return list.find((m) => m.specialUse === flag)?.path ?? list.find((m) => m.path.toLowerCase() === name)?.path ?? null;
}

/**
 * One IMAP connection for tool calls, opened lazily and reopened after it drops.
 * Separate from the watcher's IDLE connection so tools never wait on it.
 */
export class MailClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;

  constructor(private readonly c: MailConnection) {}

  private async connection(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    this.connecting ??= (async () => {
      const client = connect(this.c, await this.c.password(), { idle: false });
      await client.connect();
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** The mailbox behind a folder name, or null when the server has no Sent folder. */
  private async mailboxOf(folder: Folder): Promise<string | null> {
    if (folder === 'INBOX') return 'INBOX';
    if (this.special.sent) return this.special.sent;
    const path = findSpecial(await (await this.connection()).list(), 'sent');
    if (path) this.special.sent = path;
    return path;
  }

  /** Runs fn with the folder selected read-only. Null when the folder doesn't exist on this server. */
  private async inFolder<T>(folder: Folder, fn: (client: ImapFlow) => Promise<T>): Promise<T | null> {
    try {
      const path = await this.mailboxOf(folder);
      if (!path) return null;
      const client = await this.connection();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      throw new Error(describeMailError(err), { cause: err });
    }
  }

  /** Newest first, across INBOX and Sent. */
  async search(query: string, opts: { since?: Date; limit: number }): Promise<MessageSummary[]> {
    const found: MessageSummary[] = [];
    for (const folder of FOLDERS) {
      await this.inFolder(folder, async (client) => {
        const since = opts.since ? { since: opts.since } : {};
        const q = query.trim();
        let uids = q ? await matchAnyField(client, q, since) : ((await client.search({ all: true, ...since }, { uid: true })) || []);
        const words = q.split(/\s+/).filter((w) => w.length >= 3);
        if (!uids.length && words.length > 1) {
          // No exact phrase: messages that contain every word somewhere.
          const sets = await Promise.all(words.map((w) => matchAnyField(client, w, since)));
          uids = sets.reduce((acc, set) => acc.filter((u) => set.includes(u)));
        }
        const newest = uids.sort((a, b) => b - a).slice(0, opts.limit);
        if (!newest.length) return;
        for await (const msg of client.fetch(newest.join(','), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          found.push(summaryOf(folder, msg));
        }
      });
    }
    return found.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)).slice(0, opts.limit);
  }

  async read(id: string): Promise<FullMessage | null> {
    const ref = parseMailId(id);
    if (!ref) return null;
    return this.inFolder(ref.folder, (client) => readFull(client, ref.folder, ref.uid));
  }

  /**
   * One attachment's decoded bytes, by its position in `attachments` (1-based, as mail_read
   * lists them). Text parts arrive converted to UTF-8. Null when there is no such attachment.
   */
  async attachment(id: string, n: number, maxBytes: number): Promise<{ info: AttachmentPart; bytes: Buffer | 'too_large' } | null> {
    const ref = parseMailId(id);
    if (!ref) return null;
    return this.inFolder(ref.folder, async (client) => {
      const msg = await client.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
      const info = msg ? walkStructure(msg.bodyStructure).attachments[n - 1] : undefined;
      if (!info) return null;
      // base64 is 4/3 of the decoded size; anything far past the cap is refused before downloading.
      if (info.size !== null && info.size > maxBytes * 1.4 + 4096) return { info, bytes: 'too_large' };
      const d = await client.download(String(ref.uid), info.part, { uid: true });
      if (!d.content) return null;
      return { info, bytes: (await readBytes(d.content, maxBytes)) ?? 'too_large' };
    });
  }

  /** The thread `id` belongs to: every message sharing its root, oldest first. */
  async thread(id: string, limit = 20): Promise<FullMessage[]> {
    const msg = await this.read(id);
    if (!msg) return [];
    const ids = new Set([...msg.references, msg.inReplyTo, msg.messageId].filter((x): x is string => !!x));
    const members = new Map<string, string>(); // mail id -> folder:uid
    for (const folder of FOLDERS) {
      await this.inFolder(folder, async (client) => {
        for (const mid of ids) {
          const or = [{ header: { 'message-id': mid } }, { header: { references: mid } }, { header: { 'in-reply-to': mid } }];
          const uids = (await client.search({ or }, { uid: true })) || [];
          for (const uid of uids) members.set(mailId(folder, uid), mailId(folder, uid));
        }
      });
    }
    const out: FullMessage[] = [];
    for (const m of [...members.keys()].slice(0, limit)) {
      const full = await this.read(m);
      if (full) out.push(full);
    }
    return out.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  }

  private special: Partial<Record<'drafts' | 'sent', string>> = {};

  /** The Drafts or Sent folder: by special-use flag when the server reports one, else by name. */
  async specialFolder(kind: 'drafts' | 'sent'): Promise<string> {
    const known = this.special[kind];
    if (known) return known;
    const client = await this.connection();
    const name = kind === 'drafts' ? 'Drafts' : 'Sent';
    const path = findSpecial(await client.list(), kind);
    if (!path) await client.mailboxCreate(name);
    return (this.special[kind] = path ?? name);
  }

  /** Append a message; returns its UID when the server reports one (UIDPLUS) or it can be found by Message-ID. */
  async append(folder: string, raw: Buffer, flags: string[], messageId?: string): Promise<number | null> {
    const client = await this.connection();
    const res = await client.append(folder, raw, flags);
    if (res && res.uid) return res.uid;
    if (!messageId) return null;
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
      return uids.at(-1) ?? null;
    } finally {
      lock.release();
    }
  }

  async deleteUid(folder: string, uid: number): Promise<void> {
    const client = await this.connection();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    await this.client?.logout().catch(() => undefined);
    this.client = null;
  }
}
