/**
 * web_open (T8): opens one link or one web search in a new Chromium window, away from the chat
 * like any app (S7), and the screen goes with it. Device tier, like open_app and video_play:
 * it runs from the user's own message, is rate limited and refused while paused, and while an
 * email or other outside text is in view it becomes a confirm card naming the site (systemTools
 * wires that), so a link in an email never opens on its own.
 *
 * Nothing from the page comes back to the model: only the site's name, written by code.
 */
import type { ChatWindow } from '../apps/window.js';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { BROWSER_NAME, checkWebLink, type OpenLink, searchLink, WebError } from './open.js';

export interface WebToolsOptions {
  open: OpenLink;
  window: Pick<ChatWindow, 'appStarting' | 'appFailed'>;
  /** `[web] search`: the search address with %s for the words. */
  search: string;
}

export interface WebOpenArgs {
  url?: string;
  search?: string;
}

/** What the audit log keeps: a link's site (its path and query can carry tokens), a search's length. */
function auditOf(a: WebOpenArgs): Record<string, unknown> {
  if (a.search !== undefined) return { search: true, chars: a.search.length };
  try {
    return { host: checkWebLink(a.url ?? '').hostname };
  } catch {
    return { host: null };
  }
}

export function webTools(o: WebToolsOptions): RegisteredTool[] {
  return [
    {
      def: toolByName('web_open')!,
      label: 'Opening Chromium…',
      auditArgs: (args) => auditOf(args as WebOpenArgs),
      async handler(args) {
        const a = args as WebOpenArgs;
        let url: URL;
        try {
          url = a.search !== undefined ? searchLink(o.search, a.search) : checkWebLink(a.url ?? '');
        } catch (err) {
          if (err instanceof WebError) return `Error: ${err.message}.`;
          throw err;
        }
        const at = await o.window.appStarting(BROWSER_NAME);
        try {
          await o.open(url.href);
        } catch (err) {
          await o.window.appFailed(BROWSER_NAME);
          throw new Error(`Chromium didn't open: ${(err as Error).message}`);
        }
        const where = at && 'screen' in at ? ` on screen ${at.screen}` : at ? ` on workspace ${at.workspace}; Super+Shift+H or the AI button in the top bar brings the chat back` : '';
        const what = a.search !== undefined ? `A web search is open in Chromium (${url.hostname})` : `${url.hostname} is open in Chromium`;
        return { content: `${what}${where}. You can't see the page. Say it in one short line.`, audit: { ...auditOf(a), ...(at ?? {}) } };
      },
    },
  ];
}

/** /web's words: a link (with or without https://) opens as it is; anything else is searched for. */
export function pickWeb(text: string): { args: { url: string } | { search: string } } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Type /web and a link, or some words to search the web for.' };
  if (!/\s/.test(t)) {
    try {
      checkWebLink(t);
      return { args: { url: t } };
    } catch {
      // A link Chromium won't get is refused by web_open with its reason; a single word is a search.
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return { args: { url: t } };
    }
  }
  return { args: { search: t } };
}
