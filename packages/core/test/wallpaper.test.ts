/**
 * The chat's wallpaper: only the user's typed /wallpaper (and Settings, scripts/test/onboard.test.ts)
 * changes it, there is no tool for it, the picture is checked by its bytes, and the chat page
 * gets only the one copied file from /wallpaper.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, initialChatState, ServerEvent, Wallpaper as WallpaperState } from '@aios/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuditLog } from '../src/audit.js';
import { HELP_TEXT, parseCommand } from '../src/commands.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { createServer } from '../src/server.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { WALLPAPER_IMAGE, WALLPAPER_MAX_BYTES, Wallpaper, wallpaperPath, wallpaperType } from '../src/wallpaper.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'aios-wallpaper-'));
  const home = join(root, 'home');
  const config = join(root, 'config');
  mkdirSync(join(home, 'Pictures', 'My Walls'), { recursive: true });
  return { root, home, config };
}

describe('wallpaperType', () => {
  it('knows PNG, JPEG, WebP and GIF by their bytes, and nothing else', () => {
    expect(wallpaperType(PNG)).toBe('image/png');
    expect(wallpaperType(JPEG)).toBe('image/jpeg');
    expect(wallpaperType(WEBP)).toBe('image/webp');
    expect(wallpaperType(GIF)).toBe('image/gif');
    for (const not of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html><script></script>', '%PDF-1.7', '']) expect(wallpaperType(Buffer.from(not))).toBeNull();
  });
});

describe('wallpaperPath', () => {
  it('reads ~, absolute and home-relative paths, quotes and file:// links', () => {
    expect(wallpaperPath('~/Pictures/a.jpg', '/home/j')).toBe('/home/j/Pictures/a.jpg');
    expect(wallpaperPath('"~/Pictures/My Walls/a b.png"', '/home/j')).toBe('/home/j/Pictures/My Walls/a b.png');
    expect(wallpaperPath('/usr/share/backgrounds/x.png', '/home/j')).toBe('/usr/share/backgrounds/x.png');
    expect(wallpaperPath('Pictures/x.png', '/home/j')).toBe('/home/j/Pictures/x.png');
    expect(wallpaperPath('file:///home/j/My%20Walls/x.png', '/home/j')).toBe('/home/j/My Walls/x.png');
    expect(wallpaperPath('', '/home/j')).toBeNull();
  });
});

describe('Wallpaper', () => {
  it('copies a picture into the config folder, changes its dim, and removes only the copy', () => {
    const f = folders();
    const original = join(f.home, 'Pictures', 'My Walls', 'beach.png');
    writeFileSync(original, PNG);
    const w = new Wallpaper(f.config);
    expect(w.current()).toBeNull();
    const r = w.setFromPath('~/Pictures/My Walls/beach.png', f.home);
    expect(r).toMatchObject({ ok: true, state: { dim: 'medium', version: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    expect(readFileSync(join(f.config, WALLPAPER_IMAGE))).toEqual(PNG);
    expect(w.file()).toEqual({ bytes: PNG, type: 'image/png' });
    expect(w.setDim('strong')).toMatchObject({ ok: true, state: { dim: 'strong' } });
    // A new picture keeps the dim the user chose.
    writeFileSync(original, JPEG);
    expect(w.setFromPath(original, f.home)).toMatchObject({ ok: true, state: { dim: 'strong' } });
    expect(w.current()?.version).not.toBe(r.ok ? r.state.version : '');
    expect(w.remove()).toBe(true);
    expect(w.current()).toBeNull();
    expect(w.file()).toBeNull();
    expect(existsSync(original)).toBe(true);
    expect(w.remove()).toBe(false);
  });

  it('refuses what is not a picture, folders, missing files and pictures over the limit', () => {
    const f = folders();
    const w = new Wallpaper(f.config);
    writeFileSync(join(f.home, 'evil.svg'), '<svg><script>alert(1)</script></svg>');
    writeFileSync(join(f.home, 'notes.txt'), 'hello');
    for (const p of ['~/evil.svg', '~/notes.txt', '~/Pictures', '~/nope.png']) expect(w.setFromPath(p, f.home).ok).toBe(false);
    expect(w.set(Buffer.concat([PNG, Buffer.alloc(WALLPAPER_MAX_BYTES)])).ok).toBe(false);
    expect(w.set(Buffer.alloc(0)).ok).toBe(false);
    expect(w.setDim('light').ok).toBe(false);
    expect(w.current()).toBeNull();
  });

  it('shows nothing when the copy was swapped for something that is not a picture', () => {
    const f = folders();
    const w = new Wallpaper(f.config);
    w.set(PNG);
    writeFileSync(join(f.config, WALLPAPER_IMAGE), '<html><script></script></html>');
    expect(w.file()).toBeNull();
  });
});

function rig() {
  const f = folders();
  const auditPath = join(f.root, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const events: ServerEvent[] = [];
  const requests: ModelRequest[] = [];
  const model = {
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
      yield { type: 'done', result: r };
      return r;
    },
  };
  const wallpaper = new Wallpaper(f.config);
  const tools = new ToolRegistry(audit);
  const shell = new Shell({
    store: new Store(':memory:'),
    model,
    tools,
    audit,
    userName: 'John',
    timeZone: 'UTC',
    modelName: 'm',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    wallpaper,
    home: f.home,
  });
  shell.subscribe((e) => events.push(e));
  const notices = () => events.flatMap((e) => (e.type === 'item' && e.item.kind === 'notice' ? [e.item.text] : []));
  const sent = () => events.flatMap((e) => (e.type === 'wallpaper' ? [e.wallpaper] : []));
  return { f, shell, wallpaper, tools, notices, sent, requests, audit: () => readFileSync(auditPath, 'utf8') };
}

describe('/wallpaper in the chat', () => {
  it('sets, dims and removes the wallpaper from the user’s typing, telling every open chat, never calling the model', async () => {
    const r = rig();
    writeFileSync(join(r.f.home, 'Pictures', 'My Walls', 'sea view.jpg'), JPEG);
    await r.shell.handle({ type: 'send', text: '/wallpaper' });
    expect(r.notices().at(-1)).toContain('The chat has no wallpaper.');
    await r.shell.handle({ type: 'send', text: '/wallpaper ~/Pictures/My Walls/sea view.jpg' });
    expect(r.notices().at(-1)).toContain('wallpaper is behind the chat');
    const set = r.sent().at(-1);
    expect(WallpaperState.parse(set)).toMatchObject({ dim: 'medium' });
    await r.shell.handle({ type: 'send', text: '/wallpaper strong' });
    expect(r.sent().at(-1)).toMatchObject({ dim: 'strong', version: set?.version });
    await r.shell.handle({ type: 'send', text: '/wallpaper dim light' });
    expect(r.sent().at(-1)).toMatchObject({ dim: 'light' });
    await r.shell.handle({ type: 'send', text: '/wallpaper off' });
    expect(r.sent().at(-1)).toBeNull();
    expect(r.notices().at(-1)).toBe('Wallpaper removed.');
    expect(r.requests).toHaveLength(0);
    // The audit log says what changed, never where the picture was.
    expect(r.audit()).toContain('"kind":"wallpaper"');
    expect(r.audit()).not.toContain('sea view');
  });

  it('says why when the file is not a picture, and changes nothing', async () => {
    const r = rig();
    writeFileSync(join(r.f.home, 'page.html'), '<html><script>alert(1)</script></html>');
    await r.shell.handle({ type: 'send', text: '/wallpaper ~/page.html' });
    expect(r.notices().at(-1)).toMatch(/isn’t a picture/);
    await r.shell.handle({ type: 'send', text: '/wallpaper strong' });
    expect(r.notices().at(-1)).toMatch(/no wallpaper yet/);
    expect(r.sent()).toEqual([]);
    expect(r.wallpaper.current()).toBeNull();
  });

  it('is in the hello, so a chat that opens later shows it, and the reducer keeps it', async () => {
    const r = rig();
    r.wallpaper.set(PNG, 'light');
    const events: ServerEvent[] = [];
    r.shell.subscribe((e) => events.push(e));
    const hello = events[0];
    expect(hello?.type === 'hello' && hello.wallpaper).toMatchObject({ dim: 'light' });
    const state = applyEvent(initialChatState, ServerEvent.parse(hello));
    expect(state.wallpaper).toMatchObject({ dim: 'light' });
    expect(applyEvent(state, { type: 'wallpaper', wallpaper: null }).wallpaper).toBeNull();
  });

  it('has no tool: neither the model nor outside text can change it', () => {
    expect(ALPHA_TOOLS.some((t) => /wallpaper|background/i.test(t.name))).toBe(false);
    expect(rig().tools.has('wallpaper')).toBe(false);
    expect(parseCommand('/wallpaper  ~/a  b.png')).toEqual({ name: 'wallpaper', text: '~/a  b.png' });
    expect(parseCommand('/background off')).toEqual({ name: 'wallpaper', text: 'off' });
    expect(HELP_TEXT).toContain('/wallpaper');
  });
});

describe('GET /wallpaper', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the copied picture to the chat page only', async () => {
    const r = rig();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    app = await createServer(r.shell, { port, wallpaper: r.wallpaper });
    await app.listen({ host: '127.0.0.1', port });
    const get = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/wallpaper?v=abc`, { headers });
    expect((await get()).status).toBe(404);
    r.wallpaper.set(WEBP);
    const ok = await get({ 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/webp');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(WEBP);
    expect((await get({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
});
