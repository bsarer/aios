/**
 * Opens a routine file in the user's editor, from their click on Open in editor. Without a shell:
 * `[routines] editor` (a program that opens a window, e.g. "gnome-text-editor"), given the path
 * after `--`; otherwise a terminal running $VISUAL or $EDITOR (Omarchy's default is Neovim),
 * else nvim, with the path. The program names are checked; the path is the routine file the
 * caller resolved. Started through `uwsm-app --` when Omarchy has it, so the window outlives Astra.
 */
import { isAbsolute } from 'node:path';
import { onPath } from '../apps/desktop.js';
import { startDetached, TERMINALS } from '../update.js';

const PROGRAM = /^[A-Za-z0-9/_.+-]{1,200}$/;

export function createRoutineEditor(o: {
  editor?: string;
  env?: NodeJS.ProcessEnv;
  start?: (cmd: string, args: string[]) => Promise<void>;
  has?: (cmd: string) => Promise<boolean>;
}): (path: string) => Promise<string> {
  const env = o.env ?? process.env;
  const start = o.start ?? startDetached(env);
  const has = o.has ?? ((c: string) => onPath(c, env));
  return async (path) => {
    if (!isAbsolute(path) || !path.endsWith('.md')) throw new Error('internal: routine paths must be absolute');
    const launch = async (args: string[]) => ((await has('uwsm-app')) ? start('uwsm-app', ['--', ...args]) : start(args[0]!, args.slice(1)));
    if (o.editor) {
      if (!PROGRAM.test(o.editor)) throw new Error('[routines] editor must be one program name, like gnome-text-editor');
      if (!(await has(o.editor))) throw new Error(`${o.editor} is not installed`);
      await launch([o.editor, '--', path]);
      return o.editor;
    }
    // Only the first word of $VISUAL or $EDITOR, checked like a program name.
    const fromEnv = [env.VISUAL, env.EDITOR].map((v) => v?.trim().split(/\s+/)[0] ?? '').find((v) => v && PROGRAM.test(v));
    const editor = fromEnv ?? 'nvim';
    if (!(await has(editor))) throw new Error(`${editor} is not installed. Set editor under [routines] in your config`);
    let term: [string, string[]] | undefined;
    for (const t of TERMINALS) if (await has(t[0])) { term = t; break; }
    if (!term) throw new Error('no terminal was found');
    await launch([term[0], ...term[1], editor, path]);
    return editor;
  };
}
