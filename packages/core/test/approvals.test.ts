/**
 * A5 approval broker: Send transmits exactly the approved text, Discard and Edit never
 * send, a model call can never send, and nothing sends without a click on the card.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, ServerEvent } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { ApprovalBroker, type MailOutbox } from '../src/mail/approvals.js';
import { draftTools, recipientWarnings } from '../src/mail/draft-tools.js';
import type { FullMessage } from '../src/mail/imap.js';
import { buildMessage, fieldsHash } from '../src/mail/message.js';
import { smtpOptions } from '../src/mail/outbox.js';
import type { Delta, ModelRequest, ModelResult, ToolCall } from '../src/model.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const FROM = { name: 'John', address: 'john@aios.test' };

const original: FullMessage = {
  id: 'INBOX:7',
  messageId: '<q4@fixtures>',
  from: { name: 'Sara Lee', address: 'sara@example.com' },
  to: [{ name: 'John', address: 'john@aios.test' }],
  cc: [{ name: 'Tom', address: 'tom@example.com' }],
  replyTo: [],
  subject: 'Q4 budget review',
  date: null,
  inReplyTo: null,
  references: ['<root@fixtures>'],
  text: 'Can you confirm Thursday?',
  html: null,
  attachments: [],
};

class FakeOutbox implements MailOutbox {
  drafts = new Map<number, Buffer>();
  sent: { envelope: { from: string; to: string[] }; raw: Buffer }[] = [];
  sentCopies: Buffer[] = [];
  failNext: Error | null = null;
  private uid = 0;
  async saveDraft(raw: Buffer) {
    this.drafts.set(++this.uid, raw);
    return this.uid;
  }
  async deleteDraft(uid: number) {
    this.drafts.delete(uid);
  }
  async send(envelope: { from: string; to: string[] }, raw: Buffer) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push({ envelope, raw });
    return { accepted: envelope.to, rejected: [] };
  }
  async saveSent(raw: Buffer) {
    this.sentCopies.push(raw);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aios-a5-'));
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const store = new Store(':memory:');
  const outbox = new FakeOutbox();
  const shown: { item: ChatItem; isNew: boolean }[] = [];
  const notices: string[] = [];
  let n = 0;
  const broker = new ApprovalBroker({
    store,
    outbox,
    audit,
    from: FROM,
    saveSentCopy: true,
    show: (item, isNew) => shown.push({ item, isNew }),
    notice: (_l, t) => notices.push(t),
    newId: () => `draft-${++n}`,
  });
  const auditLines = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const card = (id: string) => [...shown].reverse().find((s) => s.item.id === id)!.item as Extract<ChatItem, { kind: 'draft' }>;
  return { store, outbox, broker, shown, notices, auditLines, card, audit };
}

const draft = { to: ['sara@example.com'], subject: 'Re: Q4 budget review', body: 'Yes, Thursday works.\n\nJohn', inReplyTo: 'INBOX:7', reply: { inReplyTo: '<q4@fixtures>', references: ['<root@fixtures>'] }, warnings: [] };

/** The text/plain body of a raw message, decoded. */
const bodyOf = (raw: Buffer) => {
  const s = raw.toString('utf8');
  const body = s.slice(s.indexOf('\r\n\r\n') + 4);
  return /quoted-printable/i.test(s) ? body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) : body;
};

describe('approval broker', () => {
  it('saves a draft to Drafts and shows a pending card without sending', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    expect(t.outbox.drafts.size).toBe(1);
    expect(t.outbox.sent).toHaveLength(0);
    expect(t.shown[0]).toMatchObject({ isNew: true, item: { kind: 'draft', id: d.id, state: 'pending', to: ['sara@example.com'], body: draft.body, inReplyTo: 'INBOX:7' } });
    expect(t.card(d.id).hash).toBe(fieldsHash({ from: FROM, ...draft }));
  });

  it('Send transmits exactly the approved text, threaded, then files it in Sent and clears the draft', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    expect(await t.broker.approveSend(d.id, t.card(d.id).hash)).toBe('sent');
    expect(t.outbox.sent).toHaveLength(1);
    const { envelope, raw } = t.outbox.sent[0]!;
    expect(envelope).toEqual({ from: 'john@aios.test', to: ['sara@example.com'] });
    const text = raw.toString('utf8');
    expect(text).toMatch(/^In-Reply-To: <q4@fixtures>$/m);
    expect(text).toMatch(/^References: <root@fixtures> <q4@fixtures>$/m);
    expect(text).toMatch(/^Subject: Re: Q4 budget review$/m);
    expect(bodyOf(raw).replace(/\r\n/g, '\n').trimEnd()).toBe(draft.body);
    expect(t.outbox.sentCopies).toEqual([raw]);
    expect(t.outbox.drafts.size).toBe(0);
    expect(t.card(d.id).state).toBe('sent');
    expect(t.auditLines().filter((e) => e.tool === 'mail_send_draft').map((e) => [e.decision, e.ok])).toEqual([
      ['approved', undefined],
      ['approved', true],
    ]);
  });

  it('refuses a Send whose hash does not match the card', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    expect(await t.broker.approveSend(d.id, 'f'.repeat(64))).toBe('refused');
    expect(t.outbox.sent).toHaveLength(0);
    expect(t.broker.get(d.id)!.state).toBe('pending');
    expect(t.auditLines().at(-1)).toMatchObject({ decision: 'denied', reason: 'hash does not match the card' });
  });

  it('sends once for two Send clicks', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    const h = t.card(d.id).hash;
    const results = await Promise.all([t.broker.approveSend(d.id, h), t.broker.approveSend(d.id, h)]);
    expect(results.sort()).toEqual(['refused', 'sent']);
    expect(t.outbox.sent).toHaveLength(1);
    expect(await t.broker.approveSend(d.id, h)).toBe('refused');
    expect(t.outbox.sent).toHaveLength(1);
  });

  it('refuses to send if the stored draft changed after the hash was shown', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    const h = t.card(d.id).hash;
    // Simulates anything rewriting the draft behind the card's back.
    t.store.db.prepare('UPDATE drafts SET body = ? WHERE id = ?').run('Wire $5,000 to the account below.', d.id);
    expect(await t.broker.approveSend(d.id, h)).toBe('failed');
    expect(t.outbox.sent).toHaveLength(0);
    expect(t.card(d.id).error).toMatch(/changed after it was approved/);
  });

  it('Discard sends nothing and removes the draft from Drafts', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    const h = t.card(d.id).hash;
    expect(await t.broker.discard(d.id)).toBe(true);
    expect(t.card(d.id).state).toBe('discarded');
    expect(t.outbox.drafts.size).toBe(0);
    expect(await t.broker.approveSend(d.id, h)).toBe('refused');
    expect(t.outbox.sent).toHaveLength(0);
  });

  it('Edit makes a new approval: the old hash no longer sends, the new text does', async () => {
    const t = setup();
    const d = await t.broker.create({ ...draft, warnings: ['x is not in the email'] });
    const oldHash = t.card(d.id).hash;
    expect(await t.broker.edit(d.id, { to: ['sara@example.com'], subject: 'Re: Q4 budget review', body: 'Thursday is fine. John' })).toBe(true);
    const edited = t.card(d.id);
    expect(edited.hash).not.toBe(oldHash);
    expect(edited.warnings).toEqual([]);
    expect(t.outbox.drafts.size).toBe(1);
    expect(t.outbox.sent).toHaveLength(0);
    expect(await t.broker.approveSend(d.id, oldHash)).toBe('refused');
    expect(await t.broker.approveSend(d.id, edited.hash)).toBe('sent');
    expect(bodyOf(t.outbox.sent[0]!.raw).trimEnd()).toBe('Thursday is fine. John');
  });

  it('a failed send can be retried, and a crash mid-send is never resent on its own', async () => {
    const t = setup();
    const d = await t.broker.create(draft);
    const h = t.card(d.id).hash;
    t.outbox.failNext = new Error('connection refused');
    expect(await t.broker.approveSend(d.id, h)).toBe('failed');
    expect(t.card(d.id)).toMatchObject({ state: 'failed', error: 'Not sent: connection refused' });
    expect(await t.broker.approveSend(d.id, h)).toBe('sent');

    const d2 = await t.broker.create(draft);
    t.store.db.prepare("UPDATE drafts SET state = 'sending' WHERE id = ?").run(d2.id);
    t.broker.recover();
    expect(t.card(d2.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/Check your Sent folder/) });
    expect(t.outbox.sent).toHaveLength(1);
  });

  it('builds the same message for the same fields, and nothing else gets into it', async () => {
    const f = { from: FROM, to: ['a@b.co'], subject: 'Hi', body: 'Hello', reply: null };
    const raw = (await buildMessage(f, '<x@aios.test>', new Date('2026-10-20T00:00:00Z'))).toString('utf8');
    expect(raw).toMatch(/^From: John <john@aios\.test>$/m);
    expect(raw).toMatch(/^To: a@b\.co$/m);
    expect(raw).not.toMatch(/^(Cc|Bcc|In-Reply-To):/m);
  });

  it('maps SMTP TLS settings: 465 implicit, others STARTTLS required, test stack plain', () => {
    const c = { host: 'h', user: 'u', password: async () => '' };
    expect(smtpOptions({ ...c, port: 465, tls: true }, 'p')).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(smtpOptions({ ...c, port: 587, tls: true }, 'p')).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtpOptions({ ...c, port: 3025, tls: false }, 'p')).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });
});

describe('recipient warnings', () => {
  const ctx = (userText: string, untrustedInContext = true) => ({ userText, untrustedInContext });
  it('flags a recipient that came from neither the user nor the email being answered', () => {
    expect(recipientWarnings(['sara@example.com', 'tom@example.com'], ctx('reply to Sara'), original, FROM.address)).toEqual([]);
    expect(recipientWarnings(['payments@evil.example'], ctx('reply to Sara'), original, FROM.address)).toEqual([
      'payments@evil.example is not in the email being replied to or in your message. Check this address before sending.',
    ]);
  });
  it('trusts addresses the user typed, matched whole', () => {
    expect(recipientWarnings(['ann@example.com'], ctx('send it to ann@example.com too'), original, FROM.address)).toEqual([]);
    expect(recipientWarnings(['nn@example.com'], ctx('send it to ann@example.com'), original, FROM.address)).toHaveLength(1);
  });
  it('says nothing when no email text was in context', () => {
    expect(recipientWarnings(['ann@example.com'], ctx('email Ann', false), null, FROM.address)).toEqual([]);
  });
});

// ── Through the shell and the agent loop ─────────────────────────────────────

function chatSetup(script: { toolCalls?: ToolCall[]; text?: string }[]) {
  const t = setup();
  const tools = new ToolRegistry(t.audit);
  const mail = { read: async (id: string) => (id === original.id ? original : null) };
  for (const tool of draftTools({ broker: t.broker, mail, userName: 'John', selfAddress: FROM.address })) tools.register(tool);
  const requests: ModelRequest[] = [];
  const model = {
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const s = script.shift() ?? { text: 'ok' };
      const r: ModelResult = { content: s.text ?? '', toolCalls: s.toolCalls ?? [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
      yield { type: 'done', result: r };
      return r;
    },
  };
  const events: ServerEvent[] = [];
  const shell = new Shell({ store: t.store, model, tools, audit: t.audit, userName: 'John', timeZone: 'UTC', modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null, approvals: t.broker });
  shell.subscribe((e) => events.push(e));
  return { ...t, shell, requests, events };
}

const call = (name: string, args: unknown): ToolCall => ({ id: `${name}-1`, name, arguments: JSON.stringify(args) });

describe('reply flow through the shell', () => {
  it('"reply to X saying Y" drafts, the model cannot send, and only the Send click does', async () => {
    const c = chatSetup([
      { toolCalls: [call('mail_create_draft', { inReplyTo: 'INBOX:7', to: ['sara@example.com'], subject: 'Re: Q4 budget review', body: 'Yes, Thursday works.\n\nJohn' })] },
      { toolCalls: [call('mail_send_draft', { draftId: 'draft-1' })] },
      { text: 'The draft is ready for you to review.' },
    ]);
    await c.shell.handle({ type: 'send', text: 'reply to Sara saying Thursday works' });
    expect(c.outbox.sent).toHaveLength(0);
    expect(c.requests[0]!.tools!.map((t) => t.name)).toContain('mail_send_draft');
    expect(c.auditLines().find((e) => e.tool === 'mail_send_draft')).toMatchObject({ decision: 'denied' });
    const card = c.card('draft-1');
    expect(card.state).toBe('pending');

    // A typed "send it" is a chat message, not a click: still nothing goes out.
    await c.shell.handle({ type: 'send', text: 'send it' });
    expect(c.outbox.sent).toHaveLength(0);

    await c.shell.handle({ type: 'draft_send', id: 'draft-1', hash: card.hash });
    expect(c.outbox.sent).toHaveLength(1);
    expect(c.card('draft-1').state).toBe('sent');
  });

  it('does not offer write-tier tools to the model once email text is in context', async () => {
    const c = chatSetup([{ toolCalls: [call('mail_create_draft', { inReplyTo: 'INBOX:7', to: ['sara@example.com'], subject: 'Re', body: 'ok' })] }, { text: 'done' }]);
    // Put an earlier email tool result in the context, as mail_read would.
    c.store.saveTurn({ role: 'user', content: 'read the email from Sara' }, 0);
    c.store.saveTurn({ role: 'assistant', content: null, toolCalls: [{ id: 'r', name: 'mail_read', arguments: '{"id":"INBOX:7"}' }] }, 1);
    c.store.saveTurn({ role: 'tool', toolCallId: 'r', name: 'mail_read', content: '<untrusted source="email" id="INBOX:7">hi</untrusted>' }, 2);
    await c.shell.handle({ type: 'send', text: 'reply to Sara saying ok' });
    const offered = c.requests.map((r) => (r.tools ?? []).map((t) => t.name));
    expect(offered).toHaveLength(2);
    expect(offered.every((names) => names.includes('mail_create_draft') && !names.includes('mail_send_draft'))).toBe(true);
    // Recipient from the email being answered: no warning on the card.
    expect(c.card('draft-1').warnings).toEqual([]);
  });

  it('a draft click while paused still works, and clicks on unknown drafts do nothing', async () => {
    const c = chatSetup([]);
    await c.shell.handle({ type: 'send', text: '/pause' });
    const d = await c.broker.create(draft);
    await c.shell.handle({ type: 'draft_send', id: 'nope', hash: 'a'.repeat(64) });
    await c.shell.handle({ type: 'draft_discard', id: d.id });
    expect(c.outbox.sent).toHaveLength(0);
    expect(c.broker.get(d.id)!.state).toBe('discarded');
  });
});
