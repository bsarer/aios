/**
 * R2: the setup window's Chromium profile. Each run of setup serves the page on a new random port
 * and token, so a page Chromium remembers from an earlier run can only fail ("127.0.0.1 refused to
 * connect"). A profile that lasts between runs kept those pages and reopened them next to the new
 * window, so each run gets a new, empty profile that is removed when the window closes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The profile earlier versions kept in the data folder; it holds only old setup pages. */
export const OLD_PROFILE = 'setup-profile';

/** A new, empty profile for this run (mode 0700, under the temp folder), after removing the old one. */
export async function freshProfile(data: string, temp: string = tmpdir()): Promise<string> {
  await rm(join(data, OLD_PROFILE), { recursive: true, force: true });
  return mkdtemp(join(temp, 'astra-setup-'));
}

/** Removes this run's profile once the window has closed. */
export async function removeProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
