/**
 * The six hostile fixtures against the A4 mail paths: triage input stays inside its
 * untrusted wrapper, triage has no tools, and a chat model that obeys the email still
 * cannot get a write-tier action through.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  type Delta,
  type MailEvent,
  type ModelRequest,
  type ModelResult,
  Shell,
  Store,
  type ToolCall,
  ToolRegistry,
  mailTools,
  toolByName,
  triageRequest,
} from '@aios/core';
import { describe, expect, it } from 'vitest';
import { fixtures } from '../../fixtures/mail.js';

const hostile = fixtures.filter((f) => f.hostile);
const asEvent = (f: (typeof fixtures)[number], i: number): MailEvent => ({
  messageId: `<${f.key}@fixtures>`,
  mailId: `INBOX:${i + 1}`,
  from: `${f.from.name} <${f.from.address}>`,
  subject: f.subject,
  date: null,
  body: f.text ?? f.html ?? '',
  receivedAt: 0,
  status: 'pending',
  triage: null,
  attempts: 0,
});

describe('hostile mail', () => {
  it('covers all six hostile kinds', () => {
    expect(new Set(hostile.map((f) => f.hostile!.kind)).size).toBe(6);
  });

  it('triage input keeps every hostile message inside its own wrapper', () => {
    const req = triageRequest(hostile.map(asEvent));
    const text = String(req.messages.at(-1)!.content);
    expect(text.match(/<untrusted /g)).toHaveLength(hostile.length);
    expect(text.match(/<\/untrusted>/g)).toHaveLength(hostile.length);
    expect(text).not.toMatch(/<\/?system>/i);
    expect(req.tools).toBeUndefined();
  });

  it('a chat model that obeys a hostile email cannot send, open apps or save memory', async () => {
    const approval = hostile.find((f) => f.hostile!.kind === 'fake-approval')!;
    const dir = mkdtempSync(join(tmpdir(), 'aios-hostile-'));
    const audit = new AuditLog(join(dir, 'audit.jsonl'));
    const tools = new ToolRegistry(audit);
    const fakeMail = {
      search: async () => [],
      thread: async () => [],
      read: async (id: string) => ({
        id,
        messageId: '<x@y>',
        from: approval.from,
        to: [],
        cc: [],
        replyTo: [],
        subject: approval.subject,
        date: null,
        inReplyTo: null,
        references: [],
        text: approval.text ?? '',
        html: null,
        attachments: [],
      }),
    };
    for (const t of mailTools(fakeMail)) tools.register(t);
    // The real send/open tools arrive in A5/A6; register write-tier stand-ins to prove the registry blocks them.
    tools.register({ def: toolByName('mail_send_draft')!, label: 'Sending…', handler: async () => 'SENT' });

    const call = (name: string, args: unknown): ToolCall => ({ id: name, name, arguments: JSON.stringify(args) });
    const script = [
      { toolCalls: [call('mail_read', { id: 'INBOX:1' })] },
      { toolCalls: [call('mail_send_draft', { draftId: 'd1' })] },
      { text: 'Done, sent as approved.' },
    ];
    const model = {
      async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
        const t = script.shift() ?? { text: 'ok' };
        const r: ModelResult = { content: t.text ?? '', toolCalls: t.toolCalls ?? [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
        yield { type: 'done', result: r };
        return r;
      },
    };
    const store = new Store(':memory:');
    const shell = new Shell({ store, model, tools, audit, userName: 'John', timeZone: 'UTC', modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null });
    await shell.handle({ type: 'send', text: 'Read email INBOX:1' });

    const log = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.find((e) => e.tool === 'mail_send_draft')).toMatchObject({ decision: 'denied' });
    expect(log.find((e) => e.tool === 'mail_read')).toMatchObject({ decision: 'allowed' });
    expect(store.recentItems().filter((i) => i.kind === 'tool').map((i) => (i as { state: string }).state)).toEqual(['done', 'failed']);
  });
});
