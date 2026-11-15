/** Add-ons: the catalog is checked, the plan is one pacman call then fixed steps, and voice only runs a checked model. Pretend commands only. */
import { describe, expect, it } from 'vitest';
import { ADDON_IDS, install, isGgml, plan, readCatalog, whisperPaths, whisperUnit } from '../src/addons.js';
import raw from '../addons.json' with { type: 'json' };

const c = readCatalog();
const w = whisperPaths('/home/j/.local/share/astra', '/home/j');

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
    const code = await install(['music', 'video'], c, { run: (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), cmd === 'sudo' ? 1 : 0), log: (l) => log.push(l), finishVoice: async () => null, waitForOllama: () => true }, w, false);
    expect(code).toBe(1);
    expect(ran).toHaveLength(1);
    expect(log.at(-1)).toContain('run astra addons again');
  });
});
