import { describe, expect, it } from 'vitest';
import { ConfigError, configDir, parseConfig, serializeConfig } from '../src/config.js';

const valid = `
[user]
name = "John"
timezone = "Europe/Istanbul"

[models.chat]
baseUrl = "https://example.invalid/v1"
model = "chat-model"
apiKeyRef = "keyring:model-chat"

[models.triage]
baseUrl = "https://example.invalid/v1"
model = "triage-model"
apiKeyRef = "keyring:model-triage"

[models.nightly]
baseUrl = "https://example.invalid/v1"
model = "nightly-model"
apiKeyRef = "keyring:model-nightly"

[mail]
address = "john@aios.test"
username = "john@aios.test"
passwordRef = "keyring:mail"
imap = { host = "127.0.0.1", port = 3143, tls = false }
smtp = { host = "127.0.0.1", port = 3025, tls = false }
`;

describe('config schema', () => {
  it('parses a minimal config and fills defaults', () => {
    const c = parseConfig(valid);
    expect(c.mail.pollIntervalSeconds).toBe(30);
    expect(c.mail.batchWindowSeconds).toBe(20);
    expect(c.ui).toEqual({ port: 7777, kiosk: true });
    expect(c.models.chat.maxTokens).toBe(1024);
  });

  it('round-trips through TOML', () => {
    const c = parseConfig(valid);
    expect(parseConfig(serializeConfig(c))).toEqual(c);
  });

  it('rejects an inline secret where a keyring reference is expected', () => {
    const bad = valid.replace('apiKeyRef = "keyring:model-chat"', 'apiKeyRef = "sk-live-123"');
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });

  it('rejects unknown keys so typos and stray secrets do not slip through', () => {
    const bad = valid.replace('[user]', '[user]\napiKey = "sk-live-123"');
    expect(() => parseConfig(bad)).toThrow(/apiKey/);
  });

  it('reports invalid TOML clearly', () => {
    expect(() => parseConfig('[user')).toThrow(/not valid TOML/);
  });

  it('honours XDG_CONFIG_HOME', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x', HOME: '/home/j' })).toBe('/x/aios');
    expect(configDir({ HOME: '/home/j' })).toBe('/home/j/.config/aios');
  });
});
