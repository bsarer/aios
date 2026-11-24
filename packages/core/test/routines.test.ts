import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNATTENDED_NOTE } from '../src/agent.js';
import { AuditLog } from '../src/audit.js';
import { parseCommand } from '../src/commands.js';
import type { Delta, ModelRequest, ModelResult, ToolCall } from '../src/model.js';
import { rootsReaching, lastSlot, nextSlot, normalizePhrase, parseRoutine, parseSchedule, ROUTINE_TURN_PREFIX, RoutineFolder, scheduleText, STARTER_ROUTINES } from '../src/routines/routines.js';
import { RoutineScheduler } from '../src/routines/scheduler.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ALPHA_TOOLS, toolByName } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const TZ = 'Europe/Istanbul';
// Friday 27 November 2026, 16:05 in Istanbul (UTC+3).
const FRI_1605 = Date.parse('2026-11-27T13:05:00Z');

const WEEKLY = `---
name: Weekly review
say: Weekly review, review my week
schedule: fri 16:00
---
Look at my week.
`;

const tmp = () => mkdtempSync(join(tmpdir(), 'astra-routines-'));

describe('routine files', () => {
  it('reads the header and the instructions', () => {
    const r = parseRoutine(WEEKLY, 'weekly-review');
    expect(r).toEqual({ ok: true, routine: { slug: 'weekly-review', name: 'Weekly review', say: ['weekly review', 'review my week'], schedule: { days: [5], time: '16:00' }, body: 'Look at my week.' } });
  });

  it('refuses what it does not understand, saying why', () => {
    const bad = (text: string, slug = 'x') => {
      const r = parseRoutine(text, slug);
      return r.ok ? '' : r.error;
    };
    expect(bad('no header')).toMatch(/header/);
    expect(bad('---\nname: A\nsay: hello there\ntools: all\n---\nDo it.')).toMatch(/unknown tools/);
    expect(bad('---\nname: A\nsay: hello there\n---\n')).toMatch(/no instructions/);
    expect(bad('---\nname: A\nschedule: someday 16:00\n---\nDo it.')).toMatch(/someday/);
    expect(bad('---\nname: A\nsay: /pause\n---\nDo it.')).toMatch(/can't start with \//);
    expect(bad('---\nname: A\n---\nDo it.')).toMatch(/say phrase or a schedule/);
    expect(bad('---\nname: A\nname: B\nsay: hello there\n---\nDo it.')).toMatch(/twice/);
    expect(bad(`---\nname: A\nsay: hello there\n---\n${'x'.repeat(4001)}`)).toMatch(/longer than/);
    expect(bad(WEEKLY, '../evil')).toMatch(/file name/);
    expect(bad('---\nname: A‮\nsay: hello there\n---\nDo it.')).toMatch(/control/);
  });

  it('reads schedules', () => {
    expect(parseSchedule('fri 16:00')).toEqual({ days: [5], time: '16:00' });
    expect(parseSchedule('Weekdays 8:30')).toEqual({ days: [1, 2, 3, 4, 5], time: '08:30' });
    expect(parseSchedule('mon,wed 09:00')).toEqual({ days: [1, 3], time: '09:00' });
    expect(parseSchedule('sunday 21:15')).toEqual({ days: [0], time: '21:15' });
    expect(parseSchedule('daily 18:00')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '18:00' });
    expect(parseSchedule('fri 25:00')).toHaveProperty('error');
    expect(parseSchedule('16:00')).toHaveProperty('error');
    expect(scheduleText({ days: [1, 2, 3, 4, 5], time: '08:30' })).toBe('weekdays 08:30');
    expect(scheduleText({ days: [1, 3], time: '09:00' })).toBe('mon,wed 09:00');
  });

  it('works out the last and next times in the user’s time zone', () => {
    const s = { days: [5], time: '16:00' };
    expect(lastSlot(s, FRI_1605, TZ)).toBe(Date.parse('2026-11-27T13:00:00Z'));
    expect(lastSlot(s, Date.parse('2026-11-27T12:55:00Z'), TZ)).toBe(Date.parse('2026-11-20T13:00:00Z'));
    expect(nextSlot(s, FRI_1605, TZ)).toBe(Date.parse('2026-12-04T13:00:00Z'));
  });

  it('matches only a whole message, not words inside one', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'weekly-review.md'), WEEKLY);
    const f = new RoutineFolder(dir);
    expect(f.match('Weekly review.')?.slug).toBe('weekly-review');
    expect(f.match('  review   my WEEK! ')?.slug).toBe('weekly-review');
    expect(f.match('please run weekly review')).toBeNull();
    expect(f.match('weekly review of the budget')).toBeNull();
    expect(f.byName('weekly-review')?.slug).toBe('weekly-review');
    expect(f.byName('Weekly Review')?.slug).toBe('weekly-review');
    expect(normalizePhrase('“Focus time!”')).toBe('focus time');
  });

  it('never reads links, hidden or big files, and refuses a phrase two routines share', () => {
    const dir = tmp();
    const outside = join(tmp(), 'elsewhere.md');
    writeFileSync(outside, WEEKLY);
    writeFileSync(join(dir, 'weekly-review.md'), WEEKLY);
    writeFileSync(join(dir, 'z-copy.md'), WEEKLY.replace('Weekly review\n', 'Copy\n'));
    writeFileSync(join(dir, '.hidden.md'), WEEKLY);
    writeFileSync(join(dir, 'big.md'), `${WEEKLY}${'x'.repeat(17 * 1024)}`);
    symlinkSync(outside, join(dir, 'linked.md'));
    const { routines, problems } = new RoutineFolder(dir).load();
    expect(routines.map((r) => r.slug)).toEqual(['weekly-review']);
    expect(problems.map((p) => p.file).sort()).toEqual(['big.md', 'linked.md', 'z-copy.md']);
  });

  it('copies the starters in once, and they all read', () => {
    const dir = join(tmp(), 'routines');
    const f = new RoutineFolder(dir);
    expect(f.installStarters()).toBe(true);
    const { routines, problems } = f.load();
    expect(problems).toEqual([]);
    expect(routines.map((r) => r.slug).sort()).toEqual(Object.keys(STARTER_ROUTINES).sort());
    rmSync(join(dir, 'focus-time.md'));
    expect(f.installStarters()).toBe(false);
    expect(readdirSync(dir)).not.toContain('focus-time.md');
  });

  it('stays out of reach of the file tools', () => {
    const dir = '/home/j/.config/astra/routines';
    expect(rootsReaching(dir, ['/home/j/Documents', '/home/j', '/home/j/Downloads'])).toEqual([]);
    expect(rootsReaching(dir, ['/home/j/.config'])).toEqual(['/home/j/.config']);
    expect(rootsReaching(dir, ['/home/j/.config/astra', '/home/j/.config/astra/routines', 'relative'])).toEqual(['/home/j/.config/astra', '/home/j/.config/astra/routines']);
  });

  it('has no tool that runs a routine; showing is read tier and changing is write tier (a card)', () => {
    expect(ALPHA_TOOLS.filter((t) => /routine/i.test(t.name)).map((t) => [t.name, t.tier])).toEqual([
      ['routine_show', 'read'],
      ['routine_change', 'write'],
    ]);
    expect(parseCommand('/run weekly review')).toEqual({ name: 'run', text: 'weekly review' });
    expect(parseCommand('/routines')).toEqual({ name: 'routines', text: '' });
    expect(parseCommand('/routines focus time')).toEqual({ name: 'routines', text: 'focus time' });
  });
});

// ── Running ──

const result = (over: Partial<ModelResult> = {}): ModelResult => ({
  content: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: null,
  model: 'fake',
  provider: null,
  generationId: null,
  latencyMs: 1,
  ttftMs: 1,
  attempts: 1,
  ...over,
});

function fakeModel(turns: { text?: string; toolCalls?: ToolCall[] }[]) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const t = turns.shift() ?? { text: 'Done.' };
      if (t.text) yield { type: 'text', text: t.text };
      const r = result({ content: t.text ?? '', toolCalls: t.toolCalls ?? [] });
      yield { type: 'done', result: r };
      return r;
    },
  };
}

function setup(turns: { text?: string; toolCalls?: ToolCall[] }[] = []) {
  const dir = tmp();
  const routinesDir = join(dir, 'routines');
  mkdirSync(routinesDir);
  writeFileSync(join(routinesDir, 'weekly-review.md'), WEEKLY);
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const store = new Store(':memory:');
  const changed: string[] = [];
  const cards: string[] = [];
  const tools = new ToolRegistry(audit)
    // A device change with a confirm card, like volume_set.
    .register({
      def: toolByName('volume_set')!,
      label: 'Setting the volume…',
      handler: async () => {
        changed.push('volume');
        return 'Volume set.';
      },
      confirmWhenUntrusted: async () => {
        cards.push('volume');
        return 'A card asks the user.';
      },
    })
    // A device change with no card, like todo_add.
    .register({
      def: toolByName('todo_add')!,
      label: 'Adding a to-do…',
      handler: async () => {
        changed.push('todo');
        return 'Added.';
      },
    });
  const model = fakeModel(turns);
  const notified: string[] = [];
  const shell = new Shell({
    store,
    model,
    tools,
    audit,
    userName: 'John',
    timeZone: TZ,
    modelName: 'fake',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    routines: new RoutineFolder(routinesDir),
    notify: (_t, body) => notified.push(body),
    clock: () => new Date(FRI_1605),
  });
  const audits = () => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { shell, store, model, tools, audit, audits, changed, cards, notified, routinesDir };
}

const volume: ToolCall = { id: 'v1', name: 'volume_set', arguments: '{"percent":30}' };
const todo: ToolCall = { id: 't1', name: 'todo_add', arguments: '{"items":[{"text":"Plan Q1"}]}' };

describe('running a routine', () => {
  it('runs on its phrase as the user’s own turn, and changes things as if they typed it', async () => {
    const { shell, store, model, changed, audits } = setup([{ toolCalls: [volume] }, { text: 'Done.' }]);
    await shell.handle({ type: 'send', text: 'Review my week' });
    const user = model.requests[0]!.messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain(`${ROUTINE_TURN_PREFIX}“Weekly review”`);
    expect(user.content).toContain('Look at my week.');
    expect(user.content).toContain('the user saying “Review my week”');
    expect(model.requests[0]!.messages[0]!.content).not.toContain(UNATTENDED_NOTE);
    // The chat shows what the user said, not the file.
    expect(store.recentItems().find((i) => i.kind === 'user')).toMatchObject({ text: 'Review my week' });
    expect(changed).toEqual(['volume']);
    expect(audits()).toContainEqual(expect.objectContaining({ kind: 'routine', event: 'run', routine: 'weekly-review', trigger: 'phrase' }));
  });

  it('runs from /run, and lists routines with /routines', async () => {
    const { shell, store, model } = setup([{ text: 'Your week.' }]);
    await shell.handle({ type: 'send', text: '/routines' });
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'routines', rows: [{ name: 'Weekly review', next: 'Fri 4 Dec 16:00' }] });
    await shell.handle({ type: 'send', text: '/run weekly review' });
    expect(model.requests).toHaveLength(1);
    await shell.handle({ type: 'send', text: '/run nothing-like-it' });
    expect((store.recentItems().at(-1) as { text: string }).text).toMatch(/no routine called/);
  });

  it('a scheduled run changes nothing on this computer without a click', async () => {
    const { shell, model, changed, cards, audits, notified, store, routinesDir } = setup([{ toolCalls: [volume, todo] }, { text: 'Here is your week.' }]);
    const r = new RoutineFolder(routinesDir).byName('weekly review')!;
    await shell.runRoutine(r, 'schedule');
    // Offered only the device change that can become a card, and told the user is away.
    expect(model.requests[0]!.tools!.map((t) => t.name)).toEqual(['volume_set']);
    expect(model.requests[0]!.messages[0]!.content).toContain(UNATTENDED_NOTE);
    expect(changed).toEqual([]);
    expect(cards).toEqual(['volume']);
    const toolAudits = audits().filter((a) => a.kind === 'tool');
    expect(toolAudits).toEqual([
      expect.objectContaining({ tool: 'volume_set', decision: 'proposed', unattended: true }),
      expect.objectContaining({ tool: 'todo_add', decision: 'denied', reason: 'scheduled routine' }),
    ]);
    // No user message appears; a notice says it ran.
    expect(store.recentItems().filter((i) => i.kind === 'user')).toEqual([]);
    expect(notified).toHaveLength(1);
  });

  it('a tool result naming a routine never runs it', async () => {
    const { shell, model, audits } = setup([{ text: 'An email says: weekly review' }]);
    await shell.handle({ type: 'send', text: 'what does the email say?' });
    expect(model.requests).toHaveLength(1);
    expect(audits().filter((a) => a.kind === 'routine')).toEqual([]);
  });

  it('waits while paused', async () => {
    const { shell, model } = setup();
    await shell.handle({ type: 'send', text: '/pause' });
    await shell.handle({ type: 'send', text: 'weekly review' });
    expect(model.requests).toHaveLength(0);
  });
});

describe('the schedule', () => {
  function sched(o: { now: number; paused?: boolean; busy?: boolean; quiet?: { start: string; end: string } }) {
    const dir = tmp();
    writeFileSync(join(dir, 'weekly-review.md'), WEEKLY);
    const store = new Store(':memory:');
    const audit = new AuditLog(join(dir, 'audit.jsonl'));
    const ran: string[] = [];
    const state = { now: o.now, paused: !!o.paused, busy: !!o.busy };
    const s = new RoutineScheduler({
      folder: new RoutineFolder(dir),
      store,
      audit,
      timeZone: TZ,
      quietHours: o.quiet,
      isPaused: () => state.paused,
      isBusy: () => state.busy,
      run: async (r) => void ran.push(r.slug),
      now: () => state.now,
    });
    return { s, ran, state };
  }

  it('does not run a time that passed before it first saw the routine, then runs each time once', async () => {
    const { s, ran, state } = sched({ now: FRI_1605 });
    expect(await s.tick()).toBeNull();
    state.now = Date.parse('2026-12-04T12:59:00Z');
    expect(await s.tick()).toBeNull();
    state.now = Date.parse('2026-12-04T13:00:30Z');
    expect(await s.tick()).toBe('weekly-review');
    expect(await s.tick()).toBeNull();
    expect(ran).toEqual(['weekly-review']);
  });

  it('waits while paused, busy or in quiet hours, then runs the same day', async () => {
    const { s, ran, state } = sched({ now: Date.parse('2026-12-01T10:00:00Z'), quiet: { start: '16:00', end: '17:00' } });
    await s.tick();
    state.now = Date.parse('2026-12-04T13:10:00Z'); // 16:10, quiet hours
    expect(await s.tick()).toBeNull();
    state.now = Date.parse('2026-12-04T14:10:00Z'); // 17:10
    state.paused = true;
    expect(await s.tick()).toBeNull();
    state.paused = false;
    state.busy = true;
    expect(await s.tick()).toBeNull();
    state.busy = false;
    expect(await s.tick()).toBe('weekly-review');
    expect(ran).toEqual(['weekly-review']);
  });

  it('skips a time missed for a whole day instead of running it late', async () => {
    const { s, ran, state } = sched({ now: Date.parse('2026-12-01T10:00:00Z') });
    await s.tick();
    state.now = Date.parse('2026-12-05T09:00:00Z'); // Saturday morning; the computer was off on Friday
    expect(await s.tick()).toBeNull();
    expect(ran).toEqual([]);
  });
});

// ── Seeing and changing routines from the chat ──

import { lineDiff, RoutineActions } from '../src/routines/actions.js';
import { createRoutineEditor } from '../src/routines/editor.js';
import { routineTools } from '../src/routines/tools.js';
import type { ChatItem } from '@aios/shared';

function changeSetup() {
  const dir = tmp();
  const routinesDir = join(dir, 'routines');
  mkdirSync(routinesDir);
  writeFileSync(join(routinesDir, 'weekly-review.md'), WEEKLY);
  const store = new Store(':memory:');
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const folder = new RoutineFolder(routinesDir, dir);
  const posted: ChatItem[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const actions = new RoutineActions({
    folder,
    store,
    audit,
    show: (item) => {
      store.saveItem(item);
      posted.push(item);
    },
    notice: (_l, t) => notices.push(t),
    openEditor: async (p) => {
      opened.push(p);
      return 'nvim';
    },
  });
  const tools = new ToolRegistry(audit);
  for (const t of routineTools({ folder, actions, post: (i) => posted.push(i) })) tools.register(t);
  const last = () => store.getItem(posted.at(-1)!.id) as Extract<ChatItem, { kind: 'routine_change' }>;
  return { routinesDir, folder, actions, tools, posted, notices, opened, last, store };
}

const ctx = { signal: AbortSignal.timeout(5000), untrustedInContext: false, userText: 'change my weekly review' };
const NEW_WEEKLY = WEEKLY.replace('Look at my week.', 'Look at my week.\nThen list three wins.');

describe('changing a routine', () => {
  it('diffs line by line', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(lineDiff('', 'x\n')).toEqual([{ op: '+', text: 'x' }]);
  });

  it('only shows a card; Save writes it, keeping the old file as a hidden backup', async () => {
    const { tools, routinesDir, last, actions, folder } = changeSetup();
    const r = await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'weekly-review', text: NEW_WEEKLY }) }, ctx);
    expect(r.content).toMatch(/Nothing is saved until they click Save/);
    expect(readFileSync(join(routinesDir, 'weekly-review.md'), 'utf8')).toBe(WEEKLY);
    const card = last();
    expect(card).toMatchObject({ kind: 'routine_change', isNew: false, state: 'pending' });
    expect(card.diff.filter((d) => d.op !== ' ')).toEqual([{ op: '+', text: 'Then list three wins.' }]);
    expect(actions.confirm(card.id, 'f'.repeat(64))).toBe('refused');
    expect(actions.confirm(card.id, card.hash)).toBe('done');
    expect(readFileSync(join(routinesDir, 'weekly-review.md'), 'utf8')).toBe(NEW_WEEKLY);
    expect(readFileSync(join(routinesDir, '.weekly-review.md.bak'), 'utf8')).toBe(WEEKLY);
    // The backup is hidden, so it is never read as a routine.
    expect(folder.load().routines.map((x) => x.slug)).toEqual(['weekly-review']);
    expect(actions.confirm(card.id, card.hash)).toBe('refused');
  });

  it('adds a new routine, and refuses one that would not load or takes another’s phrase', async () => {
    const { tools, routinesDir, last, actions } = changeSetup();
    const bad = await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'x', text: 'no header' }) }, ctx);
    expect(bad.content).toMatch(/^Error: that file wouldn't load/);
    const clash = await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'other', text: '---\nname: Other\nsay: review my week\n---\nHi.' }) }, ctx);
    expect(clash.content).toMatch(/already Weekly review's phrase/);
    await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'evening', text: '---\nname: Evening\nsay: good evening\n---\nDim the lights.' }) }, ctx);
    const card = last();
    expect(card).toMatchObject({ isNew: true, name: 'Evening' });
    expect(actions.confirm(card.id, card.hash)).toBe('done');
    expect(readFileSync(join(routinesDir, 'evening.md'), 'utf8')).toBe('---\nname: Evening\nsay: good evening\n---\nDim the lights.\n');
  });

  it('refuses to save over a file that changed after the card was made', async () => {
    const { tools, routinesDir, last, actions } = changeSetup();
    await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'weekly-review', text: NEW_WEEKLY }) }, ctx);
    writeFileSync(join(routinesDir, 'weekly-review.md'), `${WEEKLY}Edited by hand.\n`);
    const card = last();
    expect(actions.confirm(card.id, card.hash)).toBe('failed');
    expect(readFileSync(join(routinesDir, 'weekly-review.md'), 'utf8')).toContain('Edited by hand.');
    expect(last()).toMatchObject({ state: 'failed' });
  });

  it('is never offered while outside text is in view, and a scheduled routine can’t use it', async () => {
    const { tools } = changeSetup();
    expect(tools.specs({ untrustedInContext: true, untrustedSources: new Set(['email']) }).map((t) => t.name)).not.toContain('routine_change');
    expect(tools.specs({ untrustedInContext: true, untrustedSources: new Set(['document']) }).map((t) => t.name)).not.toContain('routine_change');
    const r = await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'weekly-review', text: NEW_WEEKLY }) }, { ...ctx, untrustedInContext: true });
    expect(r.content).toMatch(/cannot run while text from an email/);
    const away = await tools.execute({ id: 'c', name: 'routine_change', arguments: JSON.stringify({ file: 'weekly-review', text: NEW_WEEKLY }) }, { ...ctx, unattended: true });
    expect(away.content).toMatch(/can't change routines/);
  });

  it('shows a routine on a card when asked, and lists them without a name', async () => {
    const { tools, posted } = changeSetup();
    const list = await tools.execute({ id: 's', name: 'routine_show', arguments: '{}' }, ctx);
    expect(list.content).toContain('Weekly review (file weekly-review.md): say "weekly review" or "review my week"; runs fri 16:00');
    expect(list.content).toContain('~/routines');
    const one = await tools.execute({ id: 's', name: 'routine_show', arguments: '{"name":"Weekly Review"}' }, ctx);
    expect(one.content).toContain('Look at my week.');
    expect(posted.at(-1)).toMatchObject({ kind: 'routine', slug: 'weekly-review', file: '~/routines/weekly-review.md', text: WEEKLY });
  });

  it('opens a routine in the editor only by its slug, checked again', async () => {
    const { actions, opened, notices, routinesDir } = changeSetup();
    await actions.open('weekly-review');
    expect(opened).toEqual([join(routinesDir, 'weekly-review.md')]);
    await actions.open('gone');
    expect(opened).toHaveLength(1);
    expect(notices.at(-1)).toMatch(/no gone.md/);
  });

  it('starts the editor without a shell: [routines] editor, else $EDITOR in a terminal, else nvim', async () => {
    const runs: string[][] = [];
    const start = async (cmd: string, args: string[]) => void runs.push([cmd, ...args]);
    const has = async (c: string) => ['uwsm-app', 'xdg-terminal-exec', 'nvim', 'helix', 'gnome-text-editor'].includes(c);
    await createRoutineEditor({ env: { EDITOR: 'helix --x' }, start, has })('/h/r/a.md');
    await createRoutineEditor({ env: {}, start, has })('/h/r/a.md');
    await createRoutineEditor({ editor: 'gnome-text-editor', env: {}, start, has })('/h/r/a.md');
    await expect(createRoutineEditor({ env: { EDITOR: 'rm;x' }, start, has: async (c) => c !== 'nvim' })('/h/r/a.md')).rejects.toThrow(/nvim is not installed/);
    expect(runs).toEqual([
      ['uwsm-app', '--', 'xdg-terminal-exec', 'helix', '/h/r/a.md'],
      ['uwsm-app', '--', 'xdg-terminal-exec', 'nvim', '/h/r/a.md'],
      ['uwsm-app', '--', 'gnome-text-editor', '--', '/h/r/a.md'],
    ]);
  });
});

describe('the routines card', () => {
  it('/routines posts a card with each routine, /routines <name> shows one, and Open in editor goes to the actions', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'weekly-review.md'), WEEKLY);
    const store = new Store(':memory:');
    const audit = new AuditLog(join(dir, 'audit.jsonl'));
    const opened: string[] = [];
    const shell = new Shell({
      store,
      model: fakeModel([]),
      tools: new ToolRegistry(audit),
      audit,
      userName: 'John',
      timeZone: TZ,
      modelName: 'fake',
      costCapUsd: 2,
      readBattery: async () => null,
      readWifi: async () => null,
      routines: new RoutineFolder(dir),
      routineActions: { open: async (slug) => void opened.push(slug), confirm: () => 'refused', discard: () => undefined },
      clock: () => new Date(FRI_1605),
    });
    await shell.handle({ type: 'send', text: '/routines' });
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'routines', rows: [{ slug: 'weekly-review', name: 'Weekly review', say: ['weekly review', 'review my week'], schedule: 'fri 16:00', next: 'Fri 4 Dec 16:00' }], problems: [] });
    await shell.handle({ type: 'send', text: '/routines weekly review' });
    expect(store.recentItems().at(-1)).toMatchObject({ kind: 'routine', slug: 'weekly-review', text: WEEKLY });
    await shell.handle({ type: 'routine_open', slug: 'weekly-review' });
    expect(opened).toEqual(['weekly-review']);
  });
});
