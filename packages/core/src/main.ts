/**
 * aios-core daemon. `pnpm start` (systemd --user in A6).
 *   AIOS_UI_DEV_ORIGIN=http://localhost:5173  also accept the Vite dev server
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, parseConfig } from '@aios/shared';
import { hyprlandIpc } from './apps/hyprland.js';
import { createLauncher } from './apps/launcher.js';
import { scanApps } from './apps/desktop.js';
import { AppBuilder } from './apps/builder.js';
import { BuildLog } from './apps/history.js';
import { AppLink, linkKey, linkToken } from './apps/link.js';
import { appTools, buildAppTool, buildStatusTool, builtAppOpener, offerBuild } from './apps/tools.js';
import { ChatWindow } from './apps/window.js';
import { desktopNotify } from './notify.js';
import { CalendarActions } from './calendar/actions.js';
import { GoogleAuth, GoogleCalendar } from './calendar/google.js';
import { calendarTools } from './calendar/tools.js';
import { AuditLog } from './audit.js';
import { DocActions } from './docs/actions.js';
import { editTools } from './docs/edit.js';
import { DocEngine } from './docs/engine.js';
import { FileActions } from './files/actions.js';
import { FileRoots } from './files/roots.js';
import { FileCatalog } from './files/catalog.js';
import { FactReader } from './files/facts.js';
import { FileIndexer } from './files/indexer.js';
import { fileSearchTools } from './files/search-tools.js';
import { fileTools } from './files/tools.js';
import { DocFiles } from './docs/files.js';
import { createDocumentOpener } from './docs/open.js';
import { docTools } from './docs/tools.js';
import { DocumentFiles } from './docs/viewer.js';
import { modelGate } from './gate.js';
import { ApprovalBroker } from './mail/approvals.js';
import { AttachmentFiles } from './mail/attachments.js';
import { draftTools } from './mail/draft-tools.js';
import { MailClient, type MailConnection } from './mail/imap.js';
import { ImapSmtpOutbox } from './mail/outbox.js';
import { MailPipeline } from './mail/pipeline.js';
import { MailState } from './mail/state.js';
import { attachmentTools, mailTools, recentMailTool } from './mail/tools.js';
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
import { SystemActions } from './system/actions.js';
import { SystemControls } from './system/controls.js';
import { systemTools } from './system/tools.js';
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

  const isPaused = () => store.getSetting('paused') === '1';
  const tools = new ToolRegistry(audit, { isPaused }).register(nowTool(config.user.timezone));
  const mailConnection: MailConnection = {
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    tls: config.mail.imap.tls,
    user: config.mail.username,
    password: async () => (await keyring.require(config.mail.passwordRef)).reveal(),
  };
  const mailClient = new MailClient(mailConnection);
  for (const t of mailTools(mailClient)) tools.register(t);
  const mailState = new MailState(store);
  tools.register(recentMailTool(mailState));
  // The shell is created below; cards only appear once it exists.
  // F1: the folders files may be managed in. Word and Excel tools see them too.
  const fileRoots = config.files.enabled ? new FileRoots({ roots: config.files.roots }) : undefined;
  let fileIndexer: FileIndexer | undefined;
  const attachmentFiles = new AttachmentFiles({
    store,
    mail: mailClient,
    audit,
    post: (item) => shell?.agent.post(item),
    patch: (item) => shell?.patchItem(item),
    ...(fileRoots ? { roots: fileRoots, saveTo: config.files.saveTo } : {}),
    onSaved: () => fileIndexer?.soon(),
  });
  for (const t of attachmentTools({ mail: mailClient, files: attachmentFiles })) tools.register(t);
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
  // C1: the calendar, when configured. Sign-in comes from `pnpm calendar:login`; until then
  // the tools answer that it isn't signed in.
  let calendarActions: CalendarActions | undefined;
  const cal = config.calendar;
  if (cal) {
    const clientSecretRef = cal.clientSecretRef;
    const auth = new GoogleAuth({
      tokenUrl: cal.tokenUrl,
      clientId: cal.clientId,
      clientSecret: async () => (clientSecretRef ? ((await keyring.get(clientSecretRef))?.reveal() ?? null) : null),
      refreshToken: async () => (await keyring.get(cal.tokenRef))?.reveal() ?? null,
    });
    const api = new GoogleCalendar({ apiBaseUrl: cal.apiBaseUrl, calendarId: cal.calendarId, auth });
    calendarActions = new CalendarActions({
      store,
      api,
      audit,
      timeZone: config.user.timezone,
      show: (item, isNew) => (isNew ? shell?.agent.post(item) : shell?.patchItem(item)),
    });
    const calendar = calendarTools({ api, actions: calendarActions, timeZone: config.user.timezone, defaultMinutes: cal.defaultMinutes, workday: cal.workday, selfAddresses: [config.mail.address] });
    for (const t of calendar) tools.register(t);
  }
  const controls = new SystemControls();
  const systemActions = new SystemActions({
    store,
    controls,
    audit,
    show: (item, isNew) => (isNew ? shell?.agent.post(item) : shell?.patchItem(item)),
    notice: (level, text) => shell?.agent.notice(level, text),
    isPaused,
  });
  const chatWindow = new ChatWindow({
    hypr: hyprlandIpc(),
    // S6: the screen the chat owns, and where apps open when the user doesn't say.
    home: config.screen.monitor,
    defaultPlace: config.screen.defaultPlace,
    audit,
    // The shell is created below; the UI hears about moves once it exists.
    onMode: (mode) => shell?.broadcast({ type: 'window', mode }),
    notice: (level, text) => shell?.agent.notice(level, text),
  });
  const launch = createLauncher();
  const apps = appTools({ scan: () => scanApps(), launch, window: chatWindow });
  // D1: Word and Excel files, read through WordCraft's and GridCraft's command-line tools.
  let documentFiles: DocumentFiles | undefined;
  let docEngine: DocEngine | undefined;
  let docFilesForShow: DocFiles | undefined;
  let docActions: DocActions | undefined;
  if (config.docs.enabled) {
    const d = config.docs;
    const docFiles = new DocFiles({ roots: [...new Set([...d.roots, ...(config.files.enabled ? config.files.roots : [])])] });
    docFilesForShow = docFiles;
    const engine = new DocEngine({ wordCli: d.wordCli, sheetCli: d.sheetCli, timeoutMs: d.timeoutSeconds * 1000 });
    docEngine = engine;
    documentFiles = new DocumentFiles({ store, files: docFiles, engine, audit, post: (item) => shell?.agent.post(item) });
    const open = createDocumentOpener({ word: d.wordApp, sheet: d.sheetApp });
    // doc_open_app is device tier like open_app, so it shares open_app's confirm card.
    apps.push(...docTools({ files: docFiles, engine, viewer: documentFiles, open, window: chatWindow }));
    // D2: changes go on a card; the Save click writes a new file (or, when asked, over the original after a backup).
    docActions = new DocActions({
      store,
      files: docFiles,
      engine,
      viewer: documentFiles,
      audit,
      backupDir: join(dataDir(), 'doc-backups'),
      show: (item, isNew) => (isNew ? shell?.agent.post(item) : shell?.patchItem(item)),
    });
    for (const t of editTools({ files: docFiles, engine, actions: docActions })) tools.register(t);
  }
  // F1: managing files. Changes go on a card; the click renames, copies or creates, never replacing anything.
  let fileActions: FileActions | undefined;
  if (fileRoots) {
    // F2: the file index for files_search, kept current by the indexer.
    const catalog = config.files.index ? new FileCatalog(store) : undefined;
    if (catalog) {
      fileIndexer = new FileIndexer({
        roots: fileRoots,
        catalog,
        facts: new FactReader({ engine: docEngine }),
        model: config.files.summaries ? model : undefined,
        store,
        audit,
        timeZone: config.user.timezone,
        summariesPerDay: config.files.summariesPerDay,
        maxFiles: config.files.maxIndexedFiles,
      });
    }
    const indexer = fileIndexer;
    fileActions = new FileActions({
      store,
      roots: fileRoots,
      audit,
      show: (item, isNew) => (isNew ? shell?.agent.post(item) : shell?.patchItem(item)),
      onChanged: (c) => (c.op === 'renamed' ? void indexer?.renamed(c.from, c.to) : indexer?.soon()),
      ...(catalog ? { setTags: (path: string, tags: string[]) => catalog.setTags(path, tags) } : {}),
    });
    if (catalog && indexer) for (const t of fileSearchTools({ roots: fileRoots, catalog, indexer, actions: fileActions, timeZone: config.user.timezone })) tools.register(t);
    const showDocument = documentFiles && docFilesForShow
      ? async (path: string) => {
          const card = documentFiles!.show(await docFilesForShow!.resolve(path));
          return `A card for the ${card.fileKind === 'word' ? 'Word' : 'Excel'} file is in the chat; the user opens it with its Open button. Say so in one line.`;
        }
      : undefined;
    for (const t of fileTools({ roots: fileRoots, actions: fileActions, viewer: attachmentFiles, ...(showDocument ? { showDocument } : {}) })) tools.register(t);
  }
  for (const t of systemTools({ controls, actions: systemActions, extra: apps })) tools.register(t);
  const buildLog = new BuildLog(store);
  buildLog.recover(Date.now());
  let appLink: AppLink | undefined;
  let builder: AppBuilder | undefined;
  if (config.builder.enabled) {
    const { maxBudgetUsd, budgetChoicesUsd } = config.builder;
    const offered = budgetChoicesUsd.filter((b) => b <= maxBudgetUsd);
    const budgets = offered.length ? offered : [maxBudgetUsd];
    // S5: the key behind each built app's Change button token (apps/link.ts).
    const key = config.builder.changeButton ? linkKey(join(dataDir(), 'app-link.key')) : null;
    const b = new AppBuilder({ config: config.builder, ...(key ? { link: { port: config.ui.port, token: (slug: string) => linkToken(key, slug) } } : {}) });
    builder = b;
    tools.register(
      buildAppTool({
        builder: b,
        actions: systemActions,
        scan: () => scanApps(),
        log: buildLog,
        budgets,
        post: (item) => shell?.agent.post(item),
        notify: (title, body) => desktopNotify(title, body),
      }),
    );
    tools.register(buildStatusTool({ log: buildLog, actions: systemActions }));
    if (key) {
      appLink = new AppLink({
        key,
        appName: (slug) => b.builtName(slug),
        waiting: (slug) => systemActions.pendingBuilds().some((p) => p.slug === slug),
        offer: async ({ name, slug, request }) => {
          const r = await offerBuild({ builder: b, actions: systemActions, log: buildLog, budgets }, { name, slug, request, fromApp: true });
          if (r.problem === 'unavailable') return { error: r.why };
          if (r.problem === 'signed_out') return { error: 'Claude Code is installed but not signed in. Open a terminal, run `claude` once and sign in, then try again.' };
          return { card: r.card };
        },
        card: (id) => systemActions.buildCard(id),
        showCard: (name) => {
          void chatWindow.bringForward(name);
          desktopNotify(`Change ${name}?`, 'Click Change on the card in the AI OS chat to start.');
        },
        audit,
      });
    }
  }
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
    systemActions,
    ...(calendarActions ? { calendarActions } : {}),
    ...(docActions ? { docActions } : {}),
    ...(fileActions ? { fileActions } : {}),
    ...(fileIndexer ? { fileIndex: fileIndexer } : {}),
    attachments: attachmentFiles,
    chatWindow,
    openBuiltApp: builtAppOpener({ actions: systemActions, launch, window: chatWindow, audit, notice: (text) => shell?.agent.notice('warning', text) }),
    onResume: () => void pipeline.run(),
    onIgnoreMail: (id) => mailState.markIgnored(id),
  });
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
    attachments: attachmentFiles,
    ...(documentFiles ? { documents: documentFiles } : {}),
    ...(appLink ? { appLink } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: config.ui.port });
  approvals.recover();
  systemActions.recover();
  // S5: apps built before the Change button get it now (or lose it when it's turned off).
  void builder
    ?.sealAll()
    .then((slugs) => slugs.length && audit.append({ kind: 'system', event: 'apps_sealed', apps: slugs, changeButton: config.builder.changeButton }))
    .catch((err: unknown) => audit.append({ kind: 'system', event: 'apps_seal_error', error: (err as Error).message }));
  calendarActions?.recover();
  docActions?.recover();
  fileActions?.recover();
  // F2: the first scan runs in the background; search works on what it has found so far.
  void fileIndexer?.start().catch((err: unknown) => audit.append({ kind: 'files', event: 'index_error', error: (err as Error).message }));
  shell.greet();
  // The chat still opens without a key, and says what is wrong, instead of the service crash-looping.
  await keyring.require(config.models.chat.apiKeyRef).catch((err: unknown) => {
    audit.append({ kind: 'model', event: 'key_missing', error: (err as Error).message });
    shell.agent.notice('error', new ModelError('key_missing', '').userMessage);
  });
  await shell.refreshSystemStatus();
  setInterval(() => void shell.refreshSystemStatus(), 15_000).unref();
  watcher.start();
  chatWindow.start();
  // Catch-up after pause, quiet hours, rate limits and failed triage; a no-op when nothing is queued.
  setInterval(() => void pipeline.run(), 30_000).unref();
  // Paused means no model calls, so the nightly summary waits too.
  const nightlyTick = () => void (shell.paused ? undefined : nightly.runIfDue(Date.now()));
  nightlyTick();
  setInterval(nightlyTick, 10 * 60_000).unref();
  console.log(`aios-core listening on http://127.0.0.1:${config.ui.port}`);

  const shutdown = async () => {
    pipeline.stop();
    chatWindow.stop();
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
