/**
 * S7: the AI button in Omarchy's top bar. The bar runs `aios-kiosk bar` every few seconds, which
 * reads one flag file that core keeps: "1" when something new came into the chat while it didn't
 * have focus (the button shows a dot), "0" otherwise. Only that one character is written, so
 * nothing from the chat reaches the bar.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** $XDG_RUNTIME_DIR/aios/unseen, or null without a runtime dir (then there is no dot). */
export function unseenPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.XDG_RUNTIME_DIR;
  return dir && dir.startsWith('/') ? join(dir, 'aios', 'unseen') : null;
}

export class UnseenFlag {
  private value: boolean | null = null;

  constructor(private readonly path: string | null) {}

  set(unseen: boolean): void {
    if (!this.path || unseen === this.value) return;
    this.value = unseen;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, unseen ? '1' : '0', { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // The dot is a convenience; the chat itself still shows everything.
    }
  }
}
