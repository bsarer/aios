import { describe, expect, it } from 'vitest';
import { type Prompter, collectSetup, secretRefs } from '../src/setup-lib.js';

/** Answers questions by matching a substring of the prompt. */
function scripted(answers: [match: string, answer: string | boolean][]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const find = (q: string) => {
    asked.push(q);
    const hit = answers.find(([m]) => q.includes(m));
    if (!hit) throw new Error(`unexpected prompt: ${q}`);
    return hit[1];
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
      ['for triage', true], ['for nightly', true],
    ]);
    const { config, secrets } = await collectSetup(rerun, first, providers);
    expect(config).toEqual(first);
    expect([...secrets.keys()]).toEqual(['keyring:mail']); // test-stack password is a fixed test value
  });

  it('requires an API key on first run', async () => {
    const noKey = firstRun.map(([m, a]) => (m === '[chat] API key' ? [m, ''] : [m, a])) as typeof firstRun;
    await expect(collectSetup(scripted(noKey), null, providers)).rejects.toThrow(/API key is required/);
  });
});
