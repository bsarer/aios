/**
 * Chat tools for apps (S3). apps_list is read tier. open_app is device tier: it runs from
 * the user's own message, is rate limited and refused while paused, and while an email is
 * in view it becomes a card the user confirms (systemTools wires that). It takes only an
 * app from the installed list: no command, file, link or option ever reaches the launcher.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { type DesktopApp, findApp, searchApps, shortId } from './desktop.js';
import type { Launch } from './launcher.js';
import type { ChatWindow } from './window.js';

const MAX_LISTED = 80;
const q = (s: string) => `“${s}”`;

export interface AppToolsOptions {
  scan: () => Promise<DesktopApp[]>;
  launch: Launch;
  window: Pick<ChatWindow, 'appStarting' | 'appFailed'>;
}

const line = (a: DesktopApp) => `- ${a.name} (id: ${shortId(a.id)})${a.terminal ? ', runs in a terminal' : ''}${a.comment ? `: ${a.comment}` : ''}`;

export function appTools(o: AppToolsOptions): RegisteredTool[] {
  return [
    {
      def: toolByName('apps_list')!,
      label: 'Looking at your apps…',
      handler: async (args) => {
        const query = (args as { query?: string }).query ?? '';
        const all = await o.scan();
        const found = searchApps(all, query);
        if (!found.length) return query ? `No installed app matches ${q(query)}. ${all.length} apps are installed; try another word or no query.` : 'No apps found.';
        const shown = found.slice(0, MAX_LISTED);
        const more = found.length - shown.length;
        return `${found.length} app${found.length === 1 ? '' : 's'}${query ? ` matching ${q(query)}` : ' installed'}:\n${shown.map(line).join('\n')}${more ? `\n…and ${more} more; give a query to narrow the list.` : ''}`;
      },
    },
    {
      def: toolByName('open_app')!,
      label: 'Opening the app…',
      handler: async (args) => {
        const want = (args as { app: string }).app;
        const found = findApp(await o.scan(), want);
        if (!found) return `Error: no installed app is called ${q(want)}. Call apps_list to find its id.`;
        if (Array.isArray(found)) return `Error: several apps are called ${q(want)}: ${found.map((a) => shortId(a.id)).join(', ')}. Ask the user which one, then use its id.`;
        await o.window.appStarting(found.name);
        try {
          await o.launch(found.id);
        } catch (err) {
          await o.window.appFailed(found.name);
          throw new Error(`${found.name} didn't start: ${(err as Error).message}`);
        }
        return {
          content: `Started ${found.name}. The chat is now the red orb at the top of the screen; it comes back full screen when ${found.name} is closed, and the user can click the orb to talk to you meanwhile. Say it in one short line.`,
          audit: { app: found.id, name: found.name },
        };
      },
    },
  ];
}
