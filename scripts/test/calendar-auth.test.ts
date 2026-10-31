/** C1: the browser sign-in, against the pretend Google: the refresh token goes to the keyring and nowhere else. */
import { CalendarConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { signInToCalendar } from '../src/calendar-auth.js';
import { FAKE_CLIENT_ID, FAKE_REFRESH_TOKEN, startFakeGoogleCalendar } from '../../fixtures/calendar.js';

function memoryKeyring() {
  const store = new Map<string, string>();
  const secret = (v: string) => ({ reveal: () => v });
  return {
    store,
    get: async (ref: string) => (store.has(ref) ? secret(store.get(ref)!) : null),
    set: async (ref: string, v: string) => void store.set(ref, v),
  };
}

describe('calendar sign-in', () => {
  it('takes the code from the redirect, exchanges it with PKCE and stores only the refresh token', async () => {
    const fake = await startFakeGoogleCalendar([]);
    try {
      const cal = CalendarConfig.parse({ clientId: FAKE_CLIENT_ID, apiBaseUrl: fake.apiBaseUrl, tokenUrl: fake.tokenUrl, authUrl: `${fake.url}/auth` });
      const keyring = memoryKeyring();
      const lines: string[] = [];
      // The "browser": Google sends the user back to the redirect with a code and the same state.
      const openBrowser = (url: string) => {
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'test-code');
        back.searchParams.set('state', u.searchParams.get('state')!);
        void fetch(back);
      };
      const n = await signInToCalendar(cal, keyring, 'UTC', { openBrowser, log: (l) => lines.push(l) });
      expect(n).toBe(0);
      expect([...keyring.store.entries()]).toEqual([['keyring:calendar-google', FAKE_REFRESH_TOKEN]]);
      expect(lines.join('\n')).not.toContain(FAKE_REFRESH_TOKEN);
      const exchange = fake.requests.find((r) => r.path === '/token' && (r.body as Record<string, string>).grant_type === 'authorization_code')!;
      expect(Object.keys(exchange.body as object).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    } finally {
      await fake.close();
    }
  });

  it('refuses a redirect with the wrong state and stores nothing', async () => {
    const fake = await startFakeGoogleCalendar([]);
    try {
      const cal = CalendarConfig.parse({ clientId: FAKE_CLIENT_ID, apiBaseUrl: fake.apiBaseUrl, tokenUrl: fake.tokenUrl, authUrl: `${fake.url}/auth` });
      const keyring = memoryKeyring();
      const openBrowser = (url: string) => {
        const back = new URL(new URL(url).searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'test-code');
        back.searchParams.set('state', 'forged');
        void fetch(back);
      };
      await expect(signInToCalendar(cal, keyring, 'UTC', { openBrowser, log: () => undefined })).rejects.toThrow(/state mismatch/);
      expect(keyring.store.size).toBe(0);
    } finally {
      await fake.close();
    }
  });
});
