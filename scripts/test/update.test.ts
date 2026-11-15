/** U1: `astra update` runs its steps in order, stops at the first that fails, and --check changes nothing. Pretend commands only. */
import { describe, expect, it } from 'vitest';
import type { UpdateCheck } from '@aios/core';
import { type UpdateSteps, noNewPrivileges, update } from '../src/update.js';

const available: UpdateCheck = { state: 'available', from: 'a'.repeat(40), to: 'b'.repeat(40), branch: 'origin/main', behind: 2, changes: ['Setup in a window', 'Voice'] };

function steps(check: UpdateCheck, fail: string | null = null) {
  const ran: string[] = [];
  const log: string[] = [];
  const s: UpdateSteps = {
    check: async () => check,
    run: (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      ran.push(line);
      return fail && line.includes(fail) ? 1 : 0;
    },
    built: () => ['PKGBUILD', 'astra-0.2.0.tar.gz', 'astra-0.2.0-1-x86_64.pkg.tar.zst'],
    serviceInstalled: () => true,
    log: (l) => log.push(l),
  };
  return { s, ran, log };
}

describe('astra update', () => {
  it('pulls, builds, installs with sudo and restarts the service', async () => {
    const t = steps(available);
    expect(await update('/home/j/astra-src', 'astra.service', t.s)).toBe(0);
    expect(t.ran).toEqual([
      'git -C /home/j/astra-src diff --quiet HEAD',
      'git -C /home/j/astra-src merge --ff-only @{u}',
      '/home/j/astra-src/packaging/arch/build.sh -s',
      'sudo pacman -U --noconfirm /home/j/astra-src/packaging/arch/out/astra-0.2.0-1-x86_64.pkg.tar.zst',
      'systemctl --user restart astra.service',
    ]);
    expect(t.log.join('\n')).toContain('settings, keys and data are unchanged');
  });

  it('--check and an up-to-date install run nothing', async () => {
    const c = steps(available);
    expect(await update('/s', 'astra.service', c.s, { check: true })).toBe(0);
    expect(c.ran).toEqual([]);
    expect(c.log).toContain('  - Setup in a window');
    const cur = steps({ state: 'current', commit: 'c'.repeat(40), branch: 'origin/main' });
    expect(await update('/s', 'astra.service', cur.s)).toBe(0);
    expect(cur.ran).toEqual([]);
  });

  it('stops at the first step that fails, before installing anything', async () => {
    for (const [fail, said] of [['diff', 'aren’t committed'], ['merge', 'commits of its own'], ['build.sh', 'build failed'], ['pacman', 'Installing failed']] as const) {
      const t = steps(available, fail);
      expect(await update('/s', 'astra.service', t.s)).toBe(1);
      expect(t.log.join('\n')).toMatch(new RegExp(said.replace('’', '.')));
      expect(t.ran.some((l) => l.startsWith('systemctl'))).toBe(false);
      if (fail !== 'pacman') expect(t.ran.some((l) => l.startsWith('sudo'))).toBe(false);
    }
  });

  it('notices a terminal where sudo can’t ask for the password', () => {
    expect(noNewPrivileges('Name:\tnode\nNoNewPrivs:\t1\nSeccomp:\t0\n')).toBe(true);
    expect(noNewPrivileges('Name:\tnode\nNoNewPrivs:\t0\n')).toBe(false);
    expect(noNewPrivileges('')).toBe(false);
  });
});
