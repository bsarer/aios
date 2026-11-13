/**
 * T1: the to-do tools. todos_list reads the list (the user's own words, so it carries no
 * outside text). todo_add, todo_update and todo_done are device tier: small changes made
 * straight from the user's own message, never offered or run while text from an email, an
 * invite, a document or any other outside source is in view, so nothing from outside can add,
 * move or tick off an item (CI injection suite: scripts/test/hostile-todos.test.ts). Each
 * posts a card that repeats back, in code's words, exactly what was saved.
 *
 * Taking an item off the list is only a Remove click on a card; no tool deletes.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import type { Todo } from './list.js';
import { TimeError, type Todos, checkDue, checkRemindAt, whenText } from './reminders.js';

const line = (t: Todo, c: { now: number; timeZone: string }) =>
  `- id ${t.id}: ${t.text}${t.remindAt ? ` · reminder ${t.remindAt} (${whenText(t.remindAt, c)})` : ''}${t.due ? ` · due ${t.due}` : ''}${t.done ? ` · done${t.doneOn ? ` ${t.doneOn}` : ''}` : ''}`;

async function checked(run: () => Promise<string> | string): Promise<string> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TimeError) return `Error: ${err.message}. Nothing was saved.`;
    throw err;
  }
}

export function todoTools(o: { todos: Todos; timeZone: string; now?: () => number }): RegisteredTool[] {
  const now = o.now ?? Date.now;
  const c = () => ({ now: now(), timeZone: o.timeZone });
  const counts = (args: unknown) => {
    const a = args as { items?: { remindAt?: string; due?: string }[]; ids?: string[]; id?: string };
    // The user's own words stay out of the audit log; counts and ids only.
    return a.items ? { items: a.items.length, reminders: a.items.filter((i) => i.remindAt).length, due: a.items.filter((i) => i.due).length } : a.ids ? { ids: a.ids } : { id: a.id };
  };
  return [
    {
      def: toolByName('todos_list')!,
      label: 'Checking your list…',
      handler: async (args) => {
        const a = args as { done?: boolean };
        const all = o.todos.list.all();
        const shown = a.done ? all : all.filter((t) => !t.done);
        if (!shown.length) return all.length && !a.done ? 'Nothing open on the list; everything on it is done.' : 'The list is empty.';
        return `The to-do list (${o.todos.list.path}), times in ${o.timeZone}:\n${shown.map((t) => line(t, c())).join('\n')}`;
      },
    },
    {
      def: toolByName('todo_add')!,
      label: 'Adding to your list…',
      auditArgs: counts,
      handler: (args) =>
        checked(() => {
          const a = args as { items: { text: string; remindAt?: string; due?: string }[] };
          for (const i of a.items) {
            if (i.remindAt) checkRemindAt(i.remindAt, c());
            if (i.due) checkDue(i.due, c());
            if (i.remindAt && i.due) throw new TimeError('give an item a reminder time or a due date, not both');
          }
          const added = o.todos.list.add(a.items.map((i) => ({ text: i.text, ...(i.remindAt ? { remindAt: i.remindAt } : {}), ...(i.due ? { due: i.due } : {}) })));
          if (!added.length) return 'Error: the items were empty after cleaning. Nothing was saved.';
          o.todos.card('added', added);
          return `Saved, and a card in the chat repeats it back:\n${added.map((t) => line(t, c())).join('\n')}\nSay what was added in one short line, with the reminder time as the card shows it.`;
        }),
    },
    {
      def: toolByName('todo_update')!,
      label: 'Changing your list…',
      auditArgs: (args) => {
        const a = args as { id: string; text?: string; remindAt?: string; noReminder?: boolean; due?: string };
        return { id: a.id, text: a.text !== undefined, remindAt: a.remindAt !== undefined, noReminder: !!a.noReminder, due: a.due !== undefined };
      },
      handler: (args) =>
        checked(() => {
          const a = args as { id: string; text?: string; remindAt?: string; noReminder?: boolean; due?: string };
          if (a.remindAt) checkRemindAt(a.remindAt, c());
          if (a.due) checkDue(a.due, c());
          if (a.remindAt && a.noReminder) throw new TimeError('give a new reminder time or noReminder, not both');
          const current = o.todos.list.get(a.id);
          if (!current) return `Error: there is no item with id ${a.id}. Call todos_list for the ids.`;
          const saved = o.todos.list.update(a.id, (t) => {
            const next: Todo = { ...t, ...(a.text ? { text: a.text } : {}) };
            if (a.remindAt) {
              next.remindAt = a.remindAt;
              delete next.due;
            }
            if (a.noReminder) delete next.remindAt;
            if (a.due) {
              next.due = a.due;
              delete next.remindAt;
            }
            return next;
          })!;
          o.todos.card('updated', [saved]);
          return `Saved, and a card in the chat repeats it back:\n${line(saved, c())}\nSay what changed in one short line.`;
        }),
    },
    {
      def: toolByName('todo_done')!,
      label: 'Ticking it off…',
      auditArgs: counts,
      handler: async (args) => {
        const a = args as { ids: string[] };
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: o.timeZone }).format(now());
        const done: Todo[] = [];
        const unknown: string[] = [];
        for (const id of new Set(a.ids)) {
          const t = o.todos.list.get(id);
          if (!t) unknown.push(id);
          else if (t.done) done.push(t);
          else done.push(o.todos.list.update(id, (x) => ({ ...x, done: true, doneOn: today }))!);
        }
        if (done.length) o.todos.card('done', done);
        const missing = unknown.length ? `\nNo item has id ${unknown.join(', ')}; call todos_list for the ids.` : '';
        return done.length ? `Ticked off (a card in the chat has Not done to undo):\n${done.map((t) => line(t, c())).join('\n')}${missing}` : `Error: nothing was ticked off.${missing}`;
      },
    },
  ];
}
