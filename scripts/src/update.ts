/**
 * U1: `astra update [--check]`. Updates the Arch package from the checkout it was built in
 * (packaging/arch/build.sh records it): fetch, fast-forward, build, `sudo pacman -U`, restart the
 * service. Settings, keys and data are in the home folder and stay as they are. --check only says
 * whether there is a new version. The chat's Update button opens a terminal running this.
 * The terminal shows a short list of steps and a progress bar (progress.ts); what the commands
 * print goes to a log file, shown with --details, by pressing d, or its last lines when a step fails.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type UpdateCheck, checkForUpdate, readBuildInfo, realGit } from '@aios/core';
import { APP_NAME } from '@aios/shared';
import { ROOT } from './astra.js';
import { kioskPaths } from './kiosk.js';
import { Progress, type StepDef, newLogPath } from './progress.js';

export interface UpdateSteps {
  check: () => Promise<UpdateCheck>;
  /** Runs one command; returns its exit code. Its output goes to the log, not the screen. */
  run: (cmd: string, args: string[], cwd?: string) => number | Promise<number>;
  /** Runs a command that talks to the person (sudo asking for the password). Defaults to run. */
  ask?: (say: string, cmd: string, args: string[]) => number | Promise<number>;
  /** Shows the installer screen with these steps; begin(i) marks the one running. */
  show?: (steps: StepDef[]) => void;
  begin?: (i: number) => void;
  /** The packages build.sh just wrote. */
  built: (dir: string) => string[];
  serviceInstalled: () => boolean;
  log: (line: string) => void;
}

/** The steps the installer screen shows, with about how long each takes. */
export function updateSteps(restart: boolean): StepDef[] {
  return [
    { label: 'Getting the new version', seconds: 5 },
    { label: 'Building the update (a few minutes)', seconds: 180 },
    { label: 'Installing it', seconds: 20 },
    ...(restart ? [{ label: `Restarting ${APP_NAME}`, seconds: 5 }] : []),
  ];
}

/** Returns the exit code. Stops at the first step that fails and says what to do. */
export async function update(source: string, service: string, s: UpdateSteps, opts: { check?: boolean } = {}): Promise<number> {
  const r = await s.check();
  if (r.state === 'unavailable') {
    s.log(r.reason);
    return 1;
  }
  if (r.state === 'current') {
    s.log(`${APP_NAME} is up to date (${r.commit.slice(0, 7)} on ${r.branch}).`);
    return 0;
  }
  s.log(`A new version of ${APP_NAME} is ready: ${r.behind || 'new'} change${r.behind === 1 ? '' : 's'} on ${r.branch}.`);
  for (const c of r.changes) s.log(`  - ${c}`);
  if (opts.check) return 0;

  const restart = s.serviceInstalled();
  s.show?.(updateSteps(restart));
  const ask = s.ask ?? ((_say: string, cmd: string, args: string[]) => s.run(cmd, args));
  const git = (args: string[]) => s.run('git', ['-C', source, ...args]);
  s.begin?.(0);
  if ((await git(['diff', '--quiet', 'HEAD'])) !== 0) {
    s.log(`${source} has changes that aren't committed. Commit or stash them (git stash), then run astra update again.`);
    return 1;
  }
  if ((await git(['merge', '--ff-only', '@{u}'])) !== 0) {
    s.log(`Couldn't move ${source} forward to ${r.branch} (it has commits of its own). Nothing was installed.`);
    return 1;
  }
  // The password once, up front, like an installer's "allow" box: the build may need it for
  // missing build tools (makepkg -s) and installing needs it. Then nothing else asks.
  if ((await ask(`${APP_NAME} needs your password to install the update.`, 'sudo', ['-v'])) !== 0) {
    s.log('Without your password the update can’t be installed. Nothing was changed; run astra update again when you’re ready.');
    return 1;
  }
  s.begin?.(1);
  const out = join(source, 'packaging', 'arch', 'out');
  if ((await s.run(join(source, 'packaging', 'arch', 'build.sh'), ['-s'], source)) !== 0) {
    s.log('The build failed; the installed version is unchanged.');
    return 1;
  }
  const pkg = s.built(out).filter((f) => /^astra-[^/]+\.pkg\.tar\.zst$/.test(f)).sort().at(-1);
  if (!pkg) {
    s.log(`The build finished but no package is in ${out}.`);
    return 1;
  }
  s.begin?.(2);
  // A long build can outlast sudo's few minutes; this asks again only then.
  if ((await ask('Your password again, please (the build took a while):', 'sudo', ['-v'])) !== 0 || (await s.run('sudo', ['-n', 'pacman', '-U', '--noconfirm', join(out, pkg)])) !== 0) {
    s.log('Installing failed; the installed version is unchanged.');
    return 1;
  }
  if (restart) {
    s.begin?.(3);
    if ((await s.run('systemctl', ['--user', 'restart', service])) !== 0) s.log(`Restart it with: systemctl --user restart ${service}`);
  }
  s.log(`${APP_NAME} is updated to ${r.to.slice(0, 7)}. Your settings, keys and data are unchanged.`);
  return 0;
}

/** sudo can't work under NoNewPrivileges (a terminal started by Astra's service the wrong way). */
export function noNewPrivileges(status: string): boolean {
  return /^NoNewPrivs:\s*1\s*$/m.test(status);
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');
  if (!check && noNewPrivileges(await readFile('/proc/self/status', 'utf8').catch(() => ''))) {
    console.log('This terminal can’t ask for your password (it was started with "no new privileges"). Open a terminal yourself (Super+Enter) and run: astra update');
    return 1;
  }
  const info = readBuildInfo(ROOT);
  const paths = kioskPaths();
  let screen: Progress | undefined;
  const code = await update(info?.source ?? '', paths.service, {
    check: () => checkForUpdate(info, realGit(info?.source ?? '/nonexistent')),
    run: (cmd, args, cwd) => screen!.run(cmd, args, cwd),
    ask: (say, cmd, args) => screen!.ask(say, cmd, args),
    show: (steps) => {
      screen = new Progress({ title: `Updating ${APP_NAME}`, steps, logPath: newLogPath('update'), details: argv.includes('--details'), input: process.stdin });
      screen.start();
    },
    begin: (i) => screen?.begin(i),
    built: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    serviceInstalled: () => existsSync(paths.unit),
    log: (l) => (screen ? screen.note(l) : console.log(l)),
  }, { check });
  screen?.end(code === 0);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c), (e: unknown) => {
  console.error(`astra update: ${(e as Error).message}`);
  process.exit(1);
});
