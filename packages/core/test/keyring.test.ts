import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { type CommandRunner, Keyring, KeyringError, Secret } from '../src/secrets/keyring.js';

/** In-memory stand-in for secret-tool that records every invocation. */
function fakeSecretTool() {
  const store = new Map<string, string>();
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  const run: CommandRunner = async (_cmd, args, stdin) => {
    calls.push({ args, stdin });
    const account = args[args.indexOf('account') + 1] ?? '';
    switch (args[0]) {
      case 'store':
        store.set(account, stdin ?? '');
        return { code: 0, stdout: '', stderr: '' };
      case 'lookup': {
        const v = store.get(account);
        return v === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: v, stderr: '' };
      }
      case 'clear':
        store.delete(account);
        return { code: 0, stdout: '', stderr: '' };
      default:
        return { code: 2, stdout: '', stderr: 'usage' };
    }
  };
  return { run, calls, store };
}

describe('Keyring', () => {
  it('stores, reads and deletes a secret', async () => {
    const fake = fakeSecretTool();
    const kr = new Keyring(fake.run);
    await kr.set('keyring:mail', 'hunter2');
    expect((await kr.get('keyring:mail'))?.reveal()).toBe('hunter2');
    await kr.delete('keyring:mail');
    expect(await kr.get('keyring:mail')).toBeNull();
  });

  it('passes the secret via stdin, never argv', async () => {
    const fake = fakeSecretTool();
    await new Keyring(fake.run).set('keyring:model-chat', 'sk-abc');
    for (const c of fake.calls) expect(c.args.join(' ')).not.toContain('sk-abc');
    expect(fake.calls[0]?.stdin).toBe('sk-abc');
  });

  it('require() explains how to fix a missing secret', async () => {
    await expect(new Keyring(fakeSecretTool().run).require('keyring:mail')).rejects.toThrow(/pnpm run setup/);
  });

  it('reports a missing secret-tool binary without leaking anything', async () => {
    const missing: CommandRunner = async () => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    };
    const kr = new Keyring(missing);
    await expect(kr.set('keyring:mail', 'hunter2')).rejects.toThrow(KeyringError);
    await expect(kr.set('keyring:mail', 'hunter2')).rejects.not.toThrow(/hunter2/);
    expect(await kr.available()).toBe(false);
  });

  it('refuses to store an empty secret', async () => {
    await expect(new Keyring(fakeSecretTool().run).set('keyring:mail', '')).rejects.toThrow(/empty/);
  });
});

describe('Secret', () => {
  it('never prints its value', () => {
    const s = new Secret('sk-live-xyz');
    expect(String(s)).toBe('[redacted]');
    expect(`${s}`).toBe('[redacted]');
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(inspect({ s })).not.toContain('sk-live-xyz');
    expect(s.reveal()).toBe('sk-live-xyz');
  });
});

describe('spawnRunner', () => {
  it('survives a command that exits without reading stdin', async () => {
    const { spawnRunner } = await import('../src/secrets/keyring.js');
    const big = 'x'.repeat(1 << 20); // larger than the pipe buffer, so the write must fail
    for (let i = 0; i < 20; i++) {
      const r = await spawnRunner('true', [], big);
      expect(r.code).toBe(0);
    }
  });
});
