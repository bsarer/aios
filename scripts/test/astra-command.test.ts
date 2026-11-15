/** R1: the `astra` command routes each subcommand to one script and passes on only known flags. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, route, version } from '../src/astra.js';
import { purgeTargets } from '../src/uninstall.js';

const script = (name: string) => join(ROOT, 'scripts', 'src', name);

describe('astra', () => {
  it('opens the chat with no arguments, and routes each subcommand to its script', () => {
    expect(route([])).toEqual({ kind: 'open' });
    expect(route(['open'])).toEqual({ kind: 'open' });
    expect(route(['setup'])).toEqual({ kind: 'script', file: script('setup.ts'), args: [] });
    expect(route(['setup', '--kiosk'])).toEqual({ kind: 'script', file: script('setup.ts'), args: ['--kiosk'] });
    expect(route(['doctor'])).toMatchObject({ kind: 'script', file: script('doctor.ts') });
    expect(route(['backup'])).toMatchObject({ kind: 'script', file: script('backup.ts') });
    expect(route(['uninstall', '--purge'])).toEqual({ kind: 'script', file: script('uninstall.ts'), args: ['--purge'] });
    expect(route(['restore', '/home/j/astra-backup.tar.gz'])).toEqual({ kind: 'restore', file: '/home/j/astra-backup.tar.gz' });
  });

  it('refuses unknown commands and flags, and never runs a file it was not built with', () => {
    expect(route(['rm'])).toMatchObject({ kind: 'error' });
    expect(route(['constructor'])).toMatchObject({ kind: 'error' });
    expect(route(['__proto__'])).toMatchObject({ kind: 'error' });
    expect(route(['doctor', '--fix'])).toMatchObject({ kind: 'error', message: expect.stringContaining('does not take --fix') });
    expect(route(['setup', '../../etc/passwd'])).toMatchObject({ kind: 'error' });
    expect(route(['restore'])).toMatchObject({ kind: 'error' });
    expect(route(['restore', '--force'])).toMatchObject({ kind: 'error' });
    expect(route(['restore', 'a', 'b'])).toMatchObject({ kind: 'error' });
    expect(route(['open', 'x'])).toMatchObject({ kind: 'error' });
  });

  it('prints help and its version, read from package.json', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
    const r = spawnSync(process.execPath, ['--import', 'tsx', script('astra.ts'), 'help'], { cwd: join(ROOT, 'scripts'), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('astra restore FILE');
    expect(r.stdout).not.toContain('*/');
    const bad = spawnSync(process.execPath, ['--import', 'tsx', script('astra.ts'), 'nope'], { cwd: join(ROOT, 'scripts'), encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });

  it('uninstall --purge deletes the config and data, but keeps an installed copy in the data folder', () => {
    const env = { HOME: '/home/j', XDG_CONFIG_HOME: '/home/j/.config', XDG_DATA_HOME: '/home/j/.local/share' };
    const t = purgeTargets(env, () => ['aios.db', 'apps', 'app', 'chromium']);
    expect(t[0]).toMatch(/^\/home\/j\/\.config\/(astra|aios)$/);
    expect(t.slice(1).map((p) => p.split('/').at(-1))).toEqual(['aios.db', 'apps', 'chromium']);
  });
});
