/**
 * Finding a song on Spotify by name (MU2), with plain fetch. Two endpoints, each answer checked
 * with zod, checked 2026-11-17 against developer.spotify.com:
 * - the Client Credentials flow: POST `[music.spotify] tokenUrl` with HTTP Basic auth of the
 *   user's own developer app and `grant_type=client_credentials` (no sign-in of their account,
 *   so nothing here can read or change their library);
 * - Search for Item: GET `{apiBaseUrl}/search?q=…&type=track&market=…&limit=…`, limit at most 10
 *   since February 2026.
 *
 * Code picks the song (the first playable result) and builds its URI from an id that must be 22
 * letters and digits, so nothing a song's publisher wrote reaches playerctl. Song names are
 * outside text: they are only returned to callers that show them as plain text or wrap them.
 * The access token lives in memory only; the secret is read from the keyring for each token.
 */
import { z } from 'zod';

export type SpotifyErrorKind = 'not_set_up' | 'auth' | 'forbidden' | 'rate' | 'server' | 'network' | 'bad_request';

export class SpotifyError extends Error {
  override readonly name = 'SpotifyError';
  constructor(
    readonly kind: SpotifyErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** One short reason for the chat, written by code. */
export function describeSpotifyError(err: unknown): string {
  if (err instanceof SpotifyError) {
    switch (err.kind) {
      case 'not_set_up':
        return "playing a song by name isn't set up yet. Run `astra spotify-login` once (it asks for a free Spotify developer app's Client ID and secret)";
      case 'auth':
        return "Spotify didn't accept the developer app's Client ID or secret. Run `astra spotify-login` again";
      case 'forbidden':
        return "Spotify refused the search (its developer apps need the owner's Premium subscription to be active)";
      case 'rate':
        return 'Spotify is limiting searches; try again in a minute';
      case 'server':
        return 'Spotify had a problem; try again shortly';
      case 'network':
        return "Spotify can't be reached. Check the network connection";
      case 'bad_request':
        return 'Spotify refused the search';
    }
  }
  if ((err as Error)?.name === 'KeyringError') return "the Spotify secret isn't readable from the keyring (it may still be locked)";
  return 'the Spotify search failed';
}

/** A Spotify track id: base-62, 22 characters. */
export const TRACK_ID = /^[A-Za-z0-9]{22}$/;

export interface SpotifyTrack {
  id: string;
  /** Outside text (the publisher's own words). */
  name: string;
  artists: string[];
  album: string;
}

const TokenResponse = z.object({ access_token: z.string().min(1), token_type: z.string(), expires_in: z.number().positive() });
const SearchResponse = z.object({
  tracks: z.object({
    items: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          artists: z.array(z.object({ name: z.string() })).default([]),
          album: z.object({ name: z.string() }).optional(),
          is_playable: z.boolean().optional(),
        })
        .nullable(),
    ),
  }),
});

type Fetch = typeof fetch;

export interface SpotifySearchOptions {
  clientId: string;
  /** From the keyring; null when `astra spotify-login` hasn't stored it. */
  clientSecret: () => Promise<string | null>;
  market: string;
  apiBaseUrl: string;
  tokenUrl: string;
  fetch?: Fetch;
  clock?: () => number;
}

const timeout = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000));

function httpError(status: number, what: string): SpotifyError {
  if (status === 401 || status === 400) return new SpotifyError(status === 401 ? 'auth' : 'bad_request', `${what} answered ${status}`, status);
  if (status === 403) return new SpotifyError('forbidden', `${what} answered 403`, status);
  if (status === 429) return new SpotifyError('rate', `${what} answered 429`, status);
  return new SpotifyError(status >= 500 ? 'server' : 'bad_request', `${what} answered ${status}`, status);
}

export class SpotifySearch {
  private token: { value: string; expires: number } | null = null;
  private readonly fetch: Fetch;
  private readonly clock: () => number;

  constructor(private readonly o: SpotifySearchOptions) {
    this.fetch = o.fetch ?? fetch;
    this.clock = o.clock ?? Date.now;
  }

  /** The first playable track for the words, or null when Spotify finds none. */
  async findTrack(query: string, signal?: AbortSignal): Promise<SpotifyTrack | null> {
    const q = query.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, 200);
    if (!q) return null;
    const url = new URL(`${this.o.apiBaseUrl.replace(/\/$/, '')}/search`);
    url.search = new URLSearchParams({ q, type: 'track', market: this.o.market, limit: '5' }).toString();
    let res = await this.get(url, signal);
    if (res.status === 401) {
      // The token may have expired early: one fresh token, then give up.
      this.token = null;
      res = await this.get(url, signal);
    }
    if (!res.ok) throw httpError(res.status, 'search');
    const parsed = SearchResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SpotifyError('server', 'the search sent something unexpected');
    for (const t of parsed.data.tracks.items) {
      if (!t || !TRACK_ID.test(t.id) || t.is_playable === false) continue;
      return { id: t.id, name: t.name, artists: t.artists.map((a) => a.name), album: t.album?.name ?? '' };
    }
    return null;
  }

  private async get(url: URL, signal?: AbortSignal): Promise<Response> {
    const token = await this.accessToken(signal);
    try {
      return await this.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: timeout(signal) });
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      throw new SpotifyError('network', 'search failed to connect');
    }
  }

  /** Exported for `astra spotify-login`'s check. */
  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expires > this.clock()) return this.token.value;
    const secret = await this.o.clientSecret();
    if (!secret) throw new SpotifyError('not_set_up', 'no client secret in the keyring');
    let res: Response;
    try {
      res = await this.fetch(this.o.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.o.clientId}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
        signal: timeout(signal),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      throw new SpotifyError('network', 'the token request failed to connect');
    }
    // Spotify answers a wrong Client ID or secret with 400 invalid_client.
    if (res.status === 400 || res.status === 401) throw new SpotifyError('auth', `token endpoint answered ${res.status}`, res.status);
    if (!res.ok) throw httpError(res.status, 'token endpoint');
    const t = TokenResponse.safeParse(await res.json().catch(() => null));
    if (!t.success) throw new SpotifyError('server', 'the token endpoint sent something unexpected');
    this.token = { value: t.data.access_token, expires: this.clock() + Math.max(0, t.data.expires_in - 60) * 1000 };
    return t.data.access_token;
  }
}
