/**
 * R2: the setup window's server. It listens on 127.0.0.1 only, on a free port, under a random
 * path token; it answers only its own page (Host and Origin checked, JSON bodies capped), so
 * another program or web page can't drive it. Secrets go from the page to the keyring when
 * setup finishes and are never logged, stored elsewhere or sent back to the page.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiosConfig, SecretRef } from '@aios/shared';
import { z } from 'zod';
import {
  type FoundApps,
  MAIL_PASSWORD_REF,
  CHAT_KEY_REF,
  type MailServers,
  type ProviderPreset,
  SetupAnswers,
  SetupError,
  buildConfig,
  cleanPassword,
  serversFor,
  summarize,
} from './answers.js';
import type { CheckResult } from './checks.js';
import type { LinkState } from './signal.js';
import { ADDON_IDS, type AddonId } from '../addons.js';

export interface SetupDeps {
  page: () => Promise<string>;
  presets: Record<string, ProviderPreset>;
  readConfig: () => Promise<AiosConfig | null>;
  writeConfig: (c: AiosConfig) => Promise<void>;
  keyring: { set(ref: SecretRef, value: string): Promise<void>; get(ref: SecretRef): Promise<{ reveal(): string } | null> };
  look: () => Promise<{
    name: string;
    timezone: string;
    folders: { path: string }[];
    apps: FoundApps & { whisper: string | null; signal?: string | null };
    ollama: string[];
    screens: { name: string; width: number; height: number; focused: boolean }[];
    addons: { id: AddonId; label: string; blurb: string; installed: boolean }[];
  }>;
  /** Opens a terminal running astra addons for these; returns the terminal's name. */
  installAddons: (ids: AddonId[]) => Promise<string>;
  mx: (address: string) => Promise<string[]>;
  checkAi: (o: { preset: ProviderPreset | undefined; baseUrl: string; model: string; key: string }) => Promise<CheckResult>;
  checkMail: (o: { address: string; password: string; servers: MailServers }) => Promise<CheckResult>;
  /** Service, launcher and the desktop parts the person ticked; returns what it did, in words. */
  installDesktop: (c: AiosConfig, d: SetupAnswers['desktop']) => Promise<string[]>;
  /** SG1: linking the phone to Signal. Without it, the Signal step says linking isn't available. */
  signal?: { start(): Promise<LinkState>; readonly status: LinkState; cancel(): void };
  /** Opens the chat and closes the setup window. */
  done: () => void;
}

const MAX_BODY = 64 * 1024;
const ServerInput = z.strictObject({ host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/), port: z.int().min(1).max(65_535) });
const TestAi = z.strictObject({ provider: z.string().min(1).max(40), baseUrl: z.url({ protocol: /^https$/ }).optional(), model: z.string().trim().min(1).max(200), key: z.string().trim().max(500) });
const TestMail = z.strictObject({ address: z.email(), password: z.string().max(500), imap: ServerInput.optional(), smtp: ServerInput.optional() });
const Address = z.strictObject({ address: z.email() });
const Addons = z.strictObject({ ids: z.array(z.enum(ADDON_IDS)).min(1).max(ADDON_IDS.length) });

export interface SetupServer {
  url: string;
  close(): Promise<void>;
}

export async function startSetupServer(deps: SetupDeps, opts: { token?: string; port?: number } = {}): Promise<SetupServer> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  let origin = '';
  let finished = false;

  const servers = async (address: string, imap?: MailServers['imap'], smtp?: MailServers['smtp']): Promise<MailServers | null> =>
    serversFor(address, await deps.mx(address)) ?? (imap && smtp ? { provider: 'other', imap, smtp } : null);

  const api: Record<string, (body: unknown) => Promise<unknown>> = {
    'GET state': async () => {
      const [existing, look] = await Promise.all([deps.readConfig(), deps.look()]);
      return {
        existing: summarize(existing, deps.presets),
        presets: Object.entries(deps.presets).map(([id, p]) => ({ id, label: p.label, blurb: p.blurb, keyUrl: p.keyUrl, defaultModel: p.defaultModel ?? '' })),
        ...look,
      };
    },
    'POST mail-servers': async (body) => {
      const { address } = Address.parse(body);
      const s = serversFor(address, await deps.mx(address));
      return { provider: s?.provider ?? null };
    },
    'POST test-ai': async (body) => {
      const b = TestAi.parse(body);
      const preset = deps.presets[b.provider];
      const baseUrl = preset?.baseUrl ?? b.baseUrl;
      if (!baseUrl) return { ok: false, message: 'Type the address of your AI provider.', fix: 'It starts with https:// and usually ends in /v1.' };
      const key = b.key || (await deps.keyring.get(CHAT_KEY_REF))?.reveal() || '';
      if (!key) return { ok: false, message: 'Paste your API key first.' };
      return deps.checkAi({ preset, baseUrl, model: b.model, key });
    },
    'POST test-mail': async (body) => {
      const b = TestMail.parse(body);
      const s = await servers(b.address, b.imap, b.smtp);
      if (!s) return { ok: false, message: "Astra doesn't know this provider's servers.", fix: 'Type the IMAP and SMTP servers from your provider’s help pages.' };
      const existing = await deps.readConfig();
      const same = existing?.mail.address.toLowerCase() === b.address.toLowerCase();
      const password = cleanPassword(b.password, s) || (same ? (await deps.keyring.get(MAIL_PASSWORD_REF))?.reveal() : '') || '';
      if (!password) return { ok: false, message: s.provider === 'gmail' ? 'Paste the app password first.' : 'Type the password first.' };
      return deps.checkMail({ address: b.address, password, servers: s });
    },
    // SG1: the window gets the QR picture and the outcome; never the link as text.
    'POST signal-link': async () => (deps.signal ? deps.signal.start() : { state: 'failed', message: 'Linking Signal isn’t available here.' }),
    'GET signal-link': async () => deps.signal?.status ?? { state: 'idle' },
    'POST signal-cancel': async () => {
      deps.signal?.cancel();
      return { ok: true };
    },
    'POST addons': async (body) => {
      const { ids } = Addons.parse(body);
      try {
        const term = await deps.installAddons([...new Set(ids)]);
        return { ok: true, message: `A terminal opened (${term}). Type your password there when it asks. When it says Done, press Check again.` };
      } catch (err) {
        return { ok: false, message: `Couldn’t open a terminal: ${(err as Error).message}` };
      }
    },
    'POST finish': async (body) => {
      const answers = SetupAnswers.parse(body);
      const existing = await deps.readConfig();
      const look = await deps.look();
      const s = serversFor(answers.mail.address, await deps.mx(answers.mail.address));
      const link = deps.signal?.status;
      const built = buildConfig(answers, existing, deps.presets, look.apps, s, link?.state === 'linked' ? link.number : null);
      for (const [ref, value] of built.secrets) await deps.keyring.set(ref, value);
      await deps.writeConfig(built.config);
      const did = ['Saved your settings, and your keys in the keyring.', ...(await deps.installDesktop(built.config, answers.desktop))];
      finished = true;
      return { ok: true, did };
    },
    'POST open': async () => {
      if (!finished && !(await deps.readConfig())) return { ok: false, message: 'Finish setup first.' };
      setTimeout(() => deps.done(), 50);
      return { ok: true };
    },
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Never echo a body: it may hold a key. Zod issues name fields, not values.
      const message = err instanceof SetupError ? err.message : err instanceof z.ZodError ? (err.issues[0]?.message ?? 'Check this step') : 'Something went wrong; try again.';
      const step = err instanceof SetupError ? err.step : undefined;
      send(res, err instanceof SetupError || err instanceof z.ZodError ? 400 : 500, { ok: false, message, ...(step ? { step } : {}) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== origin.slice('http://'.length)) return void send(res, 421, { ok: false });
    const url = new URL(req.url ?? '/', origin);
    const [, prefix, given, ...rest] = url.pathname.split('/');
    if (prefix !== 's' || !given || !sameToken(given, token)) return void send(res, 404, { ok: false });
    const route = rest.join('/');
    if (req.method === 'GET' && route === '') return void page(res);
    if (!route.startsWith('api/')) return void send(res, 404, { ok: false });
    const name = `${req.method} ${route.slice(4)}`;
    const fn = api[name];
    if (!fn) return void send(res, 404, { ok: false });
    let body: unknown = undefined;
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) return void send(res, 403, { ok: false });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return void send(res, 415, { ok: false });
      body = await readJson(req);
    }
    send(res, 200, await fn(body));
  }

  async function page(res: ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString('base64');
    const html = (await deps.page()).replaceAll('{{NONCE}}', nonce);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/s/${token}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new SetupError('welcome', 'That was too much to send.');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SetupError('welcome', 'The window sent something Astra could not read.');
  }
}
