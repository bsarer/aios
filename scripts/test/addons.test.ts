/** Add-ons: the catalog is checked, the plan is one pacman call then fixed steps, and voice only runs a checked model. Pretend commands only. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADDON_IDS, type Catalog, install, installed, isGgml, plan, readCatalog, realFinishSignal, signalPaths, whisperPaths, whisperUnit } from '../src/addons.js';
import raw from '../addons.json' with { type: 'json' };

const c = readCatalog();
const w = whisperPaths('/home/j/.local/share/astra', '/home/j');
const sp = signalPaths('/home/j/.local/share/astra');
const noop = { finishVoice: async () => null, finishSignal: async () => null, waitForOllama: () => true };

describe('astra addons', () => {
  it('reads the catalog and refuses anything that could reach a shell', () => {
    expect(Object.keys(c)).toEqual([...ADDON_IDS]);
    expect(() => readCatalog({ ...raw, video: { ...raw.video, packages: ['mpv; rm -rf /'] } })).toThrow();
    expect(() => readCatalog({ ...raw, local: { ...raw.local, pull: ['--insecure'] } })).toThrow();
    expect(() => readCatalog({ ...raw, voice: { ...raw.voice, whisper: { ...raw.voice.whisper, modelUrl: 'http://example.com/x.bin' } } })).toThrow();
  });

  it('installs every package with one sudo pacman, then each add-on’s own steps', () => {
    const steps = plan(['voice', 'local', 'video', 'music'], c, w);
    const sudo = steps.filter((s) => s.cmd === 'sudo');
    expect(sudo[0]!.args).toEqual(['pacman', '-S', '--needed', '--noconfirm', 'mpv', 'yt-dlp', 'playerctl', 'ollama', 'cmake', 'gcc', 'make', 'git', 'curl']);
    expect(sudo[1]!.args).toEqual(['systemctl', 'enable', '--now', 'ollama.service']);
    expect(sudo).toHaveLength(2);
    expect(steps.filter((s) => s.cmd === 'ollama').map((s) => s.args)).toEqual([['pull', 'qwen3:4b'], ['pull', 'embeddinggemma']]);
    expect(steps.find((s) => s.cmd === 'git')!.args).toEqual(['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', 'v1.9.5', 'https://github.com/ggml-org/whisper.cpp', '/home/j/.local/share/astra/whisper/whisper.cpp']);
    expect(steps.find((s) => s.cmd === 'curl')!.args.at(-1)).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin');
    expect(plan(['music'], c, w).map((s) => s.cmd)).toEqual(['sudo']);
    // Already downloaded: fetch the tag and check it out instead of cloning again.
    expect(plan(['voice'], c, w, true).filter((s) => s.cmd === 'git').map((s) => s.args[2])).toEqual(['fetch', 'checkout']);
  });

  it('runs whisper on this computer only, and only a real ggml model', () => {
    expect(whisperUnit(w.server, '/m/ggml-base.en.bin', 8178)).toContain('ExecStart="/home/j/.local/share/astra/whisper/whisper-server" -m "/m/ggml-base.en.bin" --host 127.0.0.1 --port 8178');
    expect(isGgml(Buffer.from('lmgg....'))).toBe(true);
    expect(isGgml(Buffer.from('<htm'))).toBe(false);
  });

  it('stops at the first failing step and says how to retry', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const code = await install(['music', 'video'], c, { run: (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), cmd === 'sudo' ? 1 : 0), log: (l) => log.push(l), ...noop }, w, false);
    expect(code).toBe(1);
    expect(ran).toHaveLength(1);
    expect(log.at(-1)).toContain('run astra addons again');
  });

  it('gets signal-cli from upstream’s pinned release, never from pacman, since Arch doesn’t have it', () => {
    const all = Object.values(raw).flatMap((v) => (typeof v === 'object' && v && 'packages' in v ? (v as { packages: string[] }).packages : []));
    expect(all).not.toContain('signal-cli');
    const steps = plan(['signal'], c, w, false, sp);
    expect(steps.map((s) => s.cmd)).toEqual(['sudo', 'curl']);
    expect(steps[1]!.args).toEqual(['-fL', '--retry', '3', '--proto', '=https', '-o', '/home/j/.local/share/astra/signal-cli/signal-cli.tar.gz.part', 'https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9-Linux-native.tar.gz']);
    expect(steps[1]!.mkdir).toBe(sp.dir);
    expect(c.signal.signalCli!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readCatalog({ ...raw, signal: { ...raw.signal, signalCli: { ...raw.signal.signalCli, url: 'https://evil.example/signal-cli.tar.gz' } } })).toThrow();
    expect(() => readCatalog({ ...raw, signal: { ...raw.signal, signalCli: { ...raw.signal.signalCli, sha256: 'abc' } } })).toThrow();
    expect(installed('signal', c.signal, () => false, (p) => p === sp.bin, w, sp)).toBe(true);
    expect(installed('signal', c.signal, (b) => b === 'signal-cli', () => false, w, sp)).toBe(true);
    expect(installed('signal', c.signal, () => false, () => false, w, sp)).toBe(false);
  });

  it('refuses Signal on a computer upstream doesn’t build for, before downloading anything', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    expect(await install(['signal'], c, { run: (cmd) => (ran.push(cmd), 0), log: (l) => log.push(l), ...noop, arch: 'arm64' }, w, false, sp)).toBe(1);
    expect(ran).toEqual([]);
    expect(log[0]).toContain('x86_64');
  });

  it('puts signal-cli in place only when the download matches its checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-signal-'));
    const p = signalPaths(dir);
    mkdirSync(p.dir, { recursive: true });
    const tarball = Buffer.from('pretend tarball');
    const good: Catalog['signal'] = { ...c.signal, signalCli: { ...c.signal.signalCli!, sha256: createHash('sha256').update(tarball).digest('hex') } };
    // A pretend tar: checks code's arguments, then writes the one program into the folder it was given.
    const tars: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      tars.push([cmd, ...args]);
      writeFileSync(join(args[3]!, 'signal-cli'), '#!/bin/sh\n');
      return 0;
    };

    writeFileSync(p.part, 'something else');
    expect(await realFinishSignal(p, run)(good)).toMatch(/checksum/);
    expect(tars).toEqual([]);
    expect(existsSync(p.part)).toBe(false);
    expect(existsSync(p.bin)).toBe(false);

    writeFileSync(p.part, tarball);
    expect(await realFinishSignal(p, run)(good)).toBeNull();
    expect(tars).toEqual([['tar', '-xzf', p.part, '-C', p.unpack, '--no-same-owner', '--no-same-permissions', 'signal-cli']]);
    expect(readFileSync(p.bin, 'utf8')).toBe('#!/bin/sh\n');
    expect(statSync(p.bin).mode & 0o777).toBe(0o755);
    expect(existsSync(p.part) || existsSync(p.unpack)).toBe(false);
  });
});
