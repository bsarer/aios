/**
 * Chat tools for apps (S3). apps_list is read tier. open_app is device tier: it runs from
 * the user's own message, is rate limited and refused while paused, and while an email is
 * in view it becomes a card the user confirms (systemTools wires that). It takes only an
 * app from the installed list: no command, file, link or option ever reaches the launcher.
 */
import { toolByName } from '../tools/definitions.js';
import type { SystemActions } from '../system/actions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { type AppBuilder, appName, appSlug } from './builder.js';
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

/**
 * build_app (S4, write tier): a model call only shows a Build card. The build runs from the
 * click (system/actions.ts), which hands it to the AppBuilder.
 */
export function buildAppTool(o: { builder: Pick<AppBuilder, 'build' | 'exists' | 'unavailable'>; actions: SystemActions }): RegisteredTool {
  o.actions.setAppBuilder(async (a) => {
    const r = await o.builder.build({ name: a.name, request: a.request });
    const cost = r.costUsd === null ? '' : ` It cost $${r.costUsd.toFixed(2)}.`;
    return {
      result: `${r.created ? 'Built' : 'Changed'} ${q(r.name)}.${r.summary ? ` ${r.summary}` : ''}${cost} Say “open ${r.name}” to start it.`,
      audit: { app: r.desktopId, created: r.created, costUsd: r.costUsd },
    };
  });
  return {
    def: toolByName('build_app')!,
    label: 'Getting the build ready…',
    deniedMessage: 'Error: only the user can start a build, by clicking Build on its card.',
    auditArgs: (args) => {
      const { name, request } = args as { name: string; request: string };
      return { name, requestChars: request.length };
    },
    handler: async () => 'Error: builds run only from the Build card.',
    propose: async (args) => {
      const { name: raw, request } = args as { name: string; request: string };
      const name = appName(raw);
      const slug = name ? appSlug(name) : null;
      if (!name || !slug) return `Error: ${q(raw)} can't be an app name; use a few letters or digits, e.g. "Pomodoro".`;
      const why = await o.builder.unavailable();
      if (why) return `Error: ${why} Tell the user.`;
      const update = o.builder.exists(slug);
      o.actions.propose({ action: 'build_app', name, slug, request: request.trim(), update });
      return {
        content: `A card now asks the user to confirm ${update ? `changing ${q(name)}` : `building ${q(name)}`}. Nothing happens until they click it; the build takes a few minutes and the card shows when it is done. Say that in one short line.`,
        audit: { app: slug, update },
      };
    },
  };
}
