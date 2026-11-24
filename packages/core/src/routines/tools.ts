/**
 * The chat's routine tools. routine_show (read) lists the routines or shows one routine's file,
 * also on a card with Open in editor and Run. routine_change (write) only posts a card with the
 * change; RoutineActions.confirm writes it on the user's Save click. Neither runs a routine:
 * only the user's phrase, /run or the schedule does (Shell.handle, scheduler.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { type RoutineActions, RoutineError } from './actions.js';
import { type Routine, type RoutineFolder, scheduleText } from './routines.js';

export function routineLine(r: Routine): string {
  const say = r.say.length ? `say ${r.say.map((p) => `"${p}"`).join(' or ')}` : `/run ${r.slug}`;
  return `${r.name} (file ${r.slug}.md): ${say}${r.schedule ? `; runs ${scheduleText(r.schedule)}` : ''}`;
}

/** A routine card: the file as plain text. */
export function routineCard(folder: RoutineFolder, r: Routine, text: string, at: number): Extract<ChatItem, { kind: 'routine' }> {
  return { kind: 'routine', id: `routine-${randomUUID().slice(0, 8)}`, slug: r.slug, name: r.name, file: `${folder.display}/${r.slug}.md`, text, at };
}

export function routineTools(o: { folder: RoutineFolder; actions: RoutineActions; post: (item: ChatItem) => void; clock?: () => number }): RegisteredTool[] {
  const clock = o.clock ?? Date.now;
  return [
    {
      def: toolByName('routine_show')!,
      label: 'Looking at your routines…',
      handler: async (args) => {
        const { name } = args as { name?: string };
        const { routines, problems } = o.folder.load();
        const where = `The files are in ${o.folder.display}.`;
        if (!name) {
          const lines = routines.map((r) => `- ${routineLine(r)}`);
          const bad = problems.map((p) => `- ${p.file} won't run: ${p.error}`);
          return [routines.length ? `The user's routines:` : 'The user has no routines yet.', ...lines, ...(bad.length ? ['Files with a problem:', ...bad] : []), where, 'routine_show with a name shows one; routine_change changes or adds one. /routines shows them on a card with buttons.'].join('\n');
        }
        const r = o.folder.byName(name);
        if (!r) return `There is no routine called "${name}". ${routines.length ? `There are: ${routines.map((x) => x.name).join(', ')}.` : 'There are none yet.'} ${where}`;
        const text = o.folder.read(r.slug) ?? '';
        o.post(routineCard(o.folder, r, text, clock()));
        return `A card now shows the user ${r.name} (${o.folder.display}/${r.slug}.md) with Open in editor and Run buttons, so don't repeat the file; say one short line. Its file:\n${text}`;
      },
    },
    {
      def: toolByName('routine_change')!,
      label: 'Preparing the routine…',
      // Write tier: the registry never calls this; only propose runs.
      handler: async () => {
        throw new Error('routine changes are saved only from a click on their card');
      },
      propose: async (args, ctx) => {
        if (ctx.unattended) return 'Error: a routine that started on its schedule can\'t change routines. Suggest the change in your reply instead.';
        const { file, text } = args as { file: string; text: string };
        try {
          const r = o.actions.propose(file, text);
          return `A card now shows the user the ${r.isNew ? 'new routine' : 'changes to'} ${r.name} line by line. Nothing is saved until they click Save, so don't say it is done; say so in one line.`;
        } catch (err) {
          if (err instanceof RoutineError) return `Error: ${err.message}`;
          throw err;
        }
      },
    },
  ];
}
