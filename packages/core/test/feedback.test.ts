/**
 * /feedback: the user's own improvement ideas, saved as JSON lines and listed back in the chat.
 * Only the user's typing adds one: there is no tool for it, and the ideas never reach the model.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { HELP_TEXT, parseCommand } from '../src/commands.js';
import { FEEDBACK_MAX_CHARS, FeedbackLog, feedbackListText } from '../src/feedback.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'aios-feedback-'));
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const feedback = new FeedbackLog(join(dir, 'config', 'feedback.jsonl'));
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
  let now = new Date('2026-11-15T09:30:00Z');
  const shell = new Shell({
    store: new Store(':memory:'),
    model,
    tools: new ToolRegistry(audit),
    audit,
    userName: 'John',
    timeZone: 'UTC',
    modelName: 'm',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
    feedback,
    clock: () => now,
  });
  shell.subscribe((e) => events.push(e));
  const notices = () => events.flatMap((e) => (e.type === 'item' && e.item.kind === 'notice' ? [e.item.text] : []));
  const send = (text: string) => shell.handle({ type: 'send', text });
  return { shell, feedback, notices, send, requests, setNow: (d: string) => (now = new Date(d)), audit: () => readFileSync(auditPath, 'utf8') };
}

describe('/feedback parsing', () => {
  it('keeps the idea as typed and treats only a bare "list" as the list', () => {
    expect(parseCommand('/feedback  Show the weather\n on the brief ')).toEqual({ name: 'feedback', list: false, text: 'Show the weather\n on the brief' });
    expect(parseCommand('/feedback list')).toEqual({ name: 'feedback', list: true });
    expect(parseCommand('/Feedback LIST')).toEqual({ name: 'feedback', list: true });
    expect(parseCommand('/feedback list view needs dates')).toEqual({ name: 'feedback', list: false, text: 'list view needs dates' });
    expect(parseCommand('/feedback')).toEqual({ name: 'feedback', list: false, text: '' });
    expect(parseCommand('/feedback remove 3')).toEqual({ name: 'feedback_remove', n: 3 });
    expect(parseCommand('/feedback Delete #12')).toEqual({ name: 'feedback_remove', n: 12 });
    // Only a bare number removes; anything else is an idea.
    expect(parseCommand('/feedback remove the old tiles')).toEqual({ name: 'feedback', list: false, text: 'remove the old tiles' });
    expect(parseCommand('/feedback Problem: remove 3')).toEqual({ name: 'feedback', list: false, text: 'Problem: remove 3' });
    expect(HELP_TEXT).toContain('/feedback <idea>');
  });
});

describe('FeedbackLog', () => {
  it('appends one JSON line per idea, private to the user, and reads them back in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-feedback-'));
    const log = new FeedbackLog(join(dir, 'nested', 'feedback.jsonl'));
    expect(log.list()).toEqual([]);
    log.add('first', new Date('2026-11-14T08:00:00Z'));
    log.add('  second\nline  ', new Date('2026-11-15T08:00:00Z'));
    const raw = readFileSync(log.path, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[1] ?? '')).toEqual({ at: '2026-11-15T08:00:00.000Z', text: 'second\nline' });
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
    expect(log.list().map((e) => e.text)).toEqual(['first', 'second\nline']);
  });

  it('refuses empty and oversized ideas, and skips lines broken by a hand edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-feedback-'));
    const log = new FeedbackLog(join(dir, 'feedback.jsonl'));
    expect(log.add('   ', new Date())).toHaveProperty('error');
    expect(log.add('x'.repeat(FEEDBACK_MAX_CHARS + 1), new Date())).toHaveProperty('error');
    expect(log.list()).toEqual([]);
    writeFileSync(log.path, '{"at":"2026-11-01T00:00:00.000Z","text":"kept"}\nnot json\n{"text":"no time"}\n');
    expect(log.list()).toEqual([{ at: '2026-11-01T00:00:00.000Z', text: 'kept' }]);
  });

  it('removes one idea by its list number and keeps every other line as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-feedback-'));
    const log = new FeedbackLog(join(dir, 'feedback.jsonl'));
    expect(log.remove(1)).toHaveProperty('error');
    writeFileSync(log.path, '{"at":"2026-11-01T00:00:00.000Z","text":"one"}\nnot json\n{"at":"2026-11-02T00:00:00.000Z","text":"two"}\n{"at":"2026-11-03T00:00:00.000Z","text":"three"}\n');
    expect(log.remove(0)).toHaveProperty('error');
    expect(log.remove(4)).toHaveProperty('error');
    expect(log.remove(2)).toEqual({ at: '2026-11-02T00:00:00.000Z', text: 'two' });
    expect(readFileSync(log.path, 'utf8')).toBe('{"at":"2026-11-01T00:00:00.000Z","text":"one"}\nnot json\n{"at":"2026-11-03T00:00:00.000Z","text":"three"}\n');
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
    expect(log.list().map((e) => e.text)).toEqual(['one', 'three']);
  });

  it('lists ideas numbered with their date', () => {
    expect(feedbackListText([], '/f')).toContain('No ideas saved yet');
    const text = feedbackListText([{ at: '2026-11-14T08:00:00.000Z', text: 'a' }, { at: '2026-11-15T08:00:00.000Z', text: 'b' }], '/f');
    expect(text).toBe('2 ideas saved in /f:\n1. 2026-11-14  a\n2. 2026-11-15  b\nTo delete one, type /feedback remove and its number.');
  });
});

describe('/feedback in the chat', () => {
  it('saves the idea, lists it back, and never calls the model', async () => {
    const r = rig();
    await r.send('/feedback');
    expect(r.notices().at(-1)).toContain('Nothing saved yet');
    await r.send('/feedback Show the weather on the brief');
    expect(r.notices().at(-1)).toContain('#1');
    r.setNow('2026-11-16T10:00:00Z');
    await r.send('/feedback Let me snooze a to-do to next week');
    expect(r.notices().at(-1)).toContain('#2');
    await r.send('/feedback list');
    expect(r.notices().at(-1)).toContain('1. 2026-11-15  Show the weather on the brief\n2. 2026-11-16  Let me snooze a to-do to next week');
    expect(r.requests).toHaveLength(0);
    // The audit log records that an idea was saved, not its words.
    expect(r.audit()).toContain('"kind":"feedback"');
    expect(r.audit()).not.toContain('Show the weather');
  });

  it('/feedback remove deletes the numbered idea, by the user\'s typing only', async () => {
    const r = rig();
    await r.send('/feedback first idea');
    await r.send('/feedback second idea');
    await r.send('/feedback remove 1');
    expect(r.notices().at(-1)).toBe('Removed idea #1: first idea. The ones after it moved up by one.');
    expect(r.feedback.list().map((e) => e.text)).toEqual(['second idea']);
    await r.send('/feedback remove 5');
    expect(r.notices().at(-1)).toContain('no idea #5');
    expect(r.requests).toHaveLength(0);
    expect(r.audit()).toContain('"event":"remove"');
    expect(r.audit()).not.toContain('first idea');
  });

  it('has no tool, so the model and outside text cannot add an idea', () => {
    expect(ALPHA_TOOLS.some((t) => /feedback/i.test(t.name))).toBe(false);
  });
});
