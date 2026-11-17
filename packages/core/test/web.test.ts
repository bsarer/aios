/**
 * T8: web_open. Only checked http(s) links and searches built from the config's template reach
 * Chromium, always as `--new-window -- <one address>`; while outside text is in view it is a
 * confirm card naming the site; nothing from the page comes back; every call is audited.
 * Uses a pretend browser, never a real one.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChatItem, WebConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { AuditLog } from '../src/audit.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { Store } from '../src/store.js';
import { SystemActions } from '../src/system/actions.js';
import { SystemControls } from '../src/system/controls.js';
import type { Run } from '../src/system/run.js';
import { systemTools } from '../src/system/tools.js';
import { toolByName } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { sanitize, wrapUntrusted } from '../src/untrusted.js';
import { browserArgs, checkWebLink, createBrowserOpener, searchLink } from '../src/web/open.js';
import { pickWeb, webTools } from '../src/web/tools.js';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `aios-${name}-`));
const SEARCH = 'https://www.google.com/search?q=%s';

describe('web links and searches (T8)', () => {
  it('opens http and https links, and gives a bare site name https://', () => {
    expect(checkWebLink(' https://www.bbc.com/news ').href).toBe('https://www.bbc.com/news');
    expect(checkWebLink('http://example.com/a?b=1').href).toBe('http://example.com/a?b=1');
    expect(checkWebLink('github.com').href).toBe('https://github.com/');
    expect(checkWebLink('news.ycombinator.com/item?id=1').href).toBe('https://news.ycombinator.com/item?id=1');
    // The local network is allowed (a router's page); a link from outside text only opens after a click.
    expect(checkWebLink('http://192.168.1.1/').href).toBe('http://192.168.1.1/');
    expect(checkWebLink('https://example.com:8443/x').port).toBe('8443');
  });

  it('refuses other protocols, this computer, credentials and anything that is not one link', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome://settings',
      'data:text/html,<script>1</script>',
      'about:blank',
      'ftp://example.com/',
      'http://127.0.0.1:7777/app-link/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0.0.0.0:7777/',
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://[::1]:7777/',
      'http://[::ffff:127.0.0.1]/',
      'https://user:pw@example.com/',
      'https://example.com/a b',
      '--user-data-dir=/tmp/x',
      'https://example.com/‮',
      'not a link',
      '',
    ]) {
      expect(() => checkWebLink(bad), bad).toThrow();
    }
  });

  it('builds searches from the config template, with the words encoded', () => {
    expect(searchLink(SEARCH, ' weather  in Istanbul & more ').href).toBe('https://www.google.com/search?q=weather%20in%20Istanbul%20%26%20more');
    expect(searchLink('https://duckduckgo.com/?q=%s', 'a#b').href).toBe('https://duckduckgo.com/?q=a%23b');
    expect(() => searchLink(SEARCH, '   ')).toThrow(/nothing to search/);
    expect(() => searchLink(SEARCH, 'x'.repeat(301))).toThrow(/at most/);
    expect(() => searchLink('http://example.com/?q=%s', 'x')).toThrow(/https/);
    expect(() => searchLink('https://127.0.0.1/?q=%s', 'x')).toThrow(/this computer/);
    expect(() => searchLink('https://example.com/?q=%s&r=%s', 'x')).toThrow(/once/);
  });

  it('checks the [web] config', () => {
    expect(WebConfig.parse({})).toEqual({ enabled: true, browser: 'chromium', search: SEARCH, read: true, maxBytes: 2_000_000, maxChars: 16_000 });
    expect(() => WebConfig.parse({ search: 'https://example.com/' })).toThrow();
    expect(() => WebConfig.parse({ search: 'file:///x?%s' })).toThrow();
  });

  it('gives the browser --new-window, then --, then the one address', () => {
    expect(browserArgs('https://example.com/x')).toEqual(['--new-window', '--', 'https://example.com/x']);
    expect(browserArgs('example.com')).toEqual(['--new-window', '--', 'https://example.com/']);
    expect(() => browserArgs('--incognito')).toThrow();
  });

  it('starts the browser without a shell and reports an exit with an error', async () => {
    const bin = tmp('webbin');
    const out = join(bin, 'args.txt');
    const fake = join(bin, 'chromium');
    writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${out}'; done\ncase "$*" in *broken*) exit 3;; esac\nexit 0\n`);
    chmodSync(fake, 0o755);
    const env = { PATH: bin };
    await createBrowserOpener(fake, env)('https://example.com/a$(touch%20x);b');
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['--new-window', '--', 'https://example.com/a$(touch%20x);b']);
    await expect(createBrowserOpener(fake, env)('https://example.com/broken')).rejects.toThrow(/exit code 3/);
    await expect(createBrowserOpener(join(bin, 'nope'), env)('https://example.com/')).rejects.toThrow(/not installed/);
  });
});

describe('web_open (T8)', () => {
  function rig(o: { failOpen?: boolean } = {}) {
    const dir = tmp('web');
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const opened: string[] = [];
    const steps: string[] = [];
    let paused = false;
    const web = webTools({
      open: async (url) => {
        steps.push('open');
        if (o.failOpen) throw new Error('the browser stopped at once (exit code 1)');
        opened.push(url);
      },
      window: {
        appStarting: async (n) => {
          steps.push(`workspace 2 for ${n}`);
          return { workspace: 2 };
        },
        appFailed: async (n) => void steps.push(`back from ${n}`),
      },
      search: SEARCH,
    });
    const shown: ChatItem[] = [];
    const store = new Store(':memory:');
    const run: Run = async () => ({ stdout: '', code: 0 });
    const actions = new SystemActions({ store, controls: new SystemControls(run), audit, show: (i, isNew) => (isNew ? shown.push(i) : shown.splice(shown.findIndex((x) => x.id === i.id), 1, i)), notice: () => undefined, isPaused: () => paused });
    const tools = new ToolRegistry(audit, { isPaused: () => paused });
    for (const t of systemTools({ controls: new SystemControls(run), actions, extra: web })) tools.register(t);
    const call = (args: unknown, untrustedInContext = false) =>
      tools.execute({ id: 'w', name: 'web_open', arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'open it' });
    const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
    return { tools, call, opened, steps, log, cards, actions, store, shown, setPaused: (p: boolean) => (paused = p) };
  }

  it('opens a link away from the chat, focus first, and audits only its site', async () => {
    const { call, opened, steps, log } = rig();
    const r = await call({ url: 'https://bank.example.com/login?session=private' });
    expect(r).toMatchObject({ ok: true });
    expect(r.content).toBe("bank.example.com is open in Chromium on workspace 2; Super+Shift+H or the AI button in the top bar brings the chat back. You can't see the page. Say it in one short line.");
    expect(steps).toEqual(['workspace 2 for Chromium', 'open']);
    expect(opened).toEqual(['https://bank.example.com/login?session=private']);
    const entry = log().at(-1)!;
    expect(entry).toMatchObject({ kind: 'tool', tool: 'web_open', tier: 'device', decision: 'allowed', ok: true, host: 'bank.example.com', workspace: 2 });
    expect(JSON.stringify(entry)).not.toContain('private');
  });

  it('opens a web search and audits its length, not its words', async () => {
    const { call, opened, log } = rig();
    const r = await call({ search: 'symptoms of something private' });
    expect(r.content).toMatch(/^A web search is open in Chromium \(www.google.com\) on workspace 2/);
    expect(opened).toEqual(['https://www.google.com/search?q=symptoms%20of%20something%20private']);
    const entry = log().at(-1)!;
    expect(entry).toMatchObject({ tool: 'web_open', decision: 'allowed', search: true, chars: 29 });
    expect(JSON.stringify(entry)).not.toContain('private');
  });

  it('refuses bad links and bad arguments, opening nothing', async () => {
    const { call, opened, steps } = rig();
    expect((await call({ url: 'file:///etc/passwd' })).content).toBe('Error: only http:// and https:// links can be opened.');
    expect((await call({ url: 'http://127.0.0.1:7777/' })).content).toBe('Error: links to this computer are not opened.');
    expect((await call({ url: 'https://a.com', search: 'x' })).content).toMatch(/^Error: invalid arguments: give either url or search/);
    expect((await call({})).content).toMatch(/^Error: invalid arguments/);
    expect((await call({ url: 'https://a.com', flags: '--incognito' })).content).toMatch(/^Error: invalid arguments/);
    expect(opened).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('takes the user back to the chat when the browser does not start', async () => {
    const { call, steps } = rig({ failOpen: true });
    const r = await call({ url: 'https://example.com' });
    expect(r).toMatchObject({ ok: false, content: "Error: Chromium didn't open: the browser stopped at once (exit code 1)" });
    expect(steps).toEqual(['workspace 2 for Chromium', 'open', 'back from Chromium']);
  });

  it('while an email or other outside text is in view, a link only gets a confirm card naming its site; the click opens it', async () => {
    const { tools, call, opened, cards, actions, log } = rig();
    expect(tools.specs({ untrustedInContext: true }).map((t) => t.name)).toContain('web_open');
    const r = await call({ url: 'https://evil.example.com/phish?x=1' }, true);
    expect(r.content).toMatch(/card now asks the user to confirm/);
    expect(opened).toEqual([]);
    expect(cards()[0]).toMatchObject({ state: 'pending', title: "Open “evil.example.com” in Chromium? This was asked for while I was reading an email or document, so I'm checking with you first." });
    expect(log().at(-1)).toMatchObject({ tool: 'web_open', decision: 'proposed', untrustedInContext: true, args: { host: 'evil.example.com' } });
    expect(await actions.confirm(cards()[0]!.id, cards()[0]!.hash)).toBe('done');
    expect(opened).toEqual(['https://evil.example.com/phish?x=1']);
  });

  it('a follow-up after an email is hidden reads it again by id, and its link gets a confirm card', async () => {
    const { tools, opened, cards, actions, store, shown } = rig();
    const unsubscribe = 'https://yalecr.example.com/unsubscribe?u=42';
    const reads: string[] = [];
    tools.register({
      def: toolByName('mail_read')!,
      label: 'Reading the email…',
      untrustedOutput: true,
      async handler(args) {
        const id = (args as { id: string }).id;
        reads.push(id);
        return `id: ${id}\n${wrapUntrusted('email', id, sanitize({ text: `Ofertas en cerraduras digitales. Darse de baja: ${unsubscribe}` }))}`;
      },
    });
    const requests: ModelRequest[] = [];
    const done = (r: Pick<ModelResult, 'content'> | Pick<ModelResult, 'toolCalls'>): ModelResult => ({ content: '', toolCalls: [], finishReason: null, usage: null, model: null, provider: null, generationId: null, latencyMs: 0, ttftMs: null, attempts: 1, ...r });
    // A pretend model that does what the note tells it: on the follow-up, read the email again first.
    const replies: ((req: ModelRequest) => ModelResult)[] = [
      () => done({ toolCalls: [{ id: 'r1', name: 'mail_read', arguments: '{"id":"INBOX:7"}' }] }),
      () => done({ content: 'It is a promo. Want me to open the unsubscribe page?' }),
      (req) => {
        const note = req.messages.map((m) => m.content ?? '').find((c) => c.startsWith('(Answering this, I read email INBOX:7.'));
        expect(note).toContain('call mail_read with INBOX:7 again first');
        expect(req.messages.some((m) => /<untrusted source=/.test(m.content ?? ''))).toBe(false);
        return done({ toolCalls: [{ id: 'r2', name: 'mail_read', arguments: '{"id":"INBOX:7"}' }] });
      },
      () => done({ toolCalls: [{ id: 'w1', name: 'web_open', arguments: JSON.stringify({ url: unsubscribe }) }] }),
      () => done({ content: 'A card is up to open it.' }),
    ];
    const model = {
      async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
        requests.push(req);
        const result = replies[requests.length - 1]!(req);
        if (result.content) yield { type: 'text', text: result.content };
        yield { type: 'done', result };
        return result;
      },
    };
    const agent = new Agent({ model, tools, store, userName: 'John', timeZone: 'UTC', emit: (ev) => void (ev.type === 'item' && shown.push(ev.item)) });
    await agent.run('translate the email from YALE', new AbortController().signal);
    await agent.run('open the unsubscribe page', new AbortController().signal);
    expect(requests).toHaveLength(5);
    expect(reads).toEqual(['INBOX:7', 'INBOX:7']);
    // The link came from the email, so nothing opens until the user's click.
    expect(opened).toEqual([]);
    expect(cards()[0]).toMatchObject({ state: 'pending', title: expect.stringContaining('Open “yalecr.example.com” in Chromium?') });
    expect(await actions.confirm(cards()[0]!.id, cards()[0]!.hash)).toBe('done');
    expect(opened).toEqual([unsubscribe]);
  });

  it('a search asked for with outside text in view also waits for a click; paused refuses it', async () => {
    const { call, opened, cards, setPaused } = rig();
    await call({ search: 'how to‮ reset a\npassword' }, true);
    expect(cards()[0]!.title).toMatch(/^Search the web in Chromium for “how to reset a password”\?/);
    expect(opened).toEqual([]);
    setPaused(true);
    expect((await call({ url: 'https://example.com' })).content).toMatch(/paused/);
    expect(opened).toEqual([]);
  });
});

describe('the chat prompt with web_open (T8)', () => {
  it('says the chat opens links, sends them to web_open, overrides old refusals, and never describes a page', async () => {
    const { chatSystemPrompt } = await import('../src/prompts.js');
    const on = chatSystemPrompt({ userName: 'John', now: 'now', web: true });
    expect(on).toContain('You open links and web searches in Chromium');
    expect(on).toContain('links and web searches open with web_open, not open_app');
    expect(on).toMatch(/said you cannot open links.* out of date/);
    expect(on).toMatch(/can't see or read the page/);
    expect(chatSystemPrompt({ userName: 'John', now: 'now' })).not.toContain('web_open');
  });
});

describe('/web (T8)', () => {
  it('parses as a command, and picks a link or a search', async () => {
    const { parseCommand } = await import('../src/commands.js');
    expect(parseCommand('/web bbc.com')).toEqual({ name: 'web', text: 'bbc.com' });
    expect(pickWeb('bbc.com')).toEqual({ args: { url: 'bbc.com' } });
    expect(pickWeb('https://x.org/a')).toEqual({ args: { url: 'https://x.org/a' } });
    expect(pickWeb('file:///etc/passwd')).toEqual({ args: { url: 'file:///etc/passwd' } });
    expect(pickWeb('weather')).toEqual({ args: { search: 'weather' } });
    expect(pickWeb('weather in Istanbul')).toEqual({ args: { search: 'weather in Istanbul' } });
    expect(pickWeb('  ')).toMatchObject({ error: expect.stringMatching(/Type \/web/) });
  });

  it('opens through the registry without the model, audits it, and says what is open', async () => {
    const { Shell } = await import('../src/shell.js');
    const dir = tmp('webshell');
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const opened: string[] = [];
    const tools = new ToolRegistry(audit);
    for (const t of webTools({ open: async (u) => void opened.push(u), window: { appStarting: async () => undefined, appFailed: async () => undefined }, search: SEARCH })) tools.register(t);
    const requests: unknown[] = [];
    const store = new Store(':memory:');
    const shell = new Shell({
      store,
      model: { stream: () => { requests.push(1); throw new Error('the model is never called'); } },
      tools,
      audit,
      userName: 'John',
      timeZone: 'Europe/Istanbul',
      modelName: 'fake',
      costCapUsd: 2,
      readBattery: async () => null,
      readWifi: async () => null,
    });
    await shell.handle({ type: 'send', text: '/web github.com' });
    expect(opened).toEqual(['https://github.com/']);
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'notice', text: 'github.com is open in Chromium.' });
    await shell.handle({ type: 'send', text: '/web cheap flights to Ankara' });
    expect(opened.at(-1)).toBe('https://www.google.com/search?q=cheap%20flights%20to%20Ankara');
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'notice', text: 'A web search is open in Chromium (www.google.com).' });
    await shell.handle({ type: 'send', text: '/web javascript:alert(1)' });
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'notice', text: 'only http:// and https:// links can be opened.' });
    expect(opened).toHaveLength(2);
    expect(requests).toHaveLength(0);
    const log = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.filter((e) => e.tool === 'web_open').map((e) => e.args)).toEqual([{ host: 'github.com' }, { search: true, chars: 23 }, { host: null }]);
  });
});
