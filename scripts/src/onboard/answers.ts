/**
 * R2: what the setup window sends, and the config it becomes. Only what needs the person is
 * asked; everything else has a default: the timezone comes from the system, the mail servers
 * from the address (Gmail and Google Workspace), the sign-in name is the address, triage and
 * the nightly job use the chat's model and key, and every section setup doesn't show is kept
 * from the existing config. Pure, so it is unit-tested (scripts/test/onboard.test.ts).
 */
import { AiosConfig, DEFAULT_PORT, EmbeddingsConfig, LocalModelConfig, ModelRoleConfig, type SecretRef, SIGNAL_NUMBER, SpeechConfig, WallpaperDim } from '@aios/shared';
import { z } from 'zod';

export const MAIL_PASSWORD_REF: SecretRef = 'keyring:mail';
export const CHAT_KEY_REF: SecretRef = 'keyring:model-chat';

export interface ProviderPreset {
  label: string;
  blurb: string;
  keyUrl: string;
  defaultModel?: string;
  baseUrl: string;
  extraBody: Record<string, unknown>;
  extraHeaders: Record<string, string>;
}

/** providers.json, checked: it ships with the app but is still a file on disk. */
export function readPresets(raw: Record<string, unknown>): Record<string, ProviderPreset> {
  const Preset = z.looseObject({
    label: z.string().min(1).max(40),
    blurb: z.string().max(120),
    keyUrl: z.url({ protocol: /^https$/ }),
    defaultModel: z.string().min(1).max(200).optional(),
    baseUrl: z.url({ protocol: /^https$/ }),
    extraBody: z.record(z.string(), z.unknown()),
    extraHeaders: z.record(z.string(), z.string()),
  });
  const out: Record<string, ProviderPreset> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    out[id] = Preset.parse(v) as ProviderPreset;
  }
  return out;
}

const Port = z.int().min(1).max(65_535);
const Server = z.strictObject({ host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'a host name such as imap.example.com'), port: Port });

/** A known mail provider's servers. Gmail: developers.google.com/workspace/gmail/imap/imap-smtp (2026-11-03). */
export interface MailServers {
  provider: 'gmail' | 'other';
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}
export const GMAIL: MailServers = { provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 } };

/**
 * The servers for an address, without asking: gmail.com and googlemail.com, and any domain whose
 * mail goes to Google (Google Workspace, by its MX records). Null when the person must type them.
 */
export function serversFor(address: string, mx: string[]): MailServers | null {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return GMAIL;
  if (mx.some((h) => /(^|\.)(google\.com|googlemail\.com)\.?$/i.test(h))) return GMAIL;
  return null;
}

/** Google shows an app password as four groups of four letters; the spaces are not part of it. */
export function cleanPassword(password: string, servers: MailServers | null): string {
  return servers?.provider === 'gmail' ? password.replace(/\s+/g, '') : password;
}

export const SetupAnswers = z.strictObject({
  name: z.string().trim().min(1, 'Type the name Astra should call you').max(60),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'not a timezone'),
  ai: z.strictObject({
    provider: z.string().min(1).max(40),
    /** Only for provider "other": any OpenAI-compatible address. */
    baseUrl: z.url({ protocol: /^https$/ }).optional(),
    model: z.string().trim().min(1, 'Choose a model').max(200),
    /** Empty keeps the stored key (Settings). */
    key: z.string().trim().max(500).default(''),
  }),
  /** The Ollama model for the local jobs, or null for none. */
  local: z.string().trim().min(1).max(200).nullable().default(null),
  mail: z.strictObject({
    address: z.email('Type your whole email address'),
    /** Empty keeps the stored password (Settings). */
    password: z.string().max(500).default(''),
    /** Only when the address isn't one Astra knows. */
    imap: Server.optional(),
    smtp: Server.optional(),
  }),
  /** Home folders as ~/Name. */
  folders: z.array(z.string().regex(/^~\/[^/\0][^\0]{0,200}$/, 'a folder in your home folder')).min(1, 'Tick at least one folder').max(8),
  /** voice: the chat's microphone, through a whisper.cpp server on this computer. */
  apps: z.strictObject({ docs: z.boolean(), video: z.boolean(), builder: z.boolean(), voice: z.boolean().default(false) }),
  /** The service always runs; these are the parts of the desktop it may change. */
  desktop: z.strictObject({ autostart: z.boolean(), hyprland: z.boolean(), bar: z.boolean() }),
  /** SG1: Signal on or off. The number comes from linking in this window, never from the page. */
  signal: z.strictObject({ enabled: z.boolean() }).default({ enabled: false }),
  /** The screen Astra keeps; empty when there is only one. */
  monitor: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)]).default(''),
  /**
   * The picture behind the chat. `new` uses the picture this window was sent (POST wallpaper);
   * `sample` copies the named sample in; `remove` takes the current one away; `keep` leaves it
   * and only sets the dim.
   */
  wallpaper: z
    .strictObject({ change: z.enum(['keep', 'new', 'remove', 'sample']), dim: WallpaperDim, sample: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional() })
    .default({ change: 'keep', dim: 'medium' }),
});
export type SetupAnswers = z.infer<typeof SetupAnswers>;

/** What the app scan found (probe.ts); null for not found. */
export interface FoundApps {
  wordcraft: string | null;
  gridcraft: string | null;
  wordcraftCli: string | null;
  gridcraftCli: string | null;
  mpv: string | null;
  claude: string | null;
  /** A whisper.cpp server answers on [models.speech]'s default address. */
  speech?: boolean;
  /** SG1: signal-cli, from the Signal add-on. */
  signal?: string | null;
  /** An Ollama embedding model, for finding files by meaning (F3). */
  embed?: string | null;
}

export interface BuiltSetup {
  config: AiosConfig;
  secrets: Map<SecretRef, string>;
}

/** The answers as a config, on top of the existing one. Throws a SetupError the window can show. */
export function buildConfig(
  a: SetupAnswers,
  existing: AiosConfig | null,
  presets: Record<string, ProviderPreset>,
  found: FoundApps,
  servers: MailServers | null,
  /** SG1: the number this window just linked, if it did. */
  signalLinked: string | null = null,
): BuiltSetup {
  const secrets = new Map<SecretRef, string>();

  // AI: one provider and key for chat, triage and the nightly job.
  const preset = presets[a.ai.provider];
  const baseUrl = preset?.baseUrl ?? a.ai.baseUrl;
  if (!baseUrl) throw new SetupError('ai', 'Type the address of your AI provider (it starts with https://)');
  if (a.ai.key) secrets.set(CHAT_KEY_REF, a.ai.key);
  else if (!existing) throw new SetupError('ai', 'Paste your API key');
  const prevChat = existing?.models.chat;
  const chat = ModelRoleConfig.parse({
    ...(preset ? { extraBody: preset.extraBody, extraHeaders: preset.extraHeaders } : {}),
    ...(prevChat && prevChat.baseUrl === baseUrl ? prevChat : {}),
    baseUrl,
    model: a.ai.model,
    apiKeyRef: CHAT_KEY_REF,
  });
  const models: AiosConfig['models'] = {
    // F3: kept when set; turned on with the local model when Ollama has an embedding model.
    ...(existing?.models.embeddings ? { embeddings: existing.models.embeddings } : a.local && found.embed ? { embeddings: EmbeddingsConfig.parse({ model: found.embed }) } : {}),
    // Voice: kept when it was set up by hand, turned on with defaults when the server is running.
    ...(a.apps.voice && (existing?.models.speech || found.speech) ? { speech: existing?.models.speech ?? SpeechConfig.parse({}) } : {}),
    chat,
    triage: { ...chat },
    nightly: { ...chat },
    ...(a.local ? { local: LocalModelConfig.parse({ ...(existing?.models.local ?? {}), model: a.local }) } : {}),
  };

  // Mail: the address is the sign-in name; known providers need no servers.
  const known = servers ?? null;
  const imap = known?.imap ?? a.mail.imap;
  const smtp = known?.smtp ?? a.mail.smtp;
  if (!imap || !smtp) throw new SetupError('mail', "Astra doesn't know this provider's servers; type them below");
  const password = cleanPassword(a.mail.password, known);
  if (password) secrets.set(MAIL_PASSWORD_REF, password);
  else if (!existing || existing.mail.address.toLowerCase() !== a.mail.address.toLowerCase()) throw new SetupError('mail', 'Paste the password (for Gmail, the app password)');
  const prevMail = existing?.mail;
  const mail: AiosConfig['mail'] = {
    address: a.mail.address,
    username: a.mail.address,
    passwordRef: MAIL_PASSWORD_REF,
    imap: { ...imap, tls: true },
    smtp: { ...smtp, tls: true },
    pollIntervalSeconds: prevMail?.pollIntervalSeconds ?? 30,
    batchWindowSeconds: prevMail?.batchWindowSeconds ?? 20,
    saveSentCopy: prevMail?.saveSentCopy ?? true,
  };

  // Folders: the files tools and the Word and Excel reader use the same ones.
  const roots = [...new Set(a.folders)];
  const saveTo = roots.includes('~/Downloads') ? '~/Downloads' : roots[0]!;
  const docsOn = a.apps.docs && !!found.wordcraftCli && !!found.gridcraftCli;
  const base = existing ?? null;
  const { calendar, ...kept } = base ?? ({} as Partial<AiosConfig>);
  const config = AiosConfig.parse({
    ...kept,
    ...(calendar ? { calendar } : {}),
    user: { name: a.name, timezone: a.timezone },
    models,
    mail,
    files: { ...(base?.files ?? {}), roots, saveTo },
    docs: {
      ...(base?.docs ?? {}),
      enabled: docsOn,
      roots,
      ...(found.wordcraftCli ? { wordCli: found.wordcraftCli } : {}),
      ...(found.gridcraftCli ? { sheetCli: found.gridcraftCli } : {}),
      ...(found.wordcraft ? { wordApp: found.wordcraft } : {}),
      ...(found.gridcraft ? { sheetApp: found.gridcraft } : {}),
    },
    video: { ...(base?.video ?? {}), enabled: a.apps.video && !!found.mpv, ...(found.mpv ? { player: found.mpv } : {}) },
    builder: { ...(base?.builder ?? {}), enabled: a.apps.builder && !!found.claude, ...(found.claude ? { command: found.claude } : {}) },
    ui: { ...(base?.ui ?? { port: DEFAULT_PORT }), kiosk: a.desktop.autostart },
    screen: { ...(base?.screen ?? {}), monitor: a.monitor },
    signal: signalSection(a, base, found, signalLinked),
  });
  return { config, secrets };
}

/** SG1: on only with a linked number: the one just linked, or the one linked before. */
function signalSection(a: SetupAnswers, base: AiosConfig | null, found: FoundApps, linked: string | null): Partial<AiosConfig['signal']> {
  const prev = base?.signal;
  const account = linked && SIGNAL_NUMBER.test(linked) ? linked : prev?.account;
  if (a.signal.enabled && !account) throw new SetupError('signal', 'Link your phone first, or untick Signal');
  return {
    ...(prev ?? {}),
    enabled: a.signal.enabled && !!account,
    ...(account ? { account } : {}),
    ...(found.signal ? { command: found.signal } : {}),
  };
}

/** A problem with one step's answers, in words for the window. */
export class SetupError extends Error {
  override readonly name = 'SetupError';
  constructor(
    readonly step: 'welcome' | 'ai' | 'mail' | 'signal' | 'folders' | 'wallpaper' | 'desktop',
    message: string,
  ) {
    super(message);
  }
}

/** What the window may know about an existing config: never a secret, only whether one is stored. */
export function summarize(c: AiosConfig | null, presets: Record<string, ProviderPreset>): Record<string, unknown> | null {
  if (!c) return null;
  const provider = Object.entries(presets).find(([, p]) => p.baseUrl === c.models.chat.baseUrl)?.[0] ?? 'other';
  return {
    name: c.user.name,
    timezone: c.user.timezone,
    ai: { provider, baseUrl: provider === 'other' ? c.models.chat.baseUrl : undefined, model: c.models.chat.model },
    local: c.models.local?.model ?? null,
    mail: { address: c.mail.address, imap: { host: c.mail.imap.host, port: c.mail.imap.port }, smtp: { host: c.mail.smtp.host, port: c.mail.smtp.port } },
    folders: c.files.roots,
    apps: { docs: c.docs.enabled, video: c.video.enabled, builder: c.builder.enabled, voice: !!c.models.speech },
    autostart: c.ui.kiosk,
    calendar: !!c.calendar,
    signal: { enabled: c.signal.enabled, account: c.signal.account ?? null },
    monitor: c.screen.monitor,
  };
}
