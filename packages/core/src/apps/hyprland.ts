/**
 * The little of Hyprland's IPC that S3 needs: list windows and monitors, run a dispatcher,
 * and hear windows open and close. Checked against Hyprland's source (Lua config,
 * src/config/lua/bindings and src/ipc) and Omarchy's quattro branch, October 2026:
 *
 * - `hyprctl -j clients` / `hyprctl -j monitors` print JSON; window addresses look like 0x55d0c1f4a2b0.
 * - With a Lua config, `hyprctl dispatch <expr>` evaluates `hl.dispatch(<expr>)` and prints
 *   "ok" or an error, with exit code 0 either way, so the text is what tells.
 * - The event socket, $XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock,
 *   sends lines like `openwindow>>55d0c1f4a2b0,1,firefox,Mozilla Firefox` and
 *   `closewindow>>55d0c1f4a2b0` (address without 0x).
 */
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { type Run, runCommand } from '../system/run.js';

export const HyprClient = z.looseObject({
  address: z.string().regex(/^0x[0-9a-f]+$/),
  class: z.string(),
  floating: z.boolean(),
  pinned: z.boolean(),
  /** 0 none, 1 maximized, 2 fullscreen. */
  fullscreen: z.number(),
  monitor: z.number(),
  workspace: z.looseObject({ name: z.string() }),
});
export type HyprClient = z.infer<typeof HyprClient>;

export const HyprMonitor = z.looseObject({
  id: z.number(),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
  transform: z.number(),
  focused: z.boolean(),
  activeWorkspace: z.looseObject({ id: z.number() }),
  /** Space taken by bars: left, top, right, bottom. */
  reserved: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type HyprMonitor = z.infer<typeof HyprMonitor>;

export type HyprEvent = { name: 'openwindow'; address: string; className: string } | { name: 'closewindow'; address: string };

export interface HyprIpc {
  clients(): Promise<HyprClient[]>;
  monitors(): Promise<HyprMonitor[]>;
  /** Runs one `hl.dsp.*` expression; throws with Hyprland's answer when it isn't "ok". */
  dispatch(expr: string): Promise<void>;
  /** Window events until the returned function is called; reconnects if Hyprland restarts. */
  events(on: (ev: HyprEvent) => void): () => void;
}

/** One event-socket line, or null for events S3 ignores. Addresses come back with 0x. */
export function parseHyprEvent(line: string): HyprEvent | null {
  const at = line.indexOf('>>');
  if (at < 0) return null;
  const name = line.slice(0, at);
  const data = line.slice(at + 2);
  if (name === 'openwindow') {
    const [addr, , className] = data.split(',');
    return addr && /^[0-9a-f]+$/.test(addr) ? { name, address: `0x${addr}`, className: className ?? '' } : null;
  }
  if (name === 'closewindow') return /^[0-9a-f]+$/.test(data) ? { name, address: `0x${data}` } : null;
  return null;
}

class HyprlandIpc implements HyprIpc {
  constructor(
    private readonly run: Run,
    private readonly socketPath: string,
  ) {}

  private async json<T>(what: 'clients' | 'monitors', schema: z.ZodType<T>): Promise<T[]> {
    const r = await this.run('hyprctl', ['-j', what], { timeoutMs: 3000 });
    if (r.code !== 0) throw new Error(`hyprctl ${what} failed`);
    return z.array(schema).parse(JSON.parse(r.stdout));
  }

  clients(): Promise<HyprClient[]> {
    return this.json('clients', HyprClient);
  }

  monitors(): Promise<HyprMonitor[]> {
    return this.json('monitors', HyprMonitor);
  }

  async dispatch(expr: string): Promise<void> {
    const r = await this.run('hyprctl', ['dispatch', expr], { timeoutMs: 3000 });
    const out = r.stdout.trim();
    if (r.code !== 0 || !out.startsWith('ok')) throw new Error(`Hyprland refused ${expr.split('(')[0]}: ${out.slice(0, 200) || `exit code ${r.code}`}`);
  }

  events(on: (ev: HyprEvent) => void): () => void {
    let stopped = false;
    let socket: Socket | null = null;
    let retry: NodeJS.Timeout | null = null;
    let delay = 500;
    const connect = () => {
      if (stopped) return;
      let buf = '';
      socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      socket.on('connect', () => (delay = 500));
      socket.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const ev = parseHyprEvent(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (ev) on(ev);
        }
        if (buf.length > 64 * 1024) buf = '';
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        if (stopped) return;
        retry = setTimeout(connect, delay);
        retry.unref();
        delay = Math.min(delay * 2, 30_000);
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.destroy();
    };
  }
}

/** Null when aios-core is not running inside a Hyprland session. */
export function hyprlandIpc(env: NodeJS.ProcessEnv = process.env, run: Run = runCommand): HyprIpc | null {
  const sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = env.XDG_RUNTIME_DIR;
  if (!sig || !runtime || /[/\\]|\.\./.test(sig)) return null;
  return new HyprlandIpc(run, join(runtime, 'hypr', sig, '.socket2.sock'));
}
