/**
 * MU2: `astra spotify-login`. Checks the pair before keeping anything, keeps the secret only in
 * the keyring and the Client ID in config, and never puts the secret in an error. Pretend
 * prompter, check and keyring; no network.
 */
import { type AiosConfig, parseConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { route } from '../src/astra.js';
import { countryFromLocale, spotifyLogin } from '../src/spotify-login.js';
import type { Prompter } from '../src/setup-lib.js';

const ID = 'abcdef0123456789abcdef0123456789';
const SECRET = 'sEcReT0123456789abcdef0123456789';
const TOML = `[user]\nname = "J"\ntimezone = "UTC"\n[models.chat]\nbaseUrl = "https://x.test/v1"\nmodel = "m"\napiKeyRef = "keyring:a"\n[models.triage]\nbaseUrl = "https://x.test/v1"\nmodel = "m"\napiKeyRef = "keyring:a"\n[models.nightly]\nbaseUrl = "https://x.test/v1"\nmodel = "m"\napiKeyRef = "keyring:a"\n[mail]\naddress = "j@aios.test"\nusername = "j"\npasswordRef = "keyring:m"\nimap = { host = "127.0.0.1", port = 3143, tls = false }\nsmtp = { host = "127.0.0.1", port = 3025, tls = false }\n`;
const base = (): AiosConfig => parseConfig(TOML);

function answers(list: string[]): Prompter & { secretAsked: boolean } {
  const p = {
    secretAsked: false,
    async ask(_q: string, opts?: { default?: string; secret?: boolean }) {
      if (opts?.secret) p.secretAsked = true;
      return list.shift() || opts?.default || '';
    },
    async confirm() {
      return true;
    },
  };
  return p;
}

describe('astra spotify-login (MU2)', () => {
  it('checks the pair, then keeps the secret in the keyring and the Client ID and country in config', async () => {
    const stored: [string, string][] = [];
    let written: AiosConfig | null = null;
    const prompter = answers([ID, SECRET, '']);
    const line = await spotifyLogin({
      prompter,
      config: base(),
      country: 'TR',
      check: async (id, secret, c) => (id === ID && secret === SECRET && c.music.spotify.market === 'TR' ? null : 'wrong'),
      storeSecret: async (ref, v) => void stored.push([ref, v]),
      writeConfig: async (c) => void (written = c),
    });
    expect(line).toMatch(/^Spotify search works/);
    expect(prompter.secretAsked).toBe(true);
    expect(stored).toEqual([['keyring:spotify-client', SECRET]]);
    expect(written!.music.spotify).toMatchObject({ clientId: ID, market: 'TR', clientSecretRef: 'keyring:spotify-client' });
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  it('keeps nothing when the check fails or an answer is malformed, and never echoes the secret', async () => {
    const kept: unknown[] = [];
    const deps = (list: string[], problem: string | null = null) => ({
      prompter: answers(list),
      config: base(),
      check: async () => problem,
      storeSecret: async (...a: unknown[]) => void kept.push(a),
      writeConfig: async (c: unknown) => void kept.push(c),
    });
    await expect(spotifyLogin(deps([ID, SECRET, 'US'], "Spotify didn't accept the developer app's Client ID or secret"))).rejects.toThrow(/didn't accept/);
    await expect(spotifyLogin(deps(['not an id!', SECRET, 'US']))).rejects.toThrow(/Client ID/);
    const bad = await spotifyLogin(deps([ID, `${SECRET} oops`, 'US'])).catch((e: Error) => e.message);
    expect(bad).toMatch(/client secret/);
    expect(bad).not.toContain(SECRET);
    await expect(spotifyLogin(deps([ID, SECRET, 'Turkey']))).rejects.toThrow(/two letters/);
    expect(kept).toEqual([]);
  });

  it('guesses the country from the locale and is an astra command with no flags', () => {
    expect(countryFromLocale('tr_TR.UTF-8')).toBe('TR');
    expect(countryFromLocale('C.UTF-8')).toBeUndefined();
    expect(countryFromLocale(undefined)).toBeUndefined();
    expect(route(['spotify-login'])).toMatchObject({ kind: 'script', args: [] });
    expect(route(['spotify-login', '--secret=x'])).toMatchObject({ kind: 'error' });
  });
});
