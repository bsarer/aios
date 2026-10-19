import type { ImapFlow } from 'imapflow';

/** Connection details for the local GreenMail stack in docker-compose.test.yml. Test-only values. */
export const TEST_MAILBOX = {
  host: '127.0.0.1',
  imapPort: Number(process.env.AIOS_TEST_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.AIOS_TEST_SMTP_PORT ?? 3025),
  user: 'john@aios.test',
  pass: 'test-only-password',
} as const;

/** Message counts for a folder. imapflow types status() as `false | StatusObject`. */
export async function folderStatus(client: ImapFlow, folder: string): Promise<{ messages: number; unseen: number }> {
  const s = await client.status(folder, { messages: true, unseen: true });
  if (!s) throw new Error(`could not read status of ${folder}`);
  return { messages: s.messages ?? 0, unseen: s.unseen ?? 0 };
}
