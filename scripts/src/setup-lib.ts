import { AiosConfig, MODEL_ROLES, type ModelRole, type SecretRef } from '@aios/shared';
import { TEST_MAILBOX } from './mailbox.js';

/** Asks the user something. `secret` answers must not be echoed. */
export interface Prompter {
  ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

export const MAIL_PASSWORD_REF: SecretRef = 'keyring:mail';
export const modelKeyRef = (role: ModelRole): SecretRef => `keyring:model-${role}`;

/** Every keyring reference a config points at, deduplicated. */
export function secretRefs(config: AiosConfig): SecretRef[] {
  return [...new Set([config.mail.passwordRef, ...MODEL_ROLES.map((r) => config.models[r].apiKeyRef)])];
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
export async function collectSetup(p: Prompter, existing: AiosConfig | null, providers: Record<string, string>): Promise<CollectedSetup> {
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
    };
    await keepOrAsk(MAIL_PASSWORD_REF, 'Mail app password');
  }

  // Models: chat first; triage and nightly may reuse it.
  const providerList = Object.entries(providers).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}: ${v}`).join(', ');
  const models = {} as AiosConfig['models'];
  for (const role of MODEL_ROLES) {
    const prev = existing?.models[role];
    if (role !== 'chat' && (await p.confirm(`Use the chat model settings for ${role} too?`, prev ? sameModel(prev, models.chat) : true))) {
      models[role] = { ...models.chat };
      continue;
    }
    const baseUrl = await p.ask(`[${role}] OpenAI-compatible base URL (${providerList})`, { default: prev?.baseUrl ?? '' });
    const model = await p.ask(`[${role}] Model name (the A1 bake-off picks the default)`, { default: prev?.model ?? '' });
    const apiKeyRef = modelKeyRef(role);
    await keepOrAsk(apiKeyRef, `[${role}] API key`);
    models[role] = { baseUrl, model, apiKeyRef, maxTokens: prev?.maxTokens ?? 1024, temperature: prev?.temperature ?? 0.3, timeoutMs: prev?.timeoutMs ?? 30_000 };
  }

  const config = AiosConfig.parse({
    user: { name, timezone },
    models,
    mail,
    notifications: existing?.notifications,
    cost: existing?.cost,
    ui: existing?.ui,
  });
  return { config, secrets };
}

function sameModel(a: AiosConfig['models'][ModelRole], b: AiosConfig['models'][ModelRole]): boolean {
  return a.baseUrl === b.baseUrl && a.model === b.model;
}
