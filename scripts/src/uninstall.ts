/** `pnpm --filter @aios/scripts uninstall`: remove stored secrets and, if confirmed, the config. A6 adds the systemd and Hyprland bits. */
import { readFile, rm } from 'node:fs/promises';
import { Keyring } from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { terminalPrompter } from './prompt.js';
import { secretRefs } from './setup-lib.js';

async function main(): Promise<void> {
  const dir = configDir();
  let toml: string;
  try {
    toml = await readFile(`${dir}/config.toml`, 'utf8');
  } catch {
    console.log(`nothing to uninstall (${dir}/config.toml not found)`);
    return;
  }
  const keyring = new Keyring();
  for (const ref of secretRefs(parseConfig(toml))) {
    await keyring.delete(ref);
    console.log(`removed ${ref}`);
  }
  const p = terminalPrompter();
  try {
    if (await p.confirm(`Also delete ${dir} (config and memory)?`, false)) {
      await rm(dir, { recursive: true, force: true });
      console.log(`deleted ${dir}`);
    }
  } finally {
    p.close();
  }
}

main().catch((err: unknown) => {
  console.error(`uninstall failed: ${(err as Error).message}`);
  process.exit(1);
});
