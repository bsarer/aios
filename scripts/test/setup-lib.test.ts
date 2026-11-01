import { parseConfig, serializeConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { type Prompter, collectSetup, secretRefs } from '../src/setup-lib.js';

/** Answers questions by matching a substring of the prompt. */
function scripted(answers: [match: string, answer: string | boolean | string[]][]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const find = (q: string) => {
    asked.push(q);
    const hit = answers.find(([m]) => q.includes(m));
    if (!hit) throw new Error(`unexpected prompt: ${q}`);
    // A list answers successive askings of the same question.
    return Array.isArray(hit[1]) ? (hit[1].shift() ?? '') : hit[1];
  };
  return {
    asked,
    ask: async (q, o) => (find(q) as string) || o?.default || '',
    confirm: async (q) => find(q) as boolean,
  };
}

const providers = {
  _note: 'ignored',
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', extraBody: { provider: { data_collection: 'deny' } }, extraHeaders: {} },
};

const firstRun: [string, string | boolean][] = [
  ['first name', 'John'],
  ['Timezone', 'Europe/Istanbul'],
  ['GreenMail', true],
  ['[chat] Provider', 'openrouter'],
  ['[chat] Model name', 'some/model'],
  ['[chat] API key', 'sk-test-123'],
  ['for triage', true],
  ['for nightly', true],
  ['Google Calendar', false],
];

describe('collectSetup', () => {
  it('builds a valid config for the test stack and collects secrets separately', async () => {
    const { config, secrets } = await collectSetup(scripted(firstRun), null, providers);
    expect(config.mail.imap).toEqual({ host: '127.0.0.1', port: 3143, tls: false });
    expect(config.models.triage).toEqual(config.models.chat);
    expect(config.models.chat.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.models.chat.extraBody).toEqual({ provider: { data_collection: 'deny' } });
    expect(secrets.get('keyring:model-chat')).toBe('sk-test-123');
    expect(JSON.stringify(config)).not.toContain('sk-test-123');
    expect(secretRefs(config)).toEqual(['keyring:mail', 'keyring:model-chat']);
  });

  it('is idempotent: re-running with empty answers keeps everything and stores no new secrets', async () => {
    const { config: first } = await collectSetup(scripted(firstRun), null, providers);
    const rerun = scripted([
      ['first name', ''], ['Timezone', ''], ['GreenMail', true],
      ['[chat] Provider', ''], ['[chat] Model name', ''], ['[chat] API key', ''],
      ['for triage', true], ['for nightly', true], ['Google Calendar', false],
    ]);
    const { config, secrets } = await collectSetup(rerun, first, providers);
    expect(config).toEqual(first);
    expect([...secrets.keys()]).toEqual(['keyring:mail']); // test-stack password is a fixed test value
  });

  it('adds a Google Calendar with its client secret in the keyring, and keeps it on a re-run', async () => {
    const answers = firstRun.map(([m, a]) => (m === 'Google Calendar' ? [m, true] : [m, a])) as typeof firstRun;
    const { config, secrets } = await collectSetup(scripted([...answers, ['client ID', 'abc.apps.googleusercontent.com'], ['client secret', 'GOCSPX-test']]), null, providers);
    expect(config.calendar).toMatchObject({ provider: 'google', clientId: 'abc.apps.googleusercontent.com', clientSecretRef: 'keyring:calendar-client-secret', tokenRef: 'keyring:calendar-google', calendarId: 'primary' });
    expect(secrets.get('keyring:calendar-client-secret')).toBe('GOCSPX-test');
    expect(JSON.stringify(config)).not.toContain('GOCSPX-test');
    expect(secretRefs(config)).toEqual(['keyring:mail', 'keyring:model-chat', 'keyring:calendar-client-secret', 'keyring:calendar-google']);
    const again = await collectSetup(
      scripted([['first name', ''], ['Timezone', ''], ['GreenMail', true], ['[chat] Provider', ''], ['[chat] Model name', ''], ['[chat] API key', ''], ['for triage', true], ['for nightly', true], ['Google Calendar', true], ['client ID', ''], ['client secret', '']]),
      config,
      providers,
    );
    expect(again.config).toEqual(config);
    expect(again.secrets.has('keyring:calendar-client-secret')).toBe(false);
  });

  it('requires an API key on first run', async () => {
    const noKey = firstRun.map(([m, a]) => (m === '[chat] API key' ? [m, ''] : [m, a])) as typeof firstRun;
    await expect(collectSetup(scripted(noKey), null, providers)).rejects.toThrow(/API key is required/);
  });

  it('re-asks a host given with its port, and a port that is not a number', async () => {
    const answers: [string, string | boolean | string[]][] = [
      ...firstRun.filter(([m]) => m !== 'GreenMail'),
      ['GreenMail', false],
      ['Mail address', 'test.aios@gmail.com'],
      ['username', ''],
      ['IMAP host', ['imap.gmail.com, port 993', 'imap.gmail.com']],
      ['IMAP port', ['993 (SSL)', '']],
      ['SMTP host', ['https://smtp.gmail.com', ' smtp.gmail.com ']],
      ['SMTP port', ['']],
      ['Mail app password', 'app-password'],
    ];
    const p = scripted(answers);
    const { config } = await collectSetup(p, null, providers);
    expect(config.mail).toMatchObject({
      username: 'test.aios@gmail.com',
      imap: { host: 'imap.gmail.com', port: 993, tls: true },
      smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
      // Gmail saves sent mail itself.
      saveSentCopy: false,
    });
    expect(p.asked.filter((q) => q.includes('IMAP host'))).toHaveLength(2);
    expect(p.asked.filter((q) => q.includes('IMAP port'))).toHaveLength(2);
  });

  it('a config with a port in the host name is rejected with a clear message', async () => {
    const { config } = await collectSetup(scripted(firstRun), null, providers);
    const bad = serializeConfig(config).replace('host = "127.0.0.1"', 'host = "imap.gmail.com, port 993"');
    expect(() => parseConfig(bad)).toThrow(/server name only/);
  });
});
