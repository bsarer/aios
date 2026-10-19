import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Battery {
  percent: number;
  charging: boolean;
}

/** First battery under /sys/class/power_supply, or null on machines without one. */
export async function readBattery(root = '/sys/class/power_supply'): Promise<Battery | null> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  for (const name of entries.sort()) {
    const dir = join(root, name);
    const type = await readFile(join(dir, 'type'), 'utf8').catch(() => '');
    if (type.trim() !== 'Battery') continue;
    const capacity = Number((await readFile(join(dir, 'capacity'), 'utf8').catch(() => '')).trim());
    if (!Number.isFinite(capacity)) continue;
    const status = (await readFile(join(dir, 'status'), 'utf8').catch(() => '')).trim();
    return { percent: Math.max(0, Math.min(100, capacity)), charging: status === 'Charging' || status === 'Full' };
  }
  return null;
}

export interface Wifi {
  connected: boolean;
  ssid: string | null;
}

/** Parses `nmcli -t -f ACTIVE,SSID dev wifi` output. */
export function parseNmcli(out: string): Wifi {
  for (const line of out.split('\n')) {
    // Terse mode escapes ':' in values as '\:'.
    const m = /^yes:(.*)$/.exec(line.trim());
    if (m) return { connected: true, ssid: m[1]!.replace(/\\:/g, ':') || null };
  }
  return { connected: false, ssid: null };
}

/** Wi-Fi state via nmcli, or null when NetworkManager is not available. */
export async function readWifi(): Promise<Wifi | null> {
  try {
    const { stdout } = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi'], { timeout: 3000 });
    return parseNmcli(stdout);
  } catch {
    return null;
  }
}
