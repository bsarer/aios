/** The quiet installer screen (progress.ts): commands' output goes to the log, not the screen, unless asked for or a step fails. Temporary folders only. */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Catalog, install, readCatalog, whisperPaths } from '../src/addons.js';
import { Progress, type Term, fraction, newLogPath, plainLine, tilde, view } from '../src/progress.js';

const steps = [{ label: 'Getting the new version', seconds: 5 }, { label: 'Building the update', seconds: 180 }, { label: 'Installing it', seconds: 20 }];

function term(isTTY: boolean) {
  let out = '';
  const t: Term = { isTTY, columns: 80, write: (s) => void (out += s) };
  return { t, out: () => out };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'astra-progress-'));
const noisy = ['-c', 'echo "Compiling module 1 of 300"; printf "\\033[31mwarning: red\\033[0m\\n" >&2; echo "progress 10%\\rprogress 100%"; exit 3'];

describe('installer screen', () => {
  it('draws done, running and waiting steps with a bar', () => {
    const lines = view({ title: 'Updating Astra', steps, current: 1, failed: false, stepElapsed: 65_000, frame: 0, details: false, keys: true, color: false }, 80);
    const text = lines.join('\n');
    expect(text).toContain('✓ Getting the new version');
    expect(text).toMatch(/⠋ Building the update {2}1:05/);
    expect(text).toContain('○ Installing it');
    expect(text).toContain('Press d to show the details');
    expect(text).toMatch(/█+░+ {2}\d+%/);
    expect(view({ title: 'x', steps, current: 1, failed: true, stepElapsed: 0, frame: 0, details: false, keys: true, color: false }, 80).join('\n')).toContain('✗ Building the update');
  });

  it('fills the bar by each step’s share and never reaches 100 % before the end', () => {
    expect(fraction(steps, 0, 0)).toBe(0);
    const mid = fraction(steps, 1, 60_000);
    expect(mid).toBeGreaterThan(fraction(steps, 1, 0));
    expect(fraction(steps, 1, 10_000_000)).toBeLessThan(fraction(steps, 2, 0) + 1e-9);
    expect(fraction(steps, 3, 0)).toBe(1);
  });

  it('shows output as plain text, without colors or redraws', () => {
    expect(plainLine('\x1b[1;32mok\x1b[0m done')).toBe('ok done');
    expect(plainLine('downloading 10%\rdownloading 100%')).toBe('downloading 100%');
    expect(plainLine('\x1b]0;title\x07text\x07')).toBe('text');
  });

  it('keeps what commands print in the log, off the screen, and shows its last lines when a step fails', async () => {
    const dir = tmp();
    for (const isTTY of [true, false]) {
      const s = term(isTTY);
      const log = join(dir, `run-${isTTY}.log`);
      const p = new Progress({ title: 'Updating Astra', steps, logPath: log, term: s.t, color: false });
      p.start();
      p.begin(0);
      expect(await p.run('sh', ['-c', 'echo fine; exit 0'])).toBe(0);
      p.begin(1);
      expect(await p.run('sh', noisy)).toBe(3);
      const before = s.out();
      expect(before).not.toContain('Compiling module');
      expect(before).not.toContain('fine');
      p.note('The build failed; the installed version is unchanged.');
      p.end(false);
      const after = s.out();
      expect(after).toContain('✗ Building the update');
      expect(after).toContain('The build failed; the installed version is unchanged.');
      expect(after).toContain('What happened (the last lines of the log):');
      expect(after).toContain('│ Compiling module 1 of 300');
      expect(after).toContain('│ warning: red');
      expect(after).not.toContain('\x1b[31m');
      expect(after).toContain(`The full log: ${tilde(log)}`);
      const saved = readFileSync(log, 'utf8');
      expect(saved).toContain('$ sh -c echo fine; exit 0');
      expect(saved).toContain('Compiling module 1 of 300');
      expect(saved).toContain('== Building the update ==');
    }
  });

  it('shows the output as it comes with --details, and no tail on success', async () => {
    const dir = tmp();
    const s = term(false);
    const p = new Progress({ title: 'Updating Astra', steps, logPath: join(dir, 'd.log'), term: s.t, details: true, color: false });
    p.start();
    p.begin(0);
    await p.run('sh', ['-c', 'echo "Compiling module 1 of 300"']);
    p.end(true);
    expect(s.out()).toContain('Compiling module 1 of 300');
    expect(s.out()).not.toContain('What happened');

    const quiet = term(true);
    const q = new Progress({ title: 'Updating Astra', steps, logPath: join(dir, 'q.log'), term: quiet.t, color: false });
    q.start();
    for (const i of [0, 1, 2]) {
      q.begin(i);
      await q.run('sh', ['-c', 'echo noisy']);
    }
    q.end(true);
    expect(quiet.out()).not.toContain('noisy');
    expect(quiet.out()).toContain('✓ Installing it');
    expect(quiet.out()).toContain('100%');
  });

  it('keeps the newest ten logs of a kind', () => {
    const dir = tmp();
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `update-2026-01-${String(i + 10).padStart(2, '0')}.log`), '');
    writeFileSync(join(dir, 'addons-2026-01-01.log'), '');
    const path = newLogPath('update', dir, new Date('2026-11-23T04:14:00Z'));
    expect(path).toBe(join(dir, 'update-2026-11-23-04-14-00.log'));
    const left = readdirSync(dir);
    expect(left.filter((f) => f.startsWith('update-'))).toHaveLength(9);
    expect(left).toContain('addons-2026-01-01.log');
    expect(left).not.toContain('update-2026-01-10.log');
    expect(tilde('/home/j/.local/share/astra/logs/u.log', '/home/j')).toBe('~/.local/share/astra/logs/u.log');
    expect(tilde('/tmp/u.log', '/home/j')).toBe('/tmp/u.log');
  });
});

describe('astra addons on the installer screen', () => {
  const c: Catalog = readCatalog();
  const home = mkdtempSync(join(tmpdir(), 'astra-addons-'));
  const w = whisperPaths(join(home, '.local', 'share', 'astra'), home);
  const noop = { finishVoice: async () => null, finishSignal: async () => null, waitForOllama: () => true };

  it('asks for the password once first, then runs sudo without asking, one screen line per step', async () => {
    const ran: string[] = [];
    const asked: string[] = [];
    const shown: string[][] = [];
    const begun: number[] = [];
    const code = await install(['voice', 'local'], c, {
      run: (cmd, args) => (ran.push([cmd, ...args].join(' ')), 0),
      ask: (_say, cmd, args) => (asked.push([cmd, ...args].join(' ')), 0),
      show: (s) => shown.push(s.map((x) => x.label)),
      begin: (i) => begun.push(i),
      log: () => {},
      ...noop,
    }, w, false);
    expect(code).toBe(0);
    expect(asked).toEqual(['sudo -v']);
    expect(ran.filter((l) => l.startsWith('sudo')).every((l) => l.startsWith('sudo -n '))).toBe(true);
    const labels = shown[0]!;
    expect(labels[0]).toMatch(/^Installing /);
    expect(labels).toContain('Building whisper.cpp (a few minutes)');
    expect(labels.at(-1)).toBe('Finishing');
    expect(labels.some((l) => l.includes('sudo') || l.endsWith('...'))).toBe(false);
    // Each step on the screen is begun in order; the build's two cmake runs share one line.
    expect(begun).toEqual([...begun].sort((a, b) => a - b));
    expect(new Set(begun).size).toBe(labels.length);
  });

  it('stops before anything runs when the password isn’t given', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const code = await install(['music'], c, { run: (cmd) => (ran.push(cmd), 0), ask: () => 1, log: (l) => log.push(l), ...noop }, w, false);
    expect(code).toBe(1);
    expect(ran).toEqual([]);
    expect(log.at(-1)).toContain('Without your password');
  });
});
