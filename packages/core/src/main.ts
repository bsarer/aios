/**
 * aios-core daemon. `pnpm start` (systemd --user in A6).
 *   AIOS_UI_DEV_ORIGIN=http://localhost:5173  also accept the Vite dev server
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, parseConfig } from '@aios/shared';
import { AuditLog } from './audit.js';
import { modelGate } from './gate.js';
import { ApprovalBroker } from './mail/approvals.js';
import { draftTools } from './mail/draft-tools.js';
import { MailClient, type MailConnection } from './mail/imap.js';
import { ImapSmtpOutbox } from './mail/outbox.js';
import { MailPipeline } from './mail/pipeline.js';
import { MailState } from './mail/state.js';
import { mailTools } from './mail/tools.js';
import { ImapMailSource, MailWatcher } from './mail/watcher.js';
import { MemoryFiles } from './memory/files.js';
import { Memory } from './memory/memory.js';
import { Nightly, localDate } from './memory/nightly.js';
import { ModelClient, ModelError } from './model.js';
import { dataDir } from './paths.js';
import { Keyring } from './secrets/keyring.js';
import { createServer } from './server.js';
import { Shell } from './shell.js';
import { readBattery, readWifi } from './status/system.js';
import { omarchyThemePath, readTheme, watchTheme } from './status/theme.js';
import { Store } from './store.js';
import { nowTool } from './tools/now.js';
import { ToolRegistry } from './tools/registry.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = parseConfig(await readFile(join(configDir(), 'config.toml'), 'utf8'));
  const keyring = new Keyring();

  const store = new Store(join(dataDir(), 'aios.db'));
  const audit = new AuditLog(join(dataDir(), 'audit.jsonl'));
  let shell: Shell | undefined;
  const model = new ModelClient({
    models: config.models,
    // Resolved per call, so a keyring that unlocks after login starts working without a restart.
    resolveKey: (ref) => keyring.require(ref),
    // Enforced here, for chat, triage and nightly alike, not left to each caller.
    gate: modelGate({ store, timeZone: config.user.timezone, dailyCapUsd: config.cost.dailyCapUsd }),
    onCall: (r) => {
      store.recordUsage({
        at: Date.now(),
        role: r.role,
        model: r.result?.model ?? r.model,
        ok: r.ok,
        errorKind: r.errorKind,
        promptTokens: r.result?.usage?.promptTokens,
        completionTokens: r.result?.usage?.completionTokens,
        costUsd: r.result?.usage?.costUsd,
        latencyMs: r.result?.latencyMs,
      });
      // Content never goes in the audit log, only who handled the call and what it cost.
      audit.append({ kind: 'model', role: r.role, baseUrl: r.baseUrl, model: r.model, ok: r.ok, errorKind: r.errorKind, errorStatus: r.errorStatus, errorDetail: r.errorDetail, provider: r.result?.provider, usage: r.result?.usage });
      shell?.pushStatus();
    },
  });

  const tools = new ToolRegistry(audit).register(nowTool(config.user.timezone));
  const mailConnection: MailConnection = {
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    tls: config.mail.imap.tls,
    user: config.mail.username,
    password: async () => (await keyring.require(config.mail.passwordRef)).reveal(),
  };
  const mailClient = new MailClient(mailConnection);
  for (const t of mailTools(mailClient)) tools.register(t);
  const outbox = new ImapSmtpOutbox(mailClient, {
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    tls: config.mail.smtp.tls,
    user: config.mail.username,
    password: mailConnection.password,
  });
  const approvals = new ApprovalBroker({
    store,
    outbox,
    audit,
    from: { name: config.user.name, address: config.mail.address },
    saveSentCopy: config.mail.saveSentCopy,
    // The shell is created next; drafts only appear once it exists.
    show: (item, isNew) => (isNew ? shell?.agent.post(item) : shell?.patchItem(item)),
    notice: (level, text) => shell?.agent.notice(level, text),
  });
  for (const t of draftTools({ broker: approvals, mail: mailClient, userName: config.user.name, selfAddress: config.mail.address })) tools.register(t);
  const memory = new Memory(new MemoryFiles(join(configDir(), 'memory'), config.user.name), store, config.memory.contextTokens);
  let nightlyNoticeFor = '';
  const nightly = new Nightly({
    memory,
    store,
    model,
    userName: config.user.name,
    timeZone: config.user.timezone,
    runAfter: config.memory.nightlyAt,
    onError: (err) => {
      audit.append({ kind: 'memory', decision: 'nightly_failed', error: (err as Error).message });
      // One notice per day; it retries hourly without repeating itself.
      const today = localDate(Date.now(), config.user.timezone);
      if (nightlyNoticeFor === today) return;
      nightlyNoticeFor = today;
      const why = err instanceof ModelError ? err.userMessage : 'Something went wrong.';
      shell?.agent.notice('warning', `I couldn't write yesterday's chat summary for memory. ${why} I'll try again later.`);
    },
  });
  const themePath = omarchyThemePath();
  shell = new Shell({
    store,
    model,
    tools,
    audit,
    userName: config.user.name,
    timeZone: config.user.timezone,
    modelName: config.models.chat.model,
    costCapUsd: config.cost.dailyCapUsd,
    readBattery,
    readWifi,
    theme: await readTheme(themePath),
    memory,
    approvals,
    onResume: () => void pipeline.run(),
    onIgnoreMail: (id) => mailState.markIgnored(id),
  });
  const mailState = new MailState(store);
  const pipeline = new MailPipeline({
    state: mailState,
    model,
    post: (item) => shell.agent.post(item),
    notice: (level, text) => shell.agent.notice(level, text),
    isPaused: () => shell.paused,
    timeZone: config.user.timezone,
    batchWindowMs: config.mail.batchWindowSeconds * 1000,
    maxPerHour: config.notifications.maxPerHour,
    quietHours: config.notifications.quietHours,
  });
  let mailProblem = '';
  const watcher = new MailWatcher({
    source: () => new ImapMailSource(mailConnection),
    state: mailState,
    pollMs: config.mail.pollIntervalSeconds * 1000,
    onNew: (count) => {
      audit.append({ kind: 'mail', event: 'new', count });
      pipeline.onNew();
    },
    onStatus: (status, detail) => {
      shell.setMailStatus(status);
      if (status === 'error' && detail && detail !== mailProblem) {
        audit.append({ kind: 'mail', event: 'error', detail });
        shell.agent.notice('warning', `I can't reach your mailbox: ${detail}. I'll keep retrying.`);
      }
      if (status === 'connected' && mailProblem) shell.agent.notice('info', 'Connected to your mailbox again.');
      mailProblem = status === 'error' ? (detail ?? 'error') : status === 'connected' ? '' : mailProblem;
    },
  });
  watchTheme(themePath, (t) => shell.setTheme(t));

  const app = await createServer(shell, {
    port: config.ui.port,
    uiDir: join(here, '..', '..', 'ui', 'dist'),
    devOrigins: process.env.AIOS_UI_DEV_ORIGIN ? [process.env.AIOS_UI_DEV_ORIGIN] : [],
  });
  await app.listen({ host: '127.0.0.1', port: config.ui.port });
  approvals.recover();
  shell.greet();
  // The chat still opens without a key, and says what is wrong, instead of the service crash-looping.
  await keyring.require(config.models.chat.apiKeyRef).catch((err: unknown) => {
    audit.append({ kind: 'model', event: 'key_missing', error: (err as Error).message });
    shell.agent.notice('error', new ModelError('key_missing', '').userMessage);
  });
  await shell.refreshSystemStatus();
  setInterval(() => void shell.refreshSystemStatus(), 15_000).unref();
  watcher.start();
  // Catch-up after pause, quiet hours, rate limits and failed triage; a no-op when nothing is queued.
  setInterval(() => void pipeline.run(), 30_000).unref();
  // Paused means no model calls, so the nightly summary waits too.
  const nightlyTick = () => void (shell.paused ? undefined : nightly.runIfDue(Date.now()));
  nightlyTick();
  setInterval(nightlyTick, 10 * 60_000).unref();
  console.log(`aios-core listening on http://127.0.0.1:${config.ui.port}`);

  const shutdown = async () => {
    pipeline.stop();
    await watcher.stop();
    await mailClient.close();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(`aios-core failed to start: ${(err as Error).message}`);
  process.exit(1);
});
