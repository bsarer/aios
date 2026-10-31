/**
 * `pnpm calendar:login`: sign AI OS in to Google Calendar (C1). Run it once after adding the
 * calendar in `pnpm run setup`, and again if the chat says the sign-in has expired.
 */
import { readFile } from 'node:fs/promises';
import { Keyring } from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { signInToCalendar } from './calendar-auth.js';

async function main(): Promise<void> {
  const path = `${configDir()}/config.toml`;
  const config = parseConfig(await readFile(path, 'utf8'));
  if (!config.calendar) throw new Error(`no [calendar] in ${path}; run \`pnpm run setup\` and answer yes to Google Calendar`);
  const keyring = new Keyring();
  if (!(await keyring.available())) throw new Error('secret-tool not found; install libsecret first');
  const n = await signInToCalendar(config.calendar, keyring, config.user.timezone, { loginHint: config.mail.address });
  console.log(`Calendar connected: ${n} event(s) in the next 7 days. Restart AI OS (pnpm kiosk:restart, or stop and run pnpm start) to use it.`);
}

main().catch((err: unknown) => {
  console.error(`calendar sign-in failed: ${(err as Error).message}`);
  process.exit(1);
});
