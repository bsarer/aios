/**
 * P1, R1: `astra backup` writes one .tar.gz of what Astra keeps on this computer, for a reinstall:
 * the config and memory (~/.config/astra, or ~/.config/aios for an AI OS install), the database,
 * audit log, built apps and their saved data (~/.local/share/astra), and built apps' launcher
 * entries. Left out: an installed copy of the app, the chat's browser profile and browser caches.
 * Keyring secrets are never in it; setup asks for them again. `astra restore <file>` (or
 * `install.sh --restore <file>`) puts it back.
 *
 * The service is stopped while the archive is written, so the database is not caught mid-write.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dataDir } from '@aios/core';
import { appIds, configDir } from '@aios/shared';

/** Paths inside a data dir that are never backed up: the install, browser profile and caches. */
export const BACKUP_EXCLUDES = ['app', 'chromium', '*/Cache', '*/Code Cache', '*/GPUCache', '*/Service Worker/CacheStorage'];

export interface BackupPlan {
  file: string;
  /** tar's arguments, run in $HOME. */
  args: string[];
}

/** What to back up and where, from the environment; null with a reason when it can't. Pure apart from listing files. */
export function backupPlan(env: NodeJS.ProcessEnv, now: Date, list: (dir: string) => string[] = (d) => (existsSync(d) ? readdirSync(d) : [])): BackupPlan | string {
  const home = env.HOME;
  if (!home) return 'HOME is not set';
  const config = configDir(env);
  const data = dataDir(env);
  for (const d of [config, data]) {
    const r = relative(home, d);
    if (r.startsWith('..') || r === '' || r.startsWith('/')) return `${d} is outside ${home}; back it up by hand`;
  }
  if (!existsSync(config)) return `nothing to back up: ${config} does not exist`;
  const apps = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications');
  const desktop = list(apps).filter((f) => /^aios-app-[a-z0-9-]+\.desktop$/.test(f)).map((f) => relative(home, join(apps, f)));
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = join(home, `${appIds(env).dir}-backup-${stamp}.tar.gz`);
  const dataRel = relative(home, data);
  const excludes = BACKUP_EXCLUDES.map((e) => `--exclude=${e.includes('*') ? e : `${dataRel}/${e}`}`);
  return { file, args: ['-czf', file, ...excludes, relative(home, config), ...(existsSync(data) ? [dataRel] : []), ...desktop] };
}

async function main(): Promise<void> {
  const plan = backupPlan(process.env, new Date());
  if (typeof plan === 'string') throw new Error(plan);
  const run = promisify(execFile);
  const { service } = appIds();
  const active = await run('systemctl', ['--user', 'is-active', service]).then(
    (r) => r.stdout.trim() === 'active',
    () => false,
  );
  if (active) {
    console.log(`stopping ${service} while the backup is written…`);
    await run('systemctl', ['--user', 'stop', service]);
  }
  try {
    await run('tar', plan.args, { cwd: process.env.HOME });
    await chmod(plan.file, 0o600);
  } finally {
    if (active) await run('systemctl', ['--user', 'start', service]);
  }
  console.log(`wrote ${plan.file}`);
  console.log('It holds your mail cache, memory and audit log: keep it private. Keyring secrets are not in it; setup asks for them after a restore.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`backup failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
