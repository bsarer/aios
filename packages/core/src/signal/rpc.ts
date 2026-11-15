/**
 * SG1: signal-cli's JSON-RPC mode (`signal-cli -a ACCOUNT jsonRpc`), one long-running child
 * started without a shell. Requests go in on stdin, one JSON object per line; answers and
 * `receive` notifications come back on stdout. Checked 2026-11-15 against signal-cli's
 * man page signal-cli-jsonrpc(5) and the "JSON RPC service" wiki page (v0.14.9).
 *
 * Code decides every argument: the account number (checked by the config schema and again
 * here), then `jsonRpc`. The only methods called are in SIGNAL_METHODS. If signal-cli stops,
 * it is started again, waiting longer each time.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SIGNAL_NUMBER } from '@aios/shared';
import { z } from 'zod';

/** The JSON-RPC methods Astra calls. Anything else is refused before it reaches signal-cli. */
export const SIGNAL_METHODS = ['send', 'listContacts', 'listGroups'] as const;
export type SignalMethod = (typeof SIGNAL_METHODS)[number];

export type SignalState = 'starting' | 'running' | 'missing' | 'stopped' | 'error';

export class SignalError extends Error {
  constructor(
    readonly kind: 'missing' | 'not_running' | 'timeout' | 'refused' | 'rpc',
    message: string,
  ) {
    super(message);
    this.name = 'SignalError';
  }
}

/** The part of a child process the client uses, so tests can hand in a pretend one. */
export type SpawnSignal = (command: string, args: string[], env: NodeJS.ProcessEnv) => Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'once'>;

const realSpawn: SpawnSignal = (command, args, env) => spawn(command, args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });

/** What signal-cli needs from the environment, and nothing else (no keys, no tokens). */
export function signalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'JAVA_HOME', 'TMPDIR'];
  const out: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  for (const k of keep) if (env[k]) out[k] = env[k];
  return out;
}

/** signal-cli's arguments (exported for tests). */
export function rpcArgs(account: string): string[] {
  if (!SIGNAL_NUMBER.test(account)) throw new SignalError('refused', 'internal: bad [signal] account');
  return ['-a', account, 'jsonRpc'];
}

const RpcError = z.looseObject({ code: z.number(), message: z.string().max(2000) });
const Response = z.looseObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: RpcError.optional() });
const Notification = z.looseObject({ jsonrpc: z.literal('2.0'), method: z.string().max(100), params: z.unknown().optional() });

const MAX_LINE = 1024 * 1024;

export interface SignalRpcOptions {
  command: string;
  account: string;
  /** Each `receive` notification's params, as signal-cli sent them (checked by envelope.ts). */
  onReceive: (params: unknown) => void;
  onState?: (state: SignalState, detail?: string) => void;
  spawn?: SpawnSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** First wait before starting again after signal-cli stops; doubles up to five minutes. */
  restartMs?: number;
}

export class SignalRpc {
  private child: ReturnType<SpawnSignal> | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stopped = true;
  private backoff: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  state: SignalState = 'stopped';
  detail = '';

  constructor(private readonly o: SignalRpcOptions) {
    rpcArgs(o.account);
    this.backoff = o.restartMs ?? 5000;
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
    this.fail(new SignalError('not_running', 'Signal stopped'));
    this.setState('stopped');
  }

  private setState(s: SignalState, detail = ''): void {
    this.state = s;
    this.detail = detail;
    this.o.onState?.(s, detail);
  }

  private fail(err: Error): void {
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(err);
      this.waiting.delete(id);
    }
  }

  private launch(): void {
    if (this.stopped) return;
    this.setState('starting');
    this.stderrTail = '';
    let child: ReturnType<SpawnSignal>;
    try {
      child = (this.o.spawn ?? realSpawn)(this.o.command, rpcArgs(this.o.account), this.o.env ?? signalEnv());
    } catch (err) {
      this.setState('error', (err as Error).message);
      return this.scheduleRestart();
    }
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-500);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on('line', (line) => this.onLine(line));
    let ended = false;
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      this.child = null;
      this.fail(new SignalError('not_running', 'signal-cli is not running'));
      if (err.code === 'ENOENT') {
        // Not installed: wait for the user to install it, without trying every few seconds.
        this.setState('missing', `${this.o.command} not found`);
        this.backoff = 5 * 60_000;
      } else this.setState('error', err.message);
      this.scheduleRestart();
    });
    child.once('exit', (code: number | null) => {
      if (ended) return;
      ended = true;
      this.child = null;
      this.fail(new SignalError('not_running', 'signal-cli stopped'));
      if (this.stopped) return;
      this.setState('error', `signal-cli stopped (exit ${code ?? 'signal'})${this.stderrTail ? `: ${lastLine(this.stderrTail)}` : ''}`);
      this.scheduleRestart();
    });
    // There is no "ready" line; a child that started is taken as running until it stops.
    this.setState('running');
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, wait);
    this.restartTimer.unref?.();
  }

  private onLine(line: string): void {
    if (!line.trim() || line.length > MAX_LINE) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const res = Response.safeParse(raw);
    if (res.success && typeof res.data.id === 'number' && this.waiting.has(res.data.id)) {
      const w = this.waiting.get(res.data.id)!;
      this.waiting.delete(res.data.id);
      clearTimeout(w.timer);
      // A good answer resets the wait before the next restart.
      this.backoff = this.o.restartMs ?? 5000;
      if (res.data.error) w.reject(new SignalError('rpc', res.data.error.message.slice(0, 300)));
      else w.resolve(res.data.result);
      return;
    }
    const note = Notification.safeParse(raw);
    if (note.success && note.data.method === 'receive') this.o.onReceive(note.data.params);
  }

  /** One JSON-RPC call; only methods in SIGNAL_METHODS. */
  request(method: SignalMethod, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!(SIGNAL_METHODS as readonly string[]).includes(method)) return Promise.reject(new SignalError('refused', `${String(method)} is not allowed`));
    const child = this.child;
    if (!child || this.state !== 'running') {
      return Promise.reject(new SignalError(this.state === 'missing' ? 'missing' : 'not_running', this.state === 'missing' ? `${this.o.command} is not installed` : 'Signal is not connected right now'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new SignalError('timeout', 'Signal took too long to answer'));
      }, this.o.timeoutMs ?? 20_000);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.waiting.delete(id)) return;
        clearTimeout(timer);
        reject(new SignalError('timeout', 'stopped'));
      }, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`);
    });
  }
}

function lastLine(s: string): string {
  const l = s.trim().split('\n').at(-1) ?? '';
  return l.replace(/\+\d{6,15}/g, '+…').slice(0, 200);
}
