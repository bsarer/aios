/** R1: a new install is Astra; an AI OS install from before R1 keeps its names until it is set up again. */
import { describe, expect, it } from 'vitest';
import { ASTRA_IDS, DEFAULT_PORT, LEGACY_IDS, appIds } from '../src/brand.js';

const env = { HOME: '/home/j' };
const fs = (...paths: string[]) => (p: string) => paths.includes(p);

describe('appIds', () => {
  it('is Astra on a new computer, on port 7780 so it never meets an AI OS on 7777', () => {
    expect(appIds(env, fs())).toEqual(ASTRA_IDS);
    expect(ASTRA_IDS).toMatchObject({ dir: 'astra', service: 'astra.service', keyring: 'astra', kiosk: 'astra-kiosk' });
    expect(DEFAULT_PORT).toBe(7780);
  });

  it('keeps the AI OS names, keyring and service for an install that has only an AI OS config', () => {
    expect(appIds(env, fs('/home/j/.config/aios/config.toml'))).toEqual(LEGACY_IDS);
    expect(LEGACY_IDS).toMatchObject({ dir: 'aios', service: 'aios-core.service', keyring: 'aios', legacy: true });
  });

  it('is Astra as soon as an Astra folder exists, and honours XDG_CONFIG_HOME', () => {
    expect(appIds(env, fs('/home/j/.config/aios/config.toml', '/home/j/.config/astra'))).toEqual(ASTRA_IDS);
    expect(appIds({ ...env, XDG_CONFIG_HOME: '/x' }, fs('/x/aios/config.toml'))).toEqual(LEGACY_IDS);
    expect(appIds({ ...env, XDG_CONFIG_HOME: '/x' }, fs('/home/j/.config/aios/config.toml'))).toEqual(ASTRA_IDS);
  });
});
