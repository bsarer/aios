/**
 * `astra spotify-login` (MU2): lets the chat play a song by name. Asks for the Client ID and
 * secret of the user's own Spotify developer app (developer.spotify.com/dashboard, free; Spotify
 * asks that the app's owner has Premium), checks them with one token request and one search,
 * then keeps the secret in the keyring and the Client ID (not a secret) in config.toml. The
 * secret is read with echo off, is never printed, and is never put in an error.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { describeSpotifyError, Keyring, SpotifySearch } from '@aios/core';
import { type AiosConfig, configDir, parseConfig, type SecretRef, serializeConfig } from '@aios/shared';
import { terminalPrompter } from './prompt.js';
import type { Prompter } from './setup-lib.js';

export interface SpotifyLoginDeps {
  prompter: Prompter;
  config: AiosConfig;
  /** Checks the pair; resolves to null when they work, or one reason written by code. */
  check: (clientId: string, secret: string, c: AiosConfig) => Promise<string | null>;
  storeSecret: (ref: SecretRef, value: string) => Promise<void>;
  writeConfig: (c: AiosConfig) => Promise<void>;
  /** The country guessed from the locale, e.g. "TR" from tr_TR.UTF-8. */
  country?: string;
}

/** "tr_TR.UTF-8" → "TR"; anything else → undefined (exported for tests). */
export function countryFromLocale(lang: string | undefined): string | undefined {
  const m = /^[a-z]{2,3}_([A-Z]{2})\b/.exec(lang ?? '');
  return m?.[1];
}

/** Returns the line to print at the end. Throws with a reason (never the secret) when something is wrong. */
export async function spotifyLogin(d: SpotifyLoginDeps): Promise<string> {
  const p = d.prompter;
  const sp = d.config.music.spotify;
  const clientId = (await p.ask('Client ID of your Spotify developer app', sp.clientId ? { default: sp.clientId } : {})).trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) throw new Error('that does not look like a Spotify Client ID (letters and digits, from the app’s Settings page)');
  const secret = (await p.ask('Client secret (it is not shown as you type)', { secret: true })).trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(secret)) throw new Error('that does not look like a Spotify client secret (letters and digits, from the app’s Settings page)');
  const market = (await p.ask('Your country, as two letters (the songs you can play depend on it)', { default: sp.clientId ? sp.market : (d.country ?? sp.market) })).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw new Error('the country should be two letters, such as US or TR');
  const config: AiosConfig = { ...d.config, music: { ...d.config.music, spotify: { ...sp, clientId, market } } };
  const problem = await d.check(clientId, secret, config);
  if (problem) throw new Error(problem);
  await d.storeSecret(sp.clientSecretRef, secret);
  await d.writeConfig(config);
  return 'Spotify search works. Restart Astra (systemctl --user restart astra) and ask it to play a song, with Spotify open.';
}

/** The real check: one token request and one search through the same code the chat uses. */
export async function checkSpotify(clientId: string, secret: string, c: AiosConfig): Promise<string | null> {
  const sp = c.music.spotify;
  const search = new SpotifySearch({ clientId, clientSecret: async () => secret, market: sp.market, apiBaseUrl: sp.apiBaseUrl, tokenUrl: sp.tokenUrl });
  try {
    await search.findTrack('Bohemian Rhapsody');
    return null;
  } catch (err) {
    return describeSpotifyError(err);
  }
}

async function main(): Promise<void> {
  const path = `${configDir()}/config.toml`;
  const config = parseConfig(await readFile(path, 'utf8'));
  const keyring = new Keyring();
  if (!(await keyring.available())) throw new Error('secret-tool not found; install libsecret first');
  console.log('Make a free app at https://developer.spotify.com/dashboard (any name; tick "Web API"; any redirect URI, e.g. http://127.0.0.1:8888/callback), then open its Settings for the Client ID and secret.');
  const prompter = terminalPrompter();
  try {
    const country = countryFromLocale(process.env.LC_ALL || process.env.LANG);
    const line = await spotifyLogin({
      prompter,
      config,
      check: checkSpotify,
      storeSecret: (ref, v) => keyring.set(ref, v),
      writeConfig: async (c) => writeFile(path, serializeConfig(c), { mode: 0o600 }),
      ...(country ? { country } : {}),
    });
    console.log(line);
  } finally {
    prompter.close();
  }
}

if (process.argv[1]?.endsWith('spotify-login.ts')) {
  main().catch((err: unknown) => {
    console.error(`Spotify setup failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
