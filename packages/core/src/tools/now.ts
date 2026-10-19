import type { RegisteredTool } from './registry.js';
import { ALPHA_TOOLS } from './definitions.js';

const def = ALPHA_TOOLS.find((t) => t.name === 'now')!;

/** e.g. "Monday, 19 October 2026, 09:14 (Europe/Istanbul, UTC+03:00)" */
export function formatNow(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? 'UTC';
  return `${date}, ${time} (${timeZone}, ${offset === 'UTC' ? 'UTC+00:00' : offset})`;
}

export function nowTool(timeZone: string, clock: () => Date = () => new Date()): RegisteredTool {
  return { def, label: 'Checking the time…', handler: async () => formatNow(clock(), timeZone) };
}
