import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** One line per event in an append-only JSONL file (CLAUDE.md: every tool call is logged). */
export interface AuditEntry {
  kind: 'tool' | 'model' | 'command' | 'memory' | 'mail' | 'system' | 'window' | 'calendar' | 'docs';
  [key: string]: unknown;
}

export interface AuditLogOptions {
  now?: () => number;
  /** Rotate once the file passes this size. Default 10 MB. */
  maxBytes?: number;
  /** Rotated files kept as audit.jsonl.1 … .N (oldest dropped). Default 5. */
  keep?: number;
}

const SECRETISH = /(api[_-]?key|authorization|password|secret|token)/i;

/** Drops values under secret-looking keys, recursively. Belt and braces: secrets should never get here. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRETISH.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

export class AuditLog {
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly keep: number;
  private size: number;

  constructor(
    private readonly path: string,
    o: AuditLogOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.keep = Math.max(1, o.keep ?? 5);
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  append(entry: AuditEntry): void {
    const line = `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...(redact(entry) as object) })}\n`;
    if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    // Synchronous on purpose: an entry must be on disk before the action's result is used.
    appendFileSync(this.path, line, { mode: 0o600 });
    this.size += Buffer.byteLength(line);
  }

  /** audit.jsonl → .1 → .2 …; whole files only, so no entry is ever split or rewritten. */
  private rotate(): void {
    rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }
}
