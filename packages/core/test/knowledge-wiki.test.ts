/**
 * K4: the knowledge wiki. The same no-tools reading names people, projects and organisations;
 * code files their facts on one page each with dates, sources and links both ways; a call with
 * no tools rewrites a changed page's summary; code writes index.md, log.md and the weekly
 * check; knowledge_search shows matching pages as outside text; Save on a reply files it.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeConfig as KnowledgeSchema, type KnowledgeConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { zonedToUtc } from '../src/calendar/time.js';
import { KnowledgeCrawler } from '../src/knowledge/crawler.js';
import { KnowledgeFile, emptyKnowledge } from '../src/knowledge/file.js';
import { knowledgeSearchTool } from '../src/knowledge/tool.js';
import { KnowledgeWiki, checkId, pageId, parsePage, renderPage, slugOf } from '../src/knowledge/wiki.js';
import type { FullMessage, ListedMail } from '../src/mail/imap.js';
import type { ModelRequest } from '../src/model.js';
import { chatSystemPrompt } from '../src/prompts.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const TZ = 'Europe/Istanbul';
const local = (s: string) => zonedToUtc(s, TZ).getTime();
const DAY = 86_400_000;
const CONFIG: KnowledgeConfig = { ...KnowledgeSchema.parse({}), backfillDays: 30, olderMail: 'off', perRun: 40 };

function mailbox(mails: { id: string; from: string; subject: string; text: string; at: number }[]) {
  const full = (m: (typeof mails)[number]): FullMessage => ({
    id: m.id,
    messageId: `<${m.id}@x>`,
    from: { name: m.from, address: `${m.from.split(' ')[0]!.toLowerCase()}@x.example` },
    to: [{ name: 'John', address: 'john@aios.test' }],
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
    list: async (o: { since: Date; before?: Date | undefined }): Promise<ListedMail[]> =>
      mails.filter((m) => m.at >= o.since.getTime() && (!o.before || m.at < o.before.getTime())).map((m) => ({ ...full(m), threadId: null, starred: false, important: false, bulkHeaders: {} })),
    read: async (id: string) => {
      const m = mails.find((x) => x.id === id);
      return m ? full(m) : null;
    },
  };
}

function rig(o: { config?: Partial<KnowledgeConfig> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-wiki-'));
  const store = new Store(':memory:');
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  let now = local('2026-11-10T10:00');
  const file = new KnowledgeFile(join(dir, 'knowledge'), 'John');
  const wiki = new KnowledgeWiki(file.dir);
  const mail = mailbox([
    { id: 'INBOX:1', from: 'Ana Lopez', subject: 'House move', text: 'The movers come on 3 Dec.', at: now - 2 * DAY },
    { id: 'INBOX:2', from: 'Ana Lopez', subject: 'Moving date', text: 'Sorry, the movers come on 10 Dec now.', at: now - DAY },
  ]);
  const requests: { req: ModelRequest; name: string }[] = [];
  const model = {
    structured: async (req: ModelRequest, name: string, schema: { parse: (v: unknown) => unknown }) => {
      requests.push({ req, name });
      const user = req.messages.at(-1)!.content!;
      let v: unknown = { notes: [] };
      if (name === 'knowledge_page')
        v = user.includes('Page: Ana Lopez')
          ? { summary: 'Ana Lopez may be helping with the **house move**; the movers now come on 10 Dec.', contradictions: ['The moving date is 3 Dec in one email and 10 Dec in a later one.'] }
          : { summary: 'Moving house in December.', contradictions: [] };
      // K5: each fact with its quote. "Sister" is a guess from someone else's email: code drops it.
      else if (user.includes('House move'))
        v = {
          notes: [{ section: 'people', text: 'Ana Lopez: helping with the house move.', basis: 'observed', quote: 'The movers come on 3 Dec' }],
          pages: [
            {
              kind: 'person',
              name: 'Ana Lopez',
              facts: [
                { text: 'Sister; helping with the house move.', basis: 'stated', quote: 'Ana Lopez' },
                { text: 'Helping with the house move.', basis: 'observed', quote: 'movers' },
                { text: 'Said the movers come on 3 Dec.', basis: 'stated', quote: 'The movers come on 3 Dec.' },
              ],
              links: [{ kind: 'project', name: 'House move' }],
            },
            { kind: 'project', name: 'House move', facts: [{ text: 'Movers booked for 3 Dec.', basis: 'observed', quote: 'movers come on 3 Dec' }] },
          ],
        };
      else if (user.includes('Moving date'))
        v = {
          notes: [],
          pages: [
            {
              kind: 'person',
              name: 'Ana Lopez',
              facts: [
                { text: 'Said the movers come on 10 Dec now.', basis: 'stated', quote: 'the movers come on 10 Dec now' },
                { text: 'Helping with the house move.', basis: 'observed', quote: 'movers' },
              ],
            },
          ],
        };
      return { value: schema.parse(v), result: {} };
    },
  };
  const checks: string[] = [];
  const crawler = new KnowledgeCrawler({
    config: { ...CONFIG, ...o.config },
    userName: 'John',
    timeZone: TZ,
    file,
    store,
    audit,
    mail,
    models: { backfill: { model: model as never, role: 'nightly' }, hourly: { model: model as never, role: 'local' } },
    isPaused: () => false,
    wiki,
    onCheck: (line) => checks.push(line),
    now: () => now,
  });
  return { dir, store, audit, file, wiki, crawler, requests, checks, setNow: (t: number) => (now = t) };
}

describe('K4 page names', () => {
  it('a page path is only its folder and a slug of letters, digits and dashes', () => {
    expect(slugOf('Ana López')).toBe('ana-lópez');
    expect(slugOf('Şirket A.Ş.')).toBe('şirket-a-ş');
    expect(slugOf('../../.ssh/config')).toBe('ssh-config');
    expect(slugOf('/etc/passwd')).toBe('etc-passwd');
    expect(slugOf('..')).toBeNull();
    expect(slugOf('   ')).toBeNull();
    expect(slugOf('a'.repeat(200))!.length).toBe(60);
    expect(pageId('person', 'C:\\Windows\\system32')).toBe('people/c-windows-system32');
    for (const bad of ['people/../x', '../people/x', 'people/x/y', 'people/', 'secrets/x', 'people/x.md', 'people/-x', 'people/x-']) expect(checkId(bad)).toBeNull();
    expect(checkId('orgs/hydro-ottawa')).toEqual({ kind: 'org', slug: 'hydro-ottawa' });
  });

  it('a page reads back as written, with the user lines and My notes kept', () => {
    const p = { id: 'people/ana-lopez', kind: 'person' as const, title: 'Ana Lopez', summary: 'Sister.', contradictions: ['Two dates.'], facts: [{ text: 'Likes tea', source: 'chat' as const, mine: true }, { text: 'Moving on 10 Dec', source: 'mail' as const, on: '2026-11-09' }], links: ['projects/house-move'], myNotes: 'Call her **Sunday**.', updated: '2026-11-10 10:00' };
    const md = renderPage(p);
    expect(md).toContain('- Moving on 10 Dec (mail, 2026-11-09)');
    expect(md).toContain('- [[projects/house-move]]');
    expect(parsePage(md, p.id, 'person')).toEqual(p);
    // A link line that names a path outside the folders is not a link.
    expect(parsePage(`${md}\n`.replace('- [[projects/house-move]]', '- [[../../memory/facts]]\n- [[people/ana-lopez]]'), p.id, 'person').links).toEqual([]);
  });
});

describe('K4 the wiki', () => {
  it('files facts on one page each, links both ways, summarises with no tools, and writes the index and log', async () => {
    const r = rig();
    const run = await r.crawler.run();
    expect(run).toMatchObject({ read: 2, pages: 2, summaries: 2 });

    const ana = r.wiki.read('people/ana-lopez')!;
    // Both emails' facts, newest first, deduplicated, with sources and dates. Two emails from
    // Ana are one origin, so even the fact both say stays unconfirmed; the guessed sister is gone.
    expect(ana.facts.map((f) => `${f.text} ${f.on}`)).toEqual(['Helping with the house move. 2026-11-09', 'Said the movers come on 10 Dec now. 2026-11-09', 'Said the movers come on 3 Dec. 2026-11-08']);
    expect(ana.facts.every((f) => f.unconfirmed)).toBe(true);
    expect(readFileSync(r.wiki.pathOf('people/ana-lopez')!, 'utf8')).toContain('- Helping with the house move. (mail, 2026-11-09, unconfirmed)');
    expect(ana.links).toEqual(['projects/house-move']);
    expect(r.wiki.read('projects/house-move')!.links).toEqual(['people/ana-lopez']);
    // The summary call's answer is stored as plain text, with what might not agree.
    expect(ana.summary).toBe('Ana Lopez may be helping with the house move; the movers now come on 10 Dec.');
    expect(ana.contradictions).toEqual(['The moving date is 3 Dec in one email and 10 Dec in a later one.']);

    const summaries = r.requests.filter((q) => q.name === 'knowledge_page');
    expect(summaries).toHaveLength(2);
    for (const { req } of r.requests) expect(Object.keys(req).sort()).toEqual(['messages', 'role']);
    expect(summaries[0]!.req.messages.at(-1)!.content).toMatch(/<untrusted source="knowledge" id="[^"]+">/);
    // The summary call sees which facts are only unconfirmed.
    expect(summaries.find((q) => q.req.messages.at(-1)!.content!.includes('Page: Ana Lopez'))!.req.messages.at(-1)!.content).toContain('- [unconfirmed] Said the movers come on 10 Dec now.');

    const index = readFileSync(r.wiki.indexPath, 'utf8');
    expect(index).toContain('## People (1)');
    expect(index).toContain('- [[people/ana-lopez]] Ana Lopez: Ana Lopez may be helping');
    expect(readFileSync(r.wiki.logPath, 'utf8')).toMatch(/- 2026-11-10 10:00 Filed 4 facts on 2 pages \(2 new\), rewrote 2 summaries: /);
    // Counts only in the audit log.
    const audit = readFileSync(join(r.dir, 'audit.jsonl'), 'utf8');
    expect(audit).not.toContain('Ana');
    expect(audit).not.toContain('movers');
  });

  it('keeps what the user typed on a page, and only adds', async () => {
    const r = rig();
    await r.crawler.run();
    const path = r.wiki.pathOf('people/ana-lopez')!;
    writeFileSync(path, readFileSync(path, 'utf8').replace('## Facts\n\n', '## Facts\n\n- Prefers calls after 6pm\n').replace('## My notes\n', '## My notes\n\nBirthday 2 March.\n'));
    r.wiki.file([{ kind: 'person', name: 'ANA  LOPEZ', text: 'Sent the inventory list.', links: [], source: 'mail', on: '2026-11-10' }], '2026-11-10 11:00');
    const ana = r.wiki.read('people/ana-lopez')!;
    expect(ana.title).toBe('Ana Lopez');
    expect(ana.facts[0]).toEqual({ text: 'Prefers calls after 6pm', source: 'chat', mine: true });
    expect(ana.facts).toHaveLength(5);
    expect(ana.myNotes).toBe('Birthday 2 March.');
  });

  it('summaries wait without a model and when the run stops', async () => {
    const r = rig({ config: { pageSummariesPerRun: 0 } });
    await r.crawler.run();
    expect(r.requests.filter((q) => q.name === 'knowledge_page')).toHaveLength(0);
    expect(r.wiki.read('people/ana-lopez')!.summary).toBe('');
    expect(JSON.parse(r.store.getSetting('knowledge.wikiDirty')!)).toEqual(['people/ana-lopez', 'projects/house-move']);
  });

  it('checks weekly by code: old commitments, duplicates, pages with no links', async () => {
    const r = rig();
    const k = emptyKnowledge();
    k.sections.commitments = [{ text: 'Send the lease to Hydro', source: 'mail', on: '2026-09-01' }, { text: 'Call Ana', source: 'mail', on: '2026-11-09' }];
    r.file.write(k, '2026-11-10', 14);
    await r.crawler.run();
    r.wiki.file([{ kind: 'person', name: 'Ana', text: 'Sister.', links: [], source: 'chat', on: '2026-11-10' }, { kind: 'org', name: 'Hydro Ottawa', text: 'Electricity supplier.', links: [], source: 'mail', on: '2026-11-10' }], '2026-11-10 10:05');

    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatch(/^Checked 2026-11-10 10:00: 2 pages\. 1 old commitments, 0 possible duplicates/);
    const text = r.crawler.check();
    expect(text).toContain('Checked 2026-11-10 10:00: 4 pages. 1 old commitments, 1 possible duplicates, 2 pages with no links, 1 pages whose facts might not agree.');
    expect(text).toContain('- Send the lease to Hydro (2026-09-01)');
    expect(text).toContain('- Ana and Ana Lopez');
    expect(text).toContain('- Hydro Ottawa');
    expect(readFileSync(r.wiki.checkPath, 'utf8')).toContain(text);

    // Not again within the week; again after it.
    r.setNow(local('2026-11-12T10:00'));
    await r.crawler.run();
    expect(r.checks).toHaveLength(1);
    r.setNow(local('2026-11-17T11:00'));
    await r.crawler.run();
    expect(r.checks).toHaveLength(2);
  });

  it('is off with wiki = false: no pages, no page facts stored', async () => {
    const r = rig();
    const off = new KnowledgeCrawler({ ...(r.crawler as unknown as { o: ConstructorParameters<typeof KnowledgeCrawler>[0] }).o, wiki: undefined });
    await off.run();
    expect(r.wiki.ids()).toEqual([]);
    expect(existsSync(join(r.file.dir, 'people'))).toBe(false);
  });
});

describe('K4 knowledge_search and Save', () => {
  it('finds pages by name and words, as outside text', async () => {
    const r = rig();
    await r.crawler.run();
    const tool = knowledgeSearchTool({ file: r.file, wiki: r.wiki });
    expect(tool.def.tier).toBe('read');
    expect(tool.untrustedOutput).toBe(true);
    const out = String(await tool.handler({ query: 'Ana house move' }, { signal: AbortSignal.timeout(1000) } as never));
    expect(out).toMatch(/^Knowledge base results for "Ana house move" \(2 pages/);
    expect(out).toContain('<untrusted source="knowledge" id="search">');
    expect(out.indexOf('# Ana Lopez')).toBeLessThan(out.indexOf('# House move'));
    expect(out).toContain('[people] Ana Lopez: helping with the house move. (mail, 2026-11-08, unconfirmed)');
    expect(out).toContain('never state it to the user as a fact');
    expect(await tool.handler({ query: 'zzz' }, {} as never)).toContain('Nothing in the knowledge base matches "zzz"');
    expect(chatSystemPrompt({ userName: 'John', now: 'now', knowledge: true, knowledgeSearch: true })).toContain('call knowledge_search with the name');
  });

  it('Save on a reply files it as a saved answer, once; nothing else can be saved', async () => {
    const r = rig();
    await r.crawler.run();
    const audit = new AuditLog(join(r.dir, 'audit2.jsonl'));
    const saved: string[] = [];
    const model = { async *stream() {} } as never;
    const shell = new Shell({
      store: r.store,
      model,
      tools: new ToolRegistry(audit),
      audit,
      userName: 'John',
      timeZone: TZ,
      modelName: 'm',
      costCapUsd: 2,
      readBattery: async () => null,
      readWifi: async () => null,
      knowledge: {
        view: () => '',
        run: async () => null,
        save: (text) => {
          const id = r.wiki.saveAnswer(text, '2026-11-10 12:00');
          if (id) saved.push(id);
          return id;
        },
      },
    });
    expect(shell.status().knowledge).toBe(true);
    r.store.saveItem({ kind: 'assistant', id: 'a1', text: 'Ana Lopez moves on **10 Dec**.\n\n- Movers booked\n- Keys on the 9th', at: 1, streaming: false });
    r.store.saveItem({ kind: 'notice', id: 'n1', level: 'info', text: 'not a reply', at: 1 } as never);
    r.store.saveItem({ kind: 'assistant', id: 'a2', text: 'still typing', at: 1, streaming: true });
    await shell.handle({ type: 'knowledge_save', id: 'n1' });
    await shell.handle({ type: 'knowledge_save', id: 'a2' });
    await shell.handle({ type: 'knowledge_save', id: 'nope' });
    expect(saved).toEqual([]);
    await shell.handle({ type: 'knowledge_save', id: 'a1' });
    await shell.handle({ type: 'knowledge_save', id: 'a1' });
    expect(saved).toEqual(['saved/2026-11-10-ana-lopez-moves-on-10-dec']);
    expect(r.store.getItem('a1')).toMatchObject({ savedToKnowledge: true });
    const page = r.wiki.read(saved[0]!)!;
    expect(page.facts.map((f) => f.text)).toEqual(['Ana Lopez moves on 10 Dec.', 'Movers booked', 'Keys on the 9th']);
    expect(page.links).toEqual(['people/ana-lopez']);
    expect(readdirSync(join(r.file.dir, 'saved'))).toEqual(['2026-11-10-ana-lopez-moves-on-10-dec.md']);
  });
});
