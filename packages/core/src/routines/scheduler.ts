/**
 * Routines that run by themselves. Every half minute code looks for a routine whose scheduled
 * time has passed since it last ran. Like reminders, it waits while Astra is paused, in quiet
 * hours or busy with another reply, and runs as soon as that ends, if it is still the same day;
 * a time missed for a whole day (the computer was off) is skipped, never run late. Each time
 * runs once. A routine seen for the first time doesn't run for a time that has already passed.
 */
import type { AuditLog } from '../audit.js';
import { utcToLocal } from '../calendar/time.js';
import { inQuietHours } from '../mail/pipeline.js';
import type { Store } from '../store.js';
import { lastSlot, type Routine, type RoutineFolder } from './routines.js';

export interface RoutineSchedulerOptions {
  folder: Pick<RoutineFolder, 'load'>;
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  audit: AuditLog;
  timeZone: string;
  quietHours?: { start: string; end: string } | undefined;
  isPaused: () => boolean;
  isBusy: () => boolean;
  /** Runs the routine as a scheduled run (Shell.runRoutine). */
  run: (routine: Routine, slot: number) => Promise<void>;
  now?: () => number;
}

export class RoutineScheduler {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly o: RoutineSchedulerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private key(slug: string): string {
    return `routine_last:${slug}`;
  }

  /** Runs at most one due routine. Returns its slug, or null. */
  async tick(): Promise<string | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      const now = this.now();
      const { routines } = this.o.folder.load();
      const scheduled = routines.filter((r) => r.schedule);
      const held = this.o.isPaused() || this.o.isBusy() || inQuietHours(now, this.o.timeZone, this.o.quietHours);
      const today = utcToLocal(now, this.o.timeZone).slice(0, 10);
      for (const r of scheduled) {
        const last = Number(this.o.store.getSetting(this.key(r.slug)));
        if (!Number.isFinite(last) || last <= 0) {
          // First sight: start counting from now.
          this.o.store.setSetting(this.key(r.slug), String(now));
          continue;
        }
        const slot = lastSlot(r.schedule!, now, this.o.timeZone);
        if (slot === null || slot <= last) continue;
        if (utcToLocal(slot, this.o.timeZone).slice(0, 10) !== today) {
          this.o.store.setSetting(this.key(r.slug), String(now));
          this.o.audit.append({ kind: 'routine', event: 'skipped', routine: r.slug, reason: 'missed its day' });
          continue;
        }
        if (held) return null;
        this.o.store.setSetting(this.key(r.slug), String(now));
        await this.o.run(r, slot);
        return r.slug;
      }
      return null;
    } finally {
      this.ticking = false;
    }
  }
}
