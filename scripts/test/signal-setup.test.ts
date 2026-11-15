/**
 * SG1: linking Signal in the setup window, with a pretend signal-cli only. signal-cli gets
 * code's arguments; the window gets a QR picture, never the link as text; the number comes
 * from linking, never from the page; and Signal stays off until a phone is linked.
 */
import { request } from 'node:http';
import { type AiosConfig, type SecretRef, SignalConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import providers from '../providers.json' with { type: 'json' };
import { type FoundApps, GMAIL, SetupAnswers, SetupError, buildConfig, readPresets, summarize } from '../src/onboard/answers.js';
import { type Probes, findApps } from '../src/onboard/probe.js';
import { type SetupDeps, startSetupServer } from '../src/onboard/server.js';
import { DEVICE_NAME, type LinkRunner, SignalLinker, numbersIn, qrDataUrl } from '../src/onboard/signal.js';

const presets = readPresets(providers as Record<string, unknown>);
const found: FoundApps = { wordcraft: null, gridcraft: null, wordcraftCli: null, gridcraftCli: null, mpv: null, claude: null, signal: '/usr/bin/signal-cli' };
const LINK = 'sgnl://linkdevice?uuid=AbCdEf123&pub_key=BQ5s%2Bkey';
const NUMBER = '+905550000001';

const answers = (over: Partial<Record<string, unknown>> = {}) =>
  SetupAnswers.parse({
    name: 'Baris',
    timezone: 'Europe/Istanbul',
    ai: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', key: 'sk-test' },
    mail: { address: 'baris@gmail.com', password: 'abcdefghijklmnop' },
    folders: ['~/Documents'],
    apps: { docs: false, video: false, builder: false },
    desktop: { autostart: true, hyprland: true, bar: true },
    ...over,
  });

/** A pretend signal-cli: `link` prints the link, then exits when the test says the phone scanned it. */
function pretendCli(o: { accountsBefore?: string; accountsAfter?: string; printsNumber?: boolean; code?: number } = {}) {
  const calls: { kind: 'link' | 'listAccounts'; command: string }[] = [];
  let finish: (() => void) | null = null;
  let killed = 0;
  let linked = false;
  const runner: LinkRunner = {
    link(command, onLine, onExit) {
      calls.push({ kind: 'link', command });
      setImmediate(() => onLine(LINK));
      finish = () => {
        linked = true;
        if (o.printsNumber) onLine(`Associated with: ${NUMBER}`);
        onExit(o.code ?? 0);
      };
      return { kill: () => void killed++ };
    },
    async listAccounts(command) {
      calls.push({ kind: 'listAccounts', command });
      return linked ? (o.accountsAfter ?? `Number: ${NUMBER}\n`) : (o.accountsBefore ?? '');
    },
  };
  return { runner, calls, scan: () => finish?.(), killed: () => killed };
}

describe('SG1 linking signal-cli', () => {
  it('shows the link as a QR picture, then reads the linked number from listAccounts', async () => {
    const cli = pretendCli();
    const l = new SignalLinker(() => '/usr/bin/signal-cli', cli.runner);
    const waiting = await l.start();
    expect(waiting.state).toBe('waiting');
    expect(waiting.state === 'waiting' && waiting.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    // The picture, not the link as text.
    expect(JSON.stringify(waiting)).not.toContain('linkdevice');
    cli.scan();
    await new Promise((r) => setTimeout(r, 10));
    expect(l.status).toEqual({ state: 'linked', number: NUMBER });
    expect(cli.calls.map((c) => c.kind)).toEqual(['listAccounts', 'link', 'listAccounts']);
    expect(DEVICE_NAME).toBe('Astra');
  });

  it('uses the number signal-cli printed, and picks the new one when there were accounts before', async () => {
    const printed = pretendCli({ printsNumber: true });
    const a = new SignalLinker(() => 'signal-cli', printed.runner);
    await a.start();
    printed.scan();
    await new Promise((r) => setTimeout(r, 10));
    expect(a.status).toEqual({ state: 'linked', number: NUMBER });

    const two = pretendCli({ accountsBefore: 'Number: +905559999999\n', accountsAfter: 'Number: +905559999999\nNumber: +905550000001\n' });
    const b = new SignalLinker(() => 'signal-cli', two.runner);
    await b.start();
    two.scan();
    await new Promise((r) => setTimeout(r, 10));
    expect(b.status).toEqual({ state: 'linked', number: NUMBER });
  });

  it('says what to do when signal-cli is missing or linking fails, and never runs two at once', async () => {
    expect(await new SignalLinker(() => null, pretendCli().runner).start()).toMatchObject({ state: 'failed', message: expect.stringMatching(/Signal add-on/) });
    const bad = pretendCli({ code: 1 });
    const l = new SignalLinker(() => 'signal-cli', bad.runner);
    await l.start();
    await l.start();
    expect(bad.killed()).toBe(1);
    bad.scan();
    await new Promise((r) => setTimeout(r, 10));
    expect(l.status).toMatchObject({ state: 'failed', message: expect.stringMatching(/Press Link again/) });
  });

  it('finds numbers only in international form, and makes a scannable-size QR', () => {
    expect(numbersIn('Number: +905550000001\nDevice 2 +1 555\n+0123456789 +15551234567')).toEqual(['+905550000001', '+15551234567']);
    expect(Buffer.from(qrDataUrl(LINK).split(',')[1]!, 'base64').toString()).toMatch(/^<svg[\s\S]*<\/svg>$/);
  });

  it('finds signal-cli on PATH, or where the upstream tarball puts it', async () => {
    const probes = (have: string[]): Probes => ({ home: '/home/j', path: '/usr/bin', isDir: () => false, isExecutable: async (p) => have.includes(p), run: async () => '', fetch: (async () => { throw new Error('off'); }) as unknown as typeof fetch, mx: async () => [], readFile: async () => '' });
    expect((await findApps(probes(['/usr/bin/signal-cli']))).signal).toBe('/usr/bin/signal-cli');
    expect((await findApps(probes(['/opt/signal-cli/bin/signal-cli']))).signal).toBe('/opt/signal-cli/bin/signal-cli');
    expect((await findApps(probes([]))).signal).toBeNull();
  });
});

describe('SG1 setup answers', () => {
  it('turns Signal on only with a linked number, and keeps it off otherwise', () => {
    expect(buildConfig(answers(), null, presets, found, GMAIL).config.signal).toEqual(SignalConfig.parse({ command: '/usr/bin/signal-cli' }));
    const on = buildConfig(answers({ signal: { enabled: true } }), null, presets, found, GMAIL, NUMBER).config.signal;
    expect(on).toMatchObject({ enabled: true, account: NUMBER, command: '/usr/bin/signal-cli' });
    expect(() => buildConfig(answers({ signal: { enabled: true } }), null, presets, found, GMAIL)).toThrow(SetupError);
    // The page can't name the number itself.
    expect(() => SetupAnswers.parse({ ...answers(), signal: { enabled: true, account: '+15550000000' } })).toThrow();
  });

  it('Settings keeps the number linked before, and unticking turns Signal off without forgetting it', () => {
    const first = buildConfig(answers({ signal: { enabled: true } }), null, presets, found, GMAIL, NUMBER).config;
    const kept = buildConfig(answers({ signal: { enabled: true } }), first, presets, found, GMAIL).config.signal;
    expect(kept).toMatchObject({ enabled: true, account: NUMBER });
    const off = buildConfig(answers({ signal: { enabled: false } }), first, presets, found, GMAIL).config.signal;
    expect(off).toMatchObject({ enabled: false, account: NUMBER });
    expect(summarize(first, presets)).toMatchObject({ signal: { enabled: true, account: NUMBER } });
  });
});

describe('SG1 setup server', () => {
  it('links through its own routes and writes the number linked, not one the page sends', async () => {
    const cli = pretendCli();
    const linker = new SignalLinker(() => 'signal-cli', cli.runner);
    const written: AiosConfig[] = [];
    const stored = new Map<SecretRef, string>();
    const deps: SetupDeps = {
      page: async () => '',
      presets,
      readConfig: async () => written.at(-1) ?? null,
      writeConfig: async (c) => void written.push(c),
      keyring: { set: async (r, v) => void stored.set(r, v), get: async () => null },
      look: async () => ({ name: 'Baris', timezone: 'Europe/Istanbul', folders: [{ path: '~/Documents' }], apps: { ...found, whisper: null }, ollama: [], screens: [] }),
      mx: async () => [],
      checkAi: async () => ({ ok: true, message: 'm' }),
      checkMail: async () => ({ ok: true, message: 'm' }),
      installDesktop: async () => [],
      signal: linker,
      done: () => undefined,
    };
    const s = await startSetupServer(deps, { token: 'tok' });
    const u = new URL(s.url);
    const send = (path: string, body?: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ host: '127.0.0.1', port: u.port, path, method: data ? 'POST' : 'GET', headers: { host: u.host, ...(data ? { 'content-type': 'application/json', origin: u.origin } : {}) } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on('error', reject);
        req.end(data);
      });
    try {
      // Another page can't start a link.
      const evil = await new Promise<number>((resolve) => {
        const req = request({ host: '127.0.0.1', port: u.port, path: '/s/tok/api/signal-link', method: 'POST', headers: { host: u.host, 'content-type': 'application/json', origin: 'https://evil.example' } }, (res) => resolve(res.statusCode ?? 0));
        req.end('{}');
      });
      expect(evil).toBe(403);
      expect(cli.calls).toEqual([]);

      const start = JSON.parse((await send('/s/tok/api/signal-link', {})).body) as { state: string; qr?: string };
      expect(start.state).toBe('waiting');
      expect(JSON.stringify(start)).not.toContain('sgnl://');
      expect(JSON.parse((await send('/s/tok/api/signal-link')).body).state).toBe('waiting');
      cli.scan();
      await new Promise((r) => setTimeout(r, 10));
      expect(JSON.parse((await send('/s/tok/api/signal-link')).body)).toEqual({ state: 'linked', number: NUMBER });
      const r = await send('/s/tok/api/finish', { ...answers({ signal: { enabled: true } }) });
      expect(JSON.parse(r.body).ok).toBe(true);
      expect(written[0]!.signal).toMatchObject({ enabled: true, account: NUMBER });
    } finally {
      await s.close();
    }
  });
});
