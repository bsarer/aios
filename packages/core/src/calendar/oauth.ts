/**
 * The one-time Google sign-in for the calendar (C1), as Google describes it for desktop
 * apps: the browser opens Google's consent page, Google redirects to a listener on
 * http://127.0.0.1:<port>, and the code is exchanged with PKCE (S256) for a refresh token.
 * `state` guards the redirect against forgery. Checked 2026-10-31 against
 * https://developers.google.com/identity/protocols/oauth2/native-app.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CALENDAR_SCOPE, CalendarError } from './google.js';

const b64url = (b: Buffer) => b.toString('base64url');

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function newPkce(): Pkce {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(24)) };
}

export function authorizationUrl(o: { authUrl: string; clientId: string; redirectUri: string; pkce: Pkce; loginHint?: string | undefined }): string {
  const u = new URL(o.authUrl);
  const params: Record<string, string> = {
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    code_challenge: o.pkce.challenge,
    code_challenge_method: 'S256',
    state: o.pkce.state,
    // A refresh token every time, also when signing in again.
    access_type: 'offline',
    prompt: 'consent',
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** What came back to the redirect listener: the code, or why there is none. */
export function readRedirect(url: URL, expectedState: string): { code: string } | { error: string } {
  if (url.searchParams.get('state') !== expectedState) return { error: 'the sign-in answer did not match this request (state mismatch)' };
  const error = url.searchParams.get('error');
  if (error) return { error: error === 'access_denied' ? 'access was not granted' : error };
  const code = url.searchParams.get('code');
  return code ? { code } : { error: 'Google sent no code' };
}

const Tokens = z.object({ access_token: z.string(), refresh_token: z.string().min(1).optional(), scope: z.string().optional() });

/** Exchange the code for tokens. Returns the refresh token; it goes straight to the keyring. */
export async function exchangeCode(o: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  verifier: string;
  fetch?: typeof fetch;
}): Promise<{ refreshToken: string; scopes: string[] }> {
  const body = new URLSearchParams({
    client_id: o.clientId,
    code: o.code,
    code_verifier: o.verifier,
    grant_type: 'authorization_code',
    redirect_uri: o.redirectUri,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
  });
  const res = await (o.fetch ?? fetch)(o.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = z.object({ error: z.string(), error_description: z.string().optional() }).safeParse(json);
    throw new CalendarError('auth', e.success ? `${e.data.error}${e.data.error_description ? `: ${e.data.error_description}` : ''}` : `token endpoint answered ${res.status}`, res.status);
  }
  const t = Tokens.safeParse(json);
  if (!t.success || !t.data.refresh_token) throw new CalendarError('auth', 'Google returned no refresh token');
  const scopes = (t.data.scope ?? '').split(' ').filter(Boolean);
  if (scopes.length && !scopes.includes(CALENDAR_SCOPE)) throw new CalendarError('auth', 'calendar access was not granted (tick the calendar box on the consent page)');
  return { refreshToken: t.data.refresh_token, scopes };
}
