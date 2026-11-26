/**
 * Unsubscribing from a mailing list (List-Unsubscribe, RFC 2369; one-click, RFC 8058). Code
 * reads the headers and decides how; the model only names the email. Every way out needs the
 * user's click on a card (mail/actions.ts), or for an unsubscribe email, Send on its draft.
 *
 * - One-click: an https link with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, offered
 *   only when the receiving server says the sender's DKIM signature passed and that signature
 *   covers both headers (RFC 8058 §3.1, §4). The click POSTs `List-Unsubscribe=One-Click` to it
 *   from code: no cookies, no sign-in, nothing else about the user (§3.2), no redirects
 *   followed, public addresses only (the same checked lookup as web_read).
 * - Link: any other http(s) link opens in the browser on the click, for the user to finish there.
 * - Email: a mailto: address becomes an ordinary draft card; only its Send click sends it.
 */
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import { checkWebLink, WebError } from '../web/open.js';
import { isPublicAddress, publicLookup } from '../web/read.js';

/** The headers the choice is made from, as fetched (each may appear more than once). */
export const UNSUBSCRIBE_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post', 'dkim-signature', 'authentication-results'] as const;

export type UnsubscribeWay =
  | { method: 'one_click'; url: string }
  | { method: 'link'; url: string }
  | { method: 'email'; to: string; subject: string; body: string };

const unfold = (raw: string) => raw.replace(/\r?\n[ \t]+/g, ' ');

/** Every value of header `name` in a fetched header block, in order, unfolded. */
export function headerValues(headers: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'gim');
  for (const m of unfold(headers).matchAll(re)) out.push(m[1]!.trim());
  return out;
}

/** The <…> entries of a List-Unsubscribe value, in the sender's order. */
export function unsubscribeLinks(value: string): string[] {
  return [...value.matchAll(/<([^<>\s]{1,2000})>/g)].map((m) => m[1]!);
}

const tagOf = (sig: string, tag: string) => new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;]*)`, 'i').exec(sig)?.[1]?.replace(/\s+/g, '') ?? null;

/**
 * RFC 8058's condition for one-click: the receiving server (the first Authentication-Results,
 * which Gmail and other providers add on top and strip from what senders write) reports a
 * passing DKIM signature, and a signature for that same domain lists both List-Unsubscribe and
 * List-Unsubscribe-Post in its h= tag. Code does not check signatures itself; it trusts the
 * user's own mail server's verdict, like the mail app does.
 */
export function dkimCoversUnsubscribe(headers: string): boolean {
  const results = headerValues(headers, 'authentication-results')[0];
  if (!results) return false;
  const passed = new Set<string>();
  for (const m of results.matchAll(/dkim=pass\b([^;]*)/gi)) {
    const d = /header\.d=([^\s;]+)/i.exec(m[1]!)?.[1] ?? /header\.i=[^\s;@]*@([^\s;]+)/i.exec(m[1]!)?.[1];
    if (d) passed.add(d.toLowerCase());
  }
  if (!passed.size) return false;
  return headerValues(headers, 'dkim-signature').some((sig) => {
    const d = tagOf(sig, 'd')?.toLowerCase();
    const h = (tagOf(sig, 'h') ?? '').toLowerCase().split(':');
    return !!d && passed.has(d) && h.includes('list-unsubscribe') && h.includes('list-unsubscribe-post');
  });
}

const Address = z.email().max(254);

/** A mailto: link as one address, a subject and a body (RFC 6068), or null when it isn't one plain address. */
export function parseMailto(link: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(link)) return null;
  const [rawTo = '', query = ''] = link.slice(7).split('?', 2);
  let to: string;
  try {
    to = decodeURIComponent(rawTo).trim();
  } catch {
    return null;
  }
  if (!Address.safeParse(to).success) return null;
  const params = new URLSearchParams(query);
  const line = (s: string | null, max: number) => (s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
  return { to, subject: line(params.get('subject'), 200).replace(/[\r\n]+/g, ' ').trim() || 'Unsubscribe', body: line(params.get('body'), 1000).trim() || 'Please unsubscribe me from this list.' };
}

/**
 * How to unsubscribe from the email with these headers, best first: one-click, then an email
 * (sent from the user's own account, so nothing about their browser reaches the sender), then a
 * page to open. Null when the email has no usable List-Unsubscribe.
 */
export function unsubscribeWay(headers: string): UnsubscribeWay | null {
  const value = headerValues(headers, 'list-unsubscribe')[0];
  if (!value) return null;
  const links = unsubscribeLinks(value);
  const web = links.flatMap((l) => {
    try {
      return [checkWebLink(l)];
    } catch {
      return [];
    }
  });
  const oneClickAsked = headerValues(headers, 'list-unsubscribe-post').some((v) => /^list-unsubscribe=one-click$/i.test(v.trim()));
  const https = web.find((u) => u.protocol === 'https:');
  if (oneClickAsked && https && dkimCoversUnsubscribe(headers)) return { method: 'one_click', url: https.href };
  const mail = links.map(parseMailto).find((m) => m !== null);
  if (mail) return { method: 'email', ...mail };
  const page = https ?? web[0];
  return page ? { method: 'link', url: page.href } : null;
}

export type PostOneClick = (url: string, signal: AbortSignal) => Promise<{ status: number }>;

const BODY = 'List-Unsubscribe=One-Click';

/**
 * RFC 8058's POST: the fixed body, nothing else. Public addresses only, checked in the
 * connection's own lookup; a redirect is an error (the sender must not send one).
 */
export function createOneClickPoster(o: { resolve?: Parameters<typeof publicLookup>[0]; allowAddresses?: string[]; timeoutMs?: number } = {}): PostOneClick {
  const allowed = new Set(o.allowAddresses ?? []);
  const lookup = publicLookup(o.resolve, allowed);
  return (url, signal) => {
    let u: URL;
    try {
      u = checkWebLink(url);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    if (u.protocol !== 'https:') return Promise.reject(new WebError('one-click unsubscribe needs an https link'));
    if (isIP(u.hostname) && !isPublicAddress(u.hostname) && !allowed.has(u.hostname)) return Promise.reject(new WebError('that link is on the local network'));
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        u,
        {
          method: 'POST',
          agent: false,
          lookup,
          signal,
          timeout: o.timeoutMs ?? 12_000,
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(BODY.length), 'user-agent': 'Astra unsubscribe' },
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve({ status });
          if (status >= 300 && status < 400) return reject(new WebError('the sender answered with a redirect instead of unsubscribing'));
          reject(new WebError(`the sender's site answered ${status}`));
        },
      );
      req.on('timeout', () => req.destroy(new WebError("the sender's site took too long to answer")));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof WebError) return reject(err);
        if (err.code === 'EPRIVATE') return reject(new WebError(err.message));
        reject(new WebError(`the sender's site could not be reached (${err.code ?? err.message})`));
      });
      req.end(BODY);
    });
  };
}
