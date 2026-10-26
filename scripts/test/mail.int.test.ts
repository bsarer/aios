/**
 * Mail against the real GreenMail test stack (`pnpm test:stack:up`). Skipped when it
 * is not running. The reconnect test routes the watcher through a local TCP proxy
 * and cuts every connection, the way a server restart or network drop would.
 */
import { mkdtempSync } from 'node:fs';
import { type Socket, connect as tcpConnect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, AuditLog, ImapMailSource, ImapSmtpOutbox, MAX_ATTACHMENT_BYTES, MailClient, MailState, MailWatcher, Store, type WatcherStatus, extractPdfText, sniff } from '@aios/core';
import type { ChatItem } from '@aios/shared';
import { ImapFlow } from 'imapflow';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_MAILBOX } from '../src/mailbox.js';

const reachable = await new Promise<boolean>((resolve) => {
  const s = tcpConnect(TEST_MAILBOX.imapPort, TEST_MAILBOX.host);
  s.once('connect', () => (s.destroy(), resolve(true)));
  s.once('error', () => resolve(false));
});
// CI starts the stack and sets this, so a broken stack fails the run instead of skipping it.
if (process.env.AIOS_REQUIRE_STACK === '1' && !reachable) throw new Error('GreenMail test stack is not reachable');

const conn = (port = TEST_MAILBOX.imapPort) => ({
  host: TEST_MAILBOX.host,
  port,
  tls: false,
  user: TEST_MAILBOX.user,
  password: async () => TEST_MAILBOX.pass,
});

async function deliver(subject: string): Promise<string> {
  const id = `<int-${Date.now()}-${Math.random().toString(36).slice(2)}@aios.test>`;
  const c = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
  await c.connect();
  await c.append('INBOX', `From: Test <test@aios.test>\r\nTo: ${TEST_MAILBOX.user}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\n\r\nIntegration test body.`);
  await c.logout();
  return id;
}

/** A TCP proxy whose connections can all be cut at once. */
async function proxy(): Promise<{ port: number; cut: () => void; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = tcpConnect(TEST_MAILBOX.imapPort, TEST_MAILBOX.host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => undefined);
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    cut: () => sockets.forEach((s) => s.destroy()),
    close: () => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))),
  };
}

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!reachable)('mail on the GreenMail test stack', () => {
  const client = new MailClient(conn());
  afterAll(() => client.close());

  it('searches, reads and follows a thread across INBOX and Sent', async () => {
    const found = await client.search('budget review', { limit: 10 });
    expect(found.length).toBeGreaterThanOrEqual(4);
    const thread = await client.thread(found[0]!.id);
    expect(thread.map((m) => m.id.split(':')[0])).toContain('Sent');
    expect(new Set(thread.map((m) => m.subject.replace(/^Re: /, '')))).toEqual(new Set(['Q4 budget review']));
  });

  it('still searches INBOX when the server has no folder it can tell is Sent', async () => {
    // Before, a missing "Sent" (Gmail names it "[Gmail]/Sent Mail") failed every search.
    const admin = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
    await admin.connect();
    await admin.mailboxRename('Sent', 'Outgoing');
    const fresh = new MailClient(conn());
    try {
      const found = await fresh.search('budget review', { limit: 10 });
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((m) => m.id.startsWith('INBOX:'))).toBe(true);
    } finally {
      await fresh.close();
      await admin.mailboxRename('Outgoing', 'Sent');
      await admin.logout();
    }
  });

  it('lists attachments, and fetches one decoded, by its number (S2)', async () => {
    const [msg] = await client.search('lesson', { limit: 1 });
    const full = await client.read(msg!.id);
    expect(full?.attachments.map((a) => a.name)).toContain('swim.png');
    const venues = (await client.search('Offsite venue options', { limit: 10 })).find((m) => m.subject === 'Offsite venue options for November');
    const got = await client.attachment(venues!.id, 1, MAX_ATTACHMENT_BYTES);
    expect(got?.info.name).toBe('venues.pdf');
    expect(got?.bytes).toBeInstanceOf(Buffer);
    expect(sniff(got!.bytes as Buffer, 'pdf')?.kind).toBe('pdf');
    expect((await extractPdfText(got!.bytes as Buffer)).text).toContain('Lakeside Lodge');
    expect(await client.attachment(venues!.id, 2, MAX_ATTACHMENT_BYTES)).toBeNull();
    expect((await client.attachment(venues!.id, 1, 100))?.bytes).toBe('too_large');
  });

  it('notices new mail within seconds and survives dropped connections with no duplicates or losses', async () => {
    const px = await proxy();
    const state = new MailState(new Store(':memory:'));
    const statuses: WatcherStatus[] = [];
    const w = new MailWatcher({
      source: () => new ImapMailSource(conn(px.port)),
      state,
      pollMs: 30_000,
      onNew: () => undefined,
      onStatus: (s) => statuses.push(s),
      backoffMs: [200],
    });
    const queued = () => state.withStatus('pending', 500).map((e) => e.messageId);
    try {
      w.start();
      await until(() => statuses.includes('connected') && state.folder('INBOX') !== null, 10_000);

      const first = await deliver('watcher one');
      const started = Date.now();
      await until(() => queued().includes(first), 30_000);
      expect(Date.now() - started).toBeLessThan(30_000);

      px.cut();
      const during = await deliver('arrived while disconnected');
      await until(() => statuses.filter((s) => s === 'connected').length >= 2, 15_000);
      await until(() => queued().includes(during), 15_000);
      px.cut();
      await until(() => statuses.filter((s) => s === 'connected').length >= 3, 15_000);
      await w.check();

      const after = await deliver('after reconnects');
      await until(() => queued().includes(after), 30_000);
      expect(queued()).toEqual([first, during, after]);
    } finally {
      await w.stop();
      await px.close();
    }
  }, 120_000);

  it('drafts land in Drafts; Send delivers exactly the approved text and files it in Sent; Discard sends nothing', async () => {
    const outbox = new ImapSmtpOutbox(client, { host: TEST_MAILBOX.host, port: TEST_MAILBOX.smtpPort, tls: false, user: TEST_MAILBOX.user, password: async () => TEST_MAILBOX.pass });
    const cards = new Map<string, Extract<ChatItem, { kind: 'draft' }>>();
    const broker = new ApprovalBroker({
      store: new Store(':memory:'),
      outbox,
      audit: new AuditLog(join(mkdtempSync(join(tmpdir(), 'aios-int-')), 'audit.jsonl')),
      from: { name: 'John', address: TEST_MAILBOX.user },
      saveSentCopy: true,
      show: (item) => item.kind === 'draft' && cards.set(item.id, item),
      notice: () => undefined,
    });
    const tag = `a5-${Date.now()}`;
    const body = `Thursday works for me.\nSee you then, ünd thanks — John\n${tag}`;
    const count = async (folder: string) => (await client.search(tag, { limit: 50 })).filter((m) => m.id.startsWith(`${folder}:`)).length;
    const inDrafts = async () => {
      const c = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
      await c.connect();
      try {
        await c.mailboxOpen('Drafts', { readOnly: true });
        return ((await c.search({ body: tag }, { uid: true })) || []).length;
      } finally {
        await c.logout();
      }
    };

    const kept = await broker.create({ to: [TEST_MAILBOX.user], subject: `Re: plan ${tag}`, body, inReplyTo: null, reply: { inReplyTo: '<root@fixtures>', references: [] }, warnings: [] });
    const dropped = await broker.create({ to: [TEST_MAILBOX.user], subject: `Discard me ${tag}`, body: `never ${tag}`, inReplyTo: null, reply: null, warnings: [] });
    expect(await inDrafts()).toBe(2);

    expect(await broker.discard(dropped.id)).toBe(true);
    expect(await broker.approveSend(kept.id, cards.get(kept.id)!.hash)).toBe('sent');
    expect(await inDrafts()).toBe(0);

    const end = Date.now() + 10_000;
    while ((await count('INBOX')) < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    const delivered = (await client.search(tag, { limit: 50 })).filter((m) => m.id.startsWith('INBOX:'));
    expect(delivered.map((m) => m.subject)).toEqual([`Re: plan ${tag}`]);
    const full = await client.read(delivered[0]!.id);
    expect(full!.text.replace(/\r\n/g, '\n').trimEnd()).toBe(body);
    expect(full!.inReplyTo).toBe('<root@fixtures>');
    expect(await count('Sent')).toBe(1);
  }, 30_000);
});
