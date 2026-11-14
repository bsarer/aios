/**
 * K3: a personal inbox with tens of thousands of emails. Mail is listed a month at a time going
 * back; Gmail's tabs and bulk or automated mail are skipped by code before any model sees them;
 * the user's sent mail and what they replied to come first; older mail is read overnight on the
 * local model; cloud reading stops at the knowledge budget. Pretend mailbox, pretend models.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { GmailCategory, KnowledgeConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { zonedToUtc } from '../src/calendar/time.js';
import { KnowledgeCrawler, type ModelChoice, progressText } from '../src/knowledge/crawler.js';
import { KnowledgeFile } from '../src/knowledge/file.js';
import { isAutomated, senderMatches, skipReason } from '../src/knowledge/mailfilter.js';
import { type BulkHeaders, type FullMessage, type ListedMail, gmailSkipQuery, headerFields, listedOf } from '../src/mail/imap.js';
import type { ModelRequest } from '../src/model.js';
import { Store } from '../src/store.js';

const TZ = 'Europe/Istanbul';
const local = (s: string) => zonedToUtc(s, TZ).getTime();
const DAY = 86_400_000;
const START = local('2026-11-10T10:00');

const CONFIG: KnowledgeConfig = {
  enabled: true,
  everyMinutes: 60,
  model: 'local',
  backfillDays: 183,
  backfillModel: 'cloud',
  backfillMaxMails: 5000,
  backfillMaxFiles: 300,
  perRun: 40,
  sources: ['mail'],
  calendarDays: 7,
  keepDays: 3,
  olderMail: 'local-overnight',
  olderMailMonths: 6,
  overnight: { start: '01:00', end: '07:00' },
  skipCategories: ['promotions', 'social', 'updates', 'forums'],
  skipAutomated: true,
  skipSenders: [],
  alwaysSenders: [],
  dailyBudgetUsd: 0.5,
};

interface Mail {
  id: string;
  from: string;
  to?: string;
  at: number;
  messageId?: string;
  inReplyTo?: string;
  threadId?: string;
  starred?: boolean;
  important?: boolean;
  headers?: BulkHeaders;
  category?: GmailCategory;
}

const address = (s: string) => ({ name: '', address: s });

function mailbox(mails: Mail[]) {
  const listed = (m: Mail): ListedMail => ({
    id: m.id,
    messageId: m.messageId ?? `<${m.id}@x>`,
    from: address(m.from),
    to: [address(m.to ?? 'john@aios.test')],
    subject: `Subject ${m.id}`,
    date: new Date(m.at),
    inReplyTo: m.inReplyTo ?? null,
    threadId: m.threadId ?? null,
    starred: m.starred ?? false,
    important: m.important ?? false,
    bulkHeaders: m.headers ?? {},
  });
  const lists: { since: number; before: number | undefined; skip: readonly GmailCategory[] }[] = [];
  const reads: string[] = [];
  return {
    mails,
    lists,
    reads,
    list: async (o: { since: Date; before?: Date | undefined; limit: number; skipCategories: readonly GmailCategory[] }) => {
      lists.push({ since: o.since.getTime(), before: o.before?.getTime(), skip: o.skipCategories });
      const ok = (m: Mail) => m.at >= o.since.getTime() && (!o.before || m.at < o.before.getTime()) && (!m.category || !o.skipCategories.includes(m.category));
      const folder = (f: string) => mails.filter((m) => m.id.startsWith(f) && ok(m)).sort((a, b) => b.at - a.at).slice(0, o.limit);
      return [...folder('INBOX:'), ...folder('Sent:')].sort((a, b) => b.at - a.at).map(listed);
    },
    read: async (id: string): Promise<FullMessage | null> => {
      reads.push(id);
      const m = mails.find((x) => x.id === id);
      return m ? { ...listed(m), cc: [], replyTo: [], references: [], text: `Body of ${id}`, html: null, attachments: [] } : null;
    },
  };
}

function rig(mails: Mail[], o: { config?: Partial<KnowledgeConfig>; costUsd?: number; account?: string; store?: Store; older?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-knowledge-large-'));
  const store = o.store ?? new Store(':memory:');
  let now = START;
  const box = mailbox(mails);
  const asked: { role: string; id: string }[] = [];
  const model = {
    structured: async (req: ModelRequest, name: string, schema: { parse: (v: unknown) => unknown }) => {
      const id = /id="([^"]+)"/.exec(req.messages.at(-1)!.content!)?.[1] ?? '?';
      // The tidy call at the end of the first pass is counted for its cost but not listed.
      if (name === 'knowledge_notes') asked.push({ role: req.role, id });
      const empty = name === 'knowledge_notes' ? { notes: [] } : { people: [], work: [], commitments: [], interests: [], recent: [] };
      return { value: schema.parse(empty), result: { usage: { promptTokens: 1500, completionTokens: 200, totalTokens: 1700, costUsd: o.costUsd ?? null } } };
    },
  };
  const cloud: ModelChoice = { model: model as never, role: 'nightly' };
  const localModel: ModelChoice = { model: model as never, role: 'local' };
  const crawler = new KnowledgeCrawler({
    config: { ...CONFIG, ...o.config },
    userName: 'John',
    userAddresses: ['john@aios.test'],
    account: o.account ?? 'john@aios.test',
    timeZone: TZ,
    file: new KnowledgeFile(join(dir, 'knowledge'), 'John'),
    store,
    audit: new AuditLog(join(dir, 'audit.jsonl')),
    mail: box,
    models: { backfill: cloud, hourly: localModel, older: o.older === false ? null : localModel },
    isPaused: () => false,
    now: () => now,
  });
  return { store, box, crawler, asked, setNow: (s: string) => (now = local(s)) };
}

describe('which mail is read', () => {
  it('tells bulk and automated mail by its headers and sender', () => {
    const person = { from: address('ana@home.example'), bulkHeaders: {} };
    expect(isAutomated(person)).toBe(false);
    expect(isAutomated({ ...person, bulkHeaders: { 'list-unsubscribe': '<mailto:u@shop.example>' } })).toBe(true);
    expect(isAutomated({ ...person, bulkHeaders: { 'list-id': 'News <news.shop.example>' } })).toBe(true);
    expect(isAutomated({ ...person, bulkHeaders: { precedence: 'bulk' } })).toBe(true);
    expect(isAutomated({ ...person, bulkHeaders: { 'auto-submitted': 'auto-replied' } })).toBe(true);
    expect(isAutomated({ ...person, bulkHeaders: { 'auto-submitted': 'no' } })).toBe(false);
    for (const a of ['noreply@bank.example', 'no-reply@x.example', 'donotreply@x.example', 'notifications@github.example', 'mailer-daemon@x.example', 'newsletter@x.example']) {
      expect(isAutomated({ from: address(a), bulkHeaders: {} })).toBe(true);
    }
    expect(isAutomated({ from: address('norah@home.example'), bulkHeaders: {} })).toBe(false);
  });

  it('matches senders by address or domain, and never skips the user\'s own mail', () => {
    expect(senderMatches('Ana@Home.Example', ['ana@home.example'])).toBe(true);
    expect(senderMatches('deals@mail.shop.example', ['shop.example'])).toBe(true);
    expect(senderMatches('a@notshop.example', ['shop.example'])).toBe(false);
    const c = { skipAutomated: true, skipSenders: ['shop.example'], alwaysSenders: ['school.example'] };
    const m = (a: string, bulkHeaders: BulkHeaders = {}) => ({ from: address(a), bulkHeaders });
    expect(skipReason(m('deals@shop.example'), false, c)).toBe('sender');
    expect(skipReason(m('deals@shop.example'), true, c)).toBeNull();
    expect(skipReason(m('noreply@school.example', { 'list-id': 'x' }), false, c)).toBeNull();
    expect(skipReason(m('x@y.example', { precedence: 'list' }), false, c)).toBe('automated');
    expect(skipReason(m('x@y.example', { precedence: 'list' }), false, { ...c, skipAutomated: false })).toBeNull();
  });

  it('reads the bulk headers, flags and Gmail labels from IMAP', () => {
    const headers = Buffer.from('List-Unsubscribe: <mailto:u@shop.example>,\r\n <https://shop.example/u>\r\nPrecedence: bulk\r\nSubject: nope\r\n');
    expect(headerFields(headers, ['list-unsubscribe', 'precedence', 'auto-submitted'])).toEqual({ 'list-unsubscribe': '<mailto:u@shop.example>, <https://shop.example/u>', precedence: 'bulk' });
    const m = listedOf('INBOX', {
      seq: 1,
      uid: 7,
      envelope: { messageId: '<a@x>', inReplyTo: '<b@x>', from: [{ address: 'ana@home.example' }], to: [], subject: 's', date: new Date(START) },
      flags: new Set(['\\Seen', '\\Flagged']),
      labels: new Set(['\\Important']),
      threadId: '123',
      headers,
    } as never);
    expect(m).toMatchObject({ id: 'INBOX:7', inReplyTo: '<b@x>', starred: true, important: true, threadId: '123', bulkHeaders: { precedence: 'bulk' } });
    expect(gmailSkipQuery(['promotions', 'social'])).toBe('-category:promotions -category:social');
  });

  it('skips Gmail tabs and bulk mail before any model sees them, and counts what it skipped', async () => {
    const r = rig([
      { id: 'INBOX:1', from: 'ana@home.example', at: START - DAY },
      { id: 'INBOX:2', from: 'deals@shop.example', at: START - DAY, category: 'promotions' },
      { id: 'INBOX:3', from: 'news@paper.example', at: START - DAY, headers: { 'list-unsubscribe': '<x>' } },
      { id: 'INBOX:4', from: 'noreply@bank.example', at: START - DAY },
    ]);
    await r.crawler.run();
    expect(r.box.lists[0]!.skip).toEqual(['promotions', 'social', 'updates', 'forums']);
    expect(r.box.reads).toEqual(['INBOX:1']);
    expect(r.asked.map((a) => a.id)).toEqual(['INBOX:1']);
    expect(r.crawler.progress()).toMatchObject({ skipped: 2, mail: { total: 1 } });
    expect(progressText(r.crawler.progress(), true)).toContain('Skipped 2 bulk or automated emails.');
  });
});

describe('the order mail is read in', () => {
  it('sent mail first, then what the user replied to, starred or Important mail, then people they write to', async () => {
    const r = rig(
      [
        { id: 'INBOX:1', from: 'stranger@x.example', at: START - 1 * DAY },
        { id: 'INBOX:2', from: 'kemal@work.example', at: START - 2 * DAY },
        { id: 'INBOX:3', from: 'ana@home.example', at: START - 3 * DAY, messageId: '<question@home>' },
        { id: 'INBOX:4', from: 'shop@x.example', at: START - 4 * DAY, starred: true },
        { id: 'INBOX:5', from: 'bank@x.example', at: START - 5 * DAY, important: true },
        { id: 'INBOX:6', from: 'old@x.example', at: START - 20 * DAY, threadId: 't1' },
        { id: 'Sent:1', from: 'john@aios.test', to: 'ana@home.example', at: START - 2 * DAY, inReplyTo: '<question@home>' },
        { id: 'Sent:2', from: 'john@aios.test', to: 'kemal@work.example', at: START - 3 * DAY },
        { id: 'Sent:3', from: 'john@aios.test', to: 'kemal@work.example', at: START - 4 * DAY, threadId: 't1' },
      ],
      { config: { perRun: 1 } },
    );
    // Reads one per run; look at the order the rest wait in.
    await r.crawler.run();
    const order = [r.asked[0]!.id, ...r.crawler.ledger.pending(20).map((i) => i.ref)];
    expect(order).toEqual(['Sent:1', 'Sent:2', 'Sent:3', 'INBOX:3', 'INBOX:4', 'INBOX:5', 'INBOX:6', 'INBOX:2', 'INBOX:1']);
  });
});

describe('listing a big mailbox', () => {
  /** Two emails a day for a year: about 730, more than the first pass wants waiting at once. */
  const year = (): Mail[] => Array.from({ length: 730 }, (_, i) => ({ id: `INBOX:${i + 1}`, from: `p${i % 50}@x.example`, at: START - (i + 0.5) * (DAY / 2) }));

  it('lists a month at a time while little waits, resumes where it stopped, and reads each email once', async () => {
    const r = rig(year(), { config: { perRun: 40, olderMail: 'off' }, older: false });
    await r.crawler.run();
    // 60 emails a month: two months fill two runs' worth of waiting mail.
    expect(r.box.lists.map((l) => Math.round((START - l.since) / DAY))).toEqual([30, 60]);
    expect(r.asked).toHaveLength(40);
    expect(r.crawler.progress().phase).toBe('backfill');
    for (let i = 0; i < 20 && r.crawler.progress().phase === 'backfill'; i++) await r.crawler.run();
    const p = r.crawler.progress();
    expect(p.phase).not.toBe('backfill');
    // About six months, nothing older, nothing twice.
    expect(p.mail.total).toBeGreaterThan(355);
    expect(p.mail.total).toBeLessThan(370);
    expect(new Set(r.asked.map((a) => a.id)).size).toBe(r.asked.length);
    expect(r.asked.every((a) => a.role === 'nightly')).toBe(true);
  });

  it('reads older mail on the local model only overnight, newest first, back to olderMailMonths', async () => {
    const r = rig(year(), { config: { perRun: 500 } });
    await r.crawler.run();
    await r.crawler.run();
    expect(r.crawler.progress().phase).not.toBe('backfill');
    const cloud = r.asked.length;
    // Daytime: older mail is listed but waits.
    r.setNow('2026-11-10T12:00');
    expect(await r.crawler.runIfDue()).toBe('updated');
    expect(r.asked).toHaveLength(cloud);
    expect(r.crawler.progress().older.total).toBeGreaterThan(0);
    expect(progressText(r.crawler.progress(), true)).toMatch(/Older mail: 0 of \d+ read, listed back to \d{4}-\d\d-\d\d\. It continues overnight on the local model\./);
    expect(await r.crawler.runIfDue()).toBe('not_due');
    // Overnight: every five minutes until it is all read.
    r.setNow('2026-11-11T02:00');
    for (let i = 0; i < 10; i++) await r.crawler.runIfDue();
    const older = r.asked.slice(cloud);
    expect(older.length).toBeGreaterThan(300);
    expect(older.every((a) => a.role === 'local')).toBe(true);
    const p = r.crawler.progress();
    expect(p.older.done).toBe(p.older.total);
    // Back to 6 months before the 183-day window, not further: the last few days of the year stay unread.
    expect(p.mail.total).toBeGreaterThan(700);
    expect(p.mail.total).toBeLessThan(730);
    expect(await r.crawler.runIfDue()).toBe('not_due');
  });

  it('starts again for a new mailbox and drops the old one\'s waiting mail', async () => {
    const store = new Store(':memory:');
    const first = rig(year(), { store, config: { perRun: 1, olderMail: 'off' }, older: false });
    await first.crawler.run();
    expect(first.crawler.ledger.pendingCount('backfill')).toBeGreaterThan(0);
    const second = rig([{ id: 'INBOX:1', from: 'friend@personal.example', at: START - DAY, messageId: '<new@personal>' }], { store, account: 'john@personal.example', config: { perRun: 10, olderMail: 'off' }, older: false });
    await second.crawler.run();
    expect(second.asked.map((a) => a.id)).toEqual(['INBOX:1']);
    expect(second.crawler.ledger.pendingCount('backfill')).toBe(0);
    expect(second.box.lists[0]!.before).toBe(START);
  });

  it('an earlier 90-day pass is widened to the new window without reading anything twice', async () => {
    const store = new Store(':memory:');
    const before = rig(year(), { store, config: { backfillDays: 90, perRun: 500, olderMail: 'off' }, older: false });
    for (let i = 0; i < 4; i++) await before.crawler.run();
    const read = new Set(before.asked.map((a) => a.id));
    // As an install from before K3 left it: started, but no window of its own.
    store.setSetting('knowledge.windowFrom', '');
    store.setSetting('knowledge.cursor', '');
    const after = rig(year(), { store, config: { backfillDays: 183, perRun: 500, olderMail: 'off' }, older: false });
    for (let i = 0; i < 4; i++) await after.crawler.run();
    expect(after.asked.length).toBeGreaterThan(150);
    expect(after.asked.some((a) => read.has(a.id))).toBe(false);
  });
});

describe('the knowledge budget', () => {
  it('stops cloud reading for the day at dailyBudgetUsd and goes on the next day', async () => {
    const mails: Mail[] = Array.from({ length: 30 }, (_, i) => ({ id: `INBOX:${i + 1}`, from: `p${i}@x.example`, at: START - (i + 1) * DAY }));
    const r = rig(mails, { costUsd: 0.1, config: { olderMail: 'off' }, older: false });
    const run = (await r.crawler.run())!;
    expect(run.error).toBe('budget');
    // Three lanes check before each call: it stops within a few cents of the budget.
    expect(r.asked.length).toBeGreaterThanOrEqual(5);
    expect(r.asked.length).toBeLessThanOrEqual(7);
    const p = r.crawler.progress();
    expect(p.spentToday).toBeGreaterThanOrEqual(0.5);
    expect(progressText(p, true)).toContain('The budget is spent, so cloud reading waits for tomorrow.');
    // Over budget: runIfDue doesn't run every five minutes on the cloud.
    const n = r.asked.length;
    r.setNow('2026-11-10T10:05');
    expect(await r.crawler.runIfDue()).toBe('not_due');
    expect(r.asked).toHaveLength(n);
    r.setNow('2026-11-11T10:00');
    expect(await r.crawler.runIfDue()).toBe('updated');
    expect(r.asked.length).toBeGreaterThan(n);
    expect(r.crawler.progress().spentTotal).toBeGreaterThan(p.spentToday);
  });

  it('0 turns cloud reading off; the local model is never counted', async () => {
    const mails: Mail[] = [{ id: 'INBOX:1', from: 'ana@home.example', at: START - DAY }];
    const off = rig(mails, { costUsd: 0.1, config: { dailyBudgetUsd: 0, olderMail: 'off' }, older: false });
    expect(await off.crawler.run()).toMatchObject({ error: 'budget' });
    // The first pass waits; new mail goes on the hourly local model instead.
    expect(off.asked.every((a) => a.role === 'local')).toBe(true);
    expect(progressText(off.crawler.progress(), true)).toContain('Cloud reading is off');
    expect(off.crawler.progress().spentTotal).toBe(0);
  });
});
