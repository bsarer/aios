import { spawn } from 'node:child_process';
import { inspect } from 'node:util';
import type { SecretRef } from '@aios/shared';

const SERVICE = 'aios';
const REDACTED = '[redacted]';

/**
 * A secret value that refuses to print itself. Logging, JSON-encoding or
 * string-concatenating it yields "[redacted]"; only reveal() gives the value.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with optional stdin. Injected so tests never touch a real keyring. */
export type CommandRunner = (cmd: string, args: string[], stdin?: string) => Promise<RunResult>;

export const spawnRunner: CommandRunner = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });

export class KeyringError extends Error {
  override readonly name = 'KeyringError';
}

/** Name part of a `keyring:<name>` reference. */
export function refName(ref: SecretRef): string {
  return ref.slice('keyring:'.length);
}

/**
 * Thin wrapper over libsecret's `secret-tool`. Secrets are stored under
 * attributes service=aios, account=<name>. Values travel only via stdin/stdout,
 * never argv, and are never included in error messages.
 */
export class Keyring {
  constructor(private readonly run: CommandRunner = spawnRunner) {}

  async available(): Promise<boolean> {
    try {
      // `secret-tool` with no args prints usage and exits non-zero; ENOENT means missing.
      await this.run('secret-tool', []);
      return true;
    } catch {
      return false;
    }
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    if (value.length === 0) throw new KeyringError(`refusing to store an empty secret for ${ref}`);
    const name = refName(ref);
    const res = await this.exec(['store', `--label=AI OS: ${name}`, 'service', SERVICE, 'account', name], value);
    if (res.code !== 0) throw new KeyringError(`could not store ${ref} in the keyring (${res.stderr.trim() || `exit ${res.code}`})`);
  }

  /** Returns null when the secret is not stored. */
  async get(ref: SecretRef): Promise<Secret | null> {
    const res = await this.exec(['lookup', 'service', SERVICE, 'account', refName(ref)]);
    if (res.code !== 0 || res.stdout.length === 0) return null;
    return new Secret(res.stdout.replace(/\n$/, ''));
  }

  async require(ref: SecretRef): Promise<Secret> {
    const s = await this.get(ref);
    if (!s) throw new KeyringError(`${ref} is not in the keyring; run \`pnpm run setup\``);
    return s;
  }

  async delete(ref: SecretRef): Promise<void> {
    await this.exec(['clear', 'service', SERVICE, 'account', refName(ref)]);
  }

  private async exec(args: string[], stdin?: string): Promise<RunResult> {
    try {
      return await this.run('secret-tool', args, stdin);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new KeyringError('secret-tool not found; install libsecret (e.g. `sudo pacman -S libsecret`)');
      }
      throw new KeyringError(`secret-tool failed to start (${code ?? 'unknown error'})`);
    }
  }
}
