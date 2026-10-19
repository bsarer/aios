/** List the test mailbox over IMAP, as any regular mail client would see it. */
import { ImapFlow } from 'imapflow';
import { TEST_MAILBOX, folderStatus } from './mailbox.js';

async function main(): Promise<void> {
  const client = new ImapFlow({
    host: TEST_MAILBOX.host,
    port: TEST_MAILBOX.imapPort,
    secure: false,
    auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['INBOX', 'Sent']) {
      const status = await folderStatus(client, folder);
      console.log(`\n${folder}: ${status.messages} messages, ${status.unseen} unread`);
      const lock = await client.getMailboxLock(folder);
      try {
        for await (const msg of client.fetch('1:*', { envelope: true, flags: true, bodyStructure: true })) {
          const unread = msg.flags?.has('\\Seen') ? ' ' : '*';
          const attach = JSON.stringify(msg.bodyStructure ?? {}).includes('"disposition":"attachment"') ? '📎' : '  ';
          const from = msg.envelope?.from?.[0]?.address ?? '?';
          const date = (msg.envelope?.date ? new Date(msg.envelope.date) : undefined)?.toISOString().slice(0, 16).replace('T', ' ') ?? '';
          console.log(`${unread}${attach} ${date}  ${from.padEnd(38)} ${msg.envelope?.subject ?? ''}`);
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }
}

main().catch((err: unknown) => {
  console.error(`check failed: ${(err as Error).message}`);
  process.exit(1);
});
