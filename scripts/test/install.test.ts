/**
 * P1: install.sh and pnpm backup, run for real against temporary home folders, a local git
 * repo and pretend Omarchy commands (hyprctl, pnpm, secret-tool, systemctl). Never the real home.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backupPlan } from '../src/backup.js';

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh');
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const tools = has('bash') && has('git') && has('tar');

function fakeHome(opts: { omarchy?: string | null; hyprland?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aios-install-'));
  const bin = join(home, 'fakebin');
  mkdirSync(bin);
  const log = join(home, 'calls.log');
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake('hyprctl', `echo "Hyprland ${opts.hyprland ?? '0.55.1'} built from branch main at commit abc"`);
  fake('pnpm', `if [[ $1 == --version ]]; then echo 10.28.0; exit 0; fi\necho "pnpm $*" >> "${log}"`);
  fake('secret-tool', 'exit 0');
  fake('systemctl', `echo "systemctl $*" >> "${log}"`);
  if (opts.omarchy !== null) {
    mkdirSync(join(home, '.local', 'share', 'omarchy'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'omarchy', 'version'), `${opts.omarchy ?? '4.0.0.alpha'}\n`);
  }
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C.UTF-8', AIOS_ALLOW_ROOT: '1' };
  const sh = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [INSTALL, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: '' });
  /** Calls one function from install.sh. */
  const fn = (call: string) => spawnSync('bash', ['-c', `source "${INSTALL}"; ${call}`], { env, encoding: 'utf8' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { home, sh, fn, calls };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@aios.test', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

function localRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'VERSION'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  git(repo, 'tag', 'v0.1.0');
  writeFileSync(join(repo, 'VERSION'), 'unreleased\n');
  git(repo, 'commit', '-qam', 'two');
  return repo;
}

describe.skipIf(!tools)('install.sh --check', () => {
  it('passes on Omarchy 4 with Hyprland 0.55 and changes nothing', () => {
    const h = fakeHome();
    const r = h.sh(['--check']);
    expect(r.stdout).toContain('✓ Omarchy 4.0.0.alpha');
    expect(r.stdout).toContain('✓ Hyprland 0.55.1');
    expect(r.stdout).toContain('Ready to install.');
    expect(r.status).toBe(0);
    expect(existsSync(join(h.home, '.local', 'share', 'aios'))).toBe(false);
    expect(h.calls()).toBe('');
  });

  it('fails without Omarchy 4 or with an old Hyprland', () => {
    const old = fakeHome({ omarchy: '3.2.0' }).sh(['--check']);
    expect(old.status).toBe(1);
    expect(old.stdout).toContain('✗ Omarchy 4 not found');
    const none = fakeHome({ omarchy: null }).sh(['--check']);
    expect(none.status).toBe(1);
    const hypr = fakeHome({ hyprland: '0.54.9' }).sh(['--check']);
    expect(hypr.status).toBe(1);
    expect(hypr.stdout).toContain('older than 0.55');
  });

  it('compares versions by number', () => {
    const h = fakeHome();
    for (const [a, b, ok] of [['22.13.0', '22.13', 0], ['22.9.1', '22.13', 1], ['23.0', '22.13', 0], ['0.55.0', '0.55', 0], ['0.6', '0.55', 1]] as const) {
      expect(h.fn(`version_ge ${a} ${b}`).status, `${a} >= ${b}`).toBe(ok);
    }
  });
});

describe.skipIf(!tools)('install and upgrade', () => {
  it('installs the newest release tag, runs setup and the doctor, and upgrades on a second run', () => {
    const h = fakeHome();
    const repo = localRepo(h.home);
    const r = h.sh([], { AIOS_REPO: repo });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const app = join(h.home, '.local', 'share', 'astra', 'app');
    expect(readFileSync(join(app, 'VERSION'), 'utf8')).toBe('one\n');
    // No config yet: the full setup, not --kiosk.
    expect(h.calls().split('\n').filter((l) => l.startsWith('pnpm'))).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm --filter @aios/ui build',
      'pnpm run setup',
      'pnpm doctor',
    ]);

    git(repo, 'tag', 'v0.2.0');
    mkdirSync(join(h.home, '.config', 'astra'), { recursive: true });
    writeFileSync(join(h.home, '.config', 'astra', 'config.toml'), '# test\n');
    const again = h.sh([], { AIOS_REPO: repo });
    expect(again.status).toBe(0);
    expect(readFileSync(join(app, 'VERSION'), 'utf8')).toBe('unreleased\n');
    expect(h.calls()).toContain('pnpm run setup --kiosk');

    const main = h.sh(['--ref', 'v0.1.0'], { AIOS_REPO: repo });
    expect(main.status).toBe(0);
    expect(readFileSync(join(app, 'VERSION'), 'utf8')).toBe('one\n');
  });

  it('refuses to upgrade over local changes', () => {
    const h = fakeHome();
    const repo = localRepo(h.home);
    expect(h.sh([], { AIOS_REPO: repo }).status).toBe(0);
    writeFileSync(join(h.home, '.local', 'share', 'astra', 'app', 'VERSION'), 'edited\n');
    const r = h.sh([], { AIOS_REPO: repo });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('local changes');
  });
});

/** A home with AI OS's config, data (with an install and browser profile) and one built app. */
function populated() {
  const h = fakeHome();
  const files: Record<string, string> = {
    '.config/aios/config.toml': '# config\n',
    '.config/aios/memory/profile.md': 'likes tea\n',
    '.local/share/aios/aios.db': 'db',
    '.local/share/aios/audit.jsonl': '{}\n',
    '.local/share/aios/apps/notes/index.html': '<p>notes</p>',
    '.local/share/aios/app/package.json': '{}',
    '.local/share/aios/chromium/Default/Cookies': 'cookies',
    '.local/share/aios/apps/notes/data/Cache/x': 'cache',
    '.local/share/applications/aios-app-notes.desktop': '[Desktop Entry]\n',
    '.local/share/applications/firefox.desktop': '[Desktop Entry]\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(h.home, rel)), { recursive: true });
    writeFileSync(join(h.home, rel), text);
  }
  return h;
}

function tarList(file: string): string[] {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

describe.skipIf(!tools)('pnpm backup and install.sh --restore', () => {
  it('backs up config, data and built apps, never the install, browser profile or caches', () => {
    const h = populated();
    const plan = backupPlan({ HOME: h.home }, new Date('2026-11-02T21:05:00Z'));
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.file).toBe(join(h.home, 'aios-backup-20261102-2105.tar.gz'));
    execFileSync('tar', plan.args, { cwd: h.home });
    const names = tarList(plan.file);
    expect(names).toContain('.config/aios/memory/profile.md');
    expect(names).toContain('.local/share/aios/aios.db');
    expect(names).toContain('.local/share/aios/apps/notes/index.html');
    expect(names).toContain('.local/share/applications/aios-app-notes.desktop');
    for (const n of names) {
      expect(n).not.toMatch(/aios\/app\/|chromium|\/Cache\/|firefox/);
    }
    // The archive it writes is one install.sh accepts.
    expect(h.fn(`check_backup "${plan.file}"`).status).toBe(0);
  });

  it('refuses when nothing is set up or the folders are outside home', () => {
    expect(backupPlan({ HOME: mkdtempSync(join(tmpdir(), 'aios-empty-')) }, new Date())).toMatch(/nothing to back up/);
    expect(backupPlan({ HOME: '/home/a', XDG_CONFIG_HOME: '/etc' }, new Date())).toMatch(/outside/);
    expect(backupPlan({}, new Date())).toBe('HOME is not set');
  });

  it('restores over an existing setup, keeping what was there aside and the installed copy in place', () => {
    const h = populated();
    const plan = backupPlan({ HOME: h.home }, new Date('2026-11-02T21:05:00Z'));
    if (typeof plan === 'string') throw new Error(plan);
    execFileSync('tar', plan.args, { cwd: h.home });
    writeFileSync(join(h.home, '.config/aios/memory/profile.md'), 'changed since\n');
    const r = h.fn(`restore_backup "${plan.file}"`);
    expect(r.status).toBe(0);
    expect(readFileSync(join(h.home, '.config/aios/memory/profile.md'), 'utf8')).toBe('likes tea\n');
    expect(existsSync(join(h.home, '.local/share/aios/app/package.json'))).toBe(true);
    expect(r.stdout).toMatch(/moved the current config to .*aios\.before-restore-/);
    expect(h.calls()).toContain('systemctl --user stop aios-core.service');
  });

  /** Builds an archive in a scratch folder from the given entries. */
  function archive(h: ReturnType<typeof fakeHome>, build: (dir: string) => string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'aios-tar-'));
    const entries = build(dir);
    const file = join(h.home, 'bad.tar.gz');
    execFileSync('tar', ['-czf', file, ...entries], { cwd: dir });
    return file;
  }
  const put = (dir: string, rel: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), 'x');
    return rel;
  };

  it('R1: puts an Astra backup back as Astra and an AI OS backup back as AI OS, and refuses one holding both', () => {
    const astra = fakeHome();
    const a = archive(astra, (d) => [put(d, '.config/astra/config.toml'), put(d, '.local/share/astra/aios.db')]);
    const r = astra.fn(`check_backup "${a}" && restore_backup "${a}" && echo "dir=$APP_DIR"`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dir=astra');
    expect(existsSync(join(astra.home, '.config/astra/config.toml'))).toBe(true);
    expect(astra.calls()).toContain('systemctl --user stop astra.service');

    const old = fakeHome();
    const o = archive(old, (d) => [put(d, '.config/aios/config.toml')]);
    const r2 = old.fn(`check_backup "${o}" && restore_backup "${o}" && echo "dir=$APP_DIR"`);
    expect(r2.stdout).toContain('dir=aios');
    expect(existsSync(join(old.home, '.config/aios/config.toml'))).toBe(true);
    expect(old.calls()).toContain('systemctl --user stop aios-core.service');

    const both = archive(old, (d) => [put(d, '.config/aios/config.toml'), put(d, '.config/astra/config.toml')]);
    expect(old.fn(`check_backup "${both}"`).stdout).toContain('refused: ');
  });

  it('refuses archives with anything outside AI OS, links, .. or an installed copy, and changes nothing', () => {
    const h = populated();
    const cases: Array<[string, (d: string) => string[]]> = [
      ['not AI OS', (d) => [put(d, '.config/aios/config.toml'), put(d, '.bashrc')]],
      ['other launcher entries', (d) => [put(d, '.local/share/applications/firefox.desktop')]],
      ['a symlink', (d) => {
        mkdirSync(join(d, '.config', 'aios'), { recursive: true });
        symlinkSync('/etc/passwd', join(d, '.config/aios/config.toml'));
        return ['.config/aios/config.toml'];
      }],
      ['an installed copy', (d) => [put(d, '.local/share/aios/app/install.sh')]],
    ];
    for (const [what, build] of cases) {
      const r = h.fn(`check_backup "${archive(h, build)}"`);
      expect(r.status, what).toBe(1);
      expect(r.stdout, what).toContain('refused');
    }
    // A path with .. (GNU tar keeps it when asked to).
    const dir = mkdtempSync(join(tmpdir(), 'aios-tar-'));
    put(dir, 'x/.config/aios/f');
    const dots = join(h.home, 'dots.tar.gz');
    execFileSync('tar', ['-czf', dots, '-C', join(dir, 'x'), '.config/aios/f', '--transform', 's,^,.config/aios/../../,'], { cwd: dir });
    expect(h.fn(`check_backup "${dots}"`).stdout).toMatch(/refused/);

    // install.sh --restore with a bad file stops before touching anything.
    const r = h.sh(['--restore', archive(h, (d) => [put(d, '.bashrc')])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('nothing was changed');
    expect(readFileSync(join(h.home, '.config/aios/memory/profile.md'), 'utf8')).toBe('likes tea\n');
    expect(h.calls()).toBe('');
  });
});
