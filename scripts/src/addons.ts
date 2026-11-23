/**
 * `astra addons [--video] [--music] [--local] [--voice] [--signal]`: installs what Astra's features need,
 * so nobody has to find and install pieces by hand. With no flag it lists each add-on and whether
 * it is installed. The catalog is `scripts/addons.json`: Arch packages (one `sudo pacman -S`
 * for all of them, one password), Ollama's service and models, and whisper.cpp built from its
 * release tag with its model, run as a user service on 127.0.0.1. signal-cli isn't in Arch's
 * repositories, so the Signal add-on downloads upstream's native build, checks its SHA-256 and
 * unpacks the one program into Astra's data folder. The setup window's Add-ons step opens a
 * terminal running this. It shows a short list of steps and a progress bar (progress.ts); what
 * the commands print goes to a log file, shown with --details, by pressing d, or when a step fails.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir } from '@aios/core';
import { APP_NAME } from '@aios/shared';
import { z } from 'zod';
import raw from '../addons.json' with { type: 'json' };
import { Progress, type StepDef, newLogPath } from './progress.js';
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
  signalCli: z
    .strictObject({
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
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

/** Where the Signal add-on puts signal-cli (one program, upstream's native build). */
export function signalPaths(data = dataDir()) {
  const dir = join(data, 'signal-cli');
  return { dir, bin: join(dir, 'signal-cli'), part: join(dir, 'signal-cli.tar.gz.part'), unpack: join(dir, 'unpack') };
}

/** The SHA-256 of a file, in hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .once('error', reject)
      .once('end', () => resolve(h.digest('hex')));
  });
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
  /** The step's line on the installer screen; empty when it belongs to the one before. */
  say: string;
  /** About how long it takes (the progress bar's share). */
  seconds?: number;
  cmd: string;
  args: string[];
  cwd?: string;
  /** A folder to make before the step runs. */
  mkdir?: string;
}

/** The commands for the chosen add-ons, in order. Pure, so it is unit-tested. */
export function plan(ids: AddonId[], c: Catalog, w = whisperPaths(), haveSrc = false, sp = signalPaths()): Step[] {
  const chosen = ADDON_IDS.filter((id) => ids.includes(id));
  const steps: Step[] = [];
  const pkgs = [...new Set(chosen.flatMap((id) => c[id].packages))];
  if (pkgs.length) steps.push({ say: `Installing ${pkgs.join(', ')}`, cmd: 'sudo', args: ['pacman', '-S', '--needed', '--noconfirm', ...pkgs] });
  for (const id of chosen) {
    const a = c[id];
    if (a.systemService) steps.push({ say: `Starting ${a.systemService.replace(/\.service$/, '')}`, cmd: 'sudo', args: ['systemctl', 'enable', '--now', a.systemService] });
    for (const m of a.pull ?? []) steps.push({ say: `Downloading the model ${m}`, cmd: 'ollama', args: ['pull', m] });
    const wh = a.whisper;
    if (wh) {
      steps.push(
        haveSrc
          ? { say: `Updating whisper.cpp to ${wh.tag}`, cmd: 'git', args: ['-C', w.src, 'fetch', '--depth', '1', 'origin', 'tag', wh.tag] }
          : { say: `Downloading whisper.cpp ${wh.tag}`, cmd: 'git', args: ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', wh.tag, wh.repo, w.src] },
      );
      if (haveSrc) steps.push({ say: '', cmd: 'git', args: ['-C', w.src, 'checkout', '--quiet', wh.tag] });
      steps.push(
        { say: 'Building whisper.cpp (a few minutes)', seconds: 240, cmd: 'cmake', args: ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF'], cwd: w.src },
        { say: '', cmd: 'cmake', args: ['--build', 'build', '-j', '--config', 'Release', '--target', 'whisper-server'], cwd: w.src },
        { say: `Downloading the speech model (about 150 MB)`, seconds: 60, cmd: 'curl', args: ['-fL', '--retry', '3', '-o', join(w.models, `${wh.model}.part`), wh.modelUrl], mkdir: w.models },
      );
    }
    const sc = a.signalCli;
    if (sc) steps.push({ say: `Downloading signal-cli ${sc.version} (about 120 MB)`, seconds: 60, cmd: 'curl', args: ['-fL', '--retry', '3', '--proto', '=https', '-o', sp.part, sc.url], mkdir: sp.dir });
  }
  return steps;
}

export interface Runner {
  /** Runs one command; its output goes to the log, not the screen. */
  run: (cmd: string, args: string[], cwd?: string) => number | Promise<number>;
  /** Runs a command that talks to the person (sudo asking for the password, once, first). */
  ask?: (say: string, cmd: string, args: string[]) => number | Promise<number>;
  /** Shows the installer screen with these steps; begin(i) marks the one running. */
  show?: (steps: StepDef[]) => void;
  begin?: (i: number) => void;
  log: (line: string) => void;
  /** Steps that touch files, kept apart so the test can follow them. */
  finishVoice: (a: Addon) => Promise<string | null>;
  /** Checks the download and puts signal-cli in place. */
  finishSignal: (a: Addon) => Promise<string | null>;
  waitForOllama: () => boolean;
  /** The computer's processor (process.arch); upstream builds signal-cli for x86_64 only. */
  arch?: string;
}

export async function install(ids: AddonId[], c: Catalog, r: Runner, w = whisperPaths(), haveSrc = existsSync(join(w.src, '.git')), sp = signalPaths()): Promise<number> {
  if (!ids.length) return 0;
  if (ids.includes('signal') && (r.arch ?? process.arch) !== 'x64') {
    r.log('The Signal add-on is only built for x86_64 computers, so it wasn’t installed.');
    return 1;
  }
  const steps = plan(ids, c, w, haveSrc, sp);
  // The screen's steps: each step with words, joined by the ones after it that have none.
  const screen: StepDef[] = [];
  const at: number[] = steps.map((s) => (s.say ? screen.push({ label: s.say, seconds: s.seconds ?? 15 }) - 1 : Math.max(0, screen.length - 1)));
  const finishing = ids.includes('voice') || ids.includes('signal');
  if (finishing) screen.push({ label: 'Finishing', seconds: 5 });
  r.show?.(screen);
  // The password once, before anything starts; the sudo steps then run without asking (-n).
  const sudo = steps.some((s) => s.cmd === 'sudo');
  if (sudo && r.ask && (await r.ask('Installing add-ons needs your password.', 'sudo', ['-v'])) !== 0) {
    r.log('Without your password nothing could be installed; run astra addons again when you’re ready.');
    return 1;
  }
  for (const [i, s] of steps.entries()) {
    r.begin?.(at[i]!);
    if (s.cmd === 'ollama' && !r.waitForOllama()) {
      r.log('Ollama didn’t start. Check it with: systemctl status ollama');
      return 1;
    }
    if (s.mkdir) await mkdir(s.mkdir, { recursive: true });
    const args = s.cmd === 'sudo' && r.ask ? ['-n', ...s.args] : s.args;
    if ((await r.run(s.cmd, args, s.cwd)) !== 0) {
      r.log(`That step didn’t finish (${s.say || screen[at[i]!]?.label || s.cmd}); run astra addons again to retry.`);
      return 1;
    }
  }
  if (finishing) r.begin?.(screen.length - 1);
  for (const [id, finish] of [['voice', r.finishVoice], ['signal', r.finishSignal]] as const) {
    if (!ids.includes(id)) continue;
    const err = await finish(c[id]);
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
    await run('systemctl', ['--user', 'daemon-reload']);
    if ((await run('systemctl', ['--user', 'enable', '--now', w.service])) !== 0) return `Couldn’t start ${w.service}. Check it with: systemctl --user status ${w.service}`;
    return null;
  };
}

/**
 * Only the archive's one program, unpacked into an empty folder of its own and moved into place,
 * after its SHA-256 matched the catalog's. Nothing else in the archive is written.
 */
export function realFinishSignal(sp = signalPaths(), run: Runner['run']) {
  return async (a: Addon): Promise<string | null> => {
    const sc = a.signalCli!;
    const got = await sha256File(sp.part).catch(() => '');
    if (got !== sc.sha256) {
      rmSync(sp.part, { force: true });
      return 'The signal-cli download didn’t match its checksum. Nothing was changed; run astra addons --signal again.';
    }
    rmSync(sp.unpack, { recursive: true, force: true });
    await mkdir(sp.unpack, { recursive: true });
    const code = await run('tar', ['-xzf', sp.part, '-C', sp.unpack, '--no-same-owner', '--no-same-permissions', 'signal-cli']);
    rmSync(sp.part, { force: true });
    if (code !== 0) {
      rmSync(sp.unpack, { recursive: true, force: true });
      return 'Couldn’t unpack signal-cli. Run astra addons --signal again.';
    }
    renameSync(join(sp.unpack, 'signal-cli'), sp.bin);
    rmSync(sp.unpack, { recursive: true, force: true });
    await chmod(sp.bin, 0o755);
    return null;
  };
}

/** Installed when all its programs are on PATH; voice when its server and model are in place; Signal when signal-cli is. */
export function installed(id: AddonId, a: Addon, onPath: (bin: string) => boolean, exists: (p: string) => boolean, w = whisperPaths(), sp = signalPaths()): boolean {
  if (a.whisper) return exists(w.server) && exists(join(w.models, a.whisper.model)) && exists(w.unit);
  if (a.signalCli) return exists(sp.bin) || onPath('signal-cli');
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
  const w = whisperPaths();
  await mkdir(w.dir, { recursive: true });
  let screen: Progress | undefined;
  const run: Runner['run'] = (cmd, args, cwd) => screen!.run(cmd, args, cwd);
  const code = await install(ids, c, {
    run,
    ask: (say, cmd, args) => screen!.ask(say, cmd, args),
    show: (steps) => {
      screen = new Progress({ title: `Installing ${APP_NAME} add-ons`, steps, logPath: newLogPath('addons'), details: argv.includes('--details'), input: process.stdin });
      screen.start();
    },
    begin: (i) => screen?.begin(i),
    log: (l) => (screen ? screen.note(l) : console.log(l)),
    finishVoice: realFinishVoice(w, run),
    finishSignal: realFinishSignal(signalPaths(), run),
    waitForOllama: () => {
      for (let i = 0; i < 20; i++) {
        if (spawnSync('ollama', ['list'], { stdio: 'ignore' }).status === 0) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      return false;
    },
  }, w);
  screen?.end(code === 0);
  return code;
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
