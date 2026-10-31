/**
 * Google Calendar sign-in (C1), shared by `pnpm calendar:login` and `pnpm run setup`.
 * Listens once on http://127.0.0.1:<random port>, opens Google's consent page, takes the
 * code from the redirect (checking `state`), exchanges it with PKCE and puts the refresh
 * token straight into the keyring. The token is never printed or written anywhere else.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CalendarError, GoogleAuth, GoogleCalendar, authorizationUrl, describeCalendarError, exchangeCode, newPkce, readRedirect } from '@aios/core';
import type { CalendarConfig, SecretRef } from '@aios/shared';

/** The part of the keyring the sign-in uses. */
export interface TokenStore {
  get(ref: SecretRef): Promise<{ reveal(): string } | null>;
  set(ref: SecretRef, value: string): Promise<void>;
}

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>AI OS</title><body style="font:16px system-ui;margin:3em">${text.replace(/[<>&]/g, '')}</body>`;

/** Opens a URL in the desktop's browser; failures are fine, the URL is printed too. */
export function xdgOpen(url: string): void {
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

export interface SignInOptions {
  /** Called with Google's consent page; default opens the browser. */
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
  loginHint?: string;
}

/** Runs the browser sign-in and stores the refresh token. Returns how many events the next week holds, as a check. */
export async function signInToCalendar(cal: CalendarConfig, keyring: TokenStore, timeZone: string, o: SignInOptions = {}): Promise<number> {
  const log = o.log ?? console.log;
  const pkce = newPkce();
  let done: (r: { code: string } | { error: string }) => void = () => undefined;
  const answer = new Promise<{ code: string } | { error: string }>((r) => (done = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Browsers also ask for /favicon.ico; only the redirect itself counts.
    if (url.pathname !== '/') return void res.writeHead(404).end();
    const r = readRedirect(url, pkce.state);
    res.writeHead('code' in r ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE('code' in r ? 'AI OS is connected to your calendar. You can close this tab.' : `Sign-in did not finish: ${r.error}. Close this tab and try again.`));
    done(r);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = authorizationUrl({ authUrl: cal.authUrl, clientId: cal.clientId, redirectUri, pkce, loginHint: o.loginHint });
    log(`Opening Google's sign-in page. If no browser opens, visit:\n\n  ${url}\n`);
    (o.openBrowser ?? xdgOpen)(url);
    const timeout = new Promise<{ error: string }>((r) => setTimeout(() => r({ error: 'timed out waiting for the browser' }), o.timeoutMs ?? 5 * 60_000).unref());
    const r = await Promise.race([answer, timeout]);
    if ('error' in r) throw new CalendarError('auth', r.error);
    const clientSecret = cal.clientSecretRef ? ((await keyring.get(cal.clientSecretRef))?.reveal() ?? null) : null;
    const { refreshToken } = await exchangeCode({ tokenUrl: cal.tokenUrl, clientId: cal.clientId, clientSecret, code: r.code, redirectUri, verifier: pkce.verifier });
    await keyring.set(cal.tokenRef, refreshToken);
  } finally {
    server.close();
  }

  // Check it works with what is now in the keyring.
  const auth = new GoogleAuth({
    tokenUrl: cal.tokenUrl,
    clientId: cal.clientId,
    clientSecret: async () => (cal.clientSecretRef ? ((await keyring.get(cal.clientSecretRef))?.reveal() ?? null) : null),
    refreshToken: async () => (await keyring.get(cal.tokenRef))?.reveal() ?? null,
  });
  const api = new GoogleCalendar({ apiBaseUrl: cal.apiBaseUrl, calendarId: cal.calendarId, auth });
  const now = Date.now();
  try {
    return (await api.list({ timeMin: new Date(now), timeMax: new Date(now + 7 * 86_400_000), limit: 250, timeZone })).length;
  } catch (err) {
    throw new Error(`signed in, but reading the calendar failed: ${describeCalendarError(err)}`);
  }
}
