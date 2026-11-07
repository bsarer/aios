/**
 * T1: the user's to-do list as one plain Markdown file they own, like memory
 * (`~/.config/aios/todos.md`). One line per item:
 *
 *   - [ ] Call Ana · remind 2026-11-07 16:00 <!-- id:k3f9a2 -->
 *   - [ ] Pay rent · due 2026-11-10 <!-- id:x81mzq -->
 *   - [ ] Milk <!-- id:p0d4cc -->
 *   - [x] Send the lease · done 2026-11-06 <!-- id:e5t2wa -->
 *
 * Times are the user's own wall-clock time in their timezone. The file can be edited by hand:
 * a line without an id gets one from its text and position until the next write saves it.
 * Lines that aren't items (headings, notes) are kept as they are. Nothing in this module
 * decides *whether* to write: the tools (only from the user's own words) and the card's
 * clicks do.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitize } from '../untrusted.js';

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** Reminder time, "2026-11-07T16:00" in the user's timezone. */
  remindAt?: string;
  /** Due date without a time, "2026-11-10". */
  due?: string;
  /** When it was ticked off, "2026-11-06". */
  doneOn?: string;
}

export const TODO_ID = /^[a-z0-9]{6}$/;
export const MAX_TODO_CHARS = 200;
/** Open items kept at most; adding more is refused with a message. */
export const MAX_OPEN_TODOS = 500;

const LINE =
  /^\s*[-*] \[( |x|X)\]\s+(.*?)(?:\s+·\s+remind (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}))?(?:\s+·\s+due (\d{4}-\d{2}-\d{2}))?(?:\s+·\s+done (\d{4}-\d{2}-\d{2}))?\s*(?:<!--\s*id:([a-z0-9]{6})\s*-->)?\s*$/;

const HEADER = '# To-dos\n\nYour list. Edit freely: one "- [ ]" line per item, "- [x]" when it is done.\n\n';

/** One plain line: no Markdown comment markers or our own separators, invisible characters gone, bounded. */
export function cleanTodoText(text: string): string {
  return sanitize({ text }, { maxChars: MAX_TODO_CHARS * 2 })
    .replace(/<!--|-->/g, '')
    .replace(/·/g, '-')
    .replace(/^\[( |x|X)\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TODO_CHARS);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

type Line = { kind: 'todo'; todo: Todo } | { kind: 'other'; text: string };

function render(t: Todo): string {
  const parts = [`- [${t.done ? 'x' : ' '}] ${t.text}`];
  if (t.remindAt) parts.push(`remind ${t.remindAt.replace('T', ' ')}`);
  if (t.due) parts.push(`due ${t.due}`);
  if (t.done && t.doneOn) parts.push(`done ${t.doneOn}`);
  return `${parts.join(' · ')} <!-- id:${t.id} -->`;
}

export class TodoList {
  constructor(
    readonly path: string,
    private readonly newId: () => string = () => randomBytes(8).readBigUInt64BE().toString(36).padStart(6, '0').slice(-6),
  ) {}

  private read(): Line[] {
    if (!existsSync(this.path)) return [];
    const seen = new Set<string>();
    return readFileSync(this.path, 'utf8')
      .replace(/\n$/, '')
      .split('\n')
      .map((text, i): Line => {
        const m = LINE.exec(text);
        if (!m || !m[2]?.trim()) return { kind: 'other', text };
        // Hand-written lines: an id from the text and position, stable until the line changes.
        let id = m[7] ?? createHash('sha256').update(`${i}\n${m[2]}`).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 6);
        while (seen.has(id)) id = createHash('sha256').update(id).digest('hex').slice(0, 6);
        seen.add(id);
        const todo: Todo = { id, text: cleanTodoText(m[2]), done: m[1] !== ' ' };
        if (m[3] && m[4]) todo.remindAt = `${m[3]}T${m[4]}`;
        if (m[5]) todo.due = m[5];
        if (m[6]) todo.doneOn = m[6];
        return { kind: 'todo', todo };
      });
  }

  private write(lines: Line[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = lines.map((l) => (l.kind === 'todo' ? render(l.todo) : l.text)).join('\n');
    writeAtomic(this.path, `${lines.length ? body.replace(/^\n+/, '') : HEADER.trimEnd()}\n`);
  }

  all(): Todo[] {
    return this.read().flatMap((l) => (l.kind === 'todo' ? [l.todo] : []));
  }

  open(): Todo[] {
    return this.all().filter((t) => !t.done);
  }

  get(id: string): Todo | undefined {
    return this.all().find((t) => t.id === id);
  }

  /** Adds items at the end and returns them with their ids. Text is cleaned; empty items are dropped. */
  add(items: Omit<Todo, 'id' | 'done' | 'doneOn'>[]): Todo[] {
    const lines = this.read();
    const isNew = !lines.length;
    if (isNew) lines.push(...HEADER.trimEnd().split('\n').map((text): Line => ({ kind: 'other', text })), { kind: 'other', text: '' });
    const taken = new Set(lines.flatMap((l) => (l.kind === 'todo' ? [l.todo.id] : [])));
    const openCount = lines.filter((l) => l.kind === 'todo' && !l.todo.done).length;
    const fresh = items.map((i) => ({ ...i, text: cleanTodoText(i.text) })).filter((i) => i.text);
    if (openCount + fresh.length > MAX_OPEN_TODOS) throw new Error(`the list already has ${openCount} open items, and holds at most ${MAX_OPEN_TODOS}`);
    const added = fresh.map((i): Todo => {
      let id = this.newId();
      while (taken.has(id) || !TODO_ID.test(id)) id = this.newId();
      taken.add(id);
      return { id, text: i.text, done: false, ...(i.remindAt ? { remindAt: i.remindAt } : {}), ...(i.due ? { due: i.due } : {}) };
    });
    // Before any trailing blank lines, so the file keeps its shape.
    let at = lines.length;
    while (!isNew && at > 0 && lines[at - 1]!.kind === 'other' && !(lines[at - 1] as { text: string }).text.trim()) at--;
    lines.splice(at, 0, ...added.map((todo): Line => ({ kind: 'todo', todo })));
    this.write(lines);
    return added;
  }

  /** Changes one item; returns it as saved, or undefined when there is no such item. */
  update(id: string, change: (t: Todo) => Todo): Todo | undefined {
    const lines = this.read();
    const line = lines.find((l): l is Extract<Line, { kind: 'todo' }> => l.kind === 'todo' && l.todo.id === id);
    if (!line) return undefined;
    const next = change({ ...line.todo });
    line.todo = { ...next, id, text: cleanTodoText(next.text) || line.todo.text };
    if (!line.todo.done) delete line.todo.doneOn;
    this.write(lines);
    return line.todo;
  }

  /** Takes an item off the list. Only a click on the card that added it does this. */
  remove(id: string): Todo | undefined {
    const lines = this.read();
    const i = lines.findIndex((l) => l.kind === 'todo' && l.todo.id === id);
    if (i < 0) return undefined;
    const [line] = lines.splice(i, 1);
    this.write(lines);
    return (line as Extract<Line, { kind: 'todo' }>).todo;
  }
}
