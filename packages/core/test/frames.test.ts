/**
 * Photo frames beside the chat: only the folder picked in Settings, only real photos by their
 * bytes (never hidden files, links or anything deeper than one folder down), the page names only
 * a frame's number and the time, and nothing in the chat (no tool, no command) can change them.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FramesConfig, type ServerEvent, frameTurn } from '@aios/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { parseCommand } from '../src/commands.js';
import { PhotoFrames } from '../src/frames.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { chatSystemPrompt } from '../src/prompts.js';
import { createServer } from '../src/server.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`photo ${n}`)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);

function home() {
  const root = mkdtempSync(join(tmpdir(), 'aios-frames-'));
  const h = join(root, 'home');
  mkdirSync(join(h, 'Pictures', 'Trips', 'Deeper'), { recursive: true });
  mkdirSync(join(h, 'Pictures', '.hidden'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'));
  return { root, h, pics: join(h, 'Pictures') };
}

const cfg = (over: Partial<FramesConfig> = {}): FramesConfig => ({ enabled: true, folder: '~/Pictures', count: 2, minutes: 15, ...over });

/** Every photo a frame shows over many turns, by its bytes. */
function shown(f: PhotoFrames, slot = 0, turns = 40): Set<string> {
  const out = new Set<string>();
  for (let t = 0; t < turns; t++) {
    const got = f.file(slot, t);
    if (got) out.add(got.bytes.toString('latin1'));
  }
  return out;
}

describe('PhotoFrames', () => {
  it('is off unless turned on, and with no photos', () => {
    const { h, pics } = home();
    writeFileSync(join(pics, 'a.png'), png(1));
    expect(new PhotoFrames({ config: cfg({ enabled: false }), home: h }).current()).toBeNull();
    expect(new PhotoFrames({ config: cfg({ enabled: false }), home: h }).file(0, 0)).toBeNull();
    expect(new PhotoFrames({ config: cfg({ folder: '~/Missing' }), home: h }).current()).toBeNull();
    // A relative folder isn't one.
    expect(new PhotoFrames({ config: cfg({ folder: 'Pictures' }), home: h }).current()).toBeNull();
  });

  it('shows photos in the folder and one folder down, never hidden ones, links or deeper ones', () => {
    const { root, h, pics } = home();
    writeFileSync(join(pics, 'a.png'), png(1));
    writeFileSync(join(pics, 'Trips', 'b.jpg'), JPEG);
    writeFileSync(join(pics, 'Trips', 'Deeper', 'deep.png'), png(9));
    writeFileSync(join(pics, '.secret.png'), png(8));
    writeFileSync(join(pics, '.hidden', 'c.png'), png(7));
    writeFileSync(join(pics, 'notes.txt'), png(6));
    writeFileSync(join(pics, 'drawing.svg'), '<svg><script>alert(1)</script></svg>');
    writeFileSync(join(root, 'elsewhere', 'outside.png'), png(5));
    symlinkSync(join(root, 'elsewhere', 'outside.png'), join(pics, 'link.png'));
    symlinkSync(join(root, 'elsewhere'), join(pics, 'Linked'));
    const f = new PhotoFrames({ config: cfg({ count: 1 }), home: h });
    expect(f.current()).toMatchObject({ count: 1, minutes: 15 });
    expect([...shown(f)].sort()).toEqual([JPEG.toString('latin1'), png(1).toString('latin1')].sort());
  });

  it('skips a file that says it is a photo but isn’t one by its bytes, or is too big', () => {
    const { h, pics } = home();
    writeFileSync(join(pics, 'a.png'), png(1));
    writeFileSync(join(pics, 'page.jpg'), '<html><script>alert(1)</script></html>');
    writeFileSync(join(pics, 'huge.png'), Buffer.concat([png(2), Buffer.alloc(16 * 1024 * 1024)]));
    writeFileSync(join(pics, 'empty.png'), '');
    const f = new PhotoFrames({ config: cfg({ count: 1 }), home: h });
    const all = shown(f);
    expect([...all]).toEqual([png(1).toString('latin1')]);
    for (let t = 0; t < 20; t++) expect(f.file(0, t)?.type).toBe('image/png');
  });

  it('gives each frame a different photo at the same time, and no more frames than photos', () => {
    const { h, pics } = home();
    for (let i = 0; i < 5; i++) writeFileSync(join(pics, `p${i}.png`), png(i));
    const f = new PhotoFrames({ config: cfg({ count: 3 }), home: h });
    expect(f.current()).toMatchObject({ count: 3 });
    for (let now = 0; now < 4 * 15 * 60_000; now += 60_000) {
      const at = [0, 1, 2].map((slot) => f.file(slot, frameTurn(now + 10 ** 12, 15, slot, 3))!.bytes.toString('latin1'));
      expect(new Set(at).size).toBe(3);
    }
    // Over time each frame shows them all.
    expect(shown(f, 0).size).toBe(5);
    expect(f.file(3, 0)).toBeNull();
    expect(f.file(0, -1)).toBeNull();
    expect(f.file(0.5, 1)).toBeNull();
    const { h: h2, pics: pics2 } = home();
    writeFileSync(join(pics2, 'only.png'), png(1));
    const one = new PhotoFrames({ config: cfg({ count: 3 }), home: h2 });
    expect(one.current()).toMatchObject({ count: 1 });
    expect(one.file(1, 0)).toBeNull();
  });

  it('reads the folder again after a while, and says so with a new version', () => {
    const { h, pics } = home();
    writeFileSync(join(pics, 'a.png'), png(1));
    let now = 0;
    const f = new PhotoFrames({ config: cfg(), home: h, now: () => now });
    const before = f.current()!.version;
    writeFileSync(join(pics, 'b.png'), png(2));
    expect(f.current()!.version).toBe(before);
    now += 6 * 60_000;
    expect(f.current()).toMatchObject({ count: 2 });
    expect(f.current()!.version).not.toBe(before);
  });

  it('looks at an empty folder again right away, so new photos show soon', () => {
    const { h, pics } = home();
    const f = new PhotoFrames({ config: cfg(), home: h, now: () => 0 });
    expect(f.current()).toBeNull();
    writeFileSync(join(pics, 'a.png'), png(1));
    expect(f.current()).toMatchObject({ count: 1 });
  });

  it('staggers the frames so they don’t all change at once', () => {
    const period = 15 * 60_000;
    expect([0, 1, 2].map((s) => frameTurn(10 * period, 15, s, 3))).toEqual([10, 9, 9]);
    expect([0, 1, 2].map((s) => frameTurn(10 * period + period / 2, 15, s, 3))).toEqual([10, 10, 9]);
    expect(frameTurn(0, 15, 2, 3)).toBe(0);
  });
});

function rig(frames?: PhotoFrames) {
  const root = mkdtempSync(join(tmpdir(), 'aios-frames-shell-'));
  const audit = new AuditLog(join(root, 'audit.jsonl'));
  const model = {
    async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
      yield { type: 'done', result: r };
      return r;
    },
  };
  const shell = new Shell({ store: new Store(':memory:'), model, tools: new ToolRegistry(audit), audit, userName: 'John', timeZone: 'UTC', modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null, ...(frames ? { frames } : {}) });
  return shell;
}

describe('photo frames in the chat', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('tells the page how many frames there are, and nothing about the files', () => {
    const { h, pics } = home();
    writeFileSync(join(pics, 'Grandma at the beach.png'), png(1));
    writeFileSync(join(pics, 'b.png'), png(2));
    const first = (shell: Shell) => {
      const events: ServerEvent[] = [];
      shell.subscribe((e) => events.push(e));
      return events.find((e) => e.type === 'hello');
    };
    const hello = first(rig(new PhotoFrames({ config: cfg(), home: h })));
    expect(hello).toMatchObject({ type: 'hello', frames: { count: 2, minutes: 15 } });
    expect(JSON.stringify(hello)).not.toContain('Grandma');
    expect(JSON.stringify(hello)).not.toContain(pics);
    expect(first(rig())).not.toHaveProperty('frames');
  });

  it('has no tool or command for them, and the model only points to Settings', () => {
    expect(ALPHA_TOOLS.some((t) => /frame|photo/i.test(t.name))).toBe(false);
    expect(parseCommand('/frames off')).not.toMatchObject({ name: 'frames' });
    const p = chatSystemPrompt({ userName: 'John', now: 'n' });
    expect(p).toContain("You can't turn them on or off or change their folder");
  });

  it('serves a frame’s photo to the chat page only, by frame number and time', async () => {
    const { h, pics } = home();
    writeFileSync(join(pics, 'a.png'), png(1));
    writeFileSync(join(pics, 'b.jpg'), JPEG);
    const frames = new PhotoFrames({ config: cfg(), home: h });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    app = await createServer(rig(frames), { port, frames });
    await app.listen({ host: '127.0.0.1', port });
    const get = (path: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const ok = await get('/frame/0?t=123&v=abcdefabcdef');
    expect(ok.status).toBe(200);
    expect(['image/png', 'image/jpeg']).toContain(ok.headers.get('content-type'));
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await get('/frame/0?t=123', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    for (const bad of ['/frame/3?t=1', '/frame/0', '/frame/0?t=-1', '/frame/0?t=1e3', '/frame/..%2Fa.png?t=1', '/frame/a.png?t=1']) expect((await get(bad)).status).toBe(404);
  });
});
