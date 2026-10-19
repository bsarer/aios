/**
 * aios-core daemon. `pnpm start` (systemd --user in A6).
 *   AIOS_UI_DEV_ORIGIN=http://localhost:5173  also accept the Vite dev server
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, parseConfig } from '@aios/shared';
import { AuditLog } from './audit.js';
import { MemoryFiles } from './memory/files.js';
import { Memory } from './memory/memory.js';
import { Nightly } from './memory/nightly.js';
import { ModelClient } from './model.js';
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
  await keyring.require(config.models.chat.apiKeyRef);

  const store = new Store(join(dataDir(), 'aios.db'));
  const audit = new AuditLog(join(dataDir(), 'audit.jsonl'));
  let shell: Shell | undefined;
  const model = new ModelClient({
    models: config.models,
    resolveKey: (ref) => keyring.require(ref),
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
  const memory = new Memory(new MemoryFiles(join(configDir(), 'memory'), config.user.name), store, config.memory.contextTokens);
  const nightly = new Nightly({
    memory,
    store,
    model,
    userName: config.user.name,
    timeZone: config.user.timezone,
    runAfter: config.memory.nightlyAt,
    onError: (err) => audit.append({ kind: 'memory', decision: 'nightly_failed', error: (err as Error).message }),
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
  });
  watchTheme(themePath, (t) => shell.setTheme(t));

  const app = await createServer(shell, {
    port: config.ui.port,
    uiDir: join(here, '..', '..', 'ui', 'dist'),
    devOrigins: process.env.AIOS_UI_DEV_ORIGIN ? [process.env.AIOS_UI_DEV_ORIGIN] : [],
  });
  await app.listen({ host: '127.0.0.1', port: config.ui.port });
  shell.greet();
  await shell.refreshSystemStatus();
  setInterval(() => void shell.refreshSystemStatus(), 15_000).unref();
  // Paused means no model calls, so the nightly summary waits too.
  const nightlyTick = () => void (shell.paused ? undefined : nightly.runIfDue(Date.now()));
  nightlyTick();
  setInterval(nightlyTick, 10 * 60_000).unref();
  console.log(`aios-core listening on http://127.0.0.1:${config.ui.port}`);

  const shutdown = async () => {
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
