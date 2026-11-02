import { AiosConfig, LocalModelConfig, MODEL_ROLES, type CloudModelRole, ModelRoleConfig, type SecretRef } from '@aios/shared';
import { TEST_MAILBOX } from './mailbox.js';

/** Asks the user something. `secret` answers must not be echoed. */
export interface Prompter {
  ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

export const MAIL_PASSWORD_REF: SecretRef = 'keyring:mail';
export const modelKeyRef = (role: CloudModelRole): SecretRef => `keyring:model-${role}`;
export const CALENDAR_SECRET_REF: SecretRef = 'keyring:calendar-client-secret';
export const CALENDAR_TOKEN_REF: SecretRef = 'keyring:calendar-google';

/** Every keyring reference a config points at, deduplicated. */
export function secretRefs(config: AiosConfig): SecretRef[] {
  const calendar = config.calendar ? [...(config.calendar.clientSecretRef ? [config.calendar.clientSecretRef] : []), config.calendar.tokenRef] : [];
  return [...new Set([config.mail.passwordRef, ...MODEL_ROLES.map((r) => config.models[r].apiKeyRef), ...calendar])];
}

export interface CollectedSetup {
  config: AiosConfig;
  /** Secrets to store, keyed by reference. Only entries the user typed. */
  secrets: Map<SecretRef, string>;
}

const num = (s: string) => Number.parseInt(s, 10);

/**
 * Walk the user through every setting, using `existing` as defaults so re-running is safe.
 * Pure apart from the prompter, so it is unit-testable.
 */
export interface ProviderPreset {
  baseUrl: string;
  extraBody: Record<string, unknown>;
  extraHeaders: Record<string, string>;
}
export type ProviderPresets = Record<string, ProviderPreset | string>;

export async function collectSetup(p: Prompter, existing: AiosConfig | null, providers: ProviderPresets): Promise<CollectedSetup> {
  const secrets = new Map<SecretRef, string>();
  const keepOrAsk = async (ref: SecretRef, label: string) => {
    const hint = existing ? ' (leave empty to keep the stored one)' : '';
    const v = await p.ask(`${label}${hint}`, { secret: true });
    if (v) secrets.set(ref, v);
    else if (!existing) throw new Error(`${label} is required`);
  };

  const name = await p.ask('Your first name', { default: existing?.user.name ?? '' });
  const timezone = await p.ask('Timezone', { default: existing?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });

  // Mail
  const useTestStack = await p.confirm('Use the local GreenMail test mailbox (docker compose)?', existing ? existing.mail.imap.host === TEST_MAILBOX.host : true);
  let mail: AiosConfig['mail'];
  if (useTestStack) {
    mail = {
      address: TEST_MAILBOX.user,
      username: TEST_MAILBOX.user,
      passwordRef: MAIL_PASSWORD_REF,
      imap: { host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, tls: false },
      smtp: { host: TEST_MAILBOX.host, port: TEST_MAILBOX.smtpPort, tls: false },
      pollIntervalSeconds: existing?.mail.pollIntervalSeconds ?? 30,
      batchWindowSeconds: existing?.mail.batchWindowSeconds ?? 20,
      saveSentCopy: true,
    };
    secrets.set(MAIL_PASSWORD_REF, TEST_MAILBOX.pass);
  } else {
    const prev = existing?.mail;
    const address = await p.ask('Mail address', { default: prev?.address ?? '' });
    mail = {
      address,
      username: await p.ask('IMAP/SMTP username', { default: prev?.username ?? address }),
      passwordRef: MAIL_PASSWORD_REF,
      imap: {
        host: await p.ask('IMAP host', { default: prev?.imap.host ?? '' }),
        port: num(await p.ask('IMAP port', { default: String(prev?.imap.port ?? 993) })),
        tls: true,
      },
      smtp: {
        host: await p.ask('SMTP host', { default: prev?.smtp.host ?? '' }),
        port: num(await p.ask('SMTP port', { default: String(prev?.smtp.port ?? 465) })),
        tls: true,
      },
      pollIntervalSeconds: prev?.pollIntervalSeconds ?? 30,
      batchWindowSeconds: prev?.batchWindowSeconds ?? 20,
      saveSentCopy: prev?.saveSentCopy ?? true,
    };
    await keepOrAsk(MAIL_PASSWORD_REF, 'Mail app password');
  }

  // Models: chat first; triage and nightly may reuse it.
  const presets = Object.entries(providers).flatMap(([k, v]) => (typeof v === 'string' ? [] : [[k, v] as const]));
  const providerList = presets.map(([k]) => k).join(', ');
  const models = {} as AiosConfig['models'];
  for (const role of MODEL_ROLES) {
    const prev = existing?.models[role];
    if (role !== 'chat' && (await p.confirm(`Use the chat model settings for ${role} too?`, prev ? sameModel(prev, models.chat) : true))) {
      models[role] = { ...models.chat };
      continue;
    }
    const answer = await p.ask(`[${role}] Provider (${providerList}) or an OpenAI-compatible base URL`, { default: prev?.baseUrl ?? '' });
    const preset = presets.find(([k, v]) => k === answer || v.baseUrl === answer)?.[1];
    const baseUrl = preset?.baseUrl ?? answer;
    const model = await p.ask(`[${role}] Model name (the A1 bake-off picks the default)`, { default: prev?.model ?? '' });
    const apiKeyRef = modelKeyRef(role);
    await keepOrAsk(apiKeyRef, `[${role}] API key`);
    models[role] = ModelRoleConfig.parse({
      ...(preset ? { extraBody: preset.extraBody, extraHeaders: preset.extraHeaders } : {}),
      ...(prev && prev.baseUrl === baseUrl ? prev : {}),
      baseUrl,
      model,
      apiKeyRef,
    });
  }

  // L1: a small local model through Ollama for the system assistant. No key: it never leaves this computer.
  const prevLocal = existing?.models.local;
  if (await p.confirm('Use a small local model through Ollama for the system assistant? (install Ollama and pull a model first; see the README)', !!prevLocal)) {
    const model = await p.ask('[local] Ollama model name, as `ollama list` shows it', { default: prevLocal?.model ?? '' });
    if (!model) throw new Error('a model name is required for the local model');
    models.local = LocalModelConfig.parse({ ...(prevLocal ?? {}), model });
  }

  // Calendar (C1): Google, through an OAuth client the user makes in their own Google Cloud project.
  let calendar: AiosConfig['calendar'];
  const prevCal = existing?.calendar;
  if (await p.confirm('Connect a Google Calendar? (needs an OAuth client of type "Desktop app"; see the README)', !!prevCal)) {
    const clientId = await p.ask('Google OAuth client ID', { default: prevCal?.clientId ?? '' });
    if (!clientId) throw new Error('a client ID is required for the calendar');
    const hint = prevCal?.clientSecretRef ? ' (leave empty to keep the stored one)' : ' (leave empty if the client has none)';
    const secret = await p.ask(`Google OAuth client secret${hint}`, { secret: true });
    if (secret) secrets.set(CALENDAR_SECRET_REF, secret);
    calendar = {
      ...(prevCal ?? {}),
      provider: 'google',
      clientId,
      ...(secret || prevCal?.clientSecretRef ? { clientSecretRef: CALENDAR_SECRET_REF } : {}),
      tokenRef: CALENDAR_TOKEN_REF,
    } as AiosConfig['calendar'];
  }

  const config = AiosConfig.parse({
    user: { name, timezone },
    models,
    mail,
    ...(calendar ? { calendar } : {}),
    notifications: existing?.notifications,
    cost: existing?.cost,
    ui: existing?.ui,
    assistant: existing?.assistant,
  });
  return { config, secrets };
}

function sameModel(a: AiosConfig['models'][CloudModelRole], b: AiosConfig['models'][CloudModelRole]): boolean {
  return a.baseUrl === b.baseUrl && a.model === b.model;
}
