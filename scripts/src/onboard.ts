/**
 * R2: `astra setup` (and `astra settings`, and `astra` the first time) opens setup in a window.
 * A small server on 127.0.0.1 serves the page (onboard/server.ts); this file wires it to the
 * keyring, the config file, the app scan and the desktop install, and opens the window in
 * Chromium with a new, empty profile each time (onboard/window.ts). `astra setup --terminal` keeps the question-and-answer setup.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Keyring, dataDir } from '@aios/core';
import { type AiosConfig, APP_NAME, configDir, parseConfig, serializeConfig } from '@aios/shared';
import providers from '../providers.json' with { type: 'json' };
import { installKiosk, kioskPaths } from './kiosk.js';
import { readPresets } from './onboard/answers.js';
import { checkAiKey, checkMail } from './onboard/checks.js';
import { ADDON_IDS, type AddonId, installed, onPathIn, readCatalog } from './addons.js';
import { accountFirstName, findApps, homeFolders, mailHosts, ollamaEmbedModels, ollamaModels, realProbes, screens } from './onboard/probe.js';
import { openTerminal } from '@aios/core';
import { type SetupDeps, startSetupServer } from './onboard/server.js';
import { SignalLinker } from './onboard/signal.js';
import { freshProfile, removeProfile } from './onboard/window.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const run = async (cmd: string, args: string[]) => void (await promisify(execFile)(cmd, args, { cwd: ROOT, timeout: 120_000 }));

async function readConfig(path: string): Promise<AiosConfig | null> {
  try {
    return parseConfig(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeConfig(path: string, c: AiosConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A config that didn't load (hand-edited, from an older version) is kept beside the new one.
  if (existsSync(path) && !(await readConfig(path))) await copyFile(path, `${path}.before-setup`);
  await writeFile(path, serializeConfig(c), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function installDesktop(c: AiosConfig, d: { autostart: boolean; hyprland: boolean; bar: boolean }): Promise<string[]> {
  const paths = kioskPaths();
  const packaged = process.env.ASTRA_PACKAGED === '1';
  if (!packaged) await run('pnpm', ['--filter', '@aios/ui', 'build']);
  const report = await installKiosk(
    paths,
    { node: process.execPath, coreDir: join(ROOT, 'packages', 'core'), port: c.ui.port, autostart: d.autostart, hyprland: d.hyprland, bar: d.bar, packaged, ...(c.screen.monitor ? { monitor: c.screen.monitor } : {}) },
    run,
  );
  await run('systemctl', ['--user', 'restart', paths.service]);
  const did = [`Started ${APP_NAME} in the background (${paths.service}).`];
  if (report.written.includes(paths.hyprlandLua)) {
    await run('hyprctl', ['reload']).catch(() => undefined);
    did.push('Added Super+Shift+H and the full-screen rule to Hyprland.');
  }
  if (report.written.includes(paths.shellJson)) did.push('Added the AI button to the top bar.');
  for (const n of report.notes.filter((x) => !x.startsWith('Backed up') && !x.includes('previous version'))) did.push(n);
  return did;
}

function openWindow(url: string, profile: string): ChildProcess | null {
  const candidates = [process.env.AIOS_BROWSER, 'chromium', 'google-chrome-stable', 'brave'].filter((b): b is string => !!b);
  const path = (process.env.PATH ?? '').split(':');
  const browser = candidates.find((b) => (b.startsWith('/') ? existsSync(b) : path.some((d) => existsSync(join(d, b)))));
  if (!browser || !(process.env.WAYLAND_DISPLAY || process.env.DISPLAY)) return null;
  return spawn(browser, [`--user-data-dir=${profile}`, '--class=org.aios.setup', '--no-first-run', '--no-default-browser-check', `--app=${url}`], { stdio: 'ignore' });
}

export async function runSetupWindow(): Promise<void> {
  const keyring = new Keyring();
  if (!(await keyring.available())) throw new Error('secret-tool not found; install libsecret first (`sudo pacman -S libsecret`)');
  const configPath = join(configDir(), 'config.toml');
  const presets = readPresets(providers as Record<string, unknown>);
  const probes = realProbes();
  const catalog = readCatalog();
  let window: ChildProcess | null = null;
  let resolveDone: () => void = () => undefined;
  const finished = new Promise<void>((r) => (resolveDone = r));

  // SG1: signal-cli as the window's scan found it (the scan runs again each time the window loads).
  let signalCli: string | null = null;
  const linker = new SignalLinker(() => signalCli);
  const deps: SetupDeps = {
    page: () => readFile(join(ROOT, 'scripts', 'onboard', 'page.html'), 'utf8'),
    presets,
    readConfig: () => readConfig(configPath),
    writeConfig: (c) => writeConfig(configPath, c),
    keyring,
    look: async () => ({
      name: await accountFirstName(probes),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      folders: await homeFolders(probes),
      apps: { ...(await findApps(probes).then((a) => ((signalCli = a.signal), a))), embed: (await ollamaEmbedModels(probes))[0] ?? null },
      addons: ADDON_IDS.map((id) => ({ id, label: catalog[id].label, blurb: catalog[id].blurb, installed: installed(id, catalog[id], onPathIn(), existsSync) })),
      ollama: await ollamaModels(probes),
      screens: await screens(probes),
    }),
    mx: (address) => mailHosts(probes, address),
    checkAi: (o) => checkAiKey(o),
    checkMail: (o) => checkMail(o),
    installDesktop,
    signal: linker,
    // The package's astra; a checkout runs its own through pnpm.
    installAddons: (ids: AddonId[]) => openTerminal(existsSync('/usr/bin/astra') ? ['/usr/bin/astra', 'addons', ...ids.map((i) => `--${i}`)] : ['pnpm', '-C', ROOT, 'astra', 'addons', ...ids.map((i) => `--${i}`)], 'astra-addons'),
    done: () => {
      const { launcher } = kioskPaths();
      if (existsSync(launcher)) spawn(launcher, ['open'], { stdio: 'ignore', detached: true }).unref();
      resolveDone();
    },
    exit: () => resolveDone(),
  };

  const server = await startSetupServer(deps);
  const profile = await freshProfile(dataDir());
  window = openWindow(server.url, profile);
  console.log(window ? `${APP_NAME} setup is open in a window.` : `Open this address in a browser on this computer to set up ${APP_NAME}:`);
  console.log(`  ${server.url}`);
  console.log('Close this terminal or press Ctrl+C to stop setup.');
  window?.on('exit', () => resolveDone());
  await finished;
  const closed = window && window.exitCode === null && window.signalCode === null ? new Promise<void>((r) => window?.once('exit', () => r())) : Promise.resolve();
  window?.kill();
  linker.cancel();
  await server.close();
  // Chromium writes its profile until it exits; give it a few seconds, then remove it.
  await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 5000).unref())]);
  await removeProfile(profile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetupWindow().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`setup failed: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
