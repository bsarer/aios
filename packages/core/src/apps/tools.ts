/**
 * Chat tools for apps (S3). apps_list is read tier. open_app is device tier: it runs from
 * the user's own message, is rate limited and refused while paused, and while an email is
 * in view it becomes a card the user confirms (systemTools wires that). It takes only an
 * app from the installed list: no command, file, link or option ever reaches the launcher.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import { StoppedError, type SystemActions } from '../system/actions.js';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { type AppBuilder, BuildError, type ClaudeLogin, appDesktopId, appName, appSlug } from './builder.js';
import type { BuildLog } from './history.js';
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

/** "3 min", "less than a minute", "2 h 5 min". */
export function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'less than a minute';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const capUsd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export interface BuildAppToolOptions {
  builder: Pick<AppBuilder, 'build' | 'exists' | 'unavailable' | 'login'>;
  actions: SystemActions;
  scan: () => Promise<DesktopApp[]>;
  log: BuildLog;
  /** The caps a Build card offers, e.g. [1, 2, 5]. */
  budgets: number[];
  /** Posts a chat item (the message when a build finishes). */
  post: (item: ChatItem) => void;
  /** A desktop notification; failures to show one are ignored. */
  notify: (title: string, body: string) => void;
  clock?: () => number;
  newId?: () => string;
}

/** The line under a Build card's title: the estimate, the cap, and what the dollars mean. */
function costNote(update: boolean, est: { medianUsd: number; count: number } | null, login: ClaudeLogin): string {
  const kind = update ? 'changes' : 'new builds';
  const parts = [
    est
      ? `Similar ${kind} cost about ${usd(est.medianUsd)} (median of ${est.count}).`
      : `There are no past ${kind} to estimate the cost from yet.`,
    'It stops when it reaches the cap you pick.',
    login === 'plan'
      ? "You're signed in with a Claude plan, so these dollar figures are what the work would cost at API prices; what really limits you is your plan's usage limits."
      : login === 'api'
        ? 'Dollar figures are Claude Code’s estimates at API prices; your API account is billed for the real use.'
        : 'Dollar figures are Claude Code’s estimates at API prices.',
  ];
  return parts.join(' ');
}

type Offer = { problem: 'unavailable'; why: string } | { problem: 'signed_out' } | { problem: null; card: string; update: boolean };

/**
 * Posts a Build or Change card, after checking Claude Code can run. Used by build_app and by an
 * app's own Change button (S5, link.ts). Builds nothing: that takes a click on the card.
 */
export async function offerBuild(
  o: Pick<BuildAppToolOptions, 'builder' | 'actions' | 'log' | 'budgets'>,
  b: { name: string; slug: string; request: string; fromApp?: boolean },
): Promise<Offer> {
  const why = await o.builder.unavailable();
  if (why) return { problem: 'unavailable', why };
  const login = await o.builder.login();
  if (login === 'none') return { problem: 'signed_out' };
  const update = o.builder.exists(b.slug);
  const note = costNote(update, o.log.estimate(!update), login);
  const card = o.actions.propose({
    action: 'build_app',
    name: b.name,
    slug: b.slug,
    request: b.request.trim(),
    update,
    budgets: o.budgets,
    note,
    ...(b.fromApp ? { fromApp: true } : {}),
  });
  return { problem: null, card: card.id, update };
}

/**
 * build_app (S4, write tier): a model call only shows a Build card. The build runs from the
 * click (system/actions.ts), which hands it to the AppBuilder; this records it, shows its
 * steps on the card, and posts a message and a desktop notification when it ends.
 */
export function buildAppTool(o: BuildAppToolOptions): RegisteredTool {
  const clock = o.clock ?? Date.now;
  const newId = o.newId ?? (() => `build-${randomUUID().slice(0, 8)}`);
  const finished = (actionId: string, ok: boolean, text: string, title: string, body: string) => {
    o.post({ kind: 'build_result', id: newId(), actionId, ok, text, at: clock() });
    o.notify(title, body);
  };
  o.actions.setAppBuilder(async (a, ctx) => {
    const started = clock();
    o.log.start({ id: ctx.id, name: a.name, slug: a.slug, created: !a.update, budgetUsd: ctx.budgetUsd, at: started });
    const onStep = (step: string) => {
      o.log.step(ctx.id, step);
      ctx.progress(`${step}…`);
    };
    try {
      const r = await o.builder.build({ name: a.name, request: a.request }, { signal: ctx.signal, onStep, maxBudgetUsd: ctx.budgetUsd });
      const took = duration(clock() - started);
      o.log.finish(ctx.id, { state: 'done', costUsd: r.costUsd, at: clock() });
      const cost = r.costUsd === null ? '' : ` About ${usd(r.costUsd)} at API prices.`;
      finished(ctx.id, true, `${q(r.name)} is ready${r.created ? '' : ' with your changes'}.${r.summary ? ` ${r.summary}` : ''}`, `${r.name} is ready`, 'Open it from the chat, or ask AI OS to open it.');
      return {
        result: `${r.created ? 'Built' : 'Changed'} ${q(r.name)} in ${took}.${r.summary ? ` ${r.summary}` : ''}${cost}`,
        audit: { app: r.desktopId, created: r.created, costUsd: r.costUsd },
      };
    } catch (err) {
      const took = duration(clock() - started);
      const costUsd = err instanceof BuildError ? err.costUsd : null;
      if (ctx.signal.aborted) {
        o.log.finish(ctx.id, { state: 'stopped', costUsd, at: clock() });
        throw new StoppedError(`Stopped after ${took}. ${a.update ? 'Some of its files may already be changed.' : "The app wasn't added."}`);
      }
      const why = (err as Error).message.slice(0, 200);
      o.log.finish(ctx.id, { state: 'failed', costUsd, error: why, at: clock() });
      finished(ctx.id, false, `Building ${q(a.name)} didn't work: ${why}.`, `Building ${a.name} didn't work`, why);
      throw err;
    }
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
      // An installed app with the same name would make "open <name>" ambiguous.
      const taken = (await o.scan()).find((a) => a.id !== appDesktopId(slug) && appSlug(a.name) === slug);
      if (taken) return `Error: ${q(taken.name)} is already the name of an installed app (id: ${shortId(taken.id)}). Pick a different name, e.g. "My ${name}", or ask the user for one.`;
      const offered = await offerBuild(o, { name, slug, request });
      if (offered.problem === 'unavailable') return `Error: ${offered.why} Tell the user.`;
      if (offered.problem === 'signed_out') return 'Error: Claude Code is installed but not signed in. Tell the user to open a terminal, run `claude` once and sign in, then ask again.';
      const { update } = offered;
      return {
        content: `A card in the chat now asks the user to confirm ${update ? `changing ${q(name)}` : `building ${q(name)}`} and pick a spending cap. Nothing starts until they click ${update ? 'Change' : 'Build'} on it; then the card shows each step, and a message comes when it is done. Tell them in one short line to click ${update ? 'Change' : 'Build'} on the card to start. Don't say how long it will take.`,
        audit: { app: slug, update },
      };
    },
  };
}

/** build_status (read tier): what builds are waiting, running, done or failed. Names and steps only. */
export function buildStatusTool(o: { log: BuildLog; actions: Pick<SystemActions, 'pendingBuilds'>; clock?: () => number }): RegisteredTool {
  const clock = o.clock ?? Date.now;
  return {
    def: toolByName('build_status')!,
    label: 'Checking on builds…',
    handler: async () => {
      const now = clock();
      const ago = (at: number) => `${duration(now - at)} ago`.replace('less than a minute ago', 'just now');
      const lines = o.actions.pendingBuilds().map((p) => `- ${q(p.name)}: waiting for the user to click Build on its card (shown ${ago(p.at)}). Nothing has started.`);
      for (const b of o.log.recent()) {
        const cost = b.costUsd === null ? '' : `, about ${usd(b.costUsd)} at API prices`;
        const took = b.finishedAt ? duration(b.finishedAt - b.startedAt) : '';
        switch (b.state) {
          case 'running':
            lines.push(`- ${q(b.name)}: building for ${duration(now - b.startedAt)}; now: ${b.step ?? 'starting Claude Code'}. It stops at ${capUsd(b.budgetUsd)} at most.`);
            break;
          case 'done':
            lines.push(`- ${q(b.name)}: ${b.created ? 'built' : 'changed'} ${ago(b.finishedAt ?? b.startedAt)}, in ${took}${cost}. open_app starts it.`);
            break;
          case 'stopped':
            lines.push(`- ${q(b.name)}: stopped by the user ${ago(b.finishedAt ?? b.startedAt)}, after ${took}.`);
            break;
          case 'failed':
            lines.push(`- ${q(b.name)}: failed ${ago(b.finishedAt ?? b.startedAt)}: ${b.error ?? 'unknown reason'}.`);
            break;
        }
      }
      return lines.length ? `App builds, newest first:\n${lines.join('\n')}` : 'No apps have been built yet, and no Build card is waiting.';
    },
  };
}

/**
 * The Open button on a finished build's message. It names the Build card, not an app: only an
 * app that card built opens, the same way open_app starts one, and it is audited like a tool call.
 */
export function builtAppOpener(o: { actions: Pick<SystemActions, 'builtApp'>; launch: Launch; window: Pick<ChatWindow, 'appStarting' | 'appFailed'>; audit: AuditLog; notice: (text: string) => void }) {
  return async (actionId: string): Promise<void> => {
    const app = o.actions.builtApp(actionId);
    const audit = (entry: Record<string, unknown>) => o.audit.append({ kind: 'tool', tool: 'open_app', tier: 'device', via: 'click', actionId, ...entry });
    if (!app) {
      audit({ decision: 'denied', reason: 'not a finished build' });
      return;
    }
    const id = appDesktopId(app.slug);
    audit({ decision: 'approved', app: id });
    await o.window.appStarting(app.name);
    try {
      await o.launch(id);
    } catch (err) {
      await o.window.appFailed(app.name);
      o.notice(`${app.name} didn't start: ${(err as Error).message.slice(0, 200)}`);
    }
  };
}
