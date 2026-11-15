/**
 * `astra uninstall` (R1; was `pnpm --filter @aios/scripts uninstall`): stop and remove the
 * service and kiosk (A6) and the stored secrets, then ask about the config.
 *
 *   --purge   also delete the config, memory and data folders (database, audit log, built apps)
 *   --yes     with --purge, don't ask first
 *
 * The program itself (the Arch package, or a source checkout) stays; `sudo pacman -R astra`
 * removes the package. An installed copy inside the data folder (install.sh) is kept.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Keyring, dataDir } from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { terminalPrompter } from './prompt.js';
import { kioskPaths, uninstallKiosk } from './kiosk.js';
import { secretRefs } from './setup-lib.js';

/** What --purge deletes: the config folder, and the data folder's entries except an installed copy ('app'). */
export function purgeTargets(env: NodeJS.ProcessEnv = process.env, list: (dir: string) => string[] = (d) => (existsSync(d) ? readdirSync(d) : [])): string[] {
  const data = dataDir(env);
  return [configDir(env), ...list(data).filter((e) => e !== 'app').map((e) => join(data, e))];
}

async function main(): Promise<void> {
  const purge = process.argv.includes('--purge');
  const yes = process.argv.includes('--yes');
  for (const r of await uninstallKiosk(kioskPaths(), async (cmd, args) => void (await promisify(execFile)(cmd, args)))) console.log(`removed ${r}`);
  const dir = configDir();
  let toml: string | null = null;
  try {
    toml = await readFile(`${dir}/config.toml`, 'utf8');
  } catch {
    console.log(`no config at ${dir}/config.toml, so no stored secrets to remove`);
  }
  if (toml !== null) {
    const keyring = new Keyring();
    for (const ref of secretRefs(parseConfig(toml))) {
      await keyring.delete(ref);
      console.log(`removed ${ref}`);
    }
  }
  const targets = purge ? purgeTargets() : existsSync(dir) ? [dir] : [];
  if (!targets.length) return;
  const p = terminalPrompter();
  try {
    const question = purge ? `Delete ${targets.join(', ')}? Your config, memory, mail cache, audit log and built apps go; this cannot be undone.` : `Also delete ${dir} (config and memory)?`;
    if ((purge && yes) || (await p.confirm(question, false))) {
      for (const t of targets) {
        await rm(t, { recursive: true, force: true });
        console.log(`deleted ${t}`);
      }
    }
  } finally {
    p.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`uninstall failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
