/**
 * `pnpm check:account`: check the mailbox in your config, read-only (A7).
 * Logs in over IMAP, finds Drafts and Sent the way aios-core will, and checks the SMTP
 * login without sending anything. Meant for the dedicated throwaway test account.
 *
 *   --seed-hostile   after a confirmation, add the six hostile test emails to INBOX
 *                    (throwaway accounts only), to try them against the real model
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Keyring, describeMailError, smtpOptions } from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { fixtures } from '../../fixtures/mail.js';
import { composeFixture } from './compose.js';
import { folderStatus } from './mailbox.js';
import { terminalPrompter } from './prompt.js';

const ok = (s: string) => console.log(`✓ ${s}`);
const bad = (s: string) => console.log(`✗ ${s}`);

async function main(): Promise<void> {
  const config = parseConfig(await readFile(join(configDir(), 'config.toml'), 'utf8'));
  const m = config.mail;
  console.log(`Checking ${m.address} (IMAP ${m.imap.host}:${m.imap.port}, SMTP ${m.smtp.host}:${m.smtp.port})`);
  if (!m.imap.tls || !m.smtp.tls) console.log('! TLS is off. That is only right for the local test stack.');
  const keyring = new Keyring();
  let failed = false;

  let pass: string;
  try {
    pass = (await keyring.require(m.passwordRef)).reveal();
  } catch (err) {
    bad(`password: ${describeMailError(err)}`);
    process.exit(1);
  }

  const imap = new ImapFlow({ host: m.imap.host, port: m.imap.port, secure: m.imap.tls, auth: { user: m.username, pass }, logger: false });
  try {
    await imap.connect();
    const inbox = await folderStatus(imap, 'INBOX');
    ok(`IMAP login; INBOX has ${inbox.messages} messages, ${inbox.unseen} unread`);
    const list = await imap.list();
    for (const [use, name] of [['\\Drafts', 'Drafts'], ['\\Sent', 'Sent']] as const) {
      const found = list.find((b) => b.specialUse === use) ?? list.find((b) => b.path.toLowerCase() === name.toLowerCase());
      if (found) ok(`${name} folder: ${found.path}${found.specialUse ? '' : ' (found by name)'}`);
      else console.log(`! no ${name} folder; aios-core will create "${name}" the first time it needs one`);
    }
    if (process.argv.includes('--seed-hostile')) await seedHostile(imap, m.address);
  } catch (err) {
    failed = true;
    bad(`IMAP: ${describeMailError(err)}`);
  } finally {
    await imap.logout().catch(() => undefined);
  }

  const transport = nodemailer.createTransport(
    smtpOptions({ host: m.smtp.host, port: m.smtp.port, tls: m.smtp.tls, user: m.username, password: async () => pass }, pass),
  );
  try {
    await transport.verify();
    ok('SMTP login (nothing sent)');
  } catch (err) {
    failed = true;
    bad(`SMTP: ${describeMailError(err)}`);
  } finally {
    transport.close();
  }
  if (failed) process.exit(1);
}

async function seedHostile(imap: ImapFlow, address: string): Promise<void> {
  const p = terminalPrompter();
  try {
    const yes = await p.confirm(`Add the 6 hostile test emails to the INBOX of ${address}? Only do this on a throwaway test account.`, false);
    if (!yes) return console.log('skipped');
  } finally {
    p.close();
  }
  const byKey = new Map(fixtures.map((f) => [f.key, f]));
  const now = new Date();
  for (const mail of fixtures.filter((f) => f.hostile)) {
    const { raw } = await composeFixture({ ...mail, daysAgo: 0 }, byKey, now);
    await imap.append('INBOX', raw, [], now);
  }
  ok('added 6 hostile test emails to INBOX');
}

main().catch((err: unknown) => {
  console.error(`check failed: ${describeMailError(err)}`);
  process.exit(1);
});
