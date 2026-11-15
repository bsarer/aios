/**
 * Reading a web page (T8, the reading part). aios-core fetches the page itself; no browser is
 * driven, so nothing reaches the user's own Chromium profile, its cookies or its sign-ins.
 *
 * - The address passes checkWebLink() (http/https, no credentials, nothing on this computer),
 *   and every address it resolves to must be a public one: the connection's own DNS lookup is
 *   checked (lookup below), so a name can't be switched to 192.168.x or 127.x between the check
 *   and the connection, and each redirect is checked again. So a page can't make Astra reach the
 *   router, a printer or aios-core.
 * - At most `maxBytes` of text/html, text/plain or XHTML, a time limit, a few redirects.
 * - The page text is untrusted, like email: the tool returns it sanitized inside
 *   <untrusted source="web">, so anything after it is tainted (no write or device tools).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { checkWebLink, WebError } from './open.js';

export interface WebPage {
  /** The address the text came from, after redirects. */
  url: string;
  /** The page's <title>, raw (sanitize before use). */
  title: string;
  /** The page as plain text, raw (sanitize before use). */
  text: string;
}

export type FetchPage = (url: string, signal: AbortSignal) => Promise<WebPage>;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;
const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml)\b/i;

/** Addresses that are not on the public internet. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** True for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1) counts as that IPv4 address.
    const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
    if (mapped) return isIP(mapped) === 4 && !PRIVATE.check(mapped, 'ipv4');
    return !PRIVATE.check(address, 'ipv6');
  }
  return false;
}

type Resolve = (host: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/** A lookup for the connection that only ever hands it public addresses. */
export function publicLookup(resolve: Resolve = systemResolve, allowed: ReadonlySet<string> = new Set()): LookupFunction {
  return (host, options, callback) => {
    const literal = isIP(host);
    const found = literal ? Promise.resolve([{ address: host, family: literal }]) : resolve(host);
    found.then(
      (addrs) => {
        const ok = addrs.filter((a) => isPublicAddress(a.address) || allowed.has(a.address));
        if (!addrs.length) return callback(Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' }), '', 0);
        if (ok.length !== addrs.length) return callback(Object.assign(new Error('that site is on this computer or the local network'), { code: 'EPRIVATE' }), '', 0);
        if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, ok);
        callback(null, ok[0]!.address, ok[0]!.family);
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, '', 0),
    );
  };
}

/** <title>, then the page as plain text: scripts, styles, menus and other chrome left out. */
export function pageText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript|template|svg|nav|footer|form|iframe|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // Hidden text is where a page puts words for machines, not readers.
    .replace(/<([a-z0-9]+)\b[^>]*\s(hidden|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
      try {
        if (/^#x/i.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
        if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
      } catch {
        return ' ';
      }
      return named[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: body };
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

function charsetOf(type: string): BufferEncoding | 'windows-1252' {
  const cs = /charset=["']?([\w-]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252') return 'windows-1252';
  return 'utf8';
}

export interface FetcherOptions {
  maxBytes: number;
  /** Tests: a pretend DNS. */
  resolve?: Resolve;
  /** Tests only: these private addresses count as public (a local test server behind a pretend name). */
  allowAddresses?: string[];
}

export function createPageFetcher(o: FetcherOptions): FetchPage {
  const allowed = new Set(o.allowAddresses ?? []);
  const lookup = publicLookup(o.resolve, allowed);
  const check = (raw: string): URL => {
    const u = checkWebLink(raw);
    // checkWebLink lets local-network addresses through for opening; reading never goes there.
    if (isIP(u.hostname) && !isPublicAddress(u.hostname) && !allowed.has(u.hostname)) throw new WebError('pages on the local network are not read');
    return u;
  };

  const once = (u: URL, signal: AbortSignal): Promise<{ redirect: string } | WebPage> =>
    new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: 'GET',
          // A fresh connection each time, so every one goes through the checked lookup.
          agent: false,
          lookup,
          signal,
          timeout: TIMEOUT_MS,
          headers: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Astra page reader',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return resolve({ redirect: new URL(res.headers.location, u).href });
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return reject(new WebError(`the site answered ${status}${status === 401 || status === 403 ? ' (it may need a sign-in, which Astra does not have)' : ''}`));
          }
          const type = String(res.headers['content-type'] ?? 'text/html');
          if (!TEXT_TYPES.test(type)) {
            res.resume();
            return reject(new WebError(`that address is not a web page (${type.split(';')[0]!.slice(0, 60)})`));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const body = decoded(res);
          body.on('data', (c: Buffer) => {
            size += c.length;
            if (size > o.maxBytes) {
              // Enough to read: keep what came, stop the rest.
              chunks.push(c.subarray(0, Math.max(0, c.length - (size - o.maxBytes))));
              req.destroy();
              body.removeAllListeners('data');
              finish();
              return;
            }
            chunks.push(c);
          });
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            const buf = Buffer.concat(chunks);
            const raw = charsetOf(type) === 'windows-1252' ? new TextDecoder('windows-1252').decode(buf) : buf.toString('utf8');
            const page = /^text\/plain/i.test(type) ? { title: '', text: raw } : pageText(raw);
            resolve({ url: u.href, ...page });
          };
          body.on('end', finish);
          body.on('error', (err: Error) => (done ? undefined : reject(new WebError(`the page could not be read: ${err.message}`))));
        },
      );
      req.on('timeout', () => req.destroy(new WebError('the site took too long to answer')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof WebError) return reject(err);
        if (err.code === 'EPRIVATE') return reject(new WebError(err.message));
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return reject(new WebError(`there is no site called ${u.hostname}, or this computer is offline`));
        reject(new WebError(`the site could not be reached (${err.code ?? err.message})`));
      });
      req.end();
    });

  return async (url, signal) => {
    let u = check(url);
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const r = await once(u, signal);
      if (!('redirect' in r)) return r;
      u = check(r.redirect);
    }
    throw new WebError('the page redirects too many times');
  };
}
