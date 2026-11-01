import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

/**
 * Reference to a secret held in the system keyring, e.g. `keyring:openrouter`.
 * Config files only ever hold references, never secret values.
 */
export const SecretRef = z
  .string()
  .regex(/^keyring:[a-z0-9][a-z0-9._-]{0,63}$/, 'must look like "keyring:<name>"');
export type SecretRef = z.infer<typeof SecretRef>;

export const ModelRoleConfig = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }),
  // Model names live in config only. Chosen per role after the A1 bake-off.
  model: z.string().min(1),
  apiKeyRef: SecretRef,
  maxTokens: z.int().positive().max(200_000).default(1024),
  // Sent only when set: many reasoning models reject it, and with OpenRouter's
  // require_parameters an unsupported field leaves no provider to route to.
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.int().positive().default(30_000),
  /** 'json_schema' where the provider supports it, else 'json_object' + zod validation. */
  structuredOutput: z.enum(['json_schema', 'json_object']).default('json_schema'),
  /**
   * Provider-specific request fields merged into every request body, e.g. OpenRouter's
   * `provider = { data_collection = "deny", require_parameters = true }`. Core fields
   * (model, messages, tools, stream...) always win over these.
   */
  extraBody: z.record(z.string(), z.unknown()).default({}),
  extraHeaders: z.record(z.string(), z.string()).default({}),
});
export type ModelRoleConfig = z.infer<typeof ModelRoleConfig>;

/** The cloud roles every config has. */
export const MODEL_ROLES = ['chat', 'triage', 'nightly'] as const;
export type CloudModelRole = (typeof MODEL_ROLES)[number];
/** L1: 'local' is the small model on this computer (Ollama), when [models.local] is set. */
export type ModelRole = CloudModelRole | 'local';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * L1: a small model served on this computer, by default Ollama's OpenAI-compatible API
 * (http://127.0.0.1:11434/v1, checked against docs.ollama.com on 2026-11-01). It sees file
 * names, window titles and system numbers, so it must be on this machine: only loopback
 * addresses are accepted. Ollama needs no key; one can still be given through the keyring.
 */
export const LocalModelConfig = ModelRoleConfig.extend({
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .default('http://127.0.0.1:11434/v1')
    .refine((u) => LOOPBACK_HOSTS.has(new URL(u).hostname), 'the local model must be on this computer (127.0.0.1, localhost or ::1)'),
  apiKeyRef: SecretRef.optional(),
  maxTokens: z.int().positive().max(200_000).default(600),
  // Small models on a laptop CPU can take a while, more so the first call after a model loads.
  timeoutMs: z.int().positive().default(120_000),
  // Ollama documents JSON mode for /v1; json_schema support is not documented, so zod checks the answer.
  structuredOutput: z.enum(['json_schema', 'json_object']).default('json_object'),
});
export type LocalModelConfig = z.infer<typeof LocalModelConfig>;

/** L1: jobs that can move from a cloud role to the local model, by listing them in assistant.localTasks. */
export const LOCAL_TASKS = ['mailTriage', 'fileSummaries', 'nightlySummary'] as const;
export type LocalTask = (typeof LOCAL_TASKS)[number];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

/**
 * L1: the background system assistant. Code watches disk, memory and CPU and finds big unused
 * files and idle windows; the local model only words the advice and picks what to suggest.
 */
export const AssistantConfig = z.strictObject({
  enabled: z.boolean().default(true),
  monitor: z
    .strictObject({
      enabled: z.boolean().default(true),
      intervalSeconds: z.int().min(5).max(600).default(30),
      /** Folders whose drives are watched; one alert per drive. */
      disks: z.array(z.string().min(1).max(500)).min(1).max(8).default(['/', '~']),
      /** A drive is low below this share free, or below diskFreeGb, whichever comes first. */
      diskFreePercent: z.number().min(1).max(50).default(10),
      diskFreeGb: z.number().min(0.5).max(1000).default(10),
      /** Memory is low when less than this share is available, two samples in a row. */
      memoryFreePercent: z.number().min(1).max(50).default(10),
      /** The CPU is busy at this average over cpuMinutes. */
      cpuPercent: z.number().min(50).max(100).default(90),
      cpuMinutes: z.int().min(1).max(60).default(5),
      /** The same alert again at most this often, even if it recovers and drops again. */
      cooldownHours: z.number().min(0.25).max(72).default(6),
    })
    .prefault({}),
  review: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Local time after which the day's review is posted, once a day. */
      at: HHMM.default('09:00'),
      /** Files at least this big, in the [files] folders, not opened or changed for unusedDays. */
      minFileMb: z.number().min(1).max(100_000).default(100),
      unusedDays: z.int().min(1).max(3650).default(60),
      /** Windows not focused for this long count as idle. */
      idleAppHours: z.number().min(0.5).max(168).default(4),
      maxFiles: z.int().min(0).max(20).default(5),
      maxApps: z.int().min(0).max(20).default(5),
      /** A Move to Trash button on each suggested file; it runs only on the click and can be restored from the Trash. */
      trashButton: z.boolean().default(true),
    })
    .prefault({}),
  /** Jobs to run on the local model instead of their cloud role. Needs [models.local]. */
  localTasks: z.array(z.enum(LOCAL_TASKS)).max(LOCAL_TASKS.length).default([]),
});
export type AssistantConfig = z.infer<typeof AssistantConfig>;

const Endpoint = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(1).max(65_535),
  // false only for the local GreenMail stack.
  tls: z.boolean().default(true),
});

export const MailConfig = z.strictObject({
  address: z.email(),
  username: z.string().min(1),
  passwordRef: SecretRef,
  imap: Endpoint,
  smtp: Endpoint,
  pollIntervalSeconds: z.int().min(10).default(30),
  batchWindowSeconds: z.int().min(0).default(20),
  /** Append a copy of sent mail to Sent. Turn off for servers that do it themselves (Gmail). */
  saveSentCopy: z.boolean().default(true),
});
export type MailConfig = z.infer<typeof MailConfig>;

/**
 * C1: Google Calendar through its REST API (v3), signed in once with OAuth for a desktop
 * app (`pnpm calendar:login`). Endpoints are config so tests can point them at a fake server.
 * Checked 2026-10-31 against Google's discovery document and OpenID configuration.
 */
export const CalendarConfig = z.strictObject({
  provider: z.literal('google').default('google'),
  /** The OAuth client of type "Desktop app" from the user's own Google Cloud project. Not a secret. */
  clientId: z.string().min(1),
  /** Desktop clients are public, but the secret still lives in the keyring like any other. */
  clientSecretRef: SecretRef.optional(),
  /** The refresh token from `pnpm calendar:login`. */
  tokenRef: SecretRef.default('keyring:calendar-google'),
  /** "primary" is the signed-in user's own calendar. */
  calendarId: z.string().min(1).max(200).default('primary'),
  /** Length of a new event when the user gives no end time. */
  defaultMinutes: z.int().min(5).max(24 * 60).default(30),
  /** The hours calendar_free looks in when the user names a day but no hours. */
  workday: z
    .strictObject({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
    .default({ start: '09:00', end: '18:00' }),
  apiBaseUrl: z.url({ protocol: /^https?$/ }).default('https://www.googleapis.com/calendar/v3'),
  authUrl: z.url({ protocol: /^https?$/ }).default('https://accounts.google.com/o/oauth2/v2/auth'),
  tokenUrl: z.url({ protocol: /^https?$/ }).default('https://oauth2.googleapis.com/token'),
});
export type CalendarConfig = z.infer<typeof CalendarConfig>;

/**
 * D1: Word (.docx) and Excel (.xlsx) files, read through WordCraft's and GridCraft's own
 * command-line tools (storytold/wordcraft, storytold/gridcraft; MIT OR Apache-2.0). They are
 * separate programs, not npm packages. Only files under `roots` are ever opened.
 */
export const DocsConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** Folders the chat may read documents from. `~` is the home folder. */
  roots: z.array(z.string().min(1).max(500)).min(1).max(8).default(['~/Documents']),
  /** The command-line tools. Absolute paths when the service doesn't see them on PATH. */
  wordCli: z.string().min(1).default('wordcraft-cli'),
  sheetCli: z.string().min(1).default('gridcraft-cli'),
  /** The desktop apps, started with the file as their one argument (doc_open_app). */
  wordApp: z.string().min(1).default('wordcraft'),
  sheetApp: z.string().min(1).default('gridcraft'),
  /**
   * How long one command may take. A chat tool also stops at the registry's 15 s limit;
   * showing a Word file (a PDF conversion, from the card's Open) gets three times this.
   */
  timeoutSeconds: z.int().min(2).max(60).default(12),
});
export type DocsConfig = z.infer<typeof DocsConfig>;

/**
 * F1: files in these folders can be listed, shown, read, renamed and copied from the chat,
 * and attachments saved into them. Word and Excel tools use these folders too.
 */
export const FilesConfig = z.strictObject({
  enabled: z.boolean().default(true),
  roots: z.array(z.string().min(1).max(500)).min(1).max(8).default(['~/Documents', '~/Downloads']),
  /** Where an attachment's Save button saves unless another folder is picked on the card. */
  saveTo: z.string().min(1).max(500).default('~/Downloads'),
  /** F2: keep an index of the files (facts, summaries, tags) for files_search. */
  index: z.boolean().default(true),
  /** F2: describe each file with the triage model (about $0.001 a file). Off: facts and tags only. */
  summaries: z.boolean().default(true),
  /** F2: at most this many new summaries a day; the rest wait for the next day. */
  summariesPerDay: z.int().min(0).max(10_000).default(200),
  /** F2: index at most this many files. */
  maxIndexedFiles: z.int().min(100).max(200_000).default(20_000),
});
export type FilesConfig = z.infer<typeof FilesConfig>;

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

export const AiosConfig = z.strictObject({
  user: z.strictObject({
    name: z.string().min(1),
    timezone: z.string().min(1),
  }),
  models: z.strictObject({
    chat: ModelRoleConfig,
    triage: ModelRoleConfig,
    nightly: ModelRoleConfig,
    /** L1: leave out to run without a local model; the system assistant then writes its own plain text. */
    local: LocalModelConfig.optional(),
  }),
  mail: MailConfig,
  /** C1: leave out to run without a calendar. */
  calendar: CalendarConfig.optional(),
  notifications: z
    .strictObject({
      maxPerHour: z.int().min(1).default(6),
      quietHours: z
        .strictObject({ start: HourMinute, end: HourMinute })
        .optional(),
    })
    .default({ maxPerHour: 6 }),
  memory: z
    .strictObject({
      /** Token budget for one chat request: system prompt, profile, recalled notes and recent turns. */
      contextTokens: z.int().min(2000).max(200_000).default(8000),
      /** Local time after which yesterday's chat is summarised (plan §6). */
      nightlyAt: HourMinute.default('03:00'),
    })
    .default({ contextTokens: 8000, nightlyAt: '03:00' }),
  cost: z.strictObject({ dailyCapUsd: z.number().positive().default(2) }).default({ dailyCapUsd: 2 }),
  ui: z
    .strictObject({
      port: z.int().min(1024).max(65_535).default(7777),
      kiosk: z.boolean().default(true),
    })
    .default({ port: 7777, kiosk: true }),
  /** D1: reading Word and Excel files. */
  docs: DocsConfig.default({
    enabled: true,
    roots: ['~/Documents'],
    wordCli: 'wordcraft-cli',
    sheetCli: 'gridcraft-cli',
    wordApp: 'wordcraft',
    sheetApp: 'gridcraft',
    timeoutSeconds: 12,
  }),
  /** F1: managing files in a few folders. */
  files: FilesConfig.default({ enabled: true, roots: ['~/Documents', '~/Downloads'], saveTo: '~/Downloads', index: true, summaries: true, summariesPerDay: 200, maxIndexedFiles: 20_000 }),
  /** L1: the background system assistant on the local model. */
  assistant: AssistantConfig.prefault({}),
  /** S4: building apps with Claude Code. */
  builder: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Claude Code's command. An absolute path when the service doesn't see it on PATH. */
      command: z.string().min(1).default('claude'),
      /** Passed to Claude Code as --model when set; otherwise it uses its own default. */
      model: z.string().min(1).optional(),
      /** The highest spending cap a Build card offers. */
      maxBudgetUsd: z.number().positive().max(50).default(5),
      /** The caps a Build card offers to pick from; any above maxBudgetUsd are left out. */
      budgetChoicesUsd: z.array(z.number().positive().max(50)).min(1).max(4).default([1, 2, 5]),
      timeoutMinutes: z.int().min(1).max(60).default(15),
    })
    .default({ enabled: true, command: 'claude', maxBudgetUsd: 5, budgetChoicesUsd: [1, 2, 5], timeoutMinutes: 15 }),
});
export type AiosConfig = z.infer<typeof AiosConfig>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parse and validate config TOML. Throws ConfigError with readable issues. */
export function parseConfig(toml: string): AiosConfig {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (err) {
    throw new ConfigError(`config is not valid TOML: ${(err as Error).message}`);
  }
  const result = AiosConfig.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`config is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function serializeConfig(config: AiosConfig): string {
  return stringifyToml(AiosConfig.parse(config));
}

/** Respect XDG_CONFIG_HOME, falling back to ~/.config/aios. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || `${env.HOME ?? ''}/.config`;
  return `${base}/aios`;
}
