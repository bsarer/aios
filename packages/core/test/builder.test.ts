import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { APP_CSP, AppBuilder, type BuilderConfig, appName, appSlug, claudeArgs, stepText, withCsp } from '../src/apps/builder.js';
import { scanApps } from '../src/apps/desktop.js';
import { BuildLog } from '../src/apps/history.js';
import { buildAppTool, buildStatusTool, builtAppOpener, duration } from '../src/apps/tools.js';
import { AuditLog } from '../src/audit.js';
import { Store } from '../src/store.js';
import { SystemActions } from '../src/system/actions.js';
import { SystemControls } from '../src/system/controls.js';
import { ToolRegistry } from '../src/tools/registry.js';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `aios-${name}-`));
const CONFIG: BuilderConfig = { command: 'claude', maxBudgetUsd: 2, timeoutMinutes: 1 };

describe('app names', () => {
  it('turns a name into a launcher name and a folder name', () => {
    expect([appName('Pomodoro'), appSlug('Pomodoro')]).toEqual(['Pomodoro', 'pomodoro']);
    expect(appSlug('Café Timer 2!')).toBe('cafe-timer-2');
    expect(appName('  My\u0000 Notes\n ')).toBe('My Notes');
    for (const bad of ['', '!!!', '../..', '日本']) expect(appName(bad)).toBeNull();
    expect(appSlug('a'.repeat(80))).toHaveLength(40);
  });
});

describe('the policy that keeps a built app offline', () => {
  it('goes first in <head>, replaces any other policy, and is stable', () => {
    const html = '<!doctype html><html><head><title>T</title><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><script>x()</script></body></html>';
    const out = withCsp(html);
    expect(out.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`)).toBe(true);
    expect(out).not.toContain('default-src *');
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(withCsp(out)).toBe(out);
    expect(APP_CSP).toContain("connect-src 'none'");
    expect(APP_CSP).toContain("default-src 'none'");
  });

  it('adds a <head> when there is none', () => {
    expect(withCsp('<!DOCTYPE html><p>hi</p>')).toMatch(/^<!DOCTYPE html><head><meta http-equiv="Content-Security-Policy"[^>]*><!-- AI OS[^>]*--><\/head><p>hi<\/p>$/);
    expect(withCsp('<p>hi</p>')).toMatch(/^<head><meta /);
  });
});

describe('how Claude Code is run', () => {
  it('has no shell or web tools, edits only its folder, asks nothing and has limits', () => {
    const args = claudeArgs(CONFIG, 'Pomodoro');
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('-p');
    expect(args).toContain('--restricted');
    expect(after('--tools')).toBe('Read,Write,Edit,Glob,Grep');
    expect(after('--permission-mode')).toBe('acceptEdits');
    expect(after('--permission-prompts')).toBe('none');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(after('--max-budget-usd')).toBe('2');
    expect(args).not.toContain('--model');
    expect(args.join(' ')).not.toMatch(/Bash|WebFetch|WebSearch|dangerously|bypassPermissions/);
    // The request goes on stdin, so nothing the user typed is ever an argument.
    expect(args.at(-2)).toBe('--append-system-prompt');
    expect(claudeArgs({ ...CONFIG, model: 'some-model' }, 'X')).toEqual(expect.arrayContaining(['--model', 'some-model']));
  });
});

/** A pretend `claude` and `chromium` on PATH. FAKE_CLAUDE picks what claude does. */
function rig(mode: 'ok' | 'error' | 'noindex' | 'hang' | 'slow' = 'ok', auth = 'claude.ai') {
  const dir = tmp('builder');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    'claude',
    [
      `S="${state}"`,
      'if [ "$1" = auth ]; then echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"$FAKE_AUTH\\"}"; [ "$FAKE_AUTH" = none ] && exit 1; exit 0; fi',
      'pwd > "$S/cwd"',
      'printf "%s\\n" "$@" > "$S/args"',
      'cat > "$S/stdin"',
      'case "$FAKE_CLAUDE" in',
      `  hang) sleep 30 ;;`,
      `  slow) echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"index.html"}}]}}'; sleep 30 ;;`,
      `  error) echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"Spending cap reached","total_cost_usd":2.01}'; exit 1 ;;`,
      `  noindex) echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.1}' ;;`,
      `  *) printf '<!doctype html><html><head><title>Pomodoro</title></head><body><script src="app.js"></script></body></html>' > index.html`,
      `     echo 'setInterval(tick, 1000)' > app.js`,
      `     echo '{"type":"system","subtype":"init"}'`,
      `     echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me write it."},{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"'"$PWD"'/index.html","content":"..."}}]}}'`,
      `     echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"'"$PWD"'/app.js"}}]}}'`,
      `     echo '{"type":"result","subtype":"success","is_error":false,"result":"A 25-minute focus timer with 5-minute breaks.","total_cost_usd":0.42}' ;;`,
      'esac',
    ].join('\n'),
  );
  script('chromium', 'exit 0');
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data'), XDG_DATA_DIRS: join(dir, 'share'), PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE: mode, FAKE_AUTH: auth };
  const builder = new AppBuilder({ config: { ...CONFIG, timeoutMinutes: mode === 'hang' ? 0.005 : 1 }, env });
  return { dir, state, env, builder, read: (f: string) => readFileSync(join(state, f), 'utf8') };
}

describe('building an app', () => {
  it('runs Claude Code in the app folder with the request on stdin, locks the app offline and adds it to the apps', async () => {
    const r = rig();
    const result = await r.builder.build({ name: 'Pomodoro', request: 'a pomodoro timer; 25 minutes work, 5 break' });
    expect(result).toEqual({ slug: 'pomodoro', name: 'Pomodoro', created: true, summary: 'A 25-minute focus timer with 5-minute breaks.', costUsd: 0.42, desktopId: 'aios-app-pomodoro.desktop' });
    const appDir = join(r.env.XDG_DATA_HOME, 'aios', 'apps', 'pomodoro');
    expect(r.read('cwd').trim()).toBe(appDir);
    expect(r.read('stdin')).toBe('a pomodoro timer; 25 minutes work, 5 break');
    expect(r.read('args')).toContain('--restricted');
    expect(r.read('args')).not.toContain('pomodoro timer');
    expect(readFileSync(join(appDir, 'index.html'), 'utf8')).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    const desktop = readFileSync(join(r.env.XDG_DATA_HOME, 'applications', 'aios-app-pomodoro.desktop'), 'utf8');
    expect(desktop).toContain('Name=Pomodoro\n');
    expect(desktop).toContain(
      `Exec=chromium --user-data-dir=${join(r.env.XDG_DATA_HOME, 'aios', 'app-profiles', 'pomodoro')} --class=aios-app-pomodoro --no-first-run --no-default-browser-check --app=file://${appDir}/index.html\n`,
    );
    // S3 lists it like any installed app.
    expect((await scanApps({ env: r.env })).map((a) => [a.id, a.name])).toContainEqual(['aios-app-pomodoro.desktop', 'Pomodoro']);
    expect(r.builder.exists('pomodoro')).toBe(true);
    expect((await r.builder.build({ name: 'pomodoro', request: 'longer breaks' })).created).toBe(false);
  });

  it("says why when Claude Code fails, writes no app, hangs, or another build is running", async () => {
    await expect(rig('error').builder.build({ name: 'Notes', request: 'notes' })).rejects.toThrow('it reached its $2 spending cap before finishing');
    const none = rig('noindex');
    await expect(none.builder.build({ name: 'Notes', request: 'notes' })).rejects.toThrow("without writing index.html");
    expect(existsSync(join(none.env.XDG_DATA_HOME, 'applications', 'aios-app-notes.desktop'))).toBe(false);
    await expect(rig('hang').builder.build({ name: 'Notes', request: 'notes' })).rejects.toThrow('took longer than');
    const busy = rig('hang');
    const first = busy.builder.build({ name: 'A', request: 'a' });
    await expect(busy.builder.build({ name: 'B', request: 'b' })).rejects.toThrow('another app is being built');
    await first.catch(() => undefined);
    await expect(busy.builder.build({ name: '!!!', request: 'x' })).rejects.toThrow('not a usable app name');
  });

  it('says what is missing before offering a build', async () => {
    const r = rig();
    expect(await r.builder.unavailable()).toBeNull();
    const noClaude = new AppBuilder({ config: { ...CONFIG, command: 'no-such-claude' }, env: r.env });
    expect(await noClaude.unavailable()).toMatch(/Claude Code isn't installed where AI OS can find it/);
  });
});

describe('progress lines', () => {
  it('says what Claude Code is doing in a few words', () => {
    expect(stepText('Write', '/home/x/apps/p/index.html')).toBe('Writing index.html');
    expect(stepText('Edit', 'app.js')).toBe('Editing app.js');
    expect(stepText('Read', 'style.css')).toBe('Reading style.css');
    expect(stepText('Glob')).toBe('Looking through the files');
    expect(stepText('Write', 'evil\u0000name\n.js')).toBe('Writing evilname.js');
    expect(stepText('Something')).toBe('Working');
    expect([duration(20_000), duration(180_000), duration(125 * 60_000)]).toEqual(['less than a minute', '3 min', '2 h 5 min']);
  });

  it('reads the steps from the stream, and how Claude Code is signed in', async () => {
    const r = rig();
    const steps: string[] = [];
    await r.builder.build({ name: 'Pomodoro', request: 'a timer' }, { onStep: (s) => steps.push(s), maxBudgetUsd: 1 });
    expect(steps).toEqual(['Writing index.html', 'Editing app.js']);
    expect(r.read('args')).toContain('--max-budget-usd\n1\n');
    expect(await r.builder.login()).toBe('plan');
    expect(await rig('ok', 'api_key').builder.login()).toBe('api');
    expect(await rig('ok', 'none').builder.login()).toBe('none');
    expect(await new AppBuilder({ config: { ...CONFIG, command: 'no-such-claude' }, env: r.env }).login()).toBe('unknown');
  });

  it('says when the spending cap stopped it, with what it spent', async () => {
    const err = await rig('error').builder.build({ name: 'Notes', request: 'notes' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'it reached its $2 spending cap before finishing', costUsd: 2.01 });
  });
});

describe('build_app', () => {
  function toolRig(mode: Parameters<typeof rig>[0] = 'ok', auth = 'claude.ai') {
    const r = rig(mode, auth);
    const dir = tmp('buildtool');
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const shown: ChatItem[] = [];
    const history: ChatItem[] = [];
    const posted: ChatItem[] = [];
    const notified: [string, string][] = [];
    const store = new Store(':memory:');
    let now = 1_000_000;
    const clock = () => now;
    const actions = new SystemActions({
      store,
      controls: new SystemControls(async () => ({ stdout: '', code: 0 })),
      audit,
      show: (i, isNew) => {
        history.push(i);
        if (isNew) shown.push(i);
        else shown.splice(shown.findIndex((x) => x.id === i.id), 1, i);
      },
      notice: () => undefined,
      clock,
    });
    const log = new BuildLog(store);
    const tools = new ToolRegistry(audit)
      .register(
        buildAppTool({
          builder: r.builder,
          actions,
          scan: () => scanApps({ env: r.env }),
          log,
          budgets: [1, 2, 5],
          post: (i) => posted.push(i),
          notify: (title, body) => notified.push([title, body]),
          clock,
        }),
      )
      .register(buildStatusTool({ log, actions, clock }));
    const call = (args: unknown, untrustedInContext = false) =>
      tools.execute({ id: 'b', name: 'build_app', arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'make it' });
    const status = async () => (await tools.execute({ id: 's', name: 'build_status', arguments: '{}' }, { signal: new AbortController().signal, untrustedInContext: false, userText: 'how is it going' })).content;
    const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
    const auditLog = () => readFileSync(auditPath, 'utf8');
    const tick = (ms: number) => {
      now += ms;
    };
    return { r, tools, call, status, cards, actions, history, posted, notified, auditLog, log, tick, audit, auditPath };
  }

  it('only shows a Build card with caps to pick; the click builds it, and asking again offers to change it', async () => {
    const t = toolRig();
    const res = await t.call({ name: 'Pomodoro', request: 'a pomodoro timer with my secret plan' });
    expect(res.content).toMatch(/Tell them in one short line to click Build on the card to start/);
    expect(res.content).not.toMatch(/few minutes/);
    expect(t.r.builder.exists('pomodoro')).toBe(false);
    const card = t.cards()[0]!;
    expect(card).toMatchObject({ state: 'pending', confirm: 'Build', title: expect.stringContaining('Build a new app, “Pomodoro”?') });
    expect(card.title).not.toMatch(/few minutes/);
    expect(card.choices).toEqual([
      { label: 'Build · up to $1', value: '1' },
      { label: 'Build · up to $2', value: '2' },
      { label: 'Build · up to $5', value: '5' },
    ]);
    expect(card.note).toMatch(/^There are no past new builds to estimate the cost from yet\. It stops when it reaches the cap you pick\. You're signed in with a Claude plan/);
    expect(await t.actions.confirm(card.id, card.hash, '2')).toBe('done');
    expect(t.r.read('args')).toContain('--max-budget-usd\n2\n');
    expect(t.cards()[0]).toMatchObject({ state: 'done', result: 'Built “Pomodoro” in less than a minute. A 25-minute focus timer with 5-minute breaks. About $0.42 at API prices.' });
    expect(t.cards()[0]!.progress).toBeUndefined();
    // The request is the user's own words: audits record its length, never the text.
    expect(t.auditLog()).not.toContain('secret plan');
    expect(t.auditLog()).toContain('"requestChars":36');
    expect(t.auditLog()).toContain('"costUsd":0.42');
    expect(t.auditLog()).toContain('"budgetUsd":2');

    await t.call({ name: 'Pomodoro', request: 'make the breaks 10 minutes' });
    expect(t.cards()[1]).toMatchObject({ confirm: 'Change', title: expect.stringContaining('Change the app “Pomodoro”?') });
    expect(t.cards()[1]!.note).toMatch(/^There are no past changes to estimate/);
    await t.call({ name: 'Timer', request: 'a timer' });
    expect(t.cards()[2]!.note).toMatch(/^Similar new builds cost about \$0\.42 \(median of 1\)\./);
  });

  it('shows each step on the card while it runs, then posts a message with Open and a desktop notification', async () => {
    const t = toolRig();
    await t.call({ name: 'Pomodoro', request: 'a timer' });
    const card = t.cards()[0]!;
    await t.actions.confirm(card.id, card.hash, '1');
    const steps = t.history.flatMap((i) => (i.kind === 'action' && i.progress ? [i.progress.step] : []));
    expect(steps).toEqual(['Starting Claude Code', 'Writing index.html…', 'Editing app.js…']);
    expect(t.history.find((i) => i.kind === 'action' && i.progress)).toMatchObject({ state: 'running', progress: { startedAt: 1_000_000, capUsd: 1 } });
    expect(t.posted).toEqual([
      { kind: 'build_result', id: expect.any(String), actionId: card.id, ok: true, text: '“Pomodoro” is ready. A 25-minute focus timer with 5-minute breaks.', at: 1_000_000 },
    ]);
    expect(t.notified).toEqual([['Pomodoro is ready', 'Open it from the chat, or ask AI OS to open it.']]);
    expect(t.actions.builtApp(card.id)).toEqual({ name: 'Pomodoro', slug: 'pomodoro' });
  });

  it('tells the chat about a failed build too, and records what it spent', async () => {
    const t = toolRig('error');
    await t.call({ name: 'Notes', request: 'notes' });
    const card = t.cards()[0]!;
    expect(await t.actions.confirm(card.id, card.hash, '2')).toBe('failed');
    expect(t.cards()[0]).toMatchObject({ state: 'failed', result: "Didn't work: it reached its $2 spending cap before finishing." });
    expect(t.posted[0]).toMatchObject({ kind: 'build_result', ok: false, text: "Building “Notes” didn't work: it reached its $2 spending cap before finishing." });
    expect(t.notified).toEqual([["Building Notes didn't work", 'it reached its $2 spending cap before finishing']]);
    expect(t.log.recent()[0]).toMatchObject({ state: 'failed', costUsd: 2.01 });
    expect(t.actions.builtApp(card.id)).toBeNull();
    expect(await t.status()).toMatch(/“Notes”: failed just now: it reached its \$2 spending cap before finishing\./);
  });

  it('can be stopped from the card, and build_status says where it is', async () => {
    const t = toolRig('slow');
    expect(await t.status()).toBe('No apps have been built yet, and no Build card is waiting.');
    await t.call({ name: 'Pomodoro', request: 'a timer' });
    t.tick(120_000);
    expect(await t.status()).toBe('App builds, newest first:\n- “Pomodoro”: waiting for the user to click Build on its card (shown 2 min ago). Nothing has started.');
    const card = t.cards()[0]!;
    const run = t.actions.confirm(card.id, card.hash, '5');
    await expect.poll(() => t.cards()[0]!.progress?.step).toBe('Writing index.html…');
    t.tick(180_000);
    expect(await t.status()).toBe('App builds, newest first:\n- “Pomodoro”: building for 3 min; now: Writing index.html. It stops at $5 at most.');
    expect(t.actions.stop('nope')).toBe(false);
    expect(t.actions.stop(card.id)).toBe(true);
    expect(await run).toBe('failed');
    expect(t.cards()[0]).toMatchObject({ state: 'cancelled', result: "Stopped after 3 min. The app wasn't added." });
    expect(t.posted).toEqual([]);
    expect(t.notified).toEqual([]);
    expect(t.auditLog()).toContain('"event":"action_stopped"');
    expect(await t.status()).toMatch(/“Pomodoro”: stopped by the user just now, after 3 min\./);
    expect(t.actions.stop(card.id)).toBe(false);
  });

  it('runs only with a cap the card offered', async () => {
    const t = toolRig();
    await t.call({ name: 'Notes', request: 'notes' });
    const card = t.cards()[0]!;
    expect(await t.actions.confirm(card.id, card.hash)).toBe('refused');
    expect(await t.actions.confirm(card.id, card.hash, '50')).toBe('refused');
    expect(t.cards()[0]!.state).toBe('pending');
    expect(t.auditLog()).toContain('not one of the choices on the card');
    expect(existsSync(t.r.state + '/args')).toBe(false);
  });

  it('says to sign in first when Claude Code is not signed in, and what API-key dollars mean', async () => {
    expect((await toolRig('ok', 'none').call({ name: 'Notes', request: 'notes' })).content).toMatch(/^Error: Claude Code is installed but not signed in/);
    const api = toolRig('ok', 'api_key');
    await api.call({ name: 'Notes', request: 'notes' });
    expect(api.cards()[0]!.note).toMatch(/your API account is billed for the real use\.$/);
  });

  it('is never offered or run while an email is in view, and a model call never builds', async () => {
    const t = toolRig();
    expect(t.tools.specs({ untrustedInContext: true }).map((s) => s.name)).not.toContain('build_app');
    expect(t.tools.specs().map((s) => s.name)).toContain('build_app');
    const res = await t.call({ name: 'Pomodoro', request: 'a timer' }, true);
    expect(res).toMatchObject({ ok: false, content: expect.stringMatching(/cannot run while text from an email/) });
    expect(t.cards()).toEqual([]);
    expect(existsSync(t.r.state + '/args')).toBe(false);
    for (const args of [{ name: 'X', request: 'x', command: 'rm -rf ~' }, { name: '', request: 'x' }, { name: 'X', request: 'y'.repeat(2001) }]) {
      expect((await t.call(args)).content).toMatch(/^Error: invalid arguments/);
    }
    expect((await t.call({ name: '!!!', request: 'x' })).content).toMatch(/can't be an app name/);
  });

  it('picks another name when an installed app already has it', async () => {
    const t = toolRig();
    const apps = join(t.r.env.XDG_DATA_HOME, 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'org.gnome.Calculator.desktop'), '[Desktop Entry]\nType=Application\nName=Calculator\nExec=gnome-calculator\n');
    expect((await t.call({ name: 'calculator!', request: 'a calculator' })).content).toBe('Error: “Calculator” is already the name of an installed app (id: org.gnome.Calculator). Pick a different name, e.g. "My calculator!", or ask the user for one.');
    expect(t.cards()).toEqual([]);
    // Its own earlier build is not a clash: that is a change.
    await t.call({ name: 'Pomodoro', request: 'a timer' });
    await t.actions.confirm(t.cards()[0]!.id, t.cards()[0]!.hash, '1');
    expect((await t.call({ name: 'Pomodoro', request: 'longer breaks' })).content).toMatch(/confirm changing “Pomodoro”/);
  });

  it("a card can't be confirmed with the wrong hash or twice", async () => {
    const t = toolRig();
    await t.call({ name: 'Notes', request: 'notes' });
    const card = t.cards()[0]!;
    expect(await t.actions.confirm(card.id, 'f'.repeat(64), '1')).toBe('refused');
    expect(await t.actions.confirm(card.id, card.hash, '1')).toBe('done');
    expect(await t.actions.confirm(card.id, card.hash, '1')).toBe('refused');
  });

  it('Open starts only the app a finished Build card built, and is audited', async () => {
    const t = toolRig();
    const launched: string[] = [];
    const notices: string[] = [];
    const window = { appStarting: async () => undefined, appFailed: async () => undefined };
    const open = builtAppOpener({ actions: t.actions, launch: async (id) => void launched.push(id), window, audit: t.audit, notice: (n) => notices.push(n) });
    await t.call({ name: 'Notes', request: 'notes' });
    const card = t.cards()[0]!;
    await open(card.id);
    expect(launched).toEqual([]);
    await t.actions.confirm(card.id, card.hash, '1');
    await open(card.id);
    await open('action-unknown');
    expect(launched).toEqual(['aios-app-notes.desktop']);
    expect(t.auditLog()).toContain('"tool":"open_app","tier":"device","via":"click","actionId":"' + card.id + '","decision":"approved","app":"aios-app-notes.desktop"');
    expect(t.auditLog().match(/not a finished build/g)).toHaveLength(2);
    const failing = builtAppOpener({ actions: t.actions, launch: async () => Promise.reject(new Error('gtk-launch failed')), window, audit: t.audit, notice: (n) => notices.push(n) });
    await failing(card.id);
    expect(notices).toEqual(["Notes didn't start: gtk-launch failed"]);
  });
});

describe('build history', () => {
  it('estimates from the median of finished builds of the same kind', () => {
    const log = new BuildLog(new Store(':memory:'));
    expect(log.estimate(true)).toBeNull();
    const add = (id: string, created: boolean, state: 'done' | 'failed', cost: number | null, at: number) => {
      log.start({ id, name: id, slug: id, created, budgetUsd: 2, at });
      log.finish(id, { state, costUsd: cost, at: at + 1 });
    };
    add('a', true, 'done', 1.0, 1);
    add('b', true, 'done', 3.0, 2);
    add('c', true, 'done', 1.4, 3);
    add('d', true, 'failed', 9, 4);
    add('e', false, 'done', 0.3, 5);
    expect(log.estimate(true)).toEqual({ medianUsd: 1.4, count: 3 });
    add('f', true, 'done', 2.0, 6);
    expect(log.estimate(true)).toEqual({ medianUsd: 1.7, count: 4 });
    expect(log.estimate(false)).toEqual({ medianUsd: 0.3, count: 1 });
    log.start({ id: 'g', name: 'g', slug: 'g', created: true, budgetUsd: 2, at: 7 });
    log.recover(8);
    expect(log.get('g')).toMatchObject({ state: 'failed', error: 'AI OS stopped while it was building', finishedAt: 8 });
  });
});
