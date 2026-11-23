/**
 * K5: the knowledge base keeps only what an item really says. Every fact has an exact quote that
 * code finds in the item; a relationship only from the user's own words; a liking only in the
 * words of whoever likes it; nothing inferred; the local model only records what happened. Each
 * fact keeps its sources (/knowledge why), is known only from the user's words or two separate
 * origins, and once the user says it is wrong (/knowledge wrong, or deleting the line) it is
 * never learned again. Chat is read from the user's lines only. On its first run, the old
 * notes become unconfirmed and recent items are read again.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeConfig as KnowledgeSchema, type KnowledgeConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { zonedToUtc } from '../src/calendar/time.js';
import { KnowledgeCrawler } from '../src/knowledge/crawler.js';
import { checkFact, quoted, relationOf } from '../src/knowledge/evidence.js';
import { chatItem, cleanExtracted, cleanPages, mailItem } from '../src/knowledge/extract.js';
import { KnowledgeFacts, ME } from '../src/knowledge/facts.js';
import { KnowledgeFile, emptyKnowledge } from '../src/knowledge/file.js';
import { KnowledgeWiki } from '../src/knowledge/wiki.js';
import type { FullMessage, ListedMail } from '../src/mail/imap.js';
import type { ModelRequest } from '../src/model.js';
import { Store } from '../src/store.js';

const TZ = 'Europe/Istanbul';
const local = (s: string) => zonedToUtc(s, TZ).getTime();
const DAY = 86_400_000;

const received = (from: string, text: string) => mailItem('nightly', 'Deniz Arslan', { id: 'm', sentByUser: false, from, to: ['Deniz Arslan <deniz@aios.test>'], date: '2026-10-02 18:40', subject: 'Hi', body: { text } }).check;
const sent = (text: string) => mailItem('nightly', 'Deniz Arslan', { id: 'm', sentByUser: true, from: 'Deniz Arslan <deniz@aios.test>', to: ['Hakan Demir <hakan@x>'], date: '2026-10-05 09:12', subject: 'Saturday', body: { text } }).check;
const cloud = <T extends object>(c: T) => ({ ...c, judgement: true });

describe('K5 code checks every fact against the item', () => {
  it('finds quotes on letters and digits only, and names relationships', () => {
    expect(quoted('my sister  Ece is', 'Sorry. My sister Ece is flying in')).toBe(true);
    expect(quoted('my sister Ece', 'my sisterEce')).toBe(false);
    expect(quoted('Ece', 'Ecem called')).toBe(false);
    expect(quoted('a', 'a b c')).toBe(false);
    expect(relationOf('Buket Sarer: sister')).toBe('sister');
    expect(relationOf('Olga Kozel: co-worker at Halcyon')).toBe('colleague');
    expect(relationOf('Mark Tellez: Project Manager at Acme Build')).toBeNull();
  });

  it('a shared surname, a "hey bro" or another person\'s words never make a relationship', () => {
    const selin = cloud(received('Selin Arslan <selin@x>', 'Hi Deniz, I finished the book you lent me.\n\nSelin'));
    expect(checkFact({ text: 'Selin Arslan: sister', basis: 'stated', quote: 'Selin Arslan', aboutUser: true, section: 'people' }, selin)).toEqual({ ok: false, why: 'relation' });
    expect(checkFact({ text: 'Selin Arslan: sister', basis: 'inferred', quote: 'Selin Arslan', aboutUser: true }, selin)).toEqual({ ok: false, why: 'inferred' });
    expect(checkFact({ text: 'Selin Arslan: returning the book', basis: 'stated', quote: 'I finished the book you lent me', aboutUser: true }, selin)).toMatchObject({ ok: true, byUser: false, relation: null });
    const can = cloud(received('Can Yilmaz <can@x>', 'hey bro, are you still up for the match on Sunday?'));
    expect(checkFact({ text: 'Can Yilmaz: brother', basis: 'stated', quote: 'hey bro', aboutUser: true }, can)).toEqual({ ok: false, why: 'relation' });
    // Someone else's "my colleague" is theirs.
    const jo = cloud(received('Jo <jo@x>', 'My colleague Olga will join the call.'));
    expect(checkFact({ text: 'Olga: colleague', basis: 'stated', quote: 'My colleague Olga', aboutUser: false }, jo)).toEqual({ ok: false, why: 'relation' });
  });

  it('a relationship in the user\'s own words is kept, with the relation, and only from their part of the email', () => {
    const mine = cloud(sent('Sorry, I cannot make it. My sister Ece is flying in from Berlin.'));
    expect(checkFact({ text: 'Ece: sister, flying in from Berlin', basis: 'stated', quote: 'My sister Ece is flying in', aboutUser: true, section: 'people' }, mine)).toEqual({
      ok: true,
      relation: 'sister',
      byUser: true,
      quote: 'My sister Ece is flying in',
    });
    // The quote must name the same relationship.
    expect(checkFact({ text: 'Ece: cousin', basis: 'stated', quote: 'My sister Ece', aboutUser: true }, mine)).toEqual({ ok: false, why: 'relation' });
    // A quote from the headers is in the item, but not the user's words.
    expect(checkFact({ text: 'Hakan Demir: friend', basis: 'stated', quote: 'Hakan Demir', aboutUser: true }, mine)).toEqual({ ok: false, why: 'relation' });
  });

  it('a place on a booking is not a liking; someone else\'s liking is theirs; the user\'s interest only in their words', () => {
    const hotel = cloud(received('Riverside Suites <r@x>', 'Thank you for booking with Riverside Suites Jacksonville. Check-in: 3 October.'));
    expect(checkFact({ text: 'Likes Jacksonville', basis: 'observed', quote: 'Riverside Suites Jacksonville', aboutUser: true, section: 'interests' }, hotel)).toEqual({ ok: false, why: 'liking' });
    expect(checkFact({ text: 'Visits Jacksonville often', basis: 'stated', quote: 'booking with Riverside Suites Jacksonville', aboutUser: true, section: 'interests' }, hotel)).toEqual({ ok: false, why: 'liking' });
    expect(checkFact({ text: 'Booked Riverside Suites Jacksonville for 3 Oct', basis: 'observed', quote: 'booking with Riverside Suites Jacksonville', aboutUser: true, section: 'recent' }, hotel)).toMatchObject({ ok: true });
    const jonah = cloud(received('Jonah Pike <j@x>', 'We are settled in Austin. I love it here.'));
    expect(checkFact({ text: 'Loves Austin', basis: 'stated', quote: 'I love it here', aboutUser: true, section: 'interests' }, jonah)).toEqual({ ok: false, why: 'liking' });
    expect(checkFact({ text: 'Loves living in Austin', basis: 'stated', quote: 'I love it here', aboutUser: false }, jonah)).toMatchObject({ ok: true });
    expect(checkFact({ text: 'Loves living in Austin', basis: 'observed', quote: 'settled in Austin', aboutUser: false }, jonah)).toEqual({ ok: false, why: 'liking' });
    const tennis = cloud(sent('Saturday is out, I play tennis every Saturday and I really love it.'));
    expect(checkFact({ text: 'Plays tennis every Saturday and loves it', basis: 'stated', quote: 'I play tennis every Saturday and I really love it', aboutUser: true, section: 'interests' }, tennis)).toMatchObject({ ok: true, byUser: true });
  });

  it('a quote that isn\'t in the item drops the fact; the local model only records what happened', () => {
    const mine = sent('My sister Ece is flying in on Saturday.');
    expect(checkFact({ text: 'Ece: flying in Saturday', basis: 'stated', quote: 'Ece lands at 9', aboutUser: true }, cloud(mine))).toEqual({ ok: false, why: 'quote_not_found' });
    expect(checkFact({ text: 'Ece: flying in Saturday', basis: 'stated', quote: '', aboutUser: true }, cloud(mine))).toEqual({ ok: false, why: 'no_quote' });
    const small = { ...mine, judgement: false };
    expect(checkFact({ text: 'Ece: sister', basis: 'stated', quote: 'My sister Ece', aboutUser: true }, small)).toEqual({ ok: false, why: 'judgement' });
    expect(checkFact({ text: 'Plays tennis', basis: 'stated', quote: 'My sister Ece', aboutUser: true, section: 'interests' }, small)).toEqual({ ok: false, why: 'judgement' });
    expect(checkFact({ text: 'Ece: flying in on Saturday', basis: 'stated', quote: 'Ece is flying in on Saturday', aboutUser: true }, small)).toMatchObject({ ok: true });
  });

  it('cleans a whole answer: counts what it drops, and keeps no page for a made-up person', () => {
    const item = cloud(received('Selin Arslan <selin@x>', 'I finished the book you lent me.'));
    const dropped = {};
    const answer = {
      notes: [
        { section: 'people' as const, text: 'Selin Arslan: sister', basis: 'stated' as const, quote: 'Selin Arslan' },
        { section: 'people' as const, text: 'Selin Arslan: returning the book', basis: 'stated' as const, quote: 'I finished the book you lent me' },
        { section: 'recent' as const, text: 'Got a book back', basis: 'inferred' as const, quote: 'book' },
      ],
      pages: [
        { kind: 'person' as const, name: 'Selin Arslan', facts: [{ text: 'Sister of the user', basis: 'stated' as const, quote: 'Selin' }], links: [{ kind: 'person' as const, name: 'Buket Arslan' }] },
        { kind: 'person' as const, name: 'Buket Arslan', facts: [], links: [{ kind: 'person' as const, name: 'Selin Arslan' }] },
      ],
    };
    expect(cleanExtracted(answer, item, dropped).map((n) => n.text)).toEqual(['Selin Arslan: returning the book']);
    // Selin is named in the email, so her page (and its link) stays; Buket is made up.
    expect(cleanPages(answer, item, dropped).map((p) => [p.name, p.facts.length])).toEqual([['Selin Arslan', 0]]);
    expect(dropped).toEqual({ relation: 2, inferred: 1 });
  });

  it('chat is read from the user\'s lines only', () => {
    const c = chatItem('nightly', 'Deniz', ['draft a reply to Buket saying Thursday is fine']);
    expect(c.check.own).toBe(c.check.text);
    expect(c.request.messages.at(-1)!.content).toContain('What Deniz typed to their assistant');
  });
});

describe('K5 facts and their sources', () => {
  const ev = (itemKey: string, origin: string, byUser = false) => ({ itemKey, kind: 'mail' as const, quote: 'q q q', byUser, origin, label: 'email', at: 1 });

  it('is known from the user\'s words or two origins; two emails from one sender confirm nothing', () => {
    const f = new KnowledgeFacts(new Store(':memory:'));
    const add = (text: string, key: string, origin: string, byUser = false) => f.add({ subject: 'people/ana', text, basis: 'stated', source: 'mail', on: '2026-11-01', evidence: ev(key, origin, byUser) }, 1);
    expect(add('Moving on 3 Dec', 'mail:1', 'ana')).toMatchObject({ added: true, state: 'unconfirmed' });
    expect(add('Moving on 3 Dec', 'mail:2', 'ana')).toMatchObject({ added: false, state: 'unconfirmed' });
    expect(add('moving on 3 dec!', 'mail:3', 'kemal')).toMatchObject({ added: false, state: 'known' });
    expect(add('Helps with the move', 'mail:4', 'user', true)).toMatchObject({ state: 'known' });
    expect(f.forSubject('people/ana').map((x) => [x.text, x.state, x.evidence.length])).toEqual([
      ['Helps with the move', 'known', 1],
      ['Moving on 3 Dec', 'known', 3],
    ]);
  });

  it('a newer note never replaces an older one, and a wrong fact or relation is never learned again', () => {
    const f = new KnowledgeFacts(new Store(':memory:'));
    const add = (text: string, relation: string | null = null) => f.add({ subject: ME, section: 'people', about: 'people/buket-sarer', text, basis: 'stated', relation, source: 'mail', evidence: ev(`mail:${text}`, 'user', true) }, 1);
    const sister = add('Buket Sarer: sister', 'sister');
    add('Buket Sarer: asked about the flat');
    expect(f.of(ME, 'people')).toHaveLength(2);
    if (!('id' in sister)) throw new Error('added');
    f.setWrong(sister.id, 2);
    expect(f.of(ME, 'people').map((x) => x.text)).toEqual(['Buket Sarer: asked about the flat']);
    expect(add('Buket Sarer: sister')).toEqual({ blocked: true });
    expect(add('Buket Sarer: my sister, visiting', 'sister')).toEqual({ blocked: true });
    expect(add('Buket Sarer: visiting on Friday')).toMatchObject({ added: true });
    // Still kept, marked wrong, so it is never learned again.
    expect(f.forSubject('people/buket-sarer', { wrong: true }).find((x) => x.id === sister.id)!.state).toBe('wrong');
  });
});

// ── The crawler with facts ──

function mailbox(mails: { id: string; from: string; address: string; to?: string; subject: string; text: string; at: number }[]) {
  const full = (m: (typeof mails)[number]): FullMessage => ({
    id: m.id,
    messageId: `<${m.id}@x>`,
    from: { name: m.from, address: m.address },
    to: [{ name: m.to ?? 'John', address: m.to ? 'kemal@work.example' : 'john@aios.test' }],
    subject: m.subject,
    date: new Date(m.at),
    cc: [],
    replyTo: [],
    inReplyTo: null,
    references: [],
    text: m.text,
    html: null,
    attachments: [],
  });
  return {
    mails,
    list: async (o: { since: Date; before?: Date | undefined }): Promise<ListedMail[]> =>
      mails.filter((m) => m.at >= o.since.getTime() && (!o.before || m.at < o.before.getTime())).map((m) => ({ ...full(m), threadId: null, starred: false, important: false, bulkHeaders: {} })),
    read: async (id: string) => {
      const m = mails.find((x) => x.id === id);
      return m ? full(m) : null;
    },
  };
}

/** A model that writes what the old prompt made models write: a "sister" for Buket, and the user's sister Ece from their own mail. */
function rig(o: { config?: Partial<KnowledgeConfig>; before?: (file: KnowledgeFile, store: Store) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-facts-'));
  const store = new Store(':memory:');
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  let now = local('2026-11-10T10:00');
  const file = new KnowledgeFile(join(dir, 'knowledge'), 'John');
  const wiki = new KnowledgeWiki(file.dir);
  o.before?.(file, store);
  const box = mailbox([
    { id: 'INBOX:1', from: 'Buket Sarer', address: 'buket@x.example', subject: 'The flat', text: 'Can we look at the flat on Thursday?', at: now - 2 * DAY },
    { id: 'Sent:1', from: 'John', address: 'john@aios.test', to: 'Kemal Arslan', subject: 'Saturday', text: 'I cannot come, my sister Ece is visiting on Saturday.', at: now - 3 * DAY },
  ]);
  const requests: ModelRequest[] = [];
  const model = {
    structured: async (req: ModelRequest, name: string, schema: { parse: (v: unknown) => unknown }) => {
      requests.push(req);
      const user = req.messages.at(-1)!.content!;
      let v: unknown = { notes: [] };
      if (name === 'knowledge_page') v = { summary: 'A page.', contradictions: [] };
      else if (user.includes('The flat'))
        v = {
          notes: [
            { section: 'people', text: 'Buket Sarer: sister', basis: 'stated', quote: 'Buket Sarer' },
            { section: 'people', text: 'Buket Sarer: asked to see the flat on Thursday', basis: 'stated', quote: 'Can we look at the flat on Thursday?' },
          ],
          pages: [{ kind: 'person', name: 'Buket Sarer', facts: [{ text: 'Wants to see the flat on Thursday', basis: 'stated', quote: 'look at the flat on Thursday' }] }],
        };
      else if (user.includes('Saturday'))
        v = { notes: [{ section: 'people', text: 'Ece: sister, visiting on Saturday', basis: 'stated', quote: 'my sister Ece is visiting on Saturday' }] };
      else if (user.includes('typed to their assistant')) v = { notes: [{ section: 'people', text: 'Buket: sister', basis: 'stated', quote: 'your sister Buket' }] };
      return { value: schema.parse(v), result: {} };
    },
  };
  const crawler = new KnowledgeCrawler({
    config: { ...KnowledgeSchema.parse({}), backfillDays: 30, olderMail: 'off', perRun: 40, ...o.config },
    userName: 'John',
    userAddresses: ['john@aios.test'],
    timeZone: TZ,
    file,
    store,
    audit,
    mail: box,
    models: { backfill: { model: model as never, role: 'nightly' }, hourly: { model: model as never, role: 'local' } },
    isPaused: () => false,
    wiki,
    now: () => now,
  });
  return { dir, store, file, wiki, crawler, box, requests, audit: join(dir, 'audit.jsonl'), setNow: (s: string) => (now = local(s)) };
}

describe('K5 the crawler', () => {
  it('keeps the stated sister, drops the guessed one, and says where each line came from', async () => {
    const r = rig();
    const run = (await r.crawler.run())!;
    expect(run.dropped).toEqual({ relation: 1 });
    const people = r.file.read().sections.people;
    expect(people).toEqual([
      { text: 'Ece: sister, visiting on Saturday', source: 'mail', on: '2026-11-07' },
      { text: 'Buket Sarer: asked to see the flat on Thursday', source: 'mail', on: '2026-11-08', unconfirmed: true },
    ]);
    expect(readFileSync(r.file.path, 'utf8')).toContain('- Buket Sarer: asked to see the flat on Thursday (mail, 2026-11-08, unconfirmed)');
    const why = r.crawler.why('Ece sister');
    expect(why).toMatch(/#\d+ Ece: sister, visiting on Saturday\nAbout you, people\. known: in your own words\.\nFrom your email to Kemal Arslan, Sat 7 Nov: Saturday: "my sister Ece is visiting on Saturday"/);
    expect(r.crawler.why('Buket')).toContain('unconfirmed: one source so far');
    expect(r.crawler.why('zzz')).toContain('No line in the knowledge base matches');
    // The profiles' view of a person: their page's facts and the overview lines about them.
    expect(r.crawler.facts.forSubject('people/buket-sarer').map((f) => f.text)).toEqual(['Wants to see the flat on Thursday', 'Buket Sarer: asked to see the flat on Thursday']);
    expect(r.crawler.facts.forSubject('people/ece').map((f) => [f.text, f.relation, f.state])).toEqual([['Ece: sister, visiting on Saturday', 'sister', 'known']]);
    // Counts only in the audit log.
    expect(readFileSync(r.audit, 'utf8')).not.toMatch(/Buket|Ece|flat/);
  });

  it('/knowledge wrong takes a line out for good, and so does deleting it from the file', async () => {
    const r = rig();
    await r.crawler.run();
    const id = Number(/#(\d+) Ece/.exec(r.crawler.why('Ece'))![1]);
    expect(r.crawler.wrong(id)).toBe('Taken out: "Ece: sister, visiting on Saturday". Astra won\'t learn it again, or that this person is your sister.');
    expect(r.file.read().sections.people.map((n) => n.text)).toEqual(['Buket Sarer: asked to see the flat on Thursday']);
    expect(r.crawler.wrong(id)).toContain('There is no line');
    expect(r.crawler.wrong(99999)).toContain('There is no line');
    // The user deletes Buket's line and types their own.
    writeFileSync(r.file.path, readFileSync(r.file.path, 'utf8').replace(/- Buket Sarer: asked.*\n/, '- Buket: my landlord\n'));
    // The same items, read again, give the same facts: none comes back.
    r.store.db.prepare("UPDATE knowledge_items SET state = 'pending'").run();
    r.setNow('2026-11-10T11:30');
    await r.crawler.run();
    expect(r.file.read().sections.people).toEqual([{ text: 'Buket: my landlord', source: 'chat', mine: true }]);
    expect(r.crawler.facts.forSubject('people/buket-sarer', { wrong: true }).find((f) => f.subject === ME)!.state).toBe('wrong');
  });

  it('a line deleted from a wiki page is wrong too, and a typed one is the user\'s', async () => {
    const r = rig();
    await r.crawler.run();
    const path = r.wiki.pathOf('people/buket-sarer')!;
    writeFileSync(path, readFileSync(path, 'utf8').replace(/- Wants to see the flat.*\n/, '- Owns the flat on Elm Street\n'));
    r.store.db.prepare("UPDATE knowledge_items SET state = 'pending'").run();
    r.setNow('2026-11-10T11:30');
    await r.crawler.run();
    expect(r.wiki.read('people/buket-sarer')!.facts).toEqual([{ text: 'Owns the flat on Elm Street', source: 'chat', mine: true }]);
  });

  it('reads chat from the user\'s lines only, never the assistant\'s', async () => {
    const r = rig();
    await r.crawler.run();
    r.requests.length = 0;
    r.store.saveTurn({ role: 'user', content: 'draft a reply to Buket saying Thursday is fine' }, local('2026-11-10T10:30'));
    r.store.saveTurn({ role: 'assistant', content: 'Here is a draft reply to your sister Buket: "Thursday works."' }, local('2026-11-10T10:31'));
    r.setNow('2026-11-10T11:30');
    await r.crawler.run();
    const chat = r.requests.find((q) => q.messages.at(-1)!.content!.includes('typed to their assistant'))!;
    expect(chat.role).toBe('nightly');
    expect(chat.messages.at(-1)!.content).toContain('draft a reply to Buket saying Thursday is fine');
    expect(chat.messages.at(-1)!.content).not.toContain('your sister');
    // The model's "Buket: sister" quotes words that aren't in what the user typed: dropped.
    expect(r.file.read().sections.people.map((n) => n.text)).not.toContain('Buket: sister');
  });

  it('on its first run, old notes become unconfirmed, the user\'s stay theirs, and recent items are read again', async () => {
    const r = rig({
      config: { backfillDays: 0 },
      before: (file, store) => {
        const k = emptyKnowledge();
        k.sections.people = [
          { text: 'Buket Sarer: sister', source: 'mail', on: '2026-10-03' },
          { text: 'Kemal: my manager', source: 'chat', mine: true },
        ];
        k.sections.interests = [{ text: 'Likes Jacksonville', source: 'calendar', on: '2026-10-01' }];
        file.write(k, '2026-11-01', 14);
        // Read before K5: merged, with no quotes kept.
        const old = local('2026-11-08T10:00');
        store.db
          .prepare("INSERT INTO knowledge_items (key, kind, ref, at, phase, state, updated_at, priority) VALUES ('mail:<INBOX:1@x>', 'mail', 'INBOX:1', ?, 'hourly', 'merged', ?, 3), ('mail:<old@x>', 'mail', 'INBOX:0', ?, 'hourly', 'merged', ?, 3)")
          .run(old, old, old - 60 * DAY, old);
      },
    });
    const run = (await r.crawler.run())!;
    expect(run.reread).toBe(1);
    const k = r.file.read();
    expect(k.sections.people).toEqual([
      { text: 'Kemal: my manager', source: 'chat', mine: true },
      // Re-read under the new rules: Buket's email gives what it says, not a sister.
      { text: 'Buket Sarer: asked to see the flat on Thursday', source: 'mail', on: '2026-11-08', unconfirmed: true },
      { text: 'Buket Sarer: sister', source: 'mail', on: '2026-10-03', unconfirmed: true },
    ]);
    expect(k.sections.interests).toEqual([{ text: 'Likes Jacksonville', source: 'calendar', on: '2026-10-01', unconfirmed: true }]);
    expect(r.crawler.why('Jacksonville')).toContain('Written before Astra kept sources');
    // Only once.
    expect((await r.crawler.run())!.reread).toBe(0);
  });
});
