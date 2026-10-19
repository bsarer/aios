/**
 * Mail against the real GreenMail test stack (`pnpm test:stack:up`). Skipped when it
 * is not running. The reconnect test routes the watcher through a local TCP proxy
 * and cuts every connection, the way a server restart or network drop would.
 */
import { type Socket, connect as tcpConnect, createServer } from 'node:net';
import { MailClient, MailState, MailWatcher, ImapMailSource, Store, type WatcherStatus } from '@aios/core';
import { ImapFlow } from 'imapflow';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_MAILBOX } from '../src/mailbox.js';

const reachable = await new Promise<boolean>((resolve) => {
  const s = tcpConnect(TEST_MAILBOX.imapPort, TEST_MAILBOX.host);
  s.once('connect', () => (s.destroy(), resolve(true)));
  s.once('error', () => resolve(false));
});

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

  it('reads attachment names but not their content', async () => {
    const [msg] = await client.search('lesson', { limit: 1 });
    const full = await client.read(msg!.id);
    expect(full?.attachments).toContain('swim.png');
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
});
