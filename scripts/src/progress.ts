/**
 * The quiet installer screen for `astra update` and `astra addons`: a short list of steps, a
 * progress bar and plain words, like a Mac or Windows installer. What the commands print (git,
 * makepkg, pacman, cmake, curl) goes to a log file instead of the screen; it shows only when the
 * person presses d (or runs with --details), and its last lines show when a step fails, with the
 * log's path. Password prompts (sudo -v) still talk to the person directly, never through here,
 * so the password is never in the log.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '@aios/core';

export interface StepDef {
  label: string;
  /** About how long it takes, in seconds: the bar's share for it and how fast it fills. */
  seconds?: number;
}

/** Where the screen goes; process.stdout in real use, a pretend one in tests. */
export interface Term {
  isTTY: boolean;
  columns: number;
  write: (s: string) => void;
}

export interface ViewState {
  title: string;
  steps: StepDef[];
  /** The step running now; steps.length when all are done. */
  current: number;
  failed: boolean;
  /** Milliseconds since the current step started. */
  stepElapsed: number;
  frame: number;
  details: boolean;
  keys: boolean;
  color: boolean;
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TAIL = 15;
const KEEP_LINES = 400;
const KEEP_LOGS = 10;

/** How full the bar is, 0..1. The running step fills toward 95 % of its share as time passes. */
export function fraction(steps: StepDef[], current: number, stepElapsed: number): number {
  const w = steps.map((s) => Math.max(1, s.seconds ?? 10));
  const total = w.reduce((a, b) => a + b, 0);
  if (current >= steps.length) return 1;
  const done = w.slice(0, current).reduce((a, b) => a + b, 0);
  const share = w[current] ?? 0;
  const ease = Math.min(0.95, 1 - Math.exp(-stepElapsed / 1000 / share));
  return (done + share * ease) / total;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The block of lines under the title. Pure, so the test reads it. */
export function view(st: ViewState, width: number): string[] {
  const c = (code: string, s: string) => (st.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = ['', `  ${c('1', st.title)}`, ''];
  st.steps.forEach((s, i) => {
    if (i < st.current) lines.push(`  ${c('32', '✓')} ${s.label}`);
    else if (i === st.current && st.failed) lines.push(`  ${c('31', '✗')} ${s.label}`);
    else if (i === st.current) lines.push(`  ${c('36', SPIN[st.frame % SPIN.length]!)} ${c('1', s.label)}  ${c('2', clock(st.stepElapsed))}`);
    else lines.push(`  ${c('2', '○')} ${c('2', s.label)}`);
  });
  const barWidth = Math.max(10, Math.min(40, width - 12));
  const f = fraction(st.steps, st.current, st.stepElapsed);
  const filled = Math.round(f * barWidth);
  lines.push('', `  ${c(st.failed ? '31' : '36', '█'.repeat(filled))}${c('2', '░'.repeat(barWidth - filled))}  ${Math.round(f * 100)}%`);
  if (st.keys && st.current < st.steps.length && !st.failed) lines.push('', `  ${c('2', st.details ? 'Press d to hide the details' : 'Press d to show the details')}`);
  return lines;
}

/** One line of a command's output as plain text: no colors, cursor moves or carriage-return redraws. */
export function plainLine(raw: string): string {
  const last = raw.split('\r').filter((p) => p.length).at(-1) ?? '';
  return last
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, '')
    .trimEnd();
}

const fit = (s: string, width: number) => {
  // Counted without color codes, so a colored line is cut at the same place as a plain one.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  return plain.length < width ? s : `${plain.slice(0, Math.max(1, width - 2))}…`;
};

/** The path with the home folder as ~, shorter to read. */
export function tilde(path: string, home = homedir()): string {
  return home.length > 1 && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A new log file in Astra's data folder (logs/), keeping the newest few of each kind. */
export function newLogPath(kind: string, dir = join(dataDir(), 'logs'), now = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '');
  const old = readdirSync(dir).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.log')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) rmSync(join(dir, f), { force: true });
  return join(dir, `${kind}-${stamp}.log`);
}

export interface ProgressOptions {
  title: string;
  steps: StepDef[];
  logPath: string;
  /** Start with the details showing (--details). */
  details?: boolean;
  term?: Term;
  input?: NodeJS.ReadStream;
  now?: () => number;
  color?: boolean;
}

export class Progress {
  private current = -1;
  private failed = false;
  private stepStart: number;
  private frame = 0;
  private drawn = 0;
  private details: boolean;
  private timer: NodeJS.Timeout | undefined;
  private readonly fd: number;
  private readonly recent: string[] = [];
  private readonly outcome: string[] = [];
  private child: ReturnType<typeof spawn> | undefined;
  private readonly term: Term;
  private readonly live: boolean;
  private readonly keys: boolean;
  private readonly now: () => number;
  private readonly color: boolean;
  private readonly onKey = (b: Buffer) => this.key(b.toString('utf8'));

  constructor(private readonly o: ProgressOptions) {
    this.term = o.term ?? { isTTY: Boolean(process.stdout.isTTY), columns: process.stdout.columns || 80, write: (s) => void process.stdout.write(s) };
    this.live = this.term.isTTY;
    this.keys = this.live && Boolean(o.input?.isTTY);
    this.now = o.now ?? Date.now;
    this.color = o.color ?? (this.live && !process.env.NO_COLOR);
    this.details = Boolean(o.details);
    this.stepStart = this.now();
    this.fd = openSync(o.logPath, 'a', 0o600);
    this.logLine(`${o.title} — ${new Date().toString()}`);
  }

  get logPath(): string {
    return this.o.logPath;
  }

  /** Shows the screen (and listens for d). */
  start(): void {
    if (this.live) {
      this.term.write('\x1b[?25l');
      this.timer = setInterval(() => {
        this.frame++;
        this.draw();
      }, 120);
      this.timer.unref();
      this.listen(true);
    } else {
      this.term.write(`${this.o.title}\n`);
    }
  }

  /** Marks step i as running (and the ones before it as done). */
  begin(i: number): void {
    this.current = i;
    this.stepStart = this.now();
    const label = this.o.steps[i]?.label ?? '';
    this.logLine(`\n== ${label} ==`);
    if (this.live) this.draw();
    else this.term.write(`• ${label}…\n`);
  }

  /** A message for the person; shown under the steps when they finish. */
  note(line: string): void {
    this.logLine(line);
    this.outcome.push(line);
  }

  /** Runs a command with its output in the log (and on screen only while details show). */
  run(cmd: string, args: string[], cwd?: string): Promise<number> {
    this.logLine(`$ ${[cmd, ...args].join(' ')}${cwd ? `   (in ${cwd})` : ''}`);
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      } catch (e) {
        this.logLine(`could not start ${cmd}: ${(e as Error).message}`);
        resolve(127);
        return;
      }
      this.child = child;
      let partial = '';
      const take = (d: Buffer) => {
        writeSync(this.fd, d);
        const parts = (partial + d.toString('utf8')).split('\n');
        partial = parts.pop() ?? '';
        for (const p of parts) this.output(plainLine(p));
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.once('error', (e) => {
        this.logLine(`could not start ${cmd}: ${e.message}`);
        this.child = undefined;
        resolve(127);
      });
      child.once('close', (code) => {
        if (partial) this.output(plainLine(partial));
        this.logLine(`(exit ${code ?? 'signal'})`);
        this.child = undefined;
        resolve(code ?? 1);
      });
    });
  }

  /** Runs a command that talks to the person (sudo asking for the password), with the screen paused. */
  ask(say: string, cmd: string, args: string[]): number {
    this.logLine(`$ ${[cmd, ...args].join(' ')}   (asks the person; not logged)`);
    this.listen(false);
    this.clear();
    if (this.live) this.term.write('\x1b[?25h');
    this.term.write(`\n  ${say}\n`);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (this.live) {
      this.term.write('\x1b[?25l');
      this.listen(true);
    }
    // The prompt's lines stay above; the steps are drawn again under them.
    this.draw();
    return r.error ? 127 : (r.status ?? 1);
  }

  /** The final screen: every step ticked, or the one that failed, then the messages and (on failure) the log's last lines. */
  end(ok: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.listen(false);
    if (ok) this.current = this.o.steps.length;
    else {
      this.failed = true;
      if (this.current < 0) this.current = 0;
    }
    const c = (code: string, s: string) => (this.color ? `\x1b[${code}m${s}\x1b[0m` : s);
    if (this.live) {
      this.draw();
      this.term.write('\x1b[?25h');
    } else if (this.current < this.o.steps.length) {
      this.term.write(`✗ ${this.o.steps[this.current]?.label ?? ''}\n`);
    }
    this.term.write('\n');
    for (const l of this.outcome) this.term.write(`  ${l}\n`);
    if (!ok && this.recent.length && !this.details) {
      this.term.write(`\n  ${c('1', 'What happened (the last lines of the log):')}\n`);
      for (const l of this.recent.slice(-TAIL)) this.term.write(`  ${c('2', `│ ${fit(l, this.term.columns - 6)}`)}\n`);
    }
    this.term.write(`\n  ${c('2', `The full log: ${tilde(this.o.logPath)}`)}\n`);
    this.logLine(ok ? '\nFinished.' : '\nStopped.');
    closeSync(this.fd);
  }

  private output(line: string): void {
    if (!line) return;
    this.recent.push(line);
    if (this.recent.length > KEEP_LINES) this.recent.shift();
    if (this.details) this.above(line);
  }

  /** Prints a details line above the steps. */
  private above(line: string): void {
    const c = this.color ? `\x1b[2m${fit(line, this.term.columns - 3)}\x1b[0m` : line;
    if (!this.live) {
      this.term.write(`  ${c}\n`);
      return;
    }
    this.clear();
    this.term.write(`  ${c}\n`);
    this.draw();
  }

  private key(k: string): void {
    if (k === '\x03') {
      // Ctrl+C in raw mode: stop the running command, put the terminal back and leave.
      this.child?.kill('SIGTERM');
      this.listen(false);
      this.term.write('\x1b[?25h\n');
      this.logLine('Stopped with Ctrl+C.');
      process.exit(130);
    }
    if (k !== 'd' && k !== 'D') return;
    this.details = !this.details;
    if (this.details) for (const l of this.recent.slice(-TAIL)) this.above(l);
    else this.draw();
  }

  private listen(on: boolean): void {
    const input = this.o.input;
    if (!this.keys || !input) return;
    if (on) {
      input.setRawMode(true);
      input.on('data', this.onKey);
      input.resume();
    } else {
      input.off('data', this.onKey);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    }
  }

  private clear(): void {
    if (this.live && this.drawn > 0) this.term.write(`\x1b[${this.drawn}F\x1b[0J`);
    this.drawn = 0;
  }

  private draw(): void {
    if (!this.live || this.current < 0) return;
    const lines = view(
      { title: this.o.title, steps: this.o.steps, current: this.current, failed: this.failed, stepElapsed: this.now() - this.stepStart, frame: this.frame, details: this.details, keys: this.keys, color: this.color },
      this.term.columns,
    ).map((l) => fit(l, this.term.columns));
    this.clear();
    this.term.write(lines.map((l) => `${l}\n`).join(''));
    this.drawn = lines.length;
  }

  private logLine(line: string): void {
    try {
      writeSync(this.fd, `${line}\n`);
    } catch {
      // The log is a convenience; a full disk shouldn't stop an update.
    }
  }
}
