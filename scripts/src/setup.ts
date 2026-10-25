/**
 * `pnpm run setup`: interactive, idempotent first-run setup.
 * Collects settings, stores secrets in the keyring, writes config, tests the mail login,
 * then (A6) offers to install the systemd service and the Hyprland kiosk.
 *
 *   --dry-run   print the resulting config and kiosk files; touch neither the keyring nor the disk
 *   --kiosk     skip the questions and only (re)install the service and kiosk
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Keyring } from '@aios/core';
import { type AiosConfig, configDir, parseConfig, serializeConfig } from '@aios/shared';
import { ImapFlow } from 'imapflow';
import { folderStatus } from './mailbox.js';
import providers from '../providers.json' with { type: 'json' };
import { terminalPrompter } from './prompt.js';
import { type Prompter, collectSetup } from './setup-lib.js';
import { EXIT_KEYS, OPEN_KEYS, hyprlandModule, installKiosk, kioskPaths, launcherScript, unitFile } from './kiosk.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = async (cmd: string, args: string[]) => void (await promisify(execFile)(cmd, args, { cwd: root }));

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

/** Offer the systemd service and Hyprland kiosk (plan §8). Nothing changes without a yes. */
async function kiosk(config: AiosConfig, p: Prompter, dryRun: boolean): Promise<void> {
  const paths = kioskPaths();
  const coreDir = join(root, 'packages', 'core');
  if (dryRun) {
    console.log(`\n--- ${paths.unit} (dry run) ---\n${unitFile({ node: process.execPath, coreDir })}`);
    console.log(`--- ${paths.launcher} (dry run) ---\n${launcherScript({ port: config.ui.port, profileDir: paths.profileDir })}`);
    console.log(`--- ${paths.aiosLua} (dry run) ---\n${hyprlandModule({ launcher: paths.launcher, autostart: config.ui.kiosk })}`);
    return;
  }
  if (!(await p.confirm('Run AI OS as a service that starts at login (systemd --user), with the full-screen chat?', true))) return;
  const hyprland = await p.confirm(`Add one line to ${paths.hyprlandLua} to load the kiosk window rule and keys? (a backup is kept)`, true);
  console.log('building the UI…');
  await run('pnpm', ['--filter', '@aios/ui', 'build']);
  const report = await installKiosk(paths, { node: process.execPath, coreDir, port: config.ui.port, autostart: config.ui.kiosk, hyprland }, run);
  for (const f of report.written) console.log(`wrote ${f}`);
  for (const n of report.notes) console.log(n);
  if (await p.confirm('Start (or restart) the service now? Stop any `pnpm start` first, they use the same port.', true)) {
    await run('systemctl', ['--user', 'restart', 'aios-core.service']);
    console.log(`started. Open the chat with ${paths.launcher} open (or ${OPEN_KEYS} after reloading Hyprland).`);
  }
  console.log(`Exit the chat with ${EXIT_KEYS}. If keys stop working: Ctrl+Alt+F3, log in, then \`systemctl --user stop aios-core\` and \`${paths.launcher} exit\`.`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const kioskOnly = process.argv.includes('--kiosk');
  const dir = configDir();
  const path = `${dir}/config.toml`;
  const keyring = new Keyring();

  if (!dryRun && !(await keyring.available())) {
    throw new Error('secret-tool not found; install libsecret first (Omarchy: `sudo pacman -S libsecret`)');
  }

  const existing = await loadExisting(path);
  if (kioskOnly) {
    if (!existing) throw new Error(`run \`pnpm run setup\` first; ${path} not found`);
    const p = terminalPrompter();
    try {
      await kiosk(existing, p, dryRun);
    } finally {
      p.close();
    }
    return;
  }
  console.log(existing ? `Updating ${path}` : `Creating ${path}`);
  const prompter = terminalPrompter();
  let result;
  try {
    result = await collectSetup(prompter, existing, providers);
  } catch (err) {
    prompter.close();
    throw err;
  }

  const toml = serializeConfig(result.config);
  if (dryRun) {
    console.log(`\n--- config.toml (dry run, nothing written) ---\n${toml}`);
    console.log(`would store: ${[...result.secrets.keys()].join(', ') || 'nothing'}`);
    await kiosk(result.config, prompter, true);
    prompter.close();
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
  try {
    await kiosk(result.config, prompter, false);
  } finally {
    prompter.close();
  }
}

main().catch((err: unknown) => {
  console.error(`setup failed: ${(err as Error).message}`);
  process.exit(1);
});
