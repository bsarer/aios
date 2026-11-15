/** U1: looking for a new version in real git repositories in a temporary folder, and opening the terminal with fakes. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPDATE_COMMAND, checkForUpdate, openUpdateTerminal, readBuildInfo, realGit } from '../src/update.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8' }).trim();

function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'aios-update-'));
  const origin = join(dir, 'origin');
  git(dir, 'init', '-q', origin);
  writeFileSync(join(origin, 'a.txt'), '1');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'First');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  return { dir, origin, clone, built: git(clone, 'rev-parse', 'HEAD') };
}

describe('U1 updates', () => {
  it('reads the build record only when it is well formed', () => {
    const ok = { commit: 'a'.repeat(40), source: '/home/j/astra-src' };
    expect(readBuildInfo('/x', () => JSON.stringify(ok))).toEqual(ok);
    expect(readBuildInfo('/x', () => JSON.stringify({ ...ok, source: 'relative' }))).toBeNull();
    expect(readBuildInfo('/x', () => JSON.stringify({ ...ok, commit: 'main' }))).toBeNull();
    expect(readBuildInfo('/x', () => JSON.stringify({ ...ok, extra: 1 }))).toBeNull();
    expect(readBuildInfo('/x', () => '{')).toBeNull();
    expect(readBuildInfo('/nonexistent')).toBeNull();
  });

  it('says up to date, then lists what is new on the branch, as plain one-line subjects', async () => {
    const r = repos();
    const info = { commit: r.built, source: r.clone };
    expect(await checkForUpdate(info, realGit(r.clone))).toEqual({ state: 'current', commit: r.built, branch: 'origin/main' });
    for (const m of ['Setup in a window', 'Voice\u001b[31m in setup']) {
      writeFileSync(join(r.origin, 'a.txt'), m);
      git(r.origin, 'commit', '-qam', m);
    }
    const up = await checkForUpdate(info, realGit(r.clone));
    expect(up).toMatchObject({ state: 'available', from: r.built, to: git(r.origin, 'rev-parse', 'HEAD'), branch: 'origin/main', behind: 2, changes: ['Voice [31m in setup', 'Setup in a window'] });
    // Looking changed nothing in the checkout.
    expect(git(r.clone, 'rev-parse', 'HEAD')).toBe(r.built);
  });

  it('explains why it can’t update', async () => {
    expect(await checkForUpdate(null, realGit('/nonexistent'))).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('build.sh') });
    const r = repos();
    expect(await checkForUpdate({ commit: r.built, source: r.dir }, realGit(r.dir))).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('isn’t a git checkout') });
    git(r.clone, 'checkout', '-q', '--detach');
    expect(await checkForUpdate({ commit: r.built, source: r.clone }, realGit(r.clone))).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('git checkout main') });
  });

  it('opens a terminal running astra update in its own unit, with fixed words only', async () => {
    const started: [string, string[]][] = [];
    const start = async (cmd: string, args: string[]) => void started.push([cmd, args]);
    expect(await openUpdateTerminal({ WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0; rm -rf ~' }, start, async (c) => ['xdg-terminal-exec', 'uwsm-app'].includes(c))).toBe('xdg-terminal-exec');
    expect(started[0]![1]).toContain('WAYLAND_DISPLAY=wayland-1');
    expect(started[0]![1].join(' ')).not.toContain('rm -rf');
    // Never uwsm-app: its scope would keep this service's NoNewPrivileges, and sudo would refuse without asking.
    expect(started[0]![0]).toBe('systemd-run');
    expect(started[0]![1].slice(0, 3)).toEqual(['--user', '--collect', '--quiet']);
    expect(started[0]![1]).not.toContain('--scope');
    const inner = started[0]![1].slice(started[0]![1].indexOf('--') + 1);
    expect(inner.slice(0, 3)).toEqual(['xdg-terminal-exec', 'bash', '-c']);
    expect(inner[3]).toMatch(new RegExp(`^${UPDATE_COMMAND.join(' ')}; `));
    await openUpdateTerminal({}, start, async (c) => c === 'alacritty');
    expect(started[1]![1].slice(started[1]![1].indexOf('--') + 1)).toEqual(['alacritty', '-e', 'bash', '-c', expect.stringContaining('/usr/bin/astra update')]);
    await expect(openUpdateTerminal({}, start, async () => false)).rejects.toThrow(/no terminal/);
  });
});
