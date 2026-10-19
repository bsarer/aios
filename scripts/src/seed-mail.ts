/**
 * Seed the GreenMail test mailbox with fixtures/mail.ts.
 * Idempotent: clears INBOX, Sent and Drafts first, so re-running gives the same mailbox.
 * Refuses to run against anything other than localhost.
 */
import { ImapFlow } from 'imapflow';
import { fixtures } from '../../fixtures/mail.js';
import { composeFixture } from './compose.js';
import { TEST_MAILBOX, folderStatus } from './mailbox.js';

const FOLDERS = ['INBOX', 'Sent', 'Drafts'] as const;

async function main(): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(TEST_MAILBOX.host)) {
    throw new Error('seed-mail only runs against the local test stack');
  }
  const client = new ImapFlow({
    host: TEST_MAILBOX.host,
    port: TEST_MAILBOX.imapPort,
    secure: false,
    auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass },
    logger: false,
  });
  await client.connect();
  try {
    const existing = new Set((await client.list()).map((m) => m.path));
    for (const folder of FOLDERS) {
      if (!existing.has(folder)) await client.mailboxCreate(folder);
      const lock = await client.getMailboxLock(folder);
      try {
        if ((client.mailbox && client.mailbox.exists) || 0) await client.messageDelete('1:*');
      } finally {
        lock.release();
      }
    }

    const byKey = new Map(fixtures.map((f) => [f.key, f]));
    const now = new Date();
    // Append oldest first so UIDs follow arrival order, like a real mailbox.
    const ordered = [...fixtures].sort((a, b) => b.daysAgo - a.daysAgo);
    for (const mail of ordered) {
      const { raw, date } = await composeFixture(mail, byKey, now);
      const flags = [...(mail.seen ? ['\\Seen'] : []), ...(mail.flagged ? ['\\Flagged'] : [])];
      await client.append(mail.folder, raw, flags, date);
    }

    const counts = await Promise.all(FOLDERS.map(async (f) => `${f}=${(await folderStatus(client, f)).messages}`));
    console.log(`seeded ${fixtures.length} messages (${counts.join(', ')})`);
  } finally {
    await client.logout();
  }
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${(err as Error).message}`);
  process.exit(1);
});
