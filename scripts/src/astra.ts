/**
 * R1: the `astra` command. /usr/bin/astra (the Arch package) and `pnpm astra` run this; each
 * subcommand runs one of the scripts beside it, so `astra setup` is exactly `pnpm run setup`.
 *
 *   astra                    open the chat (Super+Shift+H does the same)
 *   astra setup [--kiosk]    first-run setup, or reinstall the service and kiosk only
 *   astra doctor             check the install; one line per check, each with a fix
 *   astra backup             write ~/astra-backup-<time>.tar.gz (never keyring secrets)
 *   astra restore FILE       put a backup back (what is there now is moved aside)
 *   astra calendar-login     sign in to Google Calendar again
 *   astra uninstall [--purge]  remove the service, kiosk and stored secrets; --purge also
 *                            deletes the config, memory and data (asks first)
 *   astra version
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_NAME } from '@aios/shared';
import { kioskPaths } from './kiosk.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The repo (or /usr/lib/astra in the package). */
export const ROOT = join(here, '..', '..');

export type Route =
  | { kind: 'script'; file: string; args: string[] }
  | { kind: 'restore'; file: string }
  | { kind: 'open' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const SCRIPTS: Record<string, { file: string; flags: string[] }> = {
  setup: { file: 'setup.ts', flags: ['--kiosk', '--dry-run'] },
  doctor: { file: 'doctor.ts', flags: [] },
  backup: { file: 'backup.ts', flags: [] },
  'calendar-login': { file: 'calendar-login.ts', flags: [] },
  uninstall: { file: 'uninstall.ts', flags: ['--purge', '--yes'] },
};

/** Which subcommand argv names. Only known flags are passed on; nothing else reaches a script. */
export function route(argv: string[]): Route {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'open') return rest.length ? { kind: 'error', message: `astra open takes no arguments` } : { kind: 'open' };
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { kind: 'help' };
  if (cmd === 'version' || cmd === '--version') return { kind: 'version' };
  if (cmd === 'restore') {
    const [file, ...more] = rest;
    if (!file || more.length || file.startsWith('-')) return { kind: 'error', message: 'usage: astra restore FILE' };
    return { kind: 'restore', file };
  }
  const s = Object.hasOwn(SCRIPTS, cmd) ? SCRIPTS[cmd] : undefined;
  if (!s) return { kind: 'error', message: `unknown command ${cmd} (see astra help)` };
  const bad = rest.find((a) => !s.flags.includes(a));
  if (bad !== undefined) return { kind: 'error', message: `astra ${cmd} does not take ${bad}${s.flags.length ? ` (it takes ${s.flags.join(', ')})` : ''}` };
  return { kind: 'script', file: join(here, s.file), args: rest };
}

function help(): string {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = text.slice(text.indexOf('\n *\n') + 4, text.indexOf(' */')).split('\n');
  return [`${APP_NAME}: a chat that works with your mail, calendar, files and apps.`, '', ...lines.map((l) => l.replace(/^ \* ?/, ''))].join('\n').trimEnd();
}

export function version(root = ROOT): string {
  try {
    const v = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function run(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.error) {
    console.error(`astra: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function main(argv: string[]): number {
  const r = route(argv);
  switch (r.kind) {
    case 'error':
      console.error(`astra: ${r.message}`);
      return 2;
    case 'help':
      console.log(help());
      return 0;
    case 'version':
      console.log(`${APP_NAME} ${version()}`);
      return 0;
    case 'open': {
      const { launcher } = kioskPaths();
      if (!existsSync(launcher)) {
        console.error(`${APP_NAME} is not set up for you yet. Run \`astra setup\` first.`);
        return 1;
      }
      return run(launcher, ['open'], ROOT);
    }
    case 'restore':
      // install.sh holds the tested checks: plain files only, no links or '..', only Astra's folders.
      return run('bash', ['-c', 'source "$1"; check_backup "$2" || die "nothing was changed"; restore_backup "$2"; echo "Now run: astra setup"', 'astra-restore', join(ROOT, 'install.sh'), r.file], ROOT);
    case 'script':
      // tsx is resolved from the scripts package, so it is found wherever Astra is installed.
      return run(process.execPath, ['--import', 'tsx', r.file, ...r.args], join(ROOT, 'scripts'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
