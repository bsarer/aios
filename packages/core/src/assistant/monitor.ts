/**
 * L1: the resource monitor. Code samples disk, memory and CPU every half minute and decides,
 * with thresholds and hysteresis, when something is low; no model is involved in that. An
 * alert is posted straight away with code-written numbers, and the local model's advice is
 * added to it when (and if) it answers. When the resource recovers, the card says so.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantConfig, ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { inQuietHours } from '../mail/pipeline.js';
import { ModelError } from '../model.js';
import { type CpuTicks, type ProcessInfo, type ResourceReader, bytesText, cpuPercent } from './resources.js';
import { type LocalModel, resourceAdvice } from './worker.js';

type AlertItem = Extract<ChatItem, { kind: 'resource_alert' }>;
type Resource = AlertItem['resource'];

/** Clock ticks per second for /proc times; 100 on every mainstream Linux build. */
const USER_HZ = 100;

interface Watch {
  low: boolean;
  /** Samples in a row past the threshold (memory needs two). */
  streak: number;
  lastAlertAt: number;
  itemId?: string | undefined;
}

export interface MonitorOptions {
  reader: ResourceReader;
  config: AssistantConfig['monitor'];
  timeZone: string;
  /** Null without [models.local]: alerts then carry code-written details only. */
  model: LocalModel | null;
  post: (item: ChatItem) => void;
  patch: (item: ChatItem) => void;
  /** A desktop notification, outside quiet hours, for when the chat isn't in view. */
  notify?: (title: string, body: string) => void;
  quietHours?: { start: string; end: string } | undefined;
  audit: AuditLog;
  /** The biggest files in the allowed folders on a drive, for a disk alert. */
  bigFiles?: (drivePath: string, limit: number) => Promise<{ display: string; bytes: number }[]>;
  home?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

export class ResourceMonitor {
  private readonly watches = new Map<string, Watch>();
  private readonly items = new Map<string, AlertItem>();
  private lastCpu: CpuTicks | null = null;
  /** CPU busy share per sample, newest last, for the rolling average. */
  private cpuSamples: { at: number; pct: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly home: string;

  constructor(private readonly o: MonitorOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.home = o.home ?? homedir();
  }

  start(): void {
    if (this.timer || !this.o.config.enabled) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.config.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sample of everything. Safe to call often; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.checkMemory();
      await this.checkCpu();
      await this.checkDisks();
    } catch (err) {
      this.o.audit.append({ kind: 'assistant', event: 'monitor_error', error: (err as Error).message.slice(0, 300) });
    } finally {
      this.running = false;
    }
  }

  /** The latest numbers, written by code, for /checkup. */
  async snapshot(): Promise<string[]> {
    const c = this.o.config;
    const lines: string[] = [];
    const mem = await this.o.reader.memory();
    if (mem) lines.push(`Memory: ${bytesText(mem.availableBytes)} of ${bytesText(mem.totalBytes)} available.`);
    const avg = this.cpuAverage(c.cpuMinutes * 60_000, true);
    if (avg !== null) lines.push(`Processor: ${Math.round(avg)}% busy on average lately.`);
    for (const d of await this.o.reader.disks(this.folders())) {
      lines.push(`${driveName(d.label)}: ${bytesText(d.freeBytes)} of ${bytesText(d.totalBytes)} free.`);
    }
    return lines;
  }

  private folders(): { label: string; path: string }[] {
    return this.o.config.disks.map((d) => ({ label: d, path: d === '~' ? this.home : d.startsWith('~/') ? join(this.home, d.slice(2)) : d }));
  }

  private watch(key: string): Watch {
    let w = this.watches.get(key);
    if (!w) {
      w = { low: false, streak: 0, lastAlertAt: -Infinity };
      this.watches.set(key, w);
    }
    return w;
  }

  /**
   * Moves one watch along: `isLow` past the threshold, `isBack` clearly back (hysteresis).
   * Returns 'alert' when a new alert is due.
   */
  private step(key: string, isLow: boolean, isBack: boolean, need = 1): 'alert' | 'recovered' | null {
    const w = this.watch(key);
    if (!w.low) {
      w.streak = isLow ? w.streak + 1 : 0;
      if (w.streak < need) return null;
      w.low = true;
      w.streak = 0;
      if (this.now() - w.lastAlertAt < this.o.config.cooldownHours * 3_600_000) return null;
      w.lastAlertAt = this.now();
      return 'alert';
    }
    if (isBack) {
      w.low = false;
      return 'recovered';
    }
    return null;
  }

  private async checkMemory(): Promise<void> {
    const mem = await this.o.reader.memory();
    if (!mem) return;
    const pct = (mem.availableBytes / mem.totalBytes) * 100;
    const thr = this.o.config.memoryFreePercent;
    const s = this.step('memory', pct < thr, pct > thr + 5, 2);
    if (s === 'recovered') return this.recovered('memory');
    if (s !== 'alert') return;
    const procs = await this.o.reader.processes();
    const top = topBy(procs, (p) => p.rssBytes, 5).map((p) => `${p.name}: ${bytesText(p.rssBytes)}`);
    const swap = mem.swapTotalBytes > 0 ? ` Swap: ${bytesText(mem.swapTotalBytes - mem.swapFreeBytes)} of ${bytesText(mem.swapTotalBytes)} in use.` : '';
    await this.alert('memory', 'memory', {
      headline: `Memory is running low: ${bytesText(mem.availableBytes)} of ${bytesText(mem.totalBytes)} available.`,
      facts: `Available: ${pct.toFixed(1)}% of ${bytesText(mem.totalBytes)}.${swap}`,
      top,
      details: top.length ? [`Using the most memory: ${top.join(', ')}.`] : [],
    });
  }

  private cpuAverage(windowMs: number, partial = false): number | null {
    const since = this.now() - windowMs;
    const recent = this.cpuSamples.filter((s) => s.at >= since);
    if (!recent.length) return null;
    // Only a full window counts for alerts: a few busy seconds at start are normal.
    if (!partial && this.now() - recent[0]!.at < windowMs * 0.8) return null;
    return recent.reduce((a, s) => a + s.pct, 0) / recent.length;
  }

  private async checkCpu(): Promise<void> {
    const ticks = await this.o.reader.cpu();
    if (!ticks) return;
    const prev = this.lastCpu;
    this.lastCpu = ticks;
    if (!prev) return;
    const c = this.o.config;
    const windowMs = c.cpuMinutes * 60_000;
    this.cpuSamples.push({ at: this.now(), pct: cpuPercent(prev, ticks) });
    this.cpuSamples = this.cpuSamples.filter((s) => s.at >= this.now() - windowMs * 1.5);
    const avg = this.cpuAverage(windowMs);
    if (avg === null) return;
    const s = this.step('cpu', avg >= c.cpuPercent, avg < c.cpuPercent - 10);
    if (s === 'recovered') return this.recovered('cpu');
    if (s !== 'alert') return;
    // Who is busy: two readings a second apart.
    const a = await this.o.reader.processes();
    await this.sleep(1000);
    const b = await this.o.reader.processes();
    const before = new Map(a.map((p) => [p.pid, p.ticks]));
    const busy = b
      .map((p) => ({ p, pct: before.has(p.pid) ? ((p.ticks - before.get(p.pid)!) / USER_HZ) * 100 : 0 }))
      .filter((x) => x.pct >= 1)
      .sort((x, y) => y.pct - x.pct)
      .slice(0, 5)
      .map((x) => `${x.p.name}: ${Math.round(x.pct)}%`);
    await this.alert('cpu', 'cpu', {
      headline: `The processor has been ${Math.round(avg)}% busy for the last ${c.cpuMinutes} minutes.`,
      facts: `Average busy share over ${c.cpuMinutes} minutes: ${Math.round(avg)}%. A share over 100% means a program uses more than one core.`,
      top: busy,
      details: busy.length ? [`Busiest right now: ${busy.join(', ')}.`] : [],
    });
  }

  private async checkDisks(): Promise<void> {
    const c = this.o.config;
    for (const d of await this.o.reader.disks(this.folders())) {
      const freePct = (d.freeBytes / d.totalBytes) * 100;
      const freeGb = d.freeBytes / 1024 ** 3;
      const key = `disk:${d.path}`;
      const s = this.step(key, freePct < c.diskFreePercent || freeGb < c.diskFreeGb, freePct > c.diskFreePercent + 2 && freeGb > c.diskFreeGb + 2);
      if (s === 'recovered') {
        this.recovered(key);
        continue;
      }
      if (s !== 'alert') continue;
      const big = (await this.o.bigFiles?.(d.path, 5).catch(() => [])) ?? [];
      const top = big.map((f) => `${f.display}: ${bytesText(f.bytes)}`);
      await this.alert(key, 'disk', {
        headline: `Your ${driveName(d.label).toLowerCase()} is almost full: ${bytesText(d.freeBytes)} of ${bytesText(d.totalBytes)} free.`,
        facts: `Free: ${freePct.toFixed(1)}% (${freeGb.toFixed(1)} GB) of ${bytesText(d.totalBytes)} on the drive holding ${d.label}.`,
        top,
        details: top.length ? [`Biggest files in your folders on it: ${top.join(', ')}.`] : [],
      });
    }
  }

  private async alert(key: string, resource: Resource, a: { headline: string; facts: string; top: string[]; details: string[] }): Promise<void> {
    const item: AlertItem = { kind: 'resource_alert', id: this.o.newId?.() ?? randomUUID(), resource, headline: a.headline, details: a.details, at: this.now() };
    this.watch(key).itemId = item.id;
    this.items.set(item.id, item);
    this.o.post(item);
    // Numbers only: process and file names stay out of the audit log.
    this.o.audit.append({ kind: 'assistant', event: 'resource_alert', resource, key });
    if (!inQuietHours(this.now(), this.o.timeZone, this.o.quietHours)) this.o.notify?.('AI OS', a.headline);
    if (!this.o.model) return;
    try {
      const advice = await resourceAdvice(this.o.model, { resource, facts: a.facts, top: a.top });
      const cur = this.items.get(item.id);
      if (advice && cur) {
        const next = { ...cur, advice };
        this.items.set(item.id, next);
        this.o.patch(next);
      }
    } catch (err) {
      this.o.audit.append({ kind: 'assistant', event: 'advice_failed', resource, error: err instanceof ModelError ? err.kind : (err as Error).message.slice(0, 200) });
    }
  }

  private recovered(key: string): void {
    const w = this.watch(key);
    const cur = w.itemId ? this.items.get(w.itemId) : undefined;
    w.itemId = undefined;
    this.o.audit.append({ kind: 'assistant', event: 'resource_recovered', key });
    if (!cur) return;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: this.o.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(this.now()));
    const next = { ...cur, resolved: `Back to normal at ${time}.` };
    this.items.delete(cur.id);
    this.o.patch(next);
  }
}

function driveName(label: string): string {
  return label === '/' ? 'System drive' : label === '~' ? 'Home drive' : `Drive for ${label}`;
}

function topBy(procs: ProcessInfo[], score: (p: ProcessInfo) => number, n: number): ProcessInfo[] {
  // Group by name, so twenty browser processes show as one browser.
  const byName = new Map<string, ProcessInfo>();
  for (const p of procs) {
    const cur = byName.get(p.name);
    byName.set(p.name, cur ? { ...cur, rssBytes: cur.rssBytes + p.rssBytes, ticks: cur.ticks + p.ticks } : { ...p });
  }
  return [...byName.values()].sort((a, b) => score(b) - score(a)).slice(0, n);
}

