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
  temperature: z.number().min(0).max(2).default(0.3),
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

export const MODEL_ROLES = ['chat', 'triage', 'nightly'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

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
});
export type MailConfig = z.infer<typeof MailConfig>;

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
  }),
  mail: MailConfig,
  notifications: z
    .strictObject({
      maxPerHour: z.int().min(1).default(6),
      quietHours: z
        .strictObject({ start: HourMinute, end: HourMinute })
        .optional(),
    })
    .default({ maxPerHour: 6 }),
  cost: z.strictObject({ dailyCapUsd: z.number().positive().default(2) }).default({ dailyCapUsd: 2 }),
  ui: z
    .strictObject({
      port: z.int().min(1024).max(65_535).default(7777),
      kiosk: z.boolean().default(true),
    })
    .default({ port: 7777, kiosk: true }),
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
