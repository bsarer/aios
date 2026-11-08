/**
 * V1: video_play. Only video files inside the allowed folders and checked https links reach
 * mpv, always after `--`; while outside text is in view it is a confirm card; every call is
 * audited. Uses temporary folders and a pretend mpv, never a real player or the home folder.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { FileRoots } from '../src/files/roots.js';
import { Store } from '../src/store.js';
import { SystemActions } from '../src/system/actions.js';
import { SystemControls } from '../src/system/controls.js';
import type { Run } from '../src/system/run.js';
import { systemTools } from '../src/system/tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { checkVideoLink, createVideoPlayer, playerArgs, type VideoSource, videoFormat } from '../src/video/play.js';
import { videoTools } from '../src/video/tools.js';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `aios-${name}-`));

/** The first bytes of an MP4 (ftyp box, brand isom). */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const MKV = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);

describe('video files and links (V1)', () => {
  it('knows videos by their first bytes, not their names, and leaves pictures and other files out', () => {
    expect(videoFormat(MP4)).toBe('MP4');
    expect(videoFormat(MKV)).toBe('Matroska/WebM');
    expect(videoFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]))).toBe('AVI');
    expect(videoFormat(HEIC)).toBeNull();
    expect(videoFormat(Buffer.from('#EXTM3U\nfile:///etc/passwd\n'))).toBeNull();
    expect(videoFormat(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(videoFormat(Buffer.alloc(0))).toBeNull();
  });

  it('plays https links to a site by name only', () => {
    expect(checkVideoLink(' https://www.youtube.com/watch?v=dQw4w9WgXcQ ').href).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    for (const bad of [
      'http://www.youtube.com/watch?v=x',
      'file:///etc/passwd',
      'av://lavfi:anullsrc',
      'lavfi://sine',
      'ytdl://x',
      'https://127.0.0.1:7777/app-link/',
      'https://192.168.1.1/',
      'https://[::1]/',
      'https://localhost/x',
      'https://router.lan/',
      'https://printer.local/',
      'https://intranet/',
      'https://user:pw@example.com/v',
      'https://example.com:8443/v',
      'https://example.com/a b',
      '--script=/tmp/evil.lua',
      'not a link',
    ]) {
      expect(() => checkVideoLink(bad), bad).toThrow();
    }
  });

  it('gives mpv fixed options, then --, then the one path or link', () => {
    expect(playerArgs({ kind: 'file', path: '/home/j/Downloads/--script=x.mp4' })).toEqual(['--force-window=immediate', '--no-terminal', '--ytdl=no', '--', '/home/j/Downloads/--script=x.mp4']);
    expect(playerArgs({ kind: 'link', url: 'https://vimeo.com/1' })).toEqual(['--force-window=immediate', '--no-terminal', '--', 'https://vimeo.com/1']);
    expect(() => playerArgs({ kind: 'file', path: 'relative.mp4' })).toThrow(/absolute/);
    expect(() => playerArgs({ kind: 'link', url: 'file:///etc/passwd' })).toThrow(/https/);
  });

  it('starts the player without a shell and reports an exit with an error', async () => {
    const bin = tmp('mpvbin');
    const out = join(bin, 'args.txt');
    const fake = join(bin, 'mpv');
    writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${out}'; done\ncase "$*" in *broken*) exit 2;; esac\nexit 0\n`);
    chmodSync(fake, 0o755);
    const env = { PATH: bin };
    await createVideoPlayer(fake, env)({ kind: 'file', path: '/videos/a $(touch x) ;b.mp4' });
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['--force-window=immediate', '--no-terminal', '--ytdl=no', '--', '/videos/a $(touch x) ;b.mp4']);
    await expect(createVideoPlayer(fake, env)({ kind: 'file', path: '/videos/broken.mp4' })).rejects.toThrow(/exit code 2/);
    await expect(createVideoPlayer(join(bin, 'nope'), env)({ kind: 'file', path: '/v.mp4' })).rejects.toThrow(/not installed/);
  });
});

describe('video_play (V1)', () => {
  function rig(o: { links?: boolean; failPlay?: boolean; noRoots?: boolean } = {}) {
    const dir = tmp('video');
    const home = join(dir, 'Downloads');
    mkdirSync(home);
    mkdirSync(join(home, '.hidden'));
    writeFileSync(join(home, 'holiday.mp4'), MP4);
    writeFileSync(join(home, 'clip.webm'), MKV);
    writeFileSync(join(home, 'photo.mp4'), HEIC);
    writeFileSync(join(home, 'notes.mp4'), 'just text');
    writeFileSync(join(home, '.hidden', 'secret.mp4'), MP4);
    const outside = join(dir, 'outside.mp4');
    writeFileSync(outside, MP4);
    symlinkSync(outside, join(home, 'link.mp4'));
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const played: VideoSource[] = [];
    const steps: string[] = [];
    let paused = false;
    const video = videoTools({
      play: async (s) => {
        steps.push('play');
        if (o.failPlay) throw new Error('mpv could not play it (exit code 2)');
        played.push(s);
      },
      window: {
        appStarting: async (n) => {
          steps.push(`workspace 2 for ${n}`);
          return { workspace: 2 };
        },
        appFailed: async (n) => void steps.push(`back from ${n}`),
      },
      links: o.links ?? true,
      ...(o.noRoots ? {} : { roots: new FileRoots({ roots: [home] }) }),
    });
    const shown: ChatItem[] = [];
    const store = new Store(':memory:');
    const run: Run = async () => ({ stdout: '', code: 0 });
    const actions = new SystemActions({ store, controls: new SystemControls(run), audit, show: (i, isNew) => (isNew ? shown.push(i) : shown.splice(shown.findIndex((x) => x.id === i.id), 1, i)), notice: () => undefined, isPaused: () => paused });
    const tools = new ToolRegistry(audit, { isPaused: () => paused });
    for (const t of systemTools({ controls: new SystemControls(run), actions, extra: video })) tools.register(t);
    const call = (args: unknown, untrustedInContext = false) =>
      tools.execute({ id: 'v', name: 'video_play', arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'play it' });
    const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
    return { home, tools, call, played, steps, log, cards, actions, setPaused: (p: boolean) => (paused = p) };
  }

  it('plays a video file in the folders away from the chat, and audits it without its name in the reply', async () => {
    const { home, call, played, steps, log } = rig();
    const r = await call({ path: 'holiday.mp4' });
    expect(r).toMatchObject({ ok: true });
    expect(r.content).toBe('The video is playing in mpv on workspace 2; Super+Shift+H or the AI button in the top bar brings the chat back. Say it in one short line.');
    expect(r.content).not.toContain('holiday');
    expect(steps).toEqual(['workspace 2 for mpv', 'play']);
    expect(played).toEqual([{ kind: 'file', path: join(home, 'holiday.mp4') }]);
    expect(log().at(-1)).toMatchObject({ kind: 'tool', tool: 'video_play', tier: 'device', decision: 'allowed', ok: true, path: join(home, 'holiday.mp4'), format: 'MP4', workspace: 2 });
  });

  it('plays a link the user gave and audits only its site', async () => {
    const { call, played, log } = rig();
    const r = await call({ url: 'https://www.youtube.com/watch?v=abc&token=private' });
    expect(r.content).toMatch(/A link can take a few seconds to load/);
    expect(played).toEqual([{ kind: 'link', url: 'https://www.youtube.com/watch?v=abc&token=private' }]);
    const entry = log().at(-1)!;
    expect(entry).toMatchObject({ tool: 'video_play', decision: 'allowed', host: 'www.youtube.com' });
    expect(JSON.stringify(entry)).not.toContain('private');
  });

  it('refuses files that are not videos, outside the folders, hidden or behind a link, and bad links, playing nothing', async () => {
    const { call, played, steps } = rig();
    expect((await call({ path: 'photo.mp4' })).content).toMatch(/^Error: that file is not a video/);
    expect((await call({ path: 'notes.mp4' })).content).toMatch(/^Error: that file is not a video/);
    expect((await call({ path: 'link.mp4' })).content).toMatch(/^Error: only files in/);
    expect((await call({ path: '.hidden/secret.mp4' })).content).toMatch(/hidden files/);
    expect((await call({ path: '/etc/passwd' })).content).toMatch(/^Error: /);
    expect((await call({ path: 'missing.mp4' })).content).toMatch(/^Error: there is no file/);
    expect((await call({ url: 'file:///etc/passwd' })).content).toBe('Error: only https:// links can be played.');
    expect((await call({ url: 'https://127.0.0.1/x' })).content).toMatch(/IP address/);
    expect((await call({ path: 'holiday.mp4', url: 'https://youtube.com/x' })).content).toMatch(/^Error: invalid arguments: give either path or url/);
    expect((await call({})).content).toMatch(/^Error: invalid arguments/);
    expect((await call({ path: 'holiday.mp4', options: '--script=x' })).content).toMatch(/^Error: invalid arguments/);
    expect(played).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('follows the config: links off, or no file folders', async () => {
    expect((await rig({ links: false }).call({ url: 'https://youtube.com/x' })).content).toMatch(/turned off in config \[video\] links/);
    expect((await rig({ noRoots: true }).call({ path: 'holiday.mp4' })).content).toMatch(/turned off in config \[files\]/);
  });

  it('takes the user back to the chat when mpv does not start', async () => {
    const { call, steps } = rig({ failPlay: true });
    const r = await call({ path: 'clip.webm' });
    expect(r).toMatchObject({ ok: false, content: "Error: mpv didn't start: mpv could not play it (exit code 2)" });
    expect(steps).toEqual(['workspace 2 for mpv', 'play', 'back from mpv']);
  });

  it('while an email or other outside text is in view, a link only gets a confirm card naming its site; the click plays it', async () => {
    const { tools, call, played, cards, actions, log } = rig();
    expect(tools.specs({ untrustedInContext: true }).map((t) => t.name)).toContain('video_play');
    const r = await call({ url: 'https://evil.example.com/watch?v=1' }, true);
    expect(r.content).toMatch(/card now asks the user to confirm/);
    expect(played).toEqual([]);
    expect(cards()[0]).toMatchObject({ state: 'pending', confirm: 'Do it', title: "Play the video at “evil.example.com” in mpv? This was asked for while I was reading an email or document, so I'm checking with you first." });
    expect(log().at(-1)).toMatchObject({ tool: 'video_play', decision: 'proposed', untrustedInContext: true });
    expect(await actions.confirm(cards()[0]!.id, cards()[0]!.hash)).toBe('done');
    expect(played).toEqual([{ kind: 'link', url: 'https://evil.example.com/watch?v=1' }]);
  });

  it('a file asked for while outside text is in view also waits for a click; paused refuses it', async () => {
    const { call, played, cards, setPaused } = rig();
    await call({ path: 'holiday.mp4' }, true);
    expect(cards()[0]!.title).toMatch(/^Play “holiday.mp4” in mpv\?/);
    expect(played).toEqual([]);
    setPaused(true);
    expect((await call({ path: 'holiday.mp4' })).content).toMatch(/paused/);
    expect(played).toEqual([]);
  });
});
