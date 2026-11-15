/**
 * U1: updating Astra. The Arch package records the commit it was built from and the checkout it
 * was built in (`BUILD_INFO.json`, written by packaging/arch/build.sh). `astra update` and the
 * chat's /update both ask git whether that checkout's branch has moved on; only `astra update`
 * pulls, builds and installs, in a terminal, because pacman needs the user's password there.
 * The chat's Update button only opens that terminal: no command, path or text from the chat,
 * mail or the model reaches it, and the model has no tool for it.
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { onPath } from './apps/desktop.js';

export const BUILD_INFO_FILE = 'BUILD_INFO.json';
const BuildInfo = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  source: z.string().min(2).max(4096).refine((p) => isAbsolute(p) && !p.includes('\0'), 'an absolute path'),
});
export type BuildInfo = z.infer<typeof BuildInfo>;

/** The package's build record, or null for a copy run from a checkout (or built before U1). */
export function readBuildInfo(root: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): BuildInfo | null {
  try {
    const r = BuildInfo.safeParse(JSON.parse(read(join(root, BUILD_INFO_FILE))));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export type Git = (args: string[]) => Promise<{ ok: boolean; out: string }>;

export function realGit(cwd: string): Git {
  return (args) =>
    promisify(execFile)('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(
      (r) => ({ ok: true, out: r.stdout.trim() }),
      (e: { stdout?: string }) => ({ ok: false, out: String(e.stdout ?? '').trim() }),
    );
}

export type UpdateCheck =
  | { state: 'available'; from: string; to: string; branch: string; behind: number; changes: string[] }
  | { state: 'current'; commit: string; branch: string }
  | { state: 'unavailable'; reason: string };

const MAX_CHANGES = 10;
/** Commit subjects are text from the repository: one plain line each, short. */
const subject = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);

/** Fetches the checkout's branch and compares it with what is installed. Changes nothing but git's remote refs. */
export async function checkForUpdate(info: BuildInfo | null, git: Git, opts: { fetch?: boolean } = {}): Promise<UpdateCheck> {
  if (!info) return { state: 'unavailable', reason: 'This copy of Astra wasn’t installed from the package, or the package was built before updates were added. Rebuild it once from your checkout: packaging/arch/build.sh -s, then sudo pacman -U packaging/arch/out/astra-*.pkg.tar.zst.' };
  if (!(await git(['rev-parse', '--is-inside-work-tree'])).ok) return { state: 'unavailable', reason: `Astra was built in ${info.source}, which isn’t a git checkout any more. Clone it there again to update.` };
  const branch = (await git(['rev-parse', '--abbrev-ref', '@{u}'])).out;
  if (!branch) return { state: 'unavailable', reason: `The checkout in ${info.source} isn’t on a branch that follows GitHub. Run git checkout main there.` };
  if (opts.fetch !== false && !(await git(['fetch', '--quiet'])).ok) return { state: 'unavailable', reason: 'Couldn’t reach GitHub to look for a new version. Check the network and try again.' };
  const to = (await git(['rev-parse', '@{u}'])).out;
  if (!/^[0-9a-f]{40}$/.test(to)) return { state: 'unavailable', reason: `Couldn’t read ${branch} in ${info.source}.` };
  if (to === info.commit) return { state: 'current', commit: info.commit, branch };
  const count = await git(['rev-list', '--count', `${info.commit}..${to}`]);
  const log = await git(['log', '--no-merges', `--max-count=${MAX_CHANGES}`, '--format=%s', `${info.commit}..${to}`]);
  const behind = count.ok ? Number.parseInt(count.out, 10) || 0 : 0;
  // An installed commit that is already in the branch, with nothing after it, is up to date.
  if (count.ok && behind === 0) return { state: 'current', commit: info.commit, branch };
  return { state: 'available', from: info.commit, to, branch, behind, changes: log.ok ? log.out.split('\n').filter(Boolean).map(subject) : [] };
}

/** What runs in the terminal: fixed words only. */
export const UPDATE_COMMAND = ['/usr/bin/astra', 'update'] as const;
const HOLD = `${UPDATE_COMMAND.join(' ')}; echo; read -rp "Press Enter to close this window. " _`;

/** Terminals to try, each with how it takes a command. Omarchy's own is xdg-terminal-exec. */
const TERMINALS: [string, string[]][] = [
  ['xdg-terminal-exec', []],
  ['alacritty', ['-e']],
  ['ghostty', ['-e']],
  ['kitty', []],
  ['foot', []],
];

export class UpdateError extends Error {}

/**
 * Opens a terminal running `astra update`. In its own systemd unit (uwsm-app, else systemd-run),
 * so it keeps running when the update restarts this service, and sudo works in it (this service
 * runs with NoNewPrivileges, which a child process would keep).
 */
export async function openUpdateTerminal(
  env: NodeJS.ProcessEnv = process.env,
  start: (cmd: string, args: string[]) => Promise<void> = startDetached(env),
  has: (cmd: string) => Promise<boolean> = (c) => onPath(c, env),
): Promise<string> {
  let term: [string, string[]] | undefined;
  for (const t of TERMINALS) if (await has(t[0])) { term = t; break; }
  if (!term) throw new UpdateError('no terminal found. Open one and run astra update.');
  const inner = [term[0], ...term[1], 'bash', '-c', HOLD];
  const [cmd, args] = (await has('uwsm-app')) ? ['uwsm-app', ['--', ...inner]] : ['systemd-run', ['--user', '--collect', '--quiet', '--', ...inner]];
  await start(cmd, args);
  return term[0];
}

function startDetached(env: NodeJS.ProcessEnv) {
  return (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore', env });
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, 1500);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new UpdateError(`${cmd} could not start: ${err.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new UpdateError(`${cmd} could not open the terminal (exit code ${code ?? 'unknown'})`));
      });
    });
}
