/**
 * The Settings gear in the status strip (and /settings): opens the setup window (R2) on the
 * current settings by running the fixed `/usr/bin/astra settings`. Only Shell calls it, for the
 * user's own click or typed command: there is no tool for it, so neither the model nor outside
 * text can open it (test: packages/core/test/settings.test.ts). Setup itself keeps the sections it
 * doesn't show, sends keys and passwords only to the keyring, and restarts the service on Finish,
 * which is why the window runs in its own systemd unit (uwsm-app, else systemd-run).
 */
import { existsSync } from 'node:fs';
import { onPath } from './apps/desktop.js';
import { startDetached } from './update.js';

/** What runs: fixed words only. */
export const SETTINGS_COMMAND = ['/usr/bin/astra', 'settings'] as const;

export class SettingsError extends Error {}

export async function openSettingsWindow(
  env: NodeJS.ProcessEnv = process.env,
  start: (cmd: string, args: string[]) => Promise<void> = startDetached(env),
  has: (cmd: string) => Promise<boolean> = (c) => onPath(c, env),
  exists: (path: string) => boolean = existsSync,
): Promise<void> {
  // A checkout (not the package) has no /usr/bin/astra; its settings open from a terminal.
  if (!exists(SETTINGS_COMMAND[0])) throw new SettingsError('this install has no astra command. Run `astra settings` (or `pnpm run setup`) in a terminal.');
  const [cmd, args] = (await has('uwsm-app')) ? ['uwsm-app', ['--', ...SETTINGS_COMMAND]] : ['systemd-run', ['--user', '--collect', '--quiet', '--', ...SETTINGS_COMMAND]];
  try {
    await start(cmd, args);
  } catch (err) {
    throw new SettingsError((err as Error).message);
  }
}
