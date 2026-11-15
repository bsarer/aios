/**
 * `astra addons [--video] [--music] [--local] [--voice] [--signal]`: installs what Astra's features need,
 * so nobody has to find and install pieces by hand. With no flag it lists each add-on and whether
 * it is installed. The catalog is `scripts/addons.json`: Arch packages (one `sudo pacman -S`
 * for all of them, one password), Ollama's service and models, and whisper.cpp built from its
 * release tag with its model, run as a user service on 127.0.0.1. The setup window's Add-ons step
 * opens a terminal running this.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir } from '@aios/core';
import { z } from 'zod';
import raw from '../addons.json' with { type: 'json' };
import { noNewPrivileges } from './update.js';

export const ADDON_IDS = ['video', 'music', 'local', 'voice', 'signal'] as const;
export type AddonId = (typeof ADDON_IDS)[number];

const Pkg = z.string().regex(/^[a-z0-9][a-z0-9+._-]{0,80}$/);
const Model = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,80}$/);
const Addon = z.strictObject({
  label: z.string().min(1).max(40),
  blurb: z.string().max(200),
  packages: z.array(Pkg).max(20),
  bins: z.array(z.string().regex(/^[a-z0-9._-]{1,40}$/)).max(5),
  systemService: z.string().regex(/^[a-z0-9-]+\.service$/).optional(),
  pull: z.array(Model).max(5).optional(),
  whisper: z
    .strictObject({
      repo: z.url({ protocol: /^https$/ }),
      tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
      modelUrl: z.url({ protocol: /^https$/ }),
      model: z.string().regex(/^ggml-[a-z0-9.-]+\.bin$/),
      port: z.int().min(1024).max(65_535),
    })
    .optional(),
});
export type Addon = z.infer<typeof Addon>;
export type Catalog = Record<AddonId, Addon>;

/** addons.json, checked: it ships with the app but is still a file on disk. */
export function readCatalog(input: unknown = raw): Catalog {
  const obj = z.record(z.string(), z.unknown()).parse(input);
  const out = {} as Catalog;
  for (const id of ADDON_IDS) out[id] = Addon.parse(obj[id]);
  return out;
}

/** Where voice lives: the whisper.cpp checkout, the built server and its model. */
export function whisperPaths(data = dataDir(), home = homedir()) {
  const dir = join(data, 'whisper');
  return { dir, src: join(dir, 'whisper.cpp'), server: join(dir, 'whisper-server'), models: join(dir, 'models'), unit: join(home, '.config', 'systemd', 'user', 'astra-whisper.service'), service: 'astra-whisper.service' };
}

/** The user service that runs whisper-server on this computer only. */
export function whisperUnit(server: string, model: string, port: number): string {
  return `[Unit]
Description=whisper.cpp server for Astra's voice (written by astra addons)

[Service]
ExecStart="${server}" -m "${model}" --host 127.0.0.1 --port ${port}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

/** ggml model files start with the bytes "lmgg" (GGML_FILE_MAGIC 0x67676d6c, little-endian). */
export function isGgml(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32LE(0) === 0x67676d6c;
}

export interface Step {
  say: string;
  cmd: string;
  args: string[];
  cwd?: string;
}

/** The commands for the chosen add-ons, in order. Pure, so it is unit-tested. */
export function plan(ids: AddonId[], c: Catalog, w = whisperPaths(), haveSrc = false): Step[] {
  const chosen = ADDON_IDS.filter((id) => ids.includes(id));
  const steps: Step[] = [];
  const pkgs = [...new Set(chosen.flatMap((id) => c[id].packages))];
  if (pkgs.length) steps.push({ say: `Installing ${pkgs.join(', ')}. sudo asks for your password:`, cmd: 'sudo', args: ['pacman', '-S', '--needed', '--noconfirm', ...pkgs] });
  for (const id of chosen) {
    const a = c[id];
    if (a.systemService) steps.push({ say: `Starting ${a.systemService}...`, cmd: 'sudo', args: ['systemctl', 'enable', '--now', a.systemService] });
    for (const m of a.pull ?? []) steps.push({ say: `Downloading the model ${m}...`, cmd: 'ollama', args: ['pull', m] });
    const wh = a.whisper;
    if (wh) {
      steps.push(
        haveSrc
          ? { say: `Updating whisper.cpp to ${wh.tag}...`, cmd: 'git', args: ['-C', w.src, 'fetch', '--depth', '1', 'origin', 'tag', wh.tag] }
          : { say: `Downloading whisper.cpp ${wh.tag}...`, cmd: 'git', args: ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', wh.tag, wh.repo, w.src] },
      );
      if (haveSrc) steps.push({ say: '', cmd: 'git', args: ['-C', w.src, 'checkout', '--quiet', wh.tag] });
      steps.push(
        { say: 'Building whisper.cpp (a few minutes)...', cmd: 'cmake', args: ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF'], cwd: w.src },
        { say: '', cmd: 'cmake', args: ['--build', 'build', '-j', '--config', 'Release', '--target', 'whisper-server'], cwd: w.src },
        { say: `Downloading the speech model ${wh.model} (about 150 MB)...`, cmd: 'curl', args: ['-fL', '--retry', '3', '-o', join(w.models, `${wh.model}.part`), wh.modelUrl] },
      );
    }
  }
  return steps;
}

export interface Runner {
  run: (cmd: string, args: string[], cwd?: string) => number;
  log: (line: string) => void;
  /** Steps that touch files, kept apart so the test can follow them. */
  finishVoice: (a: Addon) => Promise<string | null>;
  waitForOllama: () => boolean;
}

export async function install(ids: AddonId[], c: Catalog, r: Runner, w = whisperPaths(), haveSrc = existsSync(join(w.src, '.git'))): Promise<number> {
  if (!ids.length) return 0;
  for (const s of plan(ids, c, w, haveSrc)) {
    if (s.say) r.log(s.say);
    if (s.cmd === 'ollama' && !r.waitForOllama()) {
      r.log('Ollama didn’t start. Check it with: systemctl status ollama');
      return 1;
    }
    if (s.cmd === 'curl') await mkdir(w.models, { recursive: true });
    if (r.run(s.cmd, s.args, s.cwd) !== 0) {
      r.log(`That step failed (${s.cmd}). The lines above say why; run astra addons again to retry.`);
      return 1;
    }
  }
  if (ids.includes('voice')) {
    const err = await r.finishVoice(c.voice);
    if (err) {
      r.log(err);
      return 1;
    }
  }
  r.log('Done. Open astra settings (or the gear in the chat) to turn the new features on.');
  return 0;
}

/** Puts the built server and checked model in place, writes the service and starts it. */
export function realFinishVoice(w = whisperPaths(), run: Runner['run']) {
  return async (a: Addon): Promise<string | null> => {
    const wh = a.whisper!;
    const part = join(w.models, `${wh.model}.part`);
    const model = join(w.models, wh.model);
    const head = Buffer.alloc(4);
    const fd = openSync(part, 'r');
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    if (!isGgml(head)) {
      rmSync(part, { force: true });
      return 'The speech model that downloaded isn’t a whisper model. Nothing was changed; run astra addons --voice again.';
    }
    renameSync(part, model);
    await copyFile(join(w.src, 'build', 'bin', 'whisper-server'), w.server);
    await chmod(w.server, 0o755);
    await mkdir(join(w.unit, '..'), { recursive: true });
    await writeFile(w.unit, whisperUnit(w.server, model, wh.port));
    run('systemctl', ['--user', 'daemon-reload']);
    if (run('systemctl', ['--user', 'enable', '--now', w.service]) !== 0) return `Couldn’t start ${w.service}. Check it with: systemctl --user status ${w.service}`;
    return null;
  };
}

/** Installed when all its programs are on PATH; voice when its server and model are in place. */
export function installed(id: AddonId, a: Addon, onPath: (bin: string) => boolean, exists: (p: string) => boolean, w = whisperPaths()): boolean {
  if (a.whisper) return exists(w.server) && exists(join(w.models, a.whisper.model)) && exists(w.unit);
  return a.bins.length > 0 && a.bins.every(onPath);
}

export function onPathIn(path = process.env.PATH ?? '') {
  return (bin: string) => path.split(delimiter).some((d) => d.startsWith('/') && existsSync(join(d, bin)));
}

async function main(argv: string[]): Promise<number> {
  const c = readCatalog();
  const ids = ADDON_IDS.filter((id) => argv.includes(`--${id}`));
  if (!ids.length) {
    const has = onPathIn();
    for (const id of ADDON_IDS) console.log(`${installed(id, c[id], has, existsSync) ? '✓' : '·'} ${id.padEnd(6)} ${c[id].label}: ${c[id].blurb}`);
    console.log('\nInstall with, for example: astra addons --voice --video');
    return 0;
  }
  if (noNewPrivileges(await readFile('/proc/self/status', 'utf8').catch(() => ''))) {
    console.log('This terminal can’t ask for your password (it was started with "no new privileges"). Open a terminal yourself (Super+Enter) and run: astra addons ' + ids.map((i) => `--${i}`).join(' '));
    return 1;
  }
  const run = (cmd: string, args: string[], cwd?: string) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    return r.error ? 127 : (r.status ?? 1);
  };
  const w = whisperPaths();
  await mkdir(w.dir, { recursive: true });
  return install(ids, c, {
    run,
    log: (l) => console.log(l),
    finishVoice: realFinishVoice(w, run),
    waitForOllama: () => {
      for (let i = 0; i < 20; i++) {
        if (spawnSync('ollama', ['list'], { stdio: 'ignore' }).status === 0) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      return false;
    },
  }, w);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`astra addons: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
