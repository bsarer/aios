import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AppBuilder, appCsp, withCsp } from '../src/apps/builder.js';
import { withChangeButton, withoutChangeButton } from '../src/apps/change-button.js';
import { BuildLog } from '../src/apps/history.js';
import { AppLink, type CardState, linkKey, linkToken } from '../src/apps/link.js';
import { buildAppTool, offerBuild } from '../src/apps/tools.js';
import { AuditLog } from '../src/audit.js';
import { createServer } from '../src/server.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { SystemActions } from '../src/system/actions.js';
import { SystemControls } from '../src/system/controls.js';
import { ToolRegistry } from '../src/tools/registry.js';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `aios-${name}-`));
const PORT = 7777;
const KEY = Buffer.alloc(32, 7);
const TOKEN = linkToken(KEY, 'snake');
const HTML = '<!doctype html><html><head><title>Snake</title></head><body><canvas></canvas></body></html>';

describe('the Change button', () => {
  it('goes in once, just before </body>, and comes out again', () => {
    const link = { port: PORT, slug: 'snake', token: TOKEN };
    const out = withChangeButton(HTML, link);
    expect(out.match(/AI OS: change button/g)).toHaveLength(2);
    expect(out.endsWith('<!-- /AI OS: change button --></body></html>')).toBe(true);
    expect(withChangeButton(out, link)).toBe(out);
    expect(withoutChangeButton(out)).toBe(HTML);
    expect(withChangeButton('<p>no body tag</p>', link)).toMatch(/^<p>no body tag<\/p><!-- AI OS: change button -->/);
    // The script can't close its own tag, uses no innerHTML, and talks only to the link path.
    const script = /<script>([\s\S]*)<\/script>/.exec(out)![1]!;
    expect(script).not.toContain('</');
    expect(script).not.toMatch(/innerHTML|eval\(|new Function/);
    expect(script).toContain('"base":"http://127.0.0.1:7777/app-link/"');
    expect(script).toContain(`"token":"${TOKEN}"`);
  });

  it('takes only a real slug, token and port', () => {
    expect(() => withChangeButton(HTML, { port: PORT, slug: '../x', token: TOKEN })).toThrow();
    expect(() => withChangeButton(HTML, { port: PORT, slug: 'snake', token: '"};alert(1)//' })).toThrow();
    expect(() => withChangeButton(HTML, { port: 0, slug: 'snake', token: TOKEN })).toThrow();
  });

  it("opens the app's policy to the link path on loopback and nowhere else", () => {
    expect(appCsp()).toContain("connect-src 'none'");
    expect(appCsp(PORT)).toContain('connect-src http://127.0.0.1:7777/app-link/;');
    expect(appCsp(PORT).replace('connect-src http://127.0.0.1:7777/app-link/', '')).not.toMatch(/http|127\.0\.0\.1|\*/);
    const sealed = withCsp(HTML, PORT);
    expect(sealed).toContain('except to AI OS');
    expect(withCsp(sealed)).toContain("connect-src 'none'");
    expect(withCsp(sealed).match(/Content-Security-Policy/g)).toHaveLength(1);
  });
});

describe('link tokens', () => {
  it('are made from a private key kept on disk and name one app each', () => {
    const path = join(tmp('key'), 'aios', 'app-link.key');
    const key = linkKey(path);
    expect(key).toHaveLength(32);
    expect(readFileSync(path).equals(key)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(linkKey(path).equals(key)).toBe(true);
    expect(linkToken(key, 'snake')).toMatch(/^[0-9a-f]{64}$/);
    expect(linkToken(key, 'snake')).not.toBe(linkToken(key, 'solitaire'));
  });
});

/** A pretend `claude` that writes Snake, and a pretend `chromium`. */
function rig(mode: 'ok' | 'error' = 'ok') {
  const dir = tmp('link');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    'claude',
    [
      'if [ "$1" = auth ]; then echo "{\\"authMethod\\":\\"claude.ai\\"}"; exit 0; fi',
      'cat > /dev/null',
      `if [ "$FAKE_CLAUDE" = error ]; then echo '{"type":"result","subtype":"error","is_error":true,"result":"broke"}'; exit 1; fi`,
      `printf '${HTML}' > index.html`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"A snake game.","total_cost_usd":0.3}'`,
    ].join('\n'),
  );
  script('chromium', 'exit 0');
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data'), XDG_DATA_DIRS: join(dir, 'share'), PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE: mode };
  const config = { command: 'claude', maxBudgetUsd: 2, timeoutMinutes: 1 };
  const link = { port: PORT, token: (slug: string) => linkToken(KEY, slug) };
  const builder = new AppBuilder({ config, env, link });
  const plain = new AppBuilder({ config, env });
  const index = (slug: string) => join(env.XDG_DATA_HOME, 'aios', 'apps', slug, 'index.html');
  return { env, builder, plain, index, read: (slug: string) => readFileSync(index(slug), 'utf8') };
}

describe('built apps', () => {
  it('get the Change button and a policy that reaches only AI OS', async () => {
    const r = rig();
    await r.builder.build({ name: 'Snake', request: 'snake' });
    const html = r.read('snake');
    expect(html).toContain(`content="${appCsp(PORT)}"`);
    expect(html).toContain(`"token":"${TOKEN}"`);
    expect(await r.builder.builtName('snake')).toBe('Snake');
  });

  it('are re-sealed at startup: older apps gain the button, and turning it off takes it out', async () => {
    const r = rig();
    await r.plain.build({ name: 'Snake', request: 'snake' });
    expect(r.read('snake')).not.toContain('change button');
    // A folder with no AI OS desktop entry isn't an app AI OS built, so it is left alone.
    mkdirSync(join(r.env.XDG_DATA_HOME, 'aios', 'apps', 'stray'), { recursive: true });
    writeFileSync(r.index('stray'), HTML);
    expect(await r.builder.sealAll()).toEqual(['snake']);
    expect(r.read('snake')).toContain('change button');
    expect(r.read('stray')).toBe(HTML);
    expect(await r.plain.sealAll()).toEqual(['snake']);
    expect(r.read('snake')).not.toContain('change button');
    expect(r.read('snake')).toContain("connect-src 'none'");
  });

  it('get the policy back even when a change fails part-way', async () => {
    const r = rig();
    await r.builder.build({ name: 'Snake', request: 'snake' });
    writeFileSync(r.index('snake'), HTML);
    const broken = new AppBuilder({ config: { command: 'claude', maxBudgetUsd: 2, timeoutMinutes: 1 }, env: { ...r.env, FAKE_CLAUDE: 'error' }, link: { port: PORT, token: (s) => linkToken(KEY, s) } });
    await expect(broken.build({ name: 'Snake', request: 'faster' })).rejects.toThrow('broke');
    expect(r.read('snake')).toContain(`content="${appCsp(PORT)}"`);
    expect(r.read('snake')).toContain('change button');
  });
});

function linkRig() {
  const r = rig();
  const dir = tmp('linkrig');
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const shown: ChatItem[] = [];
  const store = new Store(':memory:');
  let now = 1_000_000;
  const clock = () => now;
  const actions = new SystemActions({
    store,
    controls: new SystemControls(async () => ({ stdout: '', code: 0 })),
    audit,
    show: (i, isNew) => {
      if (isNew) shown.push(i);
      else shown.splice(shown.findIndex((x) => x.id === i.id), 1, i);
    },
    notice: () => undefined,
    clock,
  });
  const log = new BuildLog(store);
  const budgets = [1, 2];
  // Registering build_app sets up what the card's click runs.
  new ToolRegistry(audit).register(buildAppTool({ builder: r.builder, actions, scan: async () => [], log, budgets, post: () => undefined, notify: () => undefined, clock }));
  const shownCards: string[] = [];
  let offers = 0;
  const link = new AppLink({
    key: KEY,
    appName: (slug) => r.builder.builtName(slug),
    waiting: (slug) => actions.pendingBuilds().some((p) => p.slug === slug),
    offer: async (a) => {
      offers++;
      const o = await offerBuild({ builder: r.builder, actions, log, budgets }, { ...a, fromApp: true });
      return o.problem ? { error: 'no' } : { card: o.card };
    },
    card: (id) => actions.buildCard(id),
    showCard: (name) => shownCards.push(name),
    audit,
    clock,
  });
  const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
  const body = (o: Record<string, unknown>) => JSON.stringify(o);
  return { r, link, actions, cards, shownCards, body, offers: () => offers, auditLog: () => readFileSync(auditPath, 'utf8'), tick: (ms: number) => (now += ms) };
}

describe('asking for a change from inside an app', () => {
  it('only posts a Change card; the click in the chat changes the app, and the app hears it is done', async () => {
    const t = linkRig();
    await t.r.builder.build({ name: 'Snake', request: 'snake' });
    const res = await t.link.change(t.body({ slug: 'snake', token: TOKEN, request: 'make it faster​\n\n\n\nand blue\u0007' }));
    expect(res).toMatchObject({ ok: true, state: 'pending', message: expect.stringContaining('Click Change on the card') });
    const card = t.cards()[0]!;
    expect(card).toMatchObject({ id: res.card, state: 'pending', confirm: 'Change' });
    expect(card.title).toBe('Change the app “Snake”? You asked from inside the app: “make it faster\n\nand blue”. Claude Code will edit only that app\'s folder.');
    expect(t.shownCards).toEqual(['Snake']);
    // Nothing ran: the app is as it was until the click.
    expect(t.link.status(t.body({ slug: 'snake', token: TOKEN, card: res.card }))).toEqual({ ok: true, state: 'pending', message: 'Waiting for you to click Change on the card in the AI OS chat.' });
    expect(await t.actions.confirm(card.id, card.hash, '1')).toBe('done');
    expect(t.link.status(t.body({ slug: 'snake', token: TOKEN, card: res.card }))).toMatchObject({ ok: true, state: 'done' });
    // Audits record the length of the words, never the words.
    expect(t.auditLog()).toContain('"via":"app"');
    expect(t.auditLog()).toContain('"decision":"proposed"');
    expect(t.auditLog()).not.toContain('faster');
  });

  it("refuses a wrong token, another app's token, an app AI OS didn't build, and empty words", async () => {
    const t = linkRig();
    await t.r.builder.build({ name: 'Snake', request: 'snake' });
    await t.r.builder.build({ name: 'Solitaire', request: 'solitaire' });
    for (const bad of [
      { slug: 'snake', token: '0'.repeat(64), request: 'x' },
      { slug: 'solitaire', token: TOKEN, request: 'x' },
      { slug: 'snake', request: 'x' },
      'not json',
      null,
    ]) {
      expect((await t.link.change(typeof bad === 'string' || bad === null ? bad : t.body(bad))).ok).toBe(false);
    }
    expect((await t.link.change(t.body({ slug: 'ghost', token: linkToken(KEY, 'ghost'), request: 'x' }))).message).toMatch(/can't find this app/);
    expect((await t.link.change(t.body({ slug: 'snake', token: TOKEN, request: ' ​\n ' }))).message).toBe('Say what should change first.');
    expect(t.cards()).toEqual([]);
    expect(t.offers()).toBe(0);
    expect(t.auditLog()).toContain('bad link request');
  });

  it('keeps one waiting card per app and limits how often apps can ask', async () => {
    const t = linkRig();
    await t.r.builder.build({ name: 'Snake', request: 'snake' });
    const ask = (request: string) => t.link.change(t.body({ slug: 'snake', token: TOKEN, request }));
    const first = await ask('faster');
    expect((await ask('slower')).message).toMatch(/already waiting/);
    t.actions.cancel(first.card!);
    expect(t.link.status(t.body({ slug: 'snake', token: TOKEN, card: first.card }))).toMatchObject({ state: 'cancelled' });
    for (let i = 0; i < 5; i++) {
      const r = await ask(`change ${i}`);
      expect(r.ok).toBe(true);
      t.actions.cancel(r.card!);
    }
    expect((await ask('one more')).message).toMatch(/Too many requests/);
    t.tick(61_000);
    expect((await ask('one more')).ok).toBe(true);
  });

  it("answers status only for the app's own cards", async () => {
    const t = linkRig();
    await t.r.builder.build({ name: 'Snake', request: 'snake' });
    await t.r.builder.build({ name: 'Solitaire', request: 'solitaire' });
    const card = (await t.link.change(t.body({ slug: 'snake', token: TOKEN, request: 'faster' }))).card!;
    const sol = linkToken(KEY, 'solitaire');
    const state = (o: Record<string, unknown>) => t.link.status(t.body(o)).state as CardState | 'unknown';
    expect(state({ slug: 'solitaire', token: sol, card })).toBe('unknown');
    expect(state({ slug: 'snake', token: sol, card })).toBe('unknown');
    expect(state({ slug: 'snake', token: TOKEN, card: 'action-nope' })).toBe('unknown');
    expect(state({ slug: 'snake', token: TOKEN, card })).toBe('pending');
  });
});

describe('the /app-link endpoint', () => {
  async function start(withLink = true) {
    const audit = new AuditLog(join(tmp('srv'), 'a.jsonl'));
    const shell = new Shell({
      store: new Store(':memory:'),
      model: { stream: () => { throw new Error('no model in this test'); } },
      tools: new ToolRegistry(audit),
      audit,
      userName: 'John',
      timeZone: 'UTC',
      modelName: 'm',
      costCapUsd: 2,
      readBattery: async () => null,
      readWifi: async () => null,
    });
    const seen: unknown[] = [];
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const app = await createServer(shell, {
      port,
      ...(withLink
        ? {
            appLink: {
              change: async (b: unknown) => {
                seen.push(b);
                return { ok: true, message: 'Sent.', card: 'action-1', state: 'pending' as const };
              },
              status: () => ({ ok: true, message: 'Done.', state: 'done' as const }),
            },
          }
        : {}),
    });
    await app.listen({ host: '127.0.0.1', port });
    return { app, port, seen };
  }
  const post = (port: number, what: string, origin: string | null, body = '{"x":1}') =>
    fetch(`http://127.0.0.1:${port}/app-link/${what}`, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=UTF-8', ...(origin === null ? {} : { origin }) } });

  it('answers file:// pages (origin null) with CORS for them, and nobody else', async () => {
    const s = await start();
    try {
      const ok = await post(s.port, 'change', 'null');
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBe('null');
      expect(await ok.json()).toMatchObject({ ok: true, card: 'action-1' });
      expect(s.seen).toEqual(['{"x":1}']);
      expect((await post(s.port, 'status', 'null')).status).toBe(200);
      expect((await post(s.port, 'change', 'https://evil.example')).status).toBe(403);
      expect((await post(s.port, 'change', `http://127.0.0.1:${s.port}`)).status).toBe(403);
      expect((await post(s.port, 'change', null)).status).toBe(403);
      expect((await post(s.port, 'other', 'null')).status).toBe(404);
      expect((await post(s.port, 'change', 'null', 'x'.repeat(20_000))).status).toBe(413);
      expect(s.seen).toHaveLength(1);
      const pre = await fetch(`http://127.0.0.1:${s.port}/app-link/change`, { method: 'OPTIONS', headers: { origin: 'null' } });
      expect(pre.status).toBe(204);
    } finally {
      await s.app.close();
    }
  });

  it('is off without the link', async () => {
    const s = await start(false);
    try {
      expect((await post(s.port, 'change', 'null')).status).toBe(404);
    } finally {
      await s.app.close();
    }
  });
});
