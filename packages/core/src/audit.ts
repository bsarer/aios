import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One line per event in an append-only JSONL file (CLAUDE.md: every tool call is logged). */
export interface AuditEntry {
  kind: 'tool' | 'model' | 'command' | 'memory';
  [key: string]: unknown;
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
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: AuditEntry): void {
    // Synchronous on purpose: an entry must be on disk before the action's result is used.
    appendFileSync(this.path, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...(redact(entry) as object) })}\n`, { mode: 0o600 });
  }
}
