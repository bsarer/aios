/**
 * WordCraft's and GridCraft's command-line tools (D1), run one command at a time: no
 * shell, a fixed subcommand, a timeout and a cap on output. Only paths that DocFiles
 * resolved reach them, and they are always absolute, so a path can never read as an
 * option. Commands as documented on 2026-10-31:
 *   wordcraft-cli text <file> · wordcraft-cli convert <in.docx> <out.pdf>   (README, docs/mcp.md)
 *   gridcraft-cli info <file> --json · cat <file> [--range R] [--sheet S] --csv
 *   gridcraft-cli eval <formula> --in <file> [--sheet S] --json              (docs/cli.md)
 * Both are alpha software; output formats that docs don't pin down are parsed leniently.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { parseCsv } from './csv.js';
import type { DocCommand } from './recipes.js';

export class DocToolError extends Error {
  constructor(
    readonly reason: 'missing' | 'timeout' | 'failed' | 'too_large',
    message: string,
    /** What the tool printed before it failed, for tools that report through a failing exit (`check`). */
    readonly stdout?: string,
  ) {
    super(message);
    this.name = 'DocToolError';
  }
}

const MAX_STDOUT = 4 * 1024 * 1024;

export interface RunCliOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

/** Run one CLI command and return its stdout. A non-zero exit is an error carrying stderr's first line. */
export function runCli(command: string, args: string[], label: string, o: RunCliOptions): Promise<string> {
  const max = o.maxBytes ?? MAX_STDOUT;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // No control-channel keys or other secrets from the service's environment.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', WORDCRAFT_NO_PREFS: '1' },
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() => reject(new DocToolError('failed', `${label} was stopped`)));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new DocToolError('timeout', `${label} took too long`)));
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > max) {
        child.kill('SIGKILL');
        finish(() => reject(new DocToolError('too_large', `${label} gave more output than can be handled`)));
        return;
      }
      out.push(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (err.length < 4000) err += d;
    });
    child.once('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === 'ENOENT'
            ? new DocToolError('missing', `${command} is not installed (or not on the service's PATH; set its full path in config [docs])`)
            : new DocToolError('failed', `${command} could not start: ${e.message}`),
        ),
      ),
    );
    child.once('close', (code) =>
      finish(() => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else {
          const why = err.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300);
          reject(new DocToolError('failed', `${label} failed${why ? `: ${why}` : ` (exit code ${code ?? 'unknown'})`}`, Buffer.concat(out).toString('utf8')));
        }
      }),
    );
  });
}

/** What `gridcraft-cli check --json` says about saving a workbook again (schema gridcraft-check/1). */
const CheckJson = z.looseObject({
  files: z.array(z.looseObject({ roundTrip: z.looseObject({ error: z.string().nullable().optional(), differing: z.array(z.string()).optional() }).optional() })).optional(),
});

/** Sheet names from `info --json`. The schema isn't documented, so a few likely shapes are accepted. */
const InfoJson = z.looseObject({
  sheets: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).optional(),
});

export interface SheetGrid {
  rows: string[][];
}

export interface DocEngineOptions {
  wordCli: string;
  sheetCli: string;
  timeoutMs: number;
  run?: typeof runCli;
}

const absolute = (p: string) => {
  if (!isAbsolute(p)) throw new DocToolError('failed', 'internal: document paths must be absolute');
  return p;
};

/** A sheet name as an argument: never one that could read as an option. */
const sheetArg = (s: string) => {
  if (s.startsWith('-') || /[\u0000-\u001f]/.test(s)) throw new DocToolError('failed', 'that sheet name cannot be used');
  return s;
};

export class DocEngine {
  private readonly run: typeof runCli;

  constructor(private readonly o: DocEngineOptions) {
    this.run = o.run ?? runCli;
  }

  /** Plain text of a Word file. */
  wordText(path: string, signal?: AbortSignal): Promise<string> {
    return this.run(this.o.wordCli, ['text', absolute(path)], 'WordCraft', { timeoutMs: this.o.timeoutMs, ...(signal ? { signal } : {}) });
  }

  /** A Word file as PDF bytes, converted in a private temporary folder that is removed afterwards. */
  async wordPdf(path: string, signal?: AbortSignal): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'aios-doc-'));
    try {
      const out = join(dir, 'document.pdf');
      await this.run(this.o.wordCli, ['convert', absolute(path), out], 'WordCraft', { timeoutMs: this.o.timeoutMs * 3, ...(signal ? { signal } : {}) });
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The sheet names of a workbook, in order; empty when GridCraft's answer can't be read. */
  async sheetNames(path: string, signal?: AbortSignal): Promise<string[]> {
    const out = await this.run(this.o.sheetCli, ['info', absolute(path), '--json'], 'GridCraft', { timeoutMs: this.o.timeoutMs, ...(signal ? { signal } : {}) });
    let raw: unknown;
    try {
      raw = JSON.parse(out);
    } catch {
      return [];
    }
    const info = InfoJson.safeParse(raw);
    return info.success ? (info.data.sheets ?? []).map((s) => (typeof s === 'string' ? s : s.name)) : [];
  }

  /** Displayed values of a range (A1:F20), as rows of cells. */
  async sheetRange(path: string, o: { range: string; sheet?: string | undefined; signal?: AbortSignal | undefined }): Promise<SheetGrid> {
    const args = ['cat', absolute(path), '--range', o.range, ...(o.sheet ? ['--sheet', sheetArg(o.sheet)] : []), '--csv'];
    const out = await this.run(this.o.sheetCli, args, 'GridCraft', { timeoutMs: this.o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
    return { rows: parseCsv(out) };
  }

  /** A formula's result over the workbook, as GridCraft prints it with --json. */
  async evaluate(path: string, formula: string, o: { sheet?: string | undefined; signal?: AbortSignal | undefined } = {}): Promise<string> {
    const args = ['eval', formula, '--in', absolute(path), ...(o.sheet ? ['--sheet', sheetArg(o.sheet)] : []), '--json'];
    const out = await this.run(this.o.sheetCli, args, 'GridCraft', { timeoutMs: this.o.timeoutMs, maxBytes: 64 * 1024, ...(o.signal ? { signal: o.signal } : {}) });
    return out.trim();
  }

  /**
   * D2: run commands on a Word file (or a new blank one) and save the result to `out`, in one
   * `wordcraft-cli run --script` (docs/mcp.md: a failing command stops the run and nothing is
   * saved). The script lives in a private temporary folder; every path in it is absolute.
   */
  async applyWord(source: string | null, commands: DocCommand[], out: string, signal?: AbortSignal): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'aios-edit-'));
    try {
      const script = join(dir, 'job.json');
      // Without `file` the run starts on a blank document (docs/mcp.md).
      await writeFile(script, JSON.stringify({ ...(source ? { file: absolute(source) } : {}), commands, save: [absolute(out)] }), { mode: 0o600 });
      await this.run(this.o.wordCli, ['run', '--script', script], 'WordCraft', { timeoutMs: this.o.timeoutMs * 3, ...(signal ? { signal } : {}) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** D2: the same for a workbook, with `gridcraft-cli run [--in] --script <steps.jsonl> --out` (docs/cli.md). */
  async applySheet(source: string | null, sheet: string | undefined, commands: DocCommand[], out: string, signal?: AbortSignal): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'aios-edit-'));
    try {
      const script = join(dir, 'steps.jsonl');
      // `run --sheet` only picks the sheet to print, so the sheet is activated by the first step.
      const steps = sheet ? [{ command: 'sheet.activate', params: { sheet } }, ...commands] : commands;
      await writeFile(script, steps.map((c) => JSON.stringify(c)).join('\n') + '\n', { mode: 0o600 });
      const args = ['run', ...(source ? ['--in', absolute(source)] : []), '--script', script, '--out', absolute(out), '--quiet'];
      await this.run(this.o.sheetCli, args, 'GridCraft', { timeoutMs: this.o.timeoutMs * 3, ...(signal ? { signal } : {}) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * D2: what GridCraft would lose saving this workbook again (`check --json` round trip), e.g.
   * ["charts", "pivots"]. Empty when nothing, null when it can't tell. `check` exits 1 when it
   * finds a difference, so that is read from its output, not its exit code.
   */
  async sheetRoundTrip(path: string, signal?: AbortSignal): Promise<string[] | null> {
    let out: string;
    try {
      out = await this.run(this.o.sheetCli, ['check', absolute(path), '--json', '--max-report', '1'], 'GridCraft', { timeoutMs: this.o.timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
      if (!(err instanceof DocToolError) || err.reason !== 'failed') return null;
      out = err.stdout ?? '';
    }
    try {
      const parsed = CheckJson.safeParse(JSON.parse(out));
      const rt = parsed.success ? parsed.data.files?.[0]?.roundTrip : undefined;
      if (!rt) return null;
      return rt.error ? ['the whole file'] : (rt.differing ?? []);
    } catch {
      return null;
    }
  }
}
