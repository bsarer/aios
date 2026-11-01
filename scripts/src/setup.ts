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
import { signInToCalendar } from './calendar-auth.js';
import { folderStatus } from './mailbox.js';
import providers from '../providers.json' with { type: 'json' };
import { terminalPrompter } from './prompt.js';
import { type Prompter, collectSetup } from './setup-lib.js';
import { EXIT_KEYS, OPEN_KEYS, hyprlandModule, installKiosk, kioskPaths, launcherScript, parseMonitors, unitFile } from './kiosk.js';

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

async function writeConfig(path: string, config: AiosConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, serializeConfig(config), { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * S6: with more than one screen, ask which one AI OS takes over and keep the answer in
 * config [screen] monitor. With one screen, or outside Hyprland, nothing is asked.
 */
async function chooseScreen(config: AiosConfig, p: Prompter, save: (c: AiosConfig) => Promise<void>): Promise<AiosConfig> {
  const out = await promisify(execFile)('hyprctl', ['-j', 'monitors'], { timeout: 3000 }).then((r) => r.stdout, () => '');
  const screens = parseMonitors(out);
  if (screens.length < 2) return config;
  const list = screens.map((s) => `${s.name} (${s.width}×${s.height}${s.focused ? ', focused now' : ''})`).join(', ');
  const current = screens.find((s) => s.name === config.screen.monitor)?.name ?? screens.find((s) => s.focused)?.name ?? screens[0]!.name;
  for (;;) {
    const answer = (await p.ask(`Which screen should AI OS take over? ${list}`, { default: current })).trim();
    const hit = screens.find((s) => s.name.toLowerCase() === answer.toLowerCase());
    if (!hit) {
      console.log(`Type one of: ${screens.map((s) => s.name).join(', ')}`);
      continue;
    }
    if (hit.name === config.screen.monitor) return config;
    const next = { ...config, screen: { ...config.screen, monitor: hit.name } };
    await save(next);
    console.log(`AI OS will use ${hit.name}; apps can open beside the chat there or on the other screens.`);
    return next;
  }
}

/** Offer the systemd service and Hyprland kiosk (plan §8). Nothing changes without a yes. */
async function kiosk(config: AiosConfig, p: Prompter, dryRun: boolean, save: (c: AiosConfig) => Promise<void> = async () => undefined): Promise<void> {
  const paths = kioskPaths();
  const coreDir = join(root, 'packages', 'core');
  const monitor = config.screen.monitor ? { monitor: config.screen.monitor } : {};
  if (dryRun) {
    console.log(`\n--- ${paths.unit} (dry run) ---\n${unitFile({ node: process.execPath, coreDir })}`);
    console.log(`--- ${paths.launcher} (dry run) ---\n${launcherScript({ port: config.ui.port, profileDir: paths.profileDir })}`);
    console.log(`--- ${paths.aiosLua} (dry run) ---\n${hyprlandModule({ launcher: paths.launcher, autostart: config.ui.kiosk, ...monitor })}`);
    return;
  }
  if (!(await p.confirm('Run AI OS as a service that starts at login (systemd --user), with the full-screen chat?', true))) return;
  const hyprland = await p.confirm(`Add one line to ${paths.hyprlandLua} to load the kiosk window rule and keys? (a backup is kept)`, true);
  config = await chooseScreen(config, p, save);
  console.log('building the UI…');
  await run('pnpm', ['--filter', '@aios/ui', 'build']);
  const report = await installKiosk(
    paths,
    { node: process.execPath, coreDir, port: config.ui.port, autostart: config.ui.kiosk, hyprland, ...(config.screen.monitor ? { monitor: config.screen.monitor } : {}) },
    run,
  );
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
      await kiosk(existing, p, dryRun, (c) => writeConfig(path, c));
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
  const cal = result.config.calendar;
  if (cal) {
    const signedIn = !!(await keyring.get(cal.tokenRef));
    if (await prompter.confirm(signedIn ? 'Sign in to Google Calendar again?' : 'Sign in to Google Calendar now? (opens your browser)', !signedIn)) {
      try {
        const n = await signInToCalendar(cal, keyring, result.config.user.timezone, { loginHint: result.config.mail.address });
        console.log(`calendar OK (${n} event(s) in the next 7 days)`);
      } catch (err) {
        console.error(`calendar sign-in failed: ${(err as Error).message}. Try again later with \`pnpm calendar:login\`.`);
      }
    }
  }
  try {
    await kiosk(result.config, prompter, false, (c) => writeConfig(path, c));
  } finally {
    prompter.close();
  }
}

main().catch((err: unknown) => {
  console.error(`setup failed: ${(err as Error).message}`);
  process.exit(1);
});
