/**
 * SG1: linking Signal from the setup window. `signal-cli link -n Astra` prints a
 * sgnl://linkdevice link, which the window shows as a QR code for the phone to scan (Signal →
 * Settings → Linked devices). signal-cli waits until the phone has scanned it and then exits;
 * the new account's number is read from what it printed or, failing that, from
 * `listAccounts` before and after. Checked 2026-11-15 against signal-cli's wiki page
 * "Linking other devices (Provisioning)" and signal-cli(1), v0.14.9.
 *
 * Runs without a shell, with code's arguments only. The link is never logged or stored; the
 * window only gets the QR picture while it is waiting.
 */
import { spawn } from 'node:child_process';
import { SIGNAL_NUMBER } from '@aios/shared';
import qrcode from 'qrcode-generator';

export const LINK_PREFIX = 'sgnl://linkdevice?';
/** The device name the phone shows under Linked devices. */
export const DEVICE_NAME = 'Astra';
/** The link is only good for a short while; after this the window offers a new one. */
const LINK_TIMEOUT_MS = 3 * 60_000;

export type LinkState =
  | { state: 'idle' }
  | { state: 'waiting'; qr: string }
  | { state: 'linked'; number: string }
  | { state: 'failed'; message: string };

export interface LinkRunner {
  /** Starts `signal-cli link`; calls onLine for each line it prints and onExit when it ends. */
  link(command: string, onLine: (line: string) => void, onExit: (code: number | null) => void): { kill(): void };
  /** The accounts signal-cli knows (its listAccounts output, as text). */
  listAccounts(command: string): Promise<string>;
}

export const realLinkRunner: LinkRunner = {
  link(command, onLine, onExit) {
    const child = spawn(command, ['link', '-n', DEVICE_NAME], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C.UTF-8' } });
    let buf = '';
    const read = (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 64 * 1024) buf = '';
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', () => onExit(127));
    child.once('exit', (code) => {
      if (buf) onLine(buf);
      onExit(code);
    });
    return { kill: () => void child.kill('SIGTERM') };
  },
  listAccounts(command) {
    return new Promise((resolve) => {
      const child = spawn(command, ['listAccounts'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
      child.once('error', () => resolve(''));
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(out.slice(0, 64 * 1024));
      });
    });
  },
};

/** Phone numbers in some signal-cli output. */
export function numbersIn(text: string): string[] {
  return [...new Set((text.match(/\+[1-9]\d{6,14}/g) ?? []).filter((n) => SIGNAL_NUMBER.test(n)))];
}

/** The link as a QR code picture the window can show (an SVG data URL). */
export function qrDataUrl(link: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(link, 'Byte');
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export class SignalLinker {
  private current: LinkState = { state: 'idle' };
  private proc: { kill(): void } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: () => string | null,
    private readonly runner: LinkRunner = realLinkRunner,
  ) {}

  get status(): LinkState {
    return this.current;
  }

  /** Starts linking (again). Only one link runs at a time. */
  async start(): Promise<LinkState> {
    const command = this.command();
    if (!command) return (this.current = { state: 'failed', message: "signal-cli isn't installed. Install Astra's Signal add-on (the signal-cli package), then open this step again." });
    this.cancel();
    const before = numbersIn(await this.runner.listAccounts(command));
    let printed = '';
    let gotLink = false;
    this.current = { state: 'idle' };
    const started = new Promise<void>((resolve) => {
      const proc = this.runner.link(
        command,
        (line) => {
          const t = line.trim();
          if (!gotLink && t.startsWith(LINK_PREFIX) && t.length < 2000) {
            gotLink = true;
            this.current = { state: 'waiting', qr: qrDataUrl(t) };
            resolve();
            return;
          }
          // Not the link: keep it to find the number in, never to show.
          if (printed.length < 16 * 1024) printed += `${line}\n`;
        },
        (code) => {
          if (this.proc !== proc) return;
          this.proc = null;
          if (this.timer) clearTimeout(this.timer);
          void this.finished(command, code, printed, before).then(resolve);
        },
      );
      this.proc = proc;
      this.timer = setTimeout(() => {
        this.cancel();
        this.current = { state: 'failed', message: 'The code ran out before the phone scanned it. Press Link again for a new one.' };
        resolve();
      }, LINK_TIMEOUT_MS);
      this.timer.unref?.();
    });
    await started;
    return this.current;
  }

  private async finished(command: string, code: number | null, printed: string, before: string[]): Promise<void> {
    if (code !== 0) {
      this.current = { state: 'failed', message: code === 127 ? "signal-cli couldn't start. Check that the Signal add-on is installed." : "Linking didn't finish. Press Link again and scan the new code." };
      return;
    }
    let number = numbersIn(printed)[0];
    if (!number) {
      const after = numbersIn(await this.runner.listAccounts(command));
      const fresh = after.filter((n) => !before.includes(n));
      number = fresh.length === 1 ? fresh[0] : after.length === 1 ? after[0] : undefined;
    }
    this.current = number ? { state: 'linked', number } : { state: 'failed', message: "The phone linked, but Astra couldn't tell which number it was. Run astra settings again." };
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    this.proc = null;
    p?.kill();
    if (this.current.state === 'waiting') this.current = { state: 'idle' };
  }
}
