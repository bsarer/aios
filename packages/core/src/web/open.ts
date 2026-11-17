/**
 * Opening links and web searches in Chromium (T8, the opening part). Code decides everything
 * the browser gets: `--new-window` (so a running Chromium opens a window where the screen now
 * is, not a tab somewhere else), then `--` (the end of options), then exactly one http(s)
 * address checked by checkWebLink() or built by searchLink(). Started the way S3 starts apps,
 * through `uwsm-app --` when Omarchy has it, so the window outlives aios-core.
 *
 * Nothing comes back from the page: reading a page is a separate step.
 */
import { spawn } from 'node:child_process';
import { onPath } from '../apps/desktop.js';

/** The name the window rules (apps/window.ts) know the browser's start by. */
export const BROWSER_NAME = 'Chromium';

export type OpenLink = (url: string) => Promise<void>;

export class WebError extends Error {}

const EARLY_EXIT_MS = 1500;
const MAX_LINK_CHARS = 2000;
export const MAX_SEARCH_CHARS = 300;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** "bbc.com", "news.ycombinator.com/item?id=1": a site's name without its https://. */
const BARE_SITE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}(:\d{1,5})?([/?#]\S*)?$/i;

/**
 * A link the browser may open: http or https only (no file://, javascript:, chrome:// or
 * data:), no user name or password, nothing on this computer (localhost, 127.x, IPv6
 * addresses), so a link can't reach aios-core, a built app's /app-link/ or anything else
 * listening here. A site's name without https:// gets it. Addresses on the local network
 * (a router's page) are allowed: a link from outside text only ever opens after a click.
 */
export function checkWebLink(input: string): URL {
  let raw = input.trim();
  if (!raw || raw.length > MAX_LINK_CHARS || /[\s\p{Cc}\p{Cf}]/u.test(raw)) throw new WebError('that is not a link');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && BARE_SITE.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError('that is not a link');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebError('only http:// and https:// links can be opened');
  if (u.username || u.password) throw new WebError('links with a user name or password are not opened');
  // The parser has already turned 2130706433, 0x7f.1 and the like into dotted form.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) throw new WebError("links to an IPv6 address are not opened; use the site's name");
  if (host === 'localhost' || host.endsWith('.localhost') || (IPV4.test(host) && (host.startsWith('127.') || host.startsWith('0.')))) {
    throw new WebError('links to this computer are not opened');
  }
  return u;
}

/**
 * The search template from config ([web] search): https, with %s once. Checked again here so a
 * hand-edited config can't put another protocol or this computer in it.
 */
export function checkSearchTemplate(template: string): string {
  if (template.split('%s').length !== 2) throw new WebError('the search address in [web] search must contain %s once');
  const u = checkWebLink(template.replace('%s', 'x'));
  if (u.protocol !== 'https:') throw new WebError('the search address in [web] search must start with https://');
  return template;
}

/** The address of a web search for the words, from the config's template. */
export function searchLink(template: string, words: string): URL {
  const w = words.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w) throw new WebError('there is nothing to search for');
  if (w.length > MAX_SEARCH_CHARS) throw new WebError(`searches are at most ${MAX_SEARCH_CHARS} characters`);
  return checkWebLink(checkSearchTemplate(template).replace('%s', encodeURIComponent(w)));
}

/** The arguments the browser gets for a link (exported for tests). */
export function browserArgs(url: string): string[] {
  return ['--new-window', '--', checkWebLink(url).href];
}

export function createBrowserOpener(browser: string, env: NodeJS.ProcessEnv = process.env): OpenLink {
  return async (url) => {
    const args = browserArgs(url);
    const [cmd, all] = (await onPath('uwsm-app', env)) ? ['uwsm-app', ['--', browser, ...args]] : [browser, args];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, all, { shell: false, detached: true, stdio: 'ignore', env });
      // A running Chromium takes the window over and the new process exits at once; a first start keeps running.
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, EARLY_EXIT_MS);
      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new WebError(err.code === 'ENOENT' ? `${browser} is not installed (or not on the service's PATH)` : `${cmd} could not start: ${err.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new WebError(`the browser stopped at once (exit code ${code ?? 'unknown'})`));
      });
    });
  };
}
