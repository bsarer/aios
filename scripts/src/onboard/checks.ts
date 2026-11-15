/**
 * R2: the setup window's Test buttons. The AI key gets one tiny call through ModelClient (the
 * only way to a model); the mail sign-in logs in over IMAP, finds the folders, and checks the
 * SMTP login without sending anything. Each answer says, in plain words, what to fix.
 * Nothing here logs or returns a secret.
 */
import { ModelClient, ModelError, Secret, describeMailError, smtpOptions } from '@aios/core';
import { ModelRoleConfig } from '@aios/shared';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { MailServers, ProviderPreset } from './answers.js';

export interface CheckResult {
  ok: boolean;
  /** One sentence for the window. */
  message: string;
  /** What to do about it, when it failed. */
  fix?: string;
}

export async function checkAiKey(o: { preset: ProviderPreset | undefined; baseUrl: string; model: string; key: string; fetch?: typeof fetch }): Promise<CheckResult> {
  const role = ModelRoleConfig.parse({
    ...(o.preset ? { extraBody: o.preset.extraBody, extraHeaders: o.preset.extraHeaders } : {}),
    baseUrl: o.baseUrl,
    model: o.model,
    apiKeyRef: 'keyring:model-chat',
    maxTokens: 32,
    timeoutMs: 20_000,
  });
  const client = new ModelClient({
    models: { chat: role, triage: role, nightly: role },
    resolveKey: async () => new Secret(o.key),
    maxAttempts: 1,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  try {
    await client.complete({ role: 'chat', messages: [{ role: 'user', content: 'Reply with the word ok.' }] });
    return { ok: true, message: 'The key works. It goes into the keyring when you finish setup.' };
  } catch (err) {
    const kind = err instanceof ModelError ? err.kind : 'network';
    const keyPage = o.preset ? ` Make a new one at ${o.preset.keyUrl}.` : '';
    switch (kind) {
      case 'auth':
        return { ok: false, message: `${o.preset?.label ?? 'The provider'} rejected this key.`, fix: `Copy the whole key again, with nothing before or after it.${keyPage}` };
      case 'credits':
        return { ok: false, message: 'The key works, but the account has no credits.', fix: `Add credits on ${o.preset?.label ?? 'the provider'}'s site, then test again.` };
      case 'forbidden':
        return { ok: false, message: 'The key works, but it may not use this model.', fix: "Check the key's limits on the provider's site, or choose another model." };
      case 'bad_request':
        return { ok: false, message: `The provider doesn't know the model "${o.model}".`, fix: "Check the model's name on the provider's site; it is case-sensitive." };
      case 'rate_limited':
        return { ok: false, message: 'The provider is busy right now.', fix: 'Wait a minute and test again.' };
      case 'timeout':
      case 'unavailable':
        return { ok: false, message: 'The provider did not answer in time.', fix: 'Test again in a minute.' };
      default:
        return { ok: false, message: "Astra can't reach the provider.", fix: 'Check that this computer is online, and the address if you typed one.' };
    }
  }
}

export interface MailCheckDeps {
  imap?: (opts: ConstructorParameters<typeof ImapFlow>[0]) => Pick<ImapFlow, 'connect' | 'list' | 'logout'>;
  smtpVerify?: (opts: ReturnType<typeof smtpOptions>) => Promise<unknown>;
}

export async function checkMail(o: { address: string; password: string; servers: MailServers; deps?: MailCheckDeps }): Promise<CheckResult> {
  const gmail = o.servers.provider === 'gmail';
  const imap = (o.deps?.imap ?? ((x) => new ImapFlow(x)))({
    host: o.servers.imap.host,
    port: o.servers.imap.port,
    secure: true,
    auth: { user: o.address, pass: o.password },
    logger: false,
  });
  let folders = '';
  try {
    await imap.connect();
    const list = await imap.list();
    const has = (use: string, name: string) => list.some((b) => b.specialUse === use || b.path.toLowerCase().endsWith(name));
    folders = ['Inbox', has('\\Sent', 'sent') || has('\\Sent', 'sent mail') ? 'Sent' : '', has('\\Drafts', 'drafts') ? 'Drafts' : ''].filter(Boolean).join(', ');
  } catch (err) {
    return mailFailure(err, gmail);
  } finally {
    await imap.logout().catch(() => undefined);
  }
  try {
    const verify = o.deps?.smtpVerify ?? ((opts) => nodemailer.createTransport(opts).verify());
    await verify(smtpOptions({ host: o.servers.smtp.host, port: o.servers.smtp.port, tls: true, user: o.address, password: async () => o.password }, o.password));
  } catch (err) {
    const f = mailFailure(err, gmail);
    return { ...f, message: `Reading mail works, but sending doesn't: ${f.message.charAt(0).toLowerCase()}${f.message.slice(1)}` };
  }
  return { ok: true, message: `Signed in. Found ${folders}.` };
}

function mailFailure(err: unknown, gmail: boolean): CheckResult {
  const e = (err ?? {}) as { authenticationFailed?: boolean; code?: string; responseCode?: number; responseText?: string };
  const authFailed = e.authenticationFailed || e.code === 'EAUTH' || e.responseCode === 535;
  if (authFailed && gmail) {
    return {
      ok: false,
      message: 'Gmail did not accept this app password.',
      fix: 'Use an app password, not your Google password: turn on 2-Step Verification, make one at https://myaccount.google.com/apppasswords, and paste its 16 letters. A work or school account may need its admin to allow it.',
    };
  }
  if (authFailed) return { ok: false, message: 'The mail server did not accept this address and password.', fix: 'Check the password. Some providers need an app password made on their website.' };
  if (gmail && /IMAP/i.test(e.responseText ?? '')) {
    return { ok: false, message: 'Gmail says IMAP is off for this account.', fix: 'Turn on IMAP in Gmail: Settings, See all settings, Forwarding and POP/IMAP.' };
  }
  const why = describeMailError(err);
  return { ok: false, message: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`, fix: 'Check that this computer is online, and the server names if you typed them.' };
}
