/**
 * Runs the system commands behind S1, and nothing else. Every command is a fixed program
 * name from SYSTEM_COMMANDS, started directly (never through a shell) with an argument
 * list, a timeout and LC_ALL=C so output parses the same in every language.
 *
 * Omarchy 4 installs its commands as /usr/bin/omarchy-*, so PATH finds them under
 * systemd --user too.
 */
import { spawn } from 'node:child_process';

export const SYSTEM_COMMANDS = [
  'nmcli',
  'bluetoothctl',
  'pactl',
  'wpctl',
  'omarchy-bluetooth-power',
  'omarchy-bluetooth-device',
  'omarchy-brightness-display',
  'omarchy-audio-output-volume',
  'omarchy-audio-output-sink',
  'omarchy-audio-output-set-default',
  'omarchy-audio-input-mute',
  'omarchy-toggle-nightlight',
  'omarchy-toggle-notification-silencing',
  'omarchy-shell',
  'omarchy-powerprofiles-list',
  'omarchy-powerprofiles-set',
  'omarchy-battery-status',
  'omarchy-system-stats',
  'omarchy-system-lock',
  'omarchy-theme-list',
  'omarchy-theme-current',
  'omarchy-theme-set',
  // S3: the chat window's place on screen (apps/hyprland.ts).
  'hyprctl',
] as const;
export type SystemCommand = (typeof SYSTEM_COMMANDS)[number];

/** nmcli arguments that print saved Wi-Fi passwords. Refused before anything starts. */
const SECRET_ARGS = new Set(['-s', '--show-secrets', '-show-secrets', 'show-password']);

export interface RunOptions {
  timeoutMs?: number;
  /**
   * Read stdout. Off for commands that change something: some of them leave a helper
   * running in the background (hyprsunset, for one), which would hold a pipe open.
   */
  capture?: boolean;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  /** Exit code; a non-zero exit is a result, not an error (e.g. `omarchy-bluetooth-power is-on`). */
  code: number;
}

export type Run = (cmd: SystemCommand, args: readonly string[], opts?: RunOptions) => Promise<CommandResult>;

export class SystemCommandError extends Error {
  constructor(
    readonly reason: 'missing' | 'timeout' | 'refused' | 'failed',
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'SystemCommandError';
  }
}

const MAX_OUTPUT = 256 * 1024;

export const runCommand: Run = (cmd, args, opts = {}) => {
  if (!(SYSTEM_COMMANDS as readonly string[]).includes(cmd)) {
    return Promise.reject(new SystemCommandError('refused', cmd, `${cmd} is not an allowed system command`));
  }
  if (cmd === 'nmcli' && args.some((a) => SECRET_ARGS.has(a))) {
    return Promise.reject(new SystemCommandError('refused', cmd, 'reading saved Wi-Fi passwords is not allowed'));
  }
  const capture = opts.capture ?? true;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      shell: false,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new SystemCommandError('timeout', cmd, `${cmd} took too long to answer`));
    }, opts.timeoutMs ?? 5000);
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') reject(new SystemCommandError('missing', cmd, `this computer doesn't have ${cmd} (it comes with Omarchy 4)`));
      else reject(new SystemCommandError('failed', cmd, `${cmd} could not start: ${err.message}`));
    });
    // 'close' waits for stdout to drain; without a pipe, 'exit' is enough.
    child.once(capture ? 'close' : 'exit', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, code: code ?? 1 });
    });
  });
};
