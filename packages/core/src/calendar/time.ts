/**
 * Wall-clock times in the user's timezone (C1). The model names times the way the user does,
 * "2026-11-02T15:00" in their own zone, never with an offset it might get wrong; code turns
 * them into instants and back.
 */

/** "2026-11-02" or "2026-11-02T15:00". */
export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(ms: number, timeZone: string): Parts {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(ms))
    .reduce<Record<string, number>>((a, x) => (x.type === 'literal' ? a : { ...a, [x.type]: Number(x.value) }), {});
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

/** How far the zone is ahead of UTC at that instant, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Throws on anything that is not a real date (2026-02-30) or time (25:00). */
function parseLocal(local: string): Parts {
  if (!LOCAL_DATE.test(local) && !LOCAL_DATE_TIME.test(local)) throw new RangeError(`${local} is not a date like 2026-11-02 or a time like 2026-11-02T15:00`);
  const [d, t = '00:00'] = local.split('T') as [string, string?];
  const [year, month, day] = d.split('-').map(Number) as [number, number, number];
  const [hour, minute] = t.split(':').map(Number) as [number, number];
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    throw new RangeError(`${local} is not a real date and time`);
  }
  return { year, month, day, hour, minute, second: 0 };
}

/** The instant a wall-clock time in `timeZone` names. In a DST gap it lands just after the gap. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const p = parseLocal(local);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  let ms = asUtc - offsetAt(asUtc, timeZone);
  // Once more with the offset at the first guess, for times near a DST change.
  ms = asUtc - offsetAt(ms, timeZone);
  return new Date(ms);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-02T15:00" for an instant, in `timeZone`. */
export function utcToLocal(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The next calendar day of "2026-11-02" (or a time's date). */
export function nextDay(local: string): string {
  const p = parseLocal(local.slice(0, 10));
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Days from `a` to `b`, both "YYYY-MM-DD". */
export function daysBetween(a: string, b: string): number {
  const pa = parseLocal(a);
  const pb = parseLocal(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

const dayFmt = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A span as people say it: "Mon 2 Nov, 15:00–15:30", "Mon 2 Nov, 23:00 – Tue 3 Nov, 01:00", "Mon 2 Nov, all day". */
export function formatSpan(span: { startMs: number; endMs: number; allDay: boolean }, timeZone: string): string {
  if (span.allDay) {
    // All-day spans are dates, kept as UTC midnights; the end date is exclusive.
    const day = dayFmt('UTC');
    const last = span.endMs - 86_400_000;
    return last > span.startMs ? `${day.format(span.startMs)} – ${day.format(last)}, all day` : `${day.format(span.startMs)}, all day`;
  }
  const day = dayFmt(timeZone);
  const time = timeFmt(timeZone);
  const sameDay = day.format(span.startMs) === day.format(span.endMs) || (utcToLocal(span.endMs, timeZone).endsWith('T00:00') && span.endMs - span.startMs < 86_400_000);
  return sameDay
    ? `${day.format(span.startMs)}, ${time.format(span.startMs)}–${time.format(span.endMs)}`
    : `${day.format(span.startMs)}, ${time.format(span.startMs)} – ${day.format(span.endMs)}, ${time.format(span.endMs)}`;
}
