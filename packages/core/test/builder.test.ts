import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { APP_CSP, AppBuilder, type BuilderConfig, appName, appSlug, claudeArgs, withCsp } from '../src/apps/builder.js';
import { scanApps } from '../src/apps/desktop.js';
import { buildAppTool } from '../src/apps/tools.js';
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
function rig(mode: 'ok' | 'error' | 'noindex' | 'hang' = 'ok') {
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
      'pwd > "$S/cwd"',
      'printf "%s\\n" "$@" > "$S/args"',
      'cat > "$S/stdin"',
      'case "$FAKE_CLAUDE" in',
      `  hang) sleep 30 ;;`,
      `  error) echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"Spending cap reached","total_cost_usd":2.01}'; exit 1 ;;`,
      `  noindex) echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.1}' ;;`,
      `  *) printf '<!doctype html><html><head><title>Pomodoro</title></head><body><script src="app.js"></script></body></html>' > index.html`,
      `     echo 'setInterval(tick, 1000)' > app.js`,
      `     echo '{"type":"system","subtype":"init"}'`,
      `     echo '{"type":"result","subtype":"success","is_error":false,"result":"A 25-minute focus timer with 5-minute breaks.","total_cost_usd":0.42}' ;;`,
      'esac',
    ].join('\n'),
  );
  script('chromium', 'exit 0');
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data'), XDG_DATA_DIRS: join(dir, 'share'), PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE: mode };
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
    await expect(rig('error').builder.build({ name: 'Notes', request: 'notes' })).rejects.toThrow('Claude Code stopped: Spending cap reached');
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

describe('build_app', () => {
  function toolRig() {
    const r = rig();
    const dir = tmp('buildtool');
    const auditPath = join(dir, 'audit.jsonl');
    const audit = new AuditLog(auditPath);
    const shown: ChatItem[] = [];
    const actions = new SystemActions({
      store: new Store(':memory:'),
      controls: new SystemControls(async () => ({ stdout: '', code: 0 })),
      audit,
      show: (i, isNew) => (isNew ? shown.push(i) : shown.splice(shown.findIndex((x) => x.id === i.id), 1, i)),
      notice: () => undefined,
    });
    const tools = new ToolRegistry(audit).register(buildAppTool({ builder: r.builder, actions }));
    const call = (args: unknown, untrustedInContext = false) =>
      tools.execute({ id: 'b', name: 'build_app', arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'make it' });
    const cards = () => shown.filter((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action');
    const log = () => readFileSync(auditPath, 'utf8');
    return { r, tools, call, cards, actions, log };
  }

  it('only shows a Build card; the click builds it, and asking again offers to change it', async () => {
    const t = toolRig();
    const res = await t.call({ name: 'Pomodoro', request: 'a pomodoro timer with my secret plan' });
    expect(res.content).toMatch(/A card now asks the user to confirm building “Pomodoro”/);
    expect(t.r.builder.exists('pomodoro')).toBe(false);
    const card = t.cards()[0]!;
    expect(card).toMatchObject({ state: 'pending', confirm: 'Build', title: expect.stringContaining('Build a new app, “Pomodoro”?') });
    expect(await t.actions.confirm(card.id, card.hash)).toBe('done');
    expect(t.cards()[0]).toMatchObject({ state: 'done', result: 'Built “Pomodoro”. A 25-minute focus timer with 5-minute breaks. It cost $0.42. Say “open Pomodoro” to start it.' });
    // The request is the user's own words: audits record its length, never the text.
    expect(t.log()).not.toContain('secret plan');
    expect(t.log()).toContain('"requestChars":36');
    expect(t.log()).toContain('"costUsd":0.42');

    await t.call({ name: 'Pomodoro', request: 'make the breaks 10 minutes' });
    expect(t.cards()[1]).toMatchObject({ confirm: 'Change', title: expect.stringContaining('Change the app “Pomodoro”?') });
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

  it("a card can't be confirmed with the wrong hash or twice", async () => {
    const t = toolRig();
    await t.call({ name: 'Notes', request: 'notes' });
    const card = t.cards()[0]!;
    expect(await t.actions.confirm(card.id, 'f'.repeat(64))).toBe('refused');
    expect(await t.actions.confirm(card.id, card.hash)).toBe('done');
    expect(await t.actions.confirm(card.id, card.hash)).toBe('refused');
  });
});
