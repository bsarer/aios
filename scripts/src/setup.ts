/**
 * `pnpm run setup`: interactive, idempotent first-run setup.
 * A0 skeleton: collects settings, stores secrets in the keyring, writes config, tests the mail login.
 * Model connection test arrives in A1; systemd unit and Hyprland snippets in A6.
 *
 *   --dry-run   print the resulting config; touch neither the keyring nor the disk
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Keyring } from '@aios/core';
import { type AiosConfig, configDir, parseConfig, serializeConfig } from '@aios/shared';
import { ImapFlow } from 'imapflow';
import { folderStatus } from './mailbox.js';
import providers from '../providers.json' with { type: 'json' };
import { terminalPrompter } from './prompt.js';
import { collectSetup } from './setup-lib.js';

async function loadExisting(path: string): Promise<AiosConfig | null> {
  try {
    return parseConfig(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function testMail(config: AiosConfig, keyring: Keyring): Promise<string> {
  const pass = await keyring.require(config.mail.passwordRef);
  const client = new ImapFlow({
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    secure: config.mail.imap.tls,
    auth: { user: config.mail.username, pass: pass.reveal() },
    logger: false,
  });
  await client.connect();
  try {
    const status = await folderStatus(client, 'INBOX');
    return `mail OK (${status.messages} messages in INBOX)`;
  } finally {
    await client.logout();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const dir = configDir();
  const path = `${dir}/config.toml`;
  const keyring = new Keyring();

  if (!dryRun && !(await keyring.available())) {
    throw new Error('secret-tool not found; install libsecret first (Omarchy: `sudo pacman -S libsecret`)');
  }

  const existing = await loadExisting(path);
  console.log(existing ? `Updating ${path}` : `Creating ${path}`);
  const prompter = terminalPrompter();
  let result;
  try {
    result = await collectSetup(prompter, existing, providers);
  } finally {
    prompter.close();
  }

  const toml = serializeConfig(result.config);
  if (dryRun) {
    console.log(`\n--- config.toml (dry run, nothing written) ---\n${toml}`);
    console.log(`would store: ${[...result.secrets.keys()].join(', ') || 'nothing'}`);
    return;
  }

  for (const [ref, value] of result.secrets) await keyring.set(ref, value);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, toml, { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(`wrote ${path}`);

  try {
    console.log(await testMail(result.config, keyring));
  } catch (err) {
    console.error(`mail test failed: ${(err as Error).message}`);
  }
  console.log('model connection test: added in A1');
  console.log('systemd unit and Hyprland snippets: added in A6');
}

main().catch((err: unknown) => {
  console.error(`setup failed: ${(err as Error).message}`);
  process.exit(1);
});
