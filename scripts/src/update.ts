/**
 * U1: `astra update [--check]`. Updates the Arch package from the checkout it was built in
 * (packaging/arch/build.sh records it): fetch, fast-forward, build, `sudo pacman -U`, restart the
 * service. Settings, keys and data are in the home folder and stay as they are. --check only says
 * whether there is a new version. The chat's Update button opens a terminal running this.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type UpdateCheck, checkForUpdate, readBuildInfo, realGit } from '@aios/core';
import { APP_NAME } from '@aios/shared';
import { ROOT } from './astra.js';
import { kioskPaths } from './kiosk.js';

export interface UpdateSteps {
  check: () => Promise<UpdateCheck>;
  /** Runs one command in the terminal; returns its exit code. */
  run: (cmd: string, args: string[], cwd?: string) => number;
  /** The packages build.sh just wrote. */
  built: (dir: string) => string[];
  serviceInstalled: () => boolean;
  log: (line: string) => void;
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

  const git = (args: string[]) => s.run('git', ['-C', source, ...args]);
  if (git(['diff', '--quiet', 'HEAD']) !== 0) {
    s.log(`${source} has changes that aren't committed. Commit or stash them (git stash), then run astra update again.`);
    return 1;
  }
  if (git(['merge', '--ff-only', '@{u}']) !== 0) {
    s.log(`Couldn't move ${source} forward to ${r.branch} (it has commits of its own). Nothing was installed.`);
    return 1;
  }
  s.log('Building the package (a few minutes)...');
  const out = join(source, 'packaging', 'arch', 'out');
  if (s.run(join(source, 'packaging', 'arch', 'build.sh'), ['-s'], source) !== 0) {
    s.log('The build failed; the installed version is unchanged. The lines above say why.');
    return 1;
  }
  const pkg = s.built(out).filter((f) => /^astra-[^/]+\.pkg\.tar\.zst$/.test(f)).sort().at(-1);
  if (!pkg) {
    s.log(`The build finished but no package is in ${out}.`);
    return 1;
  }
  s.log('Installing it. sudo asks for your password:');
  if (s.run('sudo', ['pacman', '-U', '--noconfirm', join(out, pkg)]) !== 0) {
    s.log('Installing failed; the installed version is unchanged.');
    return 1;
  }
  if (s.serviceInstalled()) {
    s.log(`Restarting ${APP_NAME}...`);
    if (s.run('systemctl', ['--user', 'restart', service]) !== 0) s.log(`Restart it with: systemctl --user restart ${service}`);
  }
  s.log(`Updated ${APP_NAME} to ${r.to.slice(0, 7)}. Your settings, keys and data are unchanged.`);
  return 0;
}

/** sudo can't work under NoNewPrivileges (a terminal started by Astra's service the wrong way). */
export function noNewPrivileges(status: string): boolean {
  return /^NoNewPrivs:\s*1\s*$/m.test(status);
}

async function main(argv: string[]): Promise<number> {
  if (!argv.includes('--check') && noNewPrivileges(await readFile('/proc/self/status', 'utf8').catch(() => ''))) {
    console.log('This terminal can’t ask for your password (it was started with "no new privileges"). Open a terminal yourself (Super+Enter) and run: astra update');
    return 1;
  }
  const info = readBuildInfo(ROOT);
  const paths = kioskPaths();
  const run = (cmd: string, args: string[], cwd?: string) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    return r.error ? 127 : (r.status ?? 1);
  };
  return update(info?.source ?? '', paths.service, {
    check: () => checkForUpdate(info, realGit(info?.source ?? '/nonexistent')),
    run,
    built: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    serviceInstalled: () => existsSync(paths.unit),
    log: (l) => console.log(l),
  }, { check: argv.includes('--check') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c), (e: unknown) => {
  console.error(`astra update: ${(e as Error).message}`);
  process.exit(1);
});
