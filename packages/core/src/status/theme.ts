import { type FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Theme } from '@aios/shared';
import { parse } from 'smol-toml';

/** Omarchy's current theme colours (plan §7). Verify the path on the installed Omarchy version. */
export function omarchyThemePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? '', '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml');
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Flattens a colors.toml into { "key": "#hex" } (nested tables become "table.key"). Non-colour values are dropped. */
export function parseThemeToml(text: string): Theme {
  const out: Theme = {};
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        const hex = v.trim().replace(/^0x/i, '#');
        if (COLOR.test(hex)) out[key] = hex;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
    }
  };
  try {
    walk(parse(text), '');
  } catch {
    // Unreadable theme: fall back to the UI's defaults.
  }
  return out;
}

export async function readTheme(path: string): Promise<Theme> {
  return parseThemeToml(await readFile(path, 'utf8').catch(() => ''));
}

/** Calls `onChange` when the theme file changes (Omarchy swaps a symlink, so watch the directory). */
export function watchTheme(path: string, onChange: (t: Theme) => void): FSWatcher | null {
  let timer: NodeJS.Timeout | undefined;
  try {
    return watch(dirname(dirname(path)), { recursive: true }, (_e, file) => {
      if (file && !String(file).endsWith(basename(path)) && !String(file).startsWith('theme')) return;
      clearTimeout(timer);
      timer = setTimeout(() => void readTheme(path).then(onChange), 200);
    });
  } catch {
    return null;
  }
}
