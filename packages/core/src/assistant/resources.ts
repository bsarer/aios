/**
 * L1: reading this computer's disk, memory, CPU and processes. Plain code, no model: /proc
 * and statfs only, never a shell. Everything takes a root folder so tests can use a fake /proc.
 *
 * Process names come from the programs themselves (anything can call itself "rm -rf"), so
 * they are only ever shown as plain text and reach a model only inside an <untrusted> wrapper.
 */
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface Memory {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

/** /proc/meminfo. MemAvailable is the kernel's own estimate of what new programs can use. */
export function parseMeminfo(text: string): Memory | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || available === null) return null;
  return { totalBytes: total, availableBytes: available, swapTotalBytes: kb('SwapTotal') ?? 0, swapFreeBytes: kb('SwapFree') ?? 0 };
}

export interface CpuTicks {
  busy: number;
  total: number;
}

/** The first "cpu" line of /proc/stat. Idle and iowait count as not busy; guest time is already in user. */
export function parseCpuLine(text: string): CpuTicks | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total };
}

/** Busy share between two readings, 0–100. */
export function cpuPercent(a: CpuTicks, b: CpuTicks): number {
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((b.busy - a.busy) / total) * 100));
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  /** user + system clock ticks so far. */
  ticks: number;
  rssBytes: number;
}

const PAGE = 4096;

/** One /proc/<pid>/stat line. The name is in parentheses and may itself hold ") ". */
export function parseProcStat(text: string): ProcessInfo | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); utime is 14, stime 15, rss 24.
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rss = Number(rest[21]);
  if (![pid, ppid, utime, stime, rss].every(Number.isFinite)) return null;
  return { pid, ppid, name: text.slice(open + 1, close).slice(0, 64), ticks: utime + stime, rssBytes: Math.max(0, rss) * PAGE };
}

export interface Disk {
  /** The folder as configured, e.g. "~" or "/". */
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceReader {
  memory(): Promise<Memory | null>;
  cpu(): Promise<CpuTicks | null>;
  processes(): Promise<ProcessInfo[]>;
  /** One entry per drive: folders on the same drive are reported once, under the first label. */
  disks(folders: { label: string; path: string }[]): Promise<Disk[]>;
}

export function procReader(root = '/proc'): ResourceReader {
  return {
    async memory() {
      return parseMeminfo(await readFile(join(root, 'meminfo'), 'utf8').catch(() => ''));
    },
    async cpu() {
      return parseCpuLine(await readFile(join(root, 'stat'), 'utf8').catch(() => ''));
    },
    async processes() {
      const names = (await readdir(root).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n));
      const out: ProcessInfo[] = [];
      for (const n of names) {
        // Processes come and go between the listing and the read; a missing one is skipped.
        const p = parseProcStat(await readFile(join(root, n, 'stat'), 'utf8').catch(() => ''));
        if (p) out.push(p);
      }
      return out;
    },
    async disks(folders) {
      const seen = new Set<number>();
      const out: Disk[] = [];
      for (const f of folders) {
        const st = await stat(f.path).catch(() => null);
        if (!st || seen.has(st.dev)) continue;
        seen.add(st.dev);
        const fs = await statfs(f.path).catch(() => null);
        if (!fs || fs.blocks <= 0) continue;
        out.push({ label: f.label, path: f.path, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize });
      }
      return out;
    },
  };
}

/** The memory a process and everything it started use, e.g. a browser and its tabs (shared pages counted more than once). */
export function treeRss(pid: number, procs: ProcessInfo[]): number {
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let total = 0;
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    total += byPid.get(cur)?.rssBytes ?? 0;
    stack.push(...(children.get(cur) ?? []));
  }
  return total;
}

/** "512 MB", "2.4 GB". */
export function bytesText(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
