/**
 * T1: to-do cards, their clicks, and the `reminders` event source.
 *
 * Cards repeat back what was saved with times written by code from the checked value, so a
 * wrong guess by the model ("at 4" as 04:00) is visible at once and fixed with one message.
 * Each row's buttons (Done, Not done, Remove, Snooze) are the user's own clicks, checked against
 * the row's hash and the item as it is in the file now.
 *
 * Reminders: every half minute code looks for open items whose reminder time has passed and
 * posts them as one card, with a desktop notification. Like new-mail notifications they wait
 * while AI OS is paused or in quiet hours, and come as soon as that ends. Each reminder fires
 * once for its time; moving the time (or Snooze) makes it fire again. No model is involved.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem, TodoRow } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { LOCAL_DATE, LOCAL_DATE_TIME, daysBetween, utcToLocal, zonedToUtc } from '../calendar/time.js';
import { inQuietHours } from '../mail/pipeline.js';
import type { Store } from '../store.js';
import type { Todo, TodoList } from './list.js';

type TodoItem = Extract<ChatItem, { kind: 'todo' }>;

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A reminder posted this much after its time says it is late. */
const LATE_MS = 10 * MINUTE;
const MAX_AHEAD_DAYS = 2 * 366;

export class TimeError extends Error {}

/** A reminder time from the model, checked: a real local time, not in the past, not years away. */
export function checkRemindAt(local: string, o: { now: number; timeZone: string }): number {
  if (!LOCAL_DATE_TIME.test(local)) throw new TimeError(`${local} is not a local time like 2026-11-07T16:00 (no seconds, no offset)`);
  let ms: number;
  try {
    ms = zonedToUtc(local, o.timeZone).getTime();
  } catch (err) {
    throw new TimeError((err as Error).message);
  }
  if (ms < o.now - MINUTE) throw new TimeError(`${local} has already passed: it is now ${utcToLocal(o.now, o.timeZone)} (${o.timeZone}). Work the time out again from now.`);
  if (ms > o.now + MAX_AHEAD_DAYS * DAY) throw new TimeError(`${local} is more than two years away`);
  return ms;
}

/** A due date from the model, checked: a real date, today or later. */
export function checkDue(local: string, o: { now: number; timeZone: string }): void {
  if (!LOCAL_DATE.test(local)) throw new TimeError(`${local} is not a local date like 2026-11-10`);
  try {
    zonedToUtc(local, o.timeZone);
  } catch (err) {
    throw new TimeError((err as Error).message);
  }
  const today = utcToLocal(o.now, o.timeZone).slice(0, 10);
  const days = daysBetween(today, local);
  if (days < 0) throw new TimeError(`${local} is before today (${today})`);
  if (days > MAX_AHEAD_DAYS) throw new TimeError(`${local} is more than two years away`);
}

const dayFmt = (timeZone: string, year: boolean) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });

/** "Today, Sat 7 Nov", "Tomorrow, Sun 8 Nov", "Mon 16 Nov", "Tue 5 Jan 2027" for a local date. */
export function dayText(date: string, o: { now: number; timeZone: string }): string {
  const today = utcToLocal(o.now, o.timeZone).slice(0, 10);
  const d = daysBetween(today, date);
  // A date's own noon in UTC names the same calendar day everywhere.
  const label = dayFmt('UTC', date.slice(0, 4) !== today.slice(0, 4)).format(Date.parse(`${date}T12:00:00Z`)).replace(',', '');
  return d === 0 ? `Today, ${label}` : d === 1 ? `Tomorrow, ${label}` : d === -1 ? `Yesterday, ${label}` : label;
}

/** "Today, Sat 7 Nov, 16:00" for a local time. */
export function whenText(local: string, o: { now: number; timeZone: string }): string {
  return `${dayText(local.slice(0, 10), o)}, ${local.slice(11, 16)}`;
}

export function todoHash(t: Pick<Todo, 'id' | 'text' | 'remindAt' | 'due'>): string {
  return createHash('sha256').update(['todo', t.id, t.text, t.remindAt ?? '', t.due ?? ''].join('\n')).digest('hex');
}

export interface TodosOptions {
  list: TodoList;
  store: Store;
  audit: AuditLog;
  timeZone: string;
  snoozeMinutes: number;
  quietHours?: { start: string; end: string } | undefined;
  isPaused: () => boolean;
  post: (item: ChatItem) => void;
  patch: (item: ChatItem) => void;
  /** A desktop notification for a reminder (S4's notify-send). */
  notify?: (title: string, body: string) => void;
  now?: () => number;
  newId?: () => string;
}

export class Todos {
  readonly list: TodoList;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: TodosOptions) {
    this.list = o.list;
    this.now = o.now ?? Date.now;
  }

  private clock() {
    return { now: this.now(), timeZone: this.o.timeZone };
  }

  row(t: Todo): TodoRow {
    const c = this.clock();
    return {
      todoId: t.id,
      text: t.text,
      ...(t.remindAt ? { when: whenText(t.remindAt, c) } : {}),
      ...(t.due ? { due: dayText(t.due, c) } : {}),
      hash: todoHash(t),
      state: t.done ? 'done' : 'open',
    };
  }

  /** Posts a card repeating back what was just saved. */
  card(event: TodoItem['event'], todos: Todo[], suffix = ''): TodoItem {
    const n = todos.length;
    const title =
      event === 'added' ? (todos.some((t) => t.remindAt) ? (n === 1 ? 'Reminder set' : 'Added to your list, with reminders') : 'Added to your list')
      : event === 'updated' ? 'Changed on your list'
      : event === 'done' ? (n === 1 ? 'Ticked off' : `${n} ticked off`)
      : n === 1 ? 'Reminder' : `${n} reminders`;
    const item: TodoItem = { kind: 'todo', id: this.o.newId?.() ?? randomUUID(), event, title: `${title}${suffix}`, rows: todos.map((t) => this.row(t)), at: this.now() };
    this.o.post(item);
    return item;
  }

  /**
   * A click on one row. Only reached from the UI: checks the row's hash, and that the item in
   * the file is still the one the card shows, before anything changes.
   */
  act(id: string, todoId: string, action: 'done' | 'reopen' | 'remove' | 'snooze', hash: string): void {
    const item = this.o.store.getItem(id);
    if (item?.kind !== 'todo') return;
    const row = item.rows.find((r) => r.todoId === todoId);
    if (!row || row.hash !== hash || row.state === 'removed') return;
    if (action === 'snooze' && item.event !== 'reminder') return;
    const log = (outcome: string) => this.o.audit.append({ kind: 'todos', event: 'click', itemId: id, todoId, action, outcome });
    const current = this.list.get(todoId);
    if (!current || todoHash(current) !== hash) {
      log('changed');
      return this.setRow(item, todoId, { result: current ? 'It changed on your list since this card was made, so I left it alone.' : "It isn't on your list any more." });
    }
    const today = utcToLocal(this.now(), this.o.timeZone).slice(0, 10);
    if (action === 'done') {
      if (current.done) return;
      this.list.update(todoId, (t) => ({ ...t, done: true, doneOn: today }));
      log('done');
      return this.setRow(item, todoId, { state: 'done', result: 'Done.' });
    }
    if (action === 'reopen') {
      if (!current.done) return;
      this.list.update(todoId, (t) => ({ ...t, done: false }));
      log('reopened');
      return this.setRow(item, todoId, { state: 'open', result: 'Back on your list.' });
    }
    if (action === 'remove') {
      this.list.remove(todoId);
      log('removed');
      return this.setRow(item, todoId, { state: 'removed', result: 'Taken off your list.' });
    }
    if (current.done) return;
    // Snooze: the next whole minute after now + snoozeMinutes.
    const at = utcToLocal(Math.ceil((this.now() + this.o.snoozeMinutes * MINUTE) / MINUTE) * MINUTE, this.o.timeZone);
    const saved = this.list.update(todoId, (t) => ({ ...t, remindAt: at }));
    log('snoozed');
    if (saved) this.setRow(item, todoId, { ...this.row(saved), result: `I'll remind you again ${whenText(at, this.clock()).replace(/^Today, [^,]+, /, 'at ')}.` });
  }

  private setRow(item: TodoItem, todoId: string, patch: Partial<TodoRow>): void {
    const next: TodoItem = { ...item, rows: item.rows.map((r) => (r.todoId === todoId ? { ...r, ...patch } : r)) };
    this.o.store.saveItem(next);
    this.o.patch(next);
  }

  private fired(key: string): boolean {
    return !!this.o.store.db.prepare('SELECT 1 FROM reminders_fired WHERE key = ?').get(key);
  }

  /** The `reminders` event source: posts every reminder that is due, unless paused or in quiet hours. */
  tick(): number {
    const now = this.now();
    if (this.o.isPaused() || inQuietHours(now, this.o.timeZone, this.o.quietHours)) return 0;
    const due: { t: Todo; ms: number; key: string }[] = [];
    for (const t of this.list.open()) {
      if (!t.remindAt) continue;
      let ms: number;
      try {
        ms = zonedToUtc(t.remindAt, this.o.timeZone).getTime();
      } catch {
        continue;
      }
      const key = `${t.id}@${t.remindAt}`;
      if (ms <= now && !this.fired(key)) due.push({ t, ms, key });
    }
    if (!due.length) return 0;
    due.sort((a, b) => a.ms - b.ms);
    const late = now - due[0]!.ms > LATE_MS;
    const insert = this.o.store.db.prepare('INSERT OR IGNORE INTO reminders_fired (key, at) VALUES (?, ?)');
    this.o.store.db.transaction(() => {
      for (const d of due) insert.run(d.key, now);
      this.o.store.db.prepare('DELETE FROM reminders_fired WHERE at < ?').run(now - 90 * DAY);
    })();
    const since = whenText(due[0]!.t.remindAt!, this.clock()).replace(/^Today, [^,]+, /, '').replace(/^(Yesterday|Tomorrow), /, '');
    this.card('reminder', due.map((d) => d.t), late ? ` (from ${since}, while you were away)` : '');
    // Counts only: the items' text stays out of the audit log.
    this.o.audit.append({ kind: 'todos', event: 'reminder', count: due.length, lateMinutes: Math.round((now - due[0]!.ms) / MINUTE) });
    this.o.notify?.(due.length === 1 ? 'Reminder' : `${due.length} reminders`, due.map((d) => d.t.text).join('\n'));
    return due.length;
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tickSafely(), intervalMs);
    this.timer.unref?.();
    this.tickSafely();
  }

  private tickSafely(): void {
    try {
      this.tick();
    } catch (err) {
      this.o.audit.append({ kind: 'todos', event: 'reminder_error', error: (err as Error).message.slice(0, 200) });
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
