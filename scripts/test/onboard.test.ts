/** R2: the setup window's answers, checks and server, with fakes only. Never a real keyring, mailbox or provider. */
import { request } from 'node:http';
import { AiosConfig, type SecretRef } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import providers from '../providers.json' with { type: 'json' };
import { type FoundApps, GMAIL, SetupAnswers, buildConfig, cleanPassword, readPresets, serversFor, summarize } from '../src/onboard/answers.js';
import { checkAiKey, checkMail } from '../src/onboard/checks.js';
import { type Probes, findApps, whisperRunning } from '../src/onboard/probe.js';
import { type SetupDeps, startSetupServer } from '../src/onboard/server.js';

const presets = readPresets(providers as Record<string, unknown>);
const none: FoundApps = { wordcraft: null, gridcraft: null, wordcraftCli: null, gridcraftCli: null, mpv: null, claude: null };
const all: FoundApps = { wordcraft: '/usr/bin/wordcraft', gridcraft: '/home/j/gridcraft-0.11.1/gridcraft', wordcraftCli: '/usr/bin/wordcraft-cli', gridcraftCli: '/home/j/gridcraft-0.11.1/gridcraft-cli', mpv: '/usr/bin/mpv', claude: '/home/j/.local/bin/claude' };
const KEY = 'sk-or-test-secret-123';
const APP_PASSWORD = 'abcd efgh ijkl mnop';

const answers = (over: Partial<Record<string, unknown>> = {}) =>
  SetupAnswers.parse({
    name: 'Baris',
    timezone: 'Europe/Istanbul',
    ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: KEY },
    mail: { address: 'baris@gmail.com', password: APP_PASSWORD },
    folders: ['~/Documents', '~/Downloads', '~/Pictures', '~/Music'],
    apps: { docs: true, video: true, builder: true },
    desktop: { autostart: true, hyprland: true, bar: true },
    ...over,
  });

describe('R2 answers: only what needs the person is asked', () => {
  it('knows Gmail and Google Workspace from the address, and needs servers for anything else', () => {
    expect(serversFor('a@gmail.com', [])).toEqual(GMAIL);
    expect(serversFor('a@googlemail.com', [])).toEqual(GMAIL);
    expect(serversFor('a@firm.com', ['aspmx.l.google.com.', 'alt1.aspmx.l.google.com'])).toEqual(GMAIL);
    expect(serversFor('a@firm.com', ['mx.firm.com'])).toBeNull();
    expect(serversFor('a@notgoogle.com.evil', ['google.com.evil'])).toBeNull();
    expect(GMAIL).toEqual({ provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 } });
  });

  it('drops the spaces Google shows in an app password, and only for Gmail', () => {
    expect(cleanPassword(APP_PASSWORD, GMAIL)).toBe('abcdefghijklmnop');
    expect(cleanPassword('pass word', null)).toBe('pass word');
  });

  it('builds a whole config from a first run: one key for every job, the address as sign-in, port 7780', () => {
    const { config, secrets } = buildConfig(answers(), null, presets, all, GMAIL);
    expect(config.models.chat).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-5.5', apiKeyRef: 'keyring:model-chat' });
    expect(config.models.triage).toEqual(config.models.chat);
    expect(config.models.nightly).toEqual(config.models.chat);
    expect(config.models.chat.extraHeaders).toEqual({ 'X-Title': 'Astra' });
    expect(config.mail).toMatchObject({ address: 'baris@gmail.com', username: 'baris@gmail.com', imap: { host: 'imap.gmail.com', port: 993, tls: true }, smtp: { host: 'smtp.gmail.com', port: 465, tls: true } });
    expect(config.files.roots).toEqual(['~/Documents', '~/Downloads', '~/Pictures', '~/Music']);
    expect(config.docs).toMatchObject({ enabled: true, roots: config.files.roots, wordCli: '/usr/bin/wordcraft-cli', sheetCli: '/home/j/gridcraft-0.11.1/gridcraft-cli' });
    expect(config.video).toMatchObject({ enabled: true, player: '/usr/bin/mpv' });
    expect(config.builder).toMatchObject({ enabled: true, command: '/home/j/.local/bin/claude' });
    expect(config.ui).toEqual({ port: 7780, kiosk: true, fade: true });
    expect([...secrets]).toEqual([['keyring:model-chat', KEY], ['keyring:mail', 'abcdefghijklmnop']]);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(JSON.stringify(config)).not.toContain('abcdefghij');
  });

  it("gives the knowledge base the provider preset's cloud model, keeps one set before, and drops it with the provider", () => {
    const pick = presets.openrouter!.knowledgeModel!;
    expect(pick).toBeTruthy();
    const first = buildConfig(answers(), null, presets, all, GMAIL).config;
    expect(first.knowledge.cloudModel).toBe(pick);
    expect(first.models.nightly.model).toBe('anthropic/claude-haiku-5.5');
    // An install from before: Settings' Save fills it in and keeps the rest of the section.
    const { cloudModel: _c, ...old } = first.knowledge;
    const before = AiosConfig.parse({ ...first, knowledge: { ...old, dailyBudgetUsd: 3 } });
    expect(before.knowledge.cloudModel).toBeUndefined();
    const saved = buildConfig(answers({ ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: '' }, mail: { address: 'baris@gmail.com', password: '' } }), before, presets, all, GMAIL).config;
    expect(saved.knowledge).toMatchObject({ cloudModel: pick, dailyBudgetUsd: 3 });
    // One the user chose stays.
    const chosen = AiosConfig.parse({ ...first, knowledge: { ...first.knowledge, cloudModel: 'z-ai/glm-5.3' } });
    expect(buildConfig(answers({ ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: '' }, mail: { address: 'baris@gmail.com', password: '' } }), chosen, presets, all, GMAIL).config.knowledge.cloudModel).toBe('z-ai/glm-5.3');
    // Another provider: an OpenRouter id would not fit, so the nightly model is used.
    const groq = buildConfig(answers({ ai: { provider: 'groq', model: 'some-model', key: KEY } }), chosen, presets, all, GMAIL).config;
    expect(groq.knowledge.cloudModel).toBeUndefined();
  });

  it('turns a feature off when its app is missing, whatever the tick says', () => {
    const { config } = buildConfig(answers(), null, presets, none, GMAIL);
    expect(config.docs.enabled).toBe(false);
    expect(config.video.enabled).toBe(false);
    expect(config.builder.enabled).toBe(false);
  });

  it('asks for servers and a key only when it must', () => {
    expect(() => buildConfig(answers({ mail: { address: 'a@firm.com', password: 'p' } }), null, presets, none, null)).toThrow(/servers/);
    const typed = buildConfig(answers({ mail: { address: 'a@firm.com', password: 'p', imap: { host: 'imap.firm.com', port: 993 }, smtp: { host: 'smtp.firm.com', port: 587 } } }), null, presets, none, null);
    expect(typed.config.mail.smtp).toEqual({ host: 'smtp.firm.com', port: 587, tls: true });
    expect(() => buildConfig(answers({ ai: { provider: 'openrouter', model: 'm', key: '' } }), null, presets, none, GMAIL)).toThrow(/API key/);
  });

  it('Settings keeps stored keys left empty, and every section it does not show', () => {
    const first = buildConfig(answers(), null, presets, all, GMAIL).config;
    const tuned = AiosConfig.parse({ ...first, personality: { ...first.personality, tone: 'playful' }, cost: { dailyCapUsd: 5 }, models: { ...first.models, speech: { baseUrl: 'http://127.0.0.1:8178' } } });
    const again = buildConfig(answers({ ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: '' }, mail: { address: 'baris@gmail.com', password: '' }, apps: { docs: true, video: true, builder: true, voice: true } }), tuned, presets, all, GMAIL);
    expect(again.secrets.size).toBe(0);
    expect(again.config).toEqual(tuned);
    // A new address needs its own password.
    expect(() => buildConfig(answers({ mail: { address: 'other@gmail.com', password: '' } }), tuned, presets, all, GMAIL)).toThrow(/password/);
  });

  it('turns voice on only when a whisper.cpp server answers, or was set up before, and off when unticked', () => {
    const voice = { docs: true, video: true, builder: true, voice: true };
    expect(buildConfig(answers({ apps: voice }), null, presets, none, GMAIL).config.models.speech).toBeUndefined();
    const on = buildConfig(answers({ apps: voice }), null, presets, { ...none, speech: true }, GMAIL).config;
    expect(on.models.speech?.baseUrl).toBe('http://127.0.0.1:8178');
    expect(summarize(on, presets)).toMatchObject({ apps: { voice: true } });
    const custom = AiosConfig.parse({ ...on, models: { ...on.models, speech: { baseUrl: 'http://127.0.0.1:9000', language: 'tr' } } });
    expect(buildConfig(answers({ apps: voice, mail: { address: 'baris@gmail.com', password: '' } }), custom, presets, none, GMAIL).config.models.speech).toMatchObject({ baseUrl: 'http://127.0.0.1:9000', language: 'tr' });
    expect(buildConfig(answers({ mail: { address: 'baris@gmail.com', password: '' } }), custom, presets, none, GMAIL).config.models.speech).toBeUndefined();
  });

  it('keeps older chat messages fading unless the Wallpaper step turns it off, and tells the window which', () => {
    const on = buildConfig(answers(), null, presets, all, GMAIL).config;
    expect(on.ui.fade).toBe(true);
    expect(summarize(on, presets)).toMatchObject({ fade: true });
    const off = buildConfig(answers({ chat: { fade: false } }), null, presets, all, GMAIL).config;
    expect(off.ui.fade).toBe(false);
    expect(summarize(off, presets)).toMatchObject({ fade: false });
    // An older config.toml without the line fades, like a new one.
    expect(AiosConfig.parse({ ...on, ui: { port: 7780, kiosk: true } }).ui.fade).toBe(true);
  });

  it('tells the window about the config without any secret', () => {
    const { config } = buildConfig(answers(), null, presets, all, GMAIL);
    const s = JSON.stringify(summarize(config, presets));
    expect(s).toContain('baris@gmail.com');
    expect(s).not.toMatch(/keyring|sk-|abcd/);
  });

  it('refuses folders outside the home folder', () => {
    expect(() => answers({ folders: ['/etc'] })).toThrow();
    expect(() => answers({ folders: ['~/../root'] })).not.toThrow(); // resolved again inside [files] roots by F1, which refuses it
  });
});

describe('R2 checks: each failure says what to fix', () => {
  const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('tests the AI key with one tiny call and names a rejected key', async () => {
    const calls: RequestInit[] = [];
    const ok = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkAiKey({ preset: presets.openrouter, baseUrl: presets.openrouter!.baseUrl, model: 'm', key: KEY, fetch: ok });
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(calls[0]!.body)).max_tokens).toBe(32);
    const bad = await checkAiKey({ preset: presets.openrouter, baseUrl: presets.openrouter!.baseUrl, model: 'm', key: KEY, fetch: fakeFetch(401, { error: { message: 'No auth' } }) });
    expect(bad).toMatchObject({ ok: false, message: 'OpenRouter rejected this key.', fix: expect.stringContaining('openrouter.ai/settings/keys') });
    expect(JSON.stringify(bad)).not.toContain(KEY);
    const credits = await checkAiKey({ preset: presets.openrouter, baseUrl: presets.openrouter!.baseUrl, model: 'm', key: KEY, fetch: fakeFetch(402, { error: { message: 'credits' } }) });
    expect(credits.message).toMatch(/no credits/);
  });

  const imapFake = (fail?: unknown) => () => ({
    connect: async () => {
      if (fail) throw fail;
    },
    list: async () => [{ path: 'INBOX' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }, { path: '[Gmail]/Drafts', specialUse: '\\Drafts' }],
    logout: async () => undefined,
  });

  it('signs in to the mailbox and checks sending without sending', async () => {
    let smtp: unknown;
    const r = await checkMail({ address: 'b@gmail.com', password: 'x', servers: GMAIL, deps: { imap: imapFake() as never, smtpVerify: async (o) => void (smtp = o) } });
    expect(r).toEqual({ ok: true, message: 'Signed in. Found Inbox, Sent, Drafts.' });
    expect(smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
  });

  it('explains a rejected Gmail app password with the steps to make one', async () => {
    const r = await checkMail({ address: 'b@gmail.com', password: 'wrong', servers: GMAIL, deps: { imap: imapFake(Object.assign(new Error('Authentication failed'), { authenticationFailed: true })) as never } });
    expect(r).toMatchObject({ ok: false, message: 'Gmail did not accept this app password.', fix: expect.stringContaining('myaccount.google.com/apppasswords') });
    const send = await checkMail({ address: 'b@gmail.com', password: 'x', servers: GMAIL, deps: { imap: imapFake() as never, smtpVerify: async () => { throw Object.assign(new Error('x'), { code: 'EAUTH' }); } } });
    expect(send.message).toMatch(/^Reading mail works, but sending doesn't/);
  });
});

/** A setup server on fake everything. */
async function serve(over: Partial<SetupDeps> = {}) {
  const stored = new Map<SecretRef, string>();
  const written: AiosConfig[] = [];
  const seen: { ai: string[]; mail: string[] } = { ai: [], mail: [] };
  let done = 0;
  let exited = 0;
  const addonCalls: string[][] = [];
  const deps: SetupDeps = {
    page: async () => '<script nonce="{{NONCE}}"></script>',
    presets,
    readConfig: async () => written.at(-1) ?? null,
    writeConfig: async (c) => void written.push(c),
    keyring: { set: async (r, v) => void stored.set(r, v), get: async (r) => (stored.has(r) ? { reveal: () => stored.get(r)! } : null) },
    look: async () => ({ name: 'Baris', timezone: 'Europe/Istanbul', folders: [{ path: '~/Documents' }], apps: { ...all, whisper: null }, ollama: [], screens: [], addons: [{ id: 'voice', label: 'Speak to Astra', blurb: 'b', installed: false }] }),
    mx: async () => [],
    checkAi: async (o) => (seen.ai.push(o.key), { ok: o.key === KEY, message: 'm' }),
    checkMail: async (o) => (seen.mail.push(o.password), { ok: true, message: 'm' }),
    installDesktop: async () => ['installed'],
    installAddons: async (ids) => {
      addonCalls.push(ids);
      return 'xdg-terminal-exec';
    },
    done: () => void done++,
    exit: () => void exited++,
    ...over,
  };
  const s = await startSetupServer(deps, { token: 'tok' });
  const u = new URL(s.url);
  const send = (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const data = o.body === undefined ? undefined : JSON.stringify(o.body);
      const req = request(
        { host: '127.0.0.1', port: u.port, path, method: o.method ?? 'GET', headers: { host: u.host, ...(data ? { 'content-type': 'application/json', origin: u.origin } : {}), ...o.headers } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  return { s, send, stored, written, seen, addonCalls, done: () => done, exited: () => exited };
}

describe('R2 setup server: only its own page can drive it', () => {
  it('listens on loopback under a token, and checks Host and Origin', async () => {
    const t = await serve();
    try {
      expect(t.s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/tok\/$/);
      const page = await t.send('/s/tok/');
      expect(page.status).toBe(200);
      expect(String(page.headers['content-security-policy'])).toMatch(/default-src 'none'; script-src 'nonce-[^']+'/);
      expect(page.body).not.toContain('{{NONCE}}');
      expect((await t.send('/s/wrong/')).status).toBe(404);
      expect((await t.send('/s/tok/api/state', { headers: { host: 'evil.example:80' } })).status).toBe(421);
      expect((await t.send('/s/tok/api/finish', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
      expect((await t.send('/s/tok/api/finish', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
      expect((await t.send('/s/tok/api/nope', { method: 'POST', body: {} })).status).toBe(404);
    } finally {
      await t.s.close();
    }
  });

  it('exits without saving: nothing is written and the chat isn’t opened', async () => {
    const t = await serve();
    try {
      expect(JSON.parse((await t.send('/s/tok/api/exit', { method: 'POST', body: {} })).body)).toEqual({ ok: true });
      expect((await t.send('/s/tok/api/exit', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
      await new Promise((r) => setTimeout(r, 100));
      expect(t.exited()).toBe(1);
      expect(t.done()).toBe(0);
      expect(t.written).toEqual([]);
      expect(t.stored.size).toBe(0);
    } finally {
      await t.s.close();
    }
  });

  it('finishes: keys to the keyring, the config written, nothing secret sent back, then opens the chat', async () => {
    const t = await serve();
    try {
      const body = { ...answers(), ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: KEY }, mail: { address: 'baris@gmail.com', password: APP_PASSWORD } };
      expect(JSON.parse((await t.send('/s/tok/api/open', { method: 'POST', body: {} })).body)).toMatchObject({ ok: false });
      const r = await t.send('/s/tok/api/finish', { method: 'POST', body });
      expect(JSON.parse(r.body)).toEqual({ ok: true, did: ['Saved your settings, and your keys in the keyring.', 'installed'] });
      expect(t.stored.get('keyring:model-chat')).toBe(KEY);
      expect(t.stored.get('keyring:mail')).toBe('abcdefghijklmnop');
      expect(t.written[0]!.mail.imap.host).toBe('imap.gmail.com');
      const state = (await t.send('/s/tok/api/state')).body;
      expect(state).toContain('baris@gmail.com');
      expect(state).not.toContain(KEY);
      expect(state).not.toContain('abcdefghij');
      await t.send('/s/tok/api/open', { method: 'POST', body: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(t.done()).toBe(1);
    } finally {
      await t.s.close();
    }
  });

  it('tests with the stored key or password when Settings leaves them empty, and never echoes a bad body', async () => {
    const t = await serve();
    try {
      await t.send('/s/tok/api/finish', { method: 'POST', body: answers() });
      expect(JSON.parse((await t.send('/s/tok/api/test-ai', { method: 'POST', body: { provider: 'openrouter', model: 'm', key: '' } })).body).ok).toBe(true);
      expect(t.seen.ai).toEqual([KEY]);
      await t.send('/s/tok/api/test-mail', { method: 'POST', body: { address: 'baris@gmail.com', password: '' } });
      expect(t.seen.mail).toEqual(['abcdefghijklmnop']);
      // Another address never gets the stored password.
      const other = JSON.parse((await t.send('/s/tok/api/test-mail', { method: 'POST', body: { address: 'x@gmail.com', password: '' } })).body);
      expect(other).toMatchObject({ ok: false, message: 'Paste the app password first.' });
      const bad = await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), name: '', ai: { provider: 'openrouter', model: 'm', key: 'sk-leak-me' } } });
      expect(bad.status).toBe(400);
      expect(bad.body).not.toContain('sk-leak-me');
    } finally {
      await t.s.close();
    }
  });
});

describe('Wallpaper step: only Finish puts the picture behind the chat', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);
  const upload = (url: string, bytes: Buffer, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const req = request({ host: '127.0.0.1', port: u.port, path: `${u.pathname}api/wallpaper`, method: 'POST', headers: { host: u.host, origin: u.origin, 'content-type': 'application/octet-stream', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(bytes);
    });

  async function withWallpaper() {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Wallpaper } = await import('@aios/core');
    const { wallpaperSamples } = await import('@aios/core');
    const wallpaper = new Wallpaper(mkdtempSync(join(tmpdir(), 'aios-setup-wp-')), () => wallpaperSamples({ themeDirs: [] }));
    return { wallpaper, t: await serve({ wallpaper }) };
  }

  it('checks the picked picture, keeps it in memory, and saves it only on Finish', async () => {
    const { wallpaper, t } = await withWallpaper();
    try {
      const listed = JSON.parse((await t.send('/s/tok/api/state')).body).wallpaper;
      expect(listed).toMatchObject({ available: true, current: null });
      expect(listed.samples[0]).toEqual({ id: 'dusk', label: 'Dusk hills' });
      expect(JSON.stringify(listed)).not.toContain('/');
      const card = await t.send('/s/tok/api/wallpaper-sample/dusk');
      expect([card.status, card.headers['content-type']]).toEqual([200, 'image/jpeg']);
      expect((await t.send('/s/tok/api/wallpaper-sample/..%2Fetc')).status).toBe(404);
      expect((await t.send('/s/tok/api/wallpaper-sample/nope')).status).toBe(404);
      expect(JSON.parse((await upload(t.s.url, Buffer.from('<svg><script>alert(1)</script></svg>'))).body)).toMatchObject({ ok: false, message: expect.stringContaining('isn’t a picture') });
      expect((await upload(t.s.url, PNG, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await upload(t.s.url, PNG, { 'content-type': 'image/png' })).status).toBe(415);
      expect(JSON.parse((await upload(t.s.url, PNG)).body)).toEqual({ ok: true });
      expect(wallpaper.current()).toBeNull();
      const r = await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'new', dim: 'strong' } } });
      expect(JSON.parse(r.body).did).toContain('Put your picture behind the chat.');
      expect(wallpaper.current()).toMatchObject({ dim: 'strong' });
      const shown = await t.send('/s/tok/api/wallpaper');
      expect(shown.status).toBe(200);
      expect(shown.headers['content-type']).toBe('image/png');
      // Keep changes only the dim; remove takes it off.
      await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'keep', dim: 'light' } } });
      expect(wallpaper.current()).toMatchObject({ dim: 'light' });
      const sample = await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'sample', sample: 'tide', dim: 'medium' } } });
      expect(JSON.parse(sample.body).did).toContain('Put the sample wallpaper behind the chat.');
      expect(wallpaper.currentSample()).toBe('tide');
      expect(JSON.parse((await t.send('/s/tok/api/state')).body).wallpaper.current).toMatchObject({ sample: 'tide' });
      const bad = await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'sample', sample: 'nope', dim: 'medium' } } });
      expect(JSON.parse(bad.body)).toMatchObject({ ok: false, step: 'wallpaper' });
      const off = await t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'remove', dim: 'light' } } });
      expect(JSON.parse(off.body).did).toContain('Took the wallpaper off the chat.');
      expect(wallpaper.current()).toBeNull();
    } finally {
      await t.s.close();
    }
  });

  it('saves nothing on Exit, and asks again when Finish has no picture', async () => {
    const { wallpaper, t } = await withWallpaper();
    try {
      await upload(t.s.url, PNG);
      await t.send('/s/tok/api/exit', { method: 'POST', body: {} });
      expect(wallpaper.current()).toBeNull();
    } finally {
      await t.s.close();
    }
    const again = await withWallpaper();
    try {
      const r = await again.t.send('/s/tok/api/finish', { method: 'POST', body: { ...answers(), wallpaper: { change: 'new', dim: 'medium' } } });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ step: 'wallpaper' });
      expect(again.t.written).toEqual([]);
      expect(again.t.stored.size).toBe(0);
    } finally {
      await again.t.s.close();
    }
  });
});

describe('Add-ons from the setup window', () => {
  it('opens the add-ons terminal only for known add-ons', async () => {
    const t = await serve();
    try {
      const ok = JSON.parse((await t.send('/s/tok/api/addons', { method: 'POST', body: { ids: ['voice', 'video', 'voice'] } })).body);
      expect(ok).toMatchObject({ ok: true, message: expect.stringContaining('password') });
      expect(t.addonCalls).toEqual([['voice', 'video']]);
      for (const ids of [['rm -rf ~'], [], ['voice', '--evil']]) expect((await t.send('/s/tok/api/addons', { method: 'POST', body: { ids } })).status).toBe(400);
      expect(t.addonCalls).toHaveLength(1);
      expect(JSON.parse((await t.send('/s/tok/api/state')).body).addons).toEqual([{ id: 'voice', label: 'Speak to Astra', blurb: 'b', installed: false }]);
    } finally {
      await t.s.close();
    }
  });
});

describe('R2 app scan: looks only', () => {
  const probes = (files: string[], answering: boolean): Probes => ({
    home: '/home/j',
    path: '/usr/bin:/bin',
    isDir: () => false,
    isExecutable: async (f) => files.includes(f),
    run: async () => '',
    fetch: (async (u: string) => {
      if (answering && String(u) === 'http://127.0.0.1:8178/') return new Response('<html>whisper.cpp</html>');
      throw new Error('refused');
    }) as unknown as typeof fetch,
    mx: async () => [],
    readFile: async () => '',
  });

  it('finds whisper-server where the README builds it, and whether it is running', async () => {
    const built = '/home/j/.local/src/whisper.cpp/build/bin/whisper-server';
    expect(await findApps(probes([built], true))).toMatchObject({ whisper: built, speech: true });
    expect(await findApps(probes(['/usr/bin/whisper-server'], false))).toMatchObject({ whisper: '/usr/bin/whisper-server', speech: false });
    expect(await findApps(probes([], false))).toMatchObject({ whisper: null, speech: false });
    expect(await whisperRunning(probes([], true))).toBe(true);
  });
});

describe('R2 window: no old setup pages come back', () => {
  it('gives each run a new, empty profile, removes the old kept one, and removes it after', async () => {
    const { mkdtemp, mkdir, writeFile, readdir, stat } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { OLD_PROFILE, freshProfile, removeProfile } = await import('../src/onboard/window.js');
    const root = await mkdtemp(join(tmpdir(), 'aios-window-'));
    const data = join(root, 'data');
    const temp = join(root, 'tmp');
    await mkdir(join(data, OLD_PROFILE, 'Default', 'Sessions'), { recursive: true });
    await writeFile(join(data, OLD_PROFILE, 'Default', 'Sessions', 'Tabs_1'), 'http://127.0.0.1:39073/s/old/');
    await mkdir(temp);

    const a = await freshProfile(data, temp);
    const b = await freshProfile(data, temp);
    expect(existsSync(join(data, OLD_PROFILE))).toBe(false);
    expect(a).not.toBe(b);
    expect(a.startsWith(join(temp, 'astra-setup-'))).toBe(true);
    expect(await readdir(a)).toEqual([]);
    expect((await stat(a)).mode & 0o777).toBe(0o700);

    await writeFile(join(a, 'Local State'), '{}');
    await removeProfile(a);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  });
});
