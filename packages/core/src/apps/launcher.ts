/**
 * Starts an installed app by its desktop id, the way Omarchy does it
 * (`uwsm-app -- gtk-launch <id>`, see omarchy-install-and-launch): uwsm puts the app in its
 * own systemd unit, so it outlives aios-core, and gtk-launch reads the Exec line itself.
 * No command line, argument or URL from the chat ever reaches it, only an id from scanApps.
 */
import { spawn } from 'node:child_process';
import { DESKTOP_ID, onPath } from './desktop.js';

export type Launch = (desktopId: string) => Promise<void>;

/** How long a launcher may take to fail before the start counts as under way. */
const EARLY_EXIT_MS = 1500;

export class LaunchError extends Error {}

export function createLauncher(env: NodeJS.ProcessEnv = process.env): Launch {
  return async (id) => {
    if (!DESKTOP_ID.test(id)) throw new LaunchError('that is not an installed app');
    if (!(await onPath('gtk-launch', env))) throw new LaunchError("this computer doesn't have gtk-launch (it comes with GTK, which Omarchy installs)");
    const [cmd, args] = (await onPath('uwsm-app', env)) ? ['uwsm-app', ['--', 'gtk-launch', id]] : ['gtk-launch', [id]];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore', env });
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, EARLY_EXIT_MS);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new LaunchError(`${cmd} could not start: ${err.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new LaunchError(`${cmd} could not start it (exit code ${code ?? 'unknown'})`));
      });
    });
  };
}
