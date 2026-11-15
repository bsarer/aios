/**
 * R2: what the setup window shows before asking anything, found by looking only: the home
 * folders, the apps that turn features on, Ollama's models, the screens, the system timezone
 * and the name in the user's account. Nothing is installed, started or changed.
 */
import { execFile } from 'node:child_process';
import { resolveMx } from 'node:dns/promises';
import { constants, existsSync, statSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { SpeechConfig } from '@aios/shared';
import { z } from 'zod';
import { parseMonitors } from '../kiosk.js';
import type { FoundApps } from './answers.js';

/** The folders offered, in this order, when they exist. */
export const HOME_FOLDERS = ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Music', 'Videos', 'Projects', 'Work'] as const;
/** Ticked on a first run. */
export const DEFAULT_TICKED = new Set(['Documents', 'Downloads', 'Pictures', 'Music', 'Videos']);

export interface Probes {
  home: string;
  path: string;
  isDir: (p: string) => boolean;
  isExecutable: (p: string) => Promise<boolean>;
  run: (cmd: string, args: string[]) => Promise<string>;
  fetch: typeof fetch;
  mx: (domain: string) => Promise<string[]>;
  readFile: (p: string) => Promise<string>;
}

export function realProbes(env: NodeJS.ProcessEnv = process.env): Probes {
  return {
    home: env.HOME ?? '',
    path: env.PATH ?? '',
    isDir: (p) => existsSync(p) && statSync(p).isDirectory(),
    isExecutable: (p) => access(p, constants.X_OK).then(() => true, () => false),
    run: (cmd, args) => promisify(execFile)(cmd, args, { timeout: 3000 }).then((r) => r.stdout, () => ''),
    fetch: (u, i) => globalThis.fetch(u, { ...i, signal: AbortSignal.timeout(1500) }),
    mx: (d) => resolveMx(d).then((r) => r.map((x) => x.exchange), () => []),
    readFile: (p) => readFile(p, 'utf8'),
  };
}

/** The first match on PATH, then in the given places (absolute, or ~/ for the home folder). */
async function find(p: Probes, names: string[], extra: string[] = []): Promise<string | null> {
  for (const name of names) {
    for (const dir of p.path.split(delimiter).filter((d) => d.startsWith('/'))) {
      const f = join(dir, name);
      if (await p.isExecutable(f)) return f;
    }
  }
  for (const e of extra) {
    const f = e.startsWith('~/') ? join(p.home, e.slice(2)) : e;
    if (await p.isExecutable(f)) return f;
  }
  return null;
}

/** GridCraft and WordCraft ship as unpacked folders too, e.g. ~/gridcraft-0.11.1-linux-x86_64. */
async function findUnpacked(p: Probes, app: string, bin: string): Promise<string | null> {
  const dirs = await readdir(p.home).catch(() => [] as string[]);
  for (const d of dirs.filter((x) => x.startsWith(`${app}-`)).sort().reverse()) {
    const f = join(p.home, d, bin);
    if (await p.isExecutable(f)) return f;
  }
  return null;
}

/** Where the README builds whisper.cpp's server; the package `whisper.cpp` puts it on PATH. */
const WHISPER_PLACES = ['~/.local/src/whisper.cpp/build/bin/whisper-server', '~/.local/bin/whisper-server'];

export async function findApps(p: Probes): Promise<FoundApps & { whisper: string | null }> {
  const home = ['~/.local/bin'];
  return {
    wordcraft: (await find(p, ['wordcraft'], home)) ?? (await findUnpacked(p, 'wordcraft', 'wordcraft')),
    gridcraft: (await find(p, ['gridcraft'], home)) ?? (await findUnpacked(p, 'gridcraft', 'gridcraft')),
    wordcraftCli: (await find(p, ['wordcraft-cli'], home)) ?? (await findUnpacked(p, 'wordcraft', 'wordcraft-cli')),
    gridcraftCli: (await find(p, ['gridcraft-cli'], home)) ?? (await findUnpacked(p, 'gridcraft', 'gridcraft-cli')),
    mpv: await find(p, ['mpv']),
    claude: await find(p, ['claude'], ['~/.local/bin/claude', '~/.claude/local/claude']),
    whisper: await find(p, ['whisper-server', 'whisper-cpp-server'], WHISPER_PLACES),
    speech: await whisperRunning(p),
  };
}

/** True when something answers on [models.speech]'s default address (whisper-server serves a page at /). */
export async function whisperRunning(p: Probes, baseUrl = SpeechConfig.parse({}).baseUrl): Promise<boolean> {
  try {
    return (await p.fetch(`${baseUrl}/`)).ok;
  } catch {
    return false;
  }
}

const OllamaTags = z.looseObject({ models: z.array(z.looseObject({ name: z.string().min(1).max(200) })).max(500) });

/** Ollama's installed models, smallest names first is not meaningful, so as Ollama lists them; [] when it isn't running. */
export async function ollamaModels(p: Probes): Promise<string[]> {
  try {
    const res = await p.fetch('http://127.0.0.1:11434/api/tags');
    if (!res.ok) return [];
    const tags = OllamaTags.safeParse(await res.json());
    return tags.success ? tags.data.models.map((m) => m.name).filter((n) => !/embed/i.test(n)) : [];
  } catch {
    return [];
  }
}

export async function homeFolders(p: Probes): Promise<{ path: string; exists: boolean }[]> {
  return HOME_FOLDERS.flatMap((name) => (p.isDir(join(p.home, name)) ? [{ path: `~/${name}`, exists: true }] : []));
}

/** The first name in the account's full name (GECOS), else empty. */
export async function accountFirstName(p: Probes): Promise<string> {
  const user = p.home.split('/').filter(Boolean).at(-1) ?? '';
  const passwd = await p.readFile('/etc/passwd').catch(() => '');
  const line = passwd.split('\n').find((l) => l.startsWith(`${user}:`));
  const full = line?.split(':')[4]?.split(',')[0]?.trim() ?? '';
  return full.split(/\s+/)[0]?.slice(0, 60) ?? '';
}

export async function screens(p: Probes) {
  return parseMonitors(await p.run('hyprctl', ['-j', 'monitors']));
}

export async function mailHosts(p: Probes, address: string): Promise<string[]> {
  const domain = address.split('@')[1]?.toLowerCase();
  if (!domain || !/^[a-z0-9.-]{1,253}$/.test(domain)) return [];
  return p.mx(domain);
}
