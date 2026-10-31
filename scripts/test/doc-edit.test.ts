/**
 * D2: changing Word and Excel files, and creating new ones, through (pretend) WordCraft and
 * GridCraft. A model call only ever puts a card in the chat; the file is written by the
 * Save click on that card, carrying its hash, to a new file unless the user's own words
 * asked to overwrite (and then after a backup). Cards may appear while a document is in
 * view, never while an email or calendar event is.
 */
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  DocActions,
  DocEngine,
  DocFiles,
  DocPathError,
  DocumentFiles,
  RecipeError,
  SheetChange,
  Store,
  ToolRegistry,
  WordChange,
  cellMatches,
  editTools,
  onlyDocuments,
  sheetChangesProblem,
  sheetChecks,
  sheetCommands,
  untrustedSources,
  userAskedOverwrite,
  wordCommands,
  type UntrustedSource,
} from '@aios/core';
import type { ChatItem } from '@aios/shared';
import { ClientMessage } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { fakeDocBytes, makeDocFixture } from '../../fixtures/documents.js';

type ChangeCard = Extract<ChatItem, { kind: 'doc_change' }>;

function rig() {
  const fx = makeDocFixture();
  const dir = mkdtempSync(join(tmpdir(), 'aios-docedit-'));
  const auditPath = join(dir, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const store = new Store(':memory:');
  const files = new DocFiles({ roots: ['~/Documents'], home: fx.home });
  const engine = new DocEngine({ wordCli: fx.wordCli, sheetCli: fx.sheetCli, timeoutMs: 10_000 });
  const posted: ChatItem[] = [];
  const viewer = new DocumentFiles({ store, files, engine, audit, post: (i) => (store.saveItem(i), posted.push(i)) });
  const cards = new Map<string, ChangeCard>();
  const backupDir = join(dir, 'backups');
  let n = 0;
  const actions = new DocActions({
    store,
    files,
    engine,
    viewer,
    audit,
    backupDir,
    show: (item) => void (item.kind === 'doc_change' && cards.set(item.id, item)),
    clock: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    newId: () => `card${++n}`,
  });
  const tools = new ToolRegistry(audit);
  for (const t of editTools({ files, engine, actions })) tools.register(t);
  const call = (name: string, args: unknown, o: { userText?: string; sources?: UntrustedSource[]; untrusted?: boolean } = {}) =>
    tools.execute(
      { id: name, name, arguments: JSON.stringify(args) },
      {
        signal: new AbortController().signal,
        untrustedInContext: o.untrusted ?? !!o.sources?.length,
        ...(o.sources ? { untrustedSources: new Set(o.sources) } : {}),
        userText: o.userText ?? 'please change it',
      },
    );
  const doc = (p: string) => JSON.parse(readFileSync(join(fx.documents, p)).subarray(4).toString('utf8')) as { text?: string; sheets?: { name: string; rows: unknown[][] }[]; applied?: { command: string }[] };
  const log = () => readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const last = () => [...cards.values()].at(-1)!;
  return { fx, files, engine, actions, tools, call, cards, last, doc, log, auditPath, backupDir, store, posted };
}

describe('the fixed list of changes', () => {
  it('refuses anything not on the list', () => {
    expect(WordChange.safeParse({ op: 'macro', code: 'Shell("rm -rf ~")' }).success).toBe(false);
    expect(WordChange.safeParse({ op: 'replace', find: 'a', replace: 'b', command: 'file.save' }).success).toBe(false);
    expect(SheetChange.safeParse({ op: 'run', command: 'file.open' }).success).toBe(false);
    expect(SheetChange.safeParse({ op: 'set', range: 'not a range', values: [[1]] }).success).toBe(false);
  });

  it('allows only calculation formulas, and a limited number of cells', () => {
    expect(sheetChangesProblem([{ op: 'set', range: 'E2', values: [['=SUM(C2:D2)']] }])).toBeNull();
    expect(sheetChangesProblem([{ op: 'set', range: 'E2', values: [['=WEBSERVICE("https://evil.example")']] }])).toMatch(/WEBSERVICE/);
    const big = Array.from({ length: 200 }, () => Array.from({ length: 30 }, () => 1));
    expect(sheetChangesProblem([{ op: 'set', range: 'A1', values: big }])).toMatch(/at most/);
  });

  it('turns Word changes into select-and-type commands, refusing text that is not there', () => {
    const text = 'Revenue grew 12% in Q3. Revenue is up.';
    const { commands, lines } = wordCommands([{ op: 'replace', find: 'Revenue', replace: 'Turnover', all: true }], text);
    expect(commands).toEqual([
      { command: 'select.text', params: { text: 'Revenue' } },
      { command: 'text.insert', params: { text: 'Turnover', raw: true } },
      { command: 'select.text', params: { text: 'Revenue' } },
      { command: 'text.insert', params: { text: 'Turnover', raw: true } },
    ]);
    expect(wordCommands([{ op: 'delete', find: 'Revenue is up.' }], text).commands[1]).toEqual({ command: 'text.delete' });
    expect(() => wordCommands([{ op: 'delete', find: 'Q3.\nRevenue' }], 'Q3.\nRevenue')).toThrow(/one paragraph/);
    expect(wordCommands([{ op: 'style', find: 'Revenue grew', style: 'Heading1' }], text).commands[1]).toEqual({ command: 'para.style', params: { style: 'Heading 1' } });
    expect(lines[0]).toEqual({ what: 'Replace (all 2)', before: 'Revenue', after: 'Turnover' });
    expect(() => wordCommands([{ op: 'delete', find: 'profit' }], text)).toThrow(RecipeError);
    expect(() => wordCommands([{ op: 'replace', find: 'Revenue', replace: 'Revenue total', all: true }], text)).toThrow(/one at a time/);
    expect(wordCommands([{ op: 'format', find: 'Q3', bold: true, color: '#1f4e79' }], text).commands[1]).toEqual({ command: 'format.set', params: { props: { bold: true, color: '1F4E79' } } });
  });

  it('starts a new document without an empty first line', () => {
    const { commands } = wordCommands([{ op: 'append', paragraphs: [{ text: 'Title', style: 'Title' }, { text: 'Body' }] }], '');
    expect(commands.filter((c) => c.command === 'text.insert').map((c) => c.params?.text)).toEqual(['Title', '\nBody']);
    expect(commands).toContainEqual({ command: 'para.style', params: { style: 'Title' } });
  });

  it('clears a list before setting bullets, since bullets are a toggle', () => {
    const { commands } = wordCommands([{ op: 'append', paragraphs: [{ text: 'One' }], bullets: true }], 'Intro');
    expect(commands.map((c) => [c.command, c.params])).toEqual([
      ['caret.docEnd', undefined],
      ['text.insert', { text: '\nOne', raw: true }],
      ['para.bullets', { off: true }],
      ['para.bullets', {}],
    ]);
    expect(() => wordCommands([{ op: 'append', paragraphs: [{ text: 'a\nb' }] }], '')).toThrow(/own entry/);
  });

  it('turns sheet changes into commands, and reads back only values nothing moved', () => {
    const changes: SheetChange[] = [
      { op: 'set', range: 'E1', values: [['Price'], [20]] },
      { op: 'format', range: 'A1:E1', bold: true, fillColor: 'ddeeff' },
      { op: 'set', range: 'F2', values: [['=D2/C2']] },
    ];
    const { commands } = sheetCommands(changes);
    expect(commands[0]).toEqual({ command: 'range.setValues', params: { range: 'E1:E2', values: [['Price'], [20]] } });
    expect(commands).toContainEqual({ command: 'home.fillColor', params: { range: 'A1:E1', color: '#DDEEFF' } });
    expect(commands).toContainEqual({ command: 'home.bold', params: { range: 'A1:E1', on: true } });
    expect(sheetChecks(changes)).toEqual([{ range: 'E1:E2', values: [['Price'], ['20']] }]);
    const lines = sheetCommands([
      { op: 'insert_rows', before: 3, count: 2 },
      { op: 'delete_columns', from: 'B', count: 3 },
      { op: 'format', range: 'D2:D9', numberFormat: '0.0%' },
    ]).commands;
    expect(lines).toEqual([
      { command: 'home.insertRows', params: { rows: '3:4' } },
      { command: 'home.deleteColumns', params: { cols: 'B:D' } },
      { command: 'home.numberFormat', params: { range: 'D2:D9', code: '0.0%' } },
    ]);
    expect(sheetChecks([...changes, { op: 'insert_rows', before: 1, count: 1 }])).toEqual([]);
    expect(cellMatches('1,200.00', '1200')).toBe(true);
    expect(cellMatches('12', '13')).toBe(false);
  });
});

describe('new file names', () => {
  it('saves edits next to the original under a name that is free', async () => {
    const { files, fx } = rig();
    const f = await files.resolve('report.docx');
    expect(await files.editedName(f)).toBe(join(fx.documents, 'report-edited.docx'));
    writeFileSync(join(fx.documents, 'report-edited.docx'), fakeDocBytes({ text: 'x' }));
    expect(await files.editedName(f)).toBe(join(fx.documents, 'report-edited-2.docx'));
    expect(await files.editedName(await files.resolve('report-edited.docx'))).toBe(join(fx.documents, 'report-edited-2.docx'));
  });

  it('puts new files in the first folder with a plain name, never over an existing one', async () => {
    const { files, fx } = rig();
    expect(await files.newFilePath('../../.ssh/Trip budget', 'sheet')).toBe(join(fx.documents, 'ssh Trip budget.xlsx'));
    expect(await files.newFilePath('Plan.docx', 'word')).toBe(join(fx.documents, 'Plan.docx'));
    await expect(files.newFilePath('report', 'word')).rejects.toThrow(DocPathError);
    await expect(files.newFilePath('///', 'word')).rejects.toThrow(DocPathError);
  });
});

describe('editing a Word file', () => {
  it('only shows a card; the Save click writes a new file and leaves the original alone', async () => {
    const r = rig();
    const before = readFileSync(join(r.fx.documents, 'report.docx'));
    const out = await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'replace', find: 'Revenue grew 12%', replace: 'Revenue grew 14%' }] });
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/Nothing is saved yet/);
    const card = r.last();
    expect(card).toMatchObject({ change: 'edit', fileKind: 'word', file: '~/Documents/report.docx', output: '~/Documents/report-edited.docx', overwrite: false, state: 'pending' });
    expect(card.lines).toEqual([{ what: 'Replace', before: 'Revenue grew 12%', after: 'Revenue grew 14%' }]);
    // Nothing ran yet.
    expect(r.fx.calls().some((c) => c.args[0] === 'run')).toBe(false);
    expect(readdirSync(r.fx.documents)).not.toContain('report-edited.docx');

    expect(await r.actions.confirm(card.id, 'f'.repeat(64))).toBe('refused');
    expect(await r.actions.confirm(card.id, card.hash)).toBe('done');
    expect(r.doc('report-edited.docx').text).toContain('Revenue grew 14% in Q3.');
    expect(readFileSync(join(r.fx.documents, 'report.docx'))).toEqual(before);
    expect(r.last()).toMatchObject({ state: 'done', result: expect.stringMatching(/Saved as ~\/Documents\/report-edited\.docx; the original is unchanged\.$/) });
    // A second click does nothing.
    expect(await r.actions.confirm(card.id, card.hash)).toBe('refused');
    // The saved file is shown like doc_show would.
    expect(r.posted.some((i) => i.kind === 'document')).toBe(true);
  });

  it('keeps document text out of the audit log, and logs the click', async () => {
    const r = rig();
    await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'replace', find: 'Hire two engineers', replace: 'Hire three engineers' }] });
    await r.actions.confirm(r.last().id, r.last().hash);
    const text = readFileSync(r.auditPath, 'utf8');
    expect(text).not.toContain('engineers');
    const clicks = r.log().filter((e) => e.tool === 'doc_edit' && e.via === 'click');
    expect(clicks.map((e) => e.decision)).toEqual(['approved', 'approved']);
    expect(r.log().find((e) => e.tool === 'doc_edit' && e.decision === 'proposed')?.args).toEqual({ path: 'report.docx', overwrite: false, changes: { replace: 1 } });
  });

  it('says so when the text to change is not in the document', async () => {
    const r = rig();
    const out = await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'delete', find: 'profit warning' }] });
    expect(out.content).toMatch(/^Error: .*not in the document/);
    expect(r.cards.size).toBe(0);
  });

  it('overwrites only when the user asked in their own words, and keeps a backup first', async () => {
    const r = rig();
    const change = { path: 'report.docx', changes: [{ op: 'append', paragraphs: [{ text: 'Approved by the board.' }] }], overwrite: true };
    expect((await r.call('doc_edit', change, { userText: 'add a line saying it was approved' })).content).toMatch(/did not ask to overwrite/);
    expect(r.cards.size).toBe(0);
    expect(userAskedOverwrite('add it and overwrite the original')).toBe(true);
    await r.call('doc_edit', change, { userText: 'add a line saying it was approved, and overwrite the original' });
    const card = r.last();
    expect(card).toMatchObject({ overwrite: true, output: '~/Documents/report.docx' });
    expect(await r.actions.confirm(card.id, card.hash)).toBe('done');
    expect(r.doc('report.docx').text).toMatch(/\nApproved by the board\.$/);
    const [backup] = readdirSync(r.backupDir);
    expect(backup).toMatch(/report\.docx$/);
    expect(readFileSync(join(r.backupDir, backup!)).subarray(4).toString()).not.toContain('Approved by the board');
  });

  it('refuses to save if the file changed after the card was made', async () => {
    const r = rig();
    await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'delete', find: 'Quarterly ' }] });
    utimesSync(join(r.fx.documents, 'report.docx'), new Date(), new Date(Date.now() + 5000));
    expect(await r.actions.confirm(r.last().id, r.last().hash)).toBe('failed');
    expect(r.last().result).toMatch(/changed since this card was made/);
    expect(readdirSync(r.fx.documents)).not.toContain('report-edited.docx');
  });

  it('never replaces a file that took the new name in the meantime', async () => {
    const r = rig();
    await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'delete', find: 'Quarterly ' }] });
    writeFileSync(join(r.fx.documents, 'report-edited.docx'), fakeDocBytes({ text: 'mine' }));
    expect(await r.actions.confirm(r.last().id, r.last().hash)).toBe('failed');
    expect(r.last().result).toMatch(/exists now/);
    expect(r.doc('report-edited.docx').text).toBe('mine');
  });

  it('discards without writing, and a crash mid-save shows as failed, never re-run', async () => {
    const r = rig();
    await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'delete', find: 'Quarterly ' }] });
    expect(r.actions.discard(r.last().id)).toBe(true);
    expect(r.last().state).toBe('discarded');
    expect(await r.actions.confirm(r.last().id, r.last().hash)).toBe('refused');
    await r.call('doc_edit', { path: 'report.docx', changes: [{ op: 'delete', find: 'Quarterly ' }] });
    r.store.db.prepare("UPDATE doc_actions SET state = 'running' WHERE id = ?").run(r.last().id);
    r.actions.recover();
    expect(r.last()).toMatchObject({ state: 'failed', result: expect.stringMatching(/stopped while saving/) });
    expect(readdirSync(r.fx.documents)).not.toContain('report-edited.docx');
  });
});

describe('editing an Excel file', () => {
  it('sets values on the named sheet into a new file, and checks they landed', async () => {
    const r = rig();
    await r.call('sheet_edit', { path: 'Finance/sales.xlsx', sheet: 'Sales', changes: [{ op: 'set', range: 'E1', values: [['Price'], [20], [300]] }, { op: 'format', range: 'A1:E1', bold: true }] });
    const card = r.last();
    expect(card).toMatchObject({ fileKind: 'sheet', output: '~/Documents/Finance/sales-edited.xlsx', warnings: [] });
    expect(card.lines.map((l) => l.what)).toEqual(['Set E1:E3', 'Format A1:E1: bold']);
    expect(await r.actions.confirm(card.id, card.hash)).toBe('done');
    expect(r.last().result).not.toMatch(/⚠/);
    const book = r.doc('Finance/sales-edited.xlsx');
    expect(book.sheets![0]!.rows.slice(0, 3).map((row) => row[4])).toEqual(['Price', 20, 300]);
    expect(book.applied!.map((c) => c.command)).toEqual(['sheet.activate', 'range.setValues', 'home.bold']);
    const run = r.fx.calls().find((c) => c.tool === 'sheet' && c.args[0] === 'run')!;
    expect(run.args.slice(0, 4)).toEqual(['run', '--in', join(r.fx.documents, 'Finance/sales.xlsx'), '--script']);
    expect(run.args).not.toContain('--sheet');
  });

  it('changes the first sheet when none is named', async () => {
    const r = rig();
    await r.call('sheet_edit', { path: 'Finance/sales.xlsx', changes: [{ op: 'delete_rows', from: 5, count: 1 }] });
    await r.actions.confirm(r.last().id, r.last().hash);
    const book = r.doc('Finance/sales-edited.xlsx');
    expect(book.applied![0]).toEqual({ command: 'sheet.activate', params: { sheet: 'Sales' } });
    expect(book.sheets![0]!.rows).toHaveLength(4);
  });

  it('refuses a sheet that is not there', async () => {
    const r = rig();
    expect((await r.call('sheet_edit', { path: 'Finance/sales.xlsx', sheet: 'Nope', changes: [{ op: 'set', range: 'A1', values: [[1]] }] })).content).toMatch(/no sheet/);
  });

  it('warns on the card when GridCraft might lose parts of the workbook', async () => {
    const r = rig();
    writeFileSync(join(r.fx.documents, 'charts.xlsx'), fakeDocBytes({ sheets: [{ name: 'S', rows: [['a']] }], lossy: ['charts', 'pivots'] }));
    await r.call('sheet_edit', { path: 'charts.xlsx', changes: [{ op: 'set', range: 'B1', values: [['b']] }] });
    expect(r.last().warnings.join(' ')).toMatch(/may not keep everything.*charts, pivots/);
  });
});

describe('creating files', () => {
  it('creates a Word file only on the click', async () => {
    const r = rig();
    const out = await r.call('doc_create', { name: 'Trip plan', kind: 'word', word: [{ op: 'append', paragraphs: [{ text: 'Trip plan', style: 'Title' }, { text: 'Day 1: Lisbon' }] }] });
    expect(out.content).toMatch(/does NOT exist yet/);
    expect(readdirSync(r.fx.documents)).not.toContain('Trip plan.docx');
    const card = r.last();
    expect(card).toMatchObject({ change: 'create', output: '~/Documents/Trip plan.docx' });
    expect(card.file).toBeUndefined();
    expect(await r.actions.confirm(card.id, card.hash)).toBe('done');
    expect(r.doc('Trip plan.docx').text).toBe('Trip plan\nDay 1: Lisbon');
  });

  it('creates an Excel file', async () => {
    const r = rig();
    await r.call('doc_create', { name: 'Budget', kind: 'sheet', sheet: [{ op: 'set', range: 'A1', values: [['Item', 'Cost'], ['Rent', 1200]] }] });
    expect(await r.actions.confirm(r.last().id, r.last().hash)).toBe('done');
    expect(r.doc('Budget.xlsx').sheets![0]!.rows).toEqual([['Item', 'Cost'], ['Rent', 1200]]);
  });

  it('never creates over an existing file', async () => {
    const r = rig();
    expect((await r.call('doc_create', { name: 'report', kind: 'word', word: [{ op: 'append', paragraphs: [{ text: 'x' }] }] })).content).toMatch(/exists already/);
  });
});

describe('when outside text is in view', () => {
  const change = { path: 'report.docx', changes: [{ op: 'delete', find: 'Quarterly ' }] };

  it('shows the card with a warning while only document text is in view', async () => {
    const r = rig();
    const out = await r.call('doc_edit', change, { sources: ['document'] });
    expect(out.ok).toBe(true);
    expect(r.last().warnings.join(' ')).toMatch(/document's text was in view/);
  });

  it('refuses while an email or calendar event is in view, even alongside a document', async () => {
    for (const sources of [['email'], ['calendar'], ['email', 'document'], ['calendar', 'document']] as UntrustedSource[][]) {
      const r = rig();
      for (const [name, args] of [
        ['doc_edit', change],
        ['sheet_edit', { path: 'Finance/sales.xlsx', changes: [{ op: 'set', range: 'A1', values: [['x']] }] }],
        ['doc_create', { name: 'New', kind: 'word', word: [{ op: 'append', paragraphs: [{ text: 'x' }] }] }],
      ] as const) {
        const out = await r.call(name, args, { sources });
        expect(out.ok, `${name} with ${sources.join('+')}`).toBe(false);
      }
      expect(r.cards.size).toBe(0);
    }
  });

  it('refuses when it is not known what is in view', async () => {
    const r = rig();
    expect((await r.call('doc_edit', change, { untrusted: true })).ok).toBe(false);
    expect(onlyDocuments({ untrustedInContext: true })).toBe(false);
    expect(onlyDocuments({ untrustedInContext: true, untrustedSources: new Set() })).toBe(false);
  });

  it('offers the edit tools to the model only with no outside text, or document text alone', () => {
    const { tools } = rig();
    const names = (o: Parameters<ToolRegistry['specs']>[0]) => tools.specs(o).map((s) => s.name).sort();
    expect(names({})).toEqual(['doc_create', 'doc_edit', 'sheet_edit']);
    expect(names({ untrustedInContext: true, untrustedSources: new Set(['document']) })).toEqual(['doc_create', 'doc_edit', 'sheet_edit']);
    expect(names({ untrustedInContext: true, untrustedSources: new Set(['email', 'document']) })).toEqual([]);
    expect(names({ untrustedInContext: true })).toEqual([]);
  });

  it('tells document, calendar and email text apart by tool and by wrapper', () => {
    const untrusted = (n: string) => n === 'doc_read' || n === 'sheet_read' || n === 'mail_read' || n === 'calendar_list';
    const tool = (name: string, content = '') => ({ role: 'tool' as const, name, toolCallId: name, content });
    expect([...untrustedSources([tool('doc_read'), tool('sheet_read')], untrusted)]).toEqual(['document']);
    expect([...untrustedSources([tool('mail_read')], untrusted)]).toEqual(['email']);
    expect([...untrustedSources([tool('calendar_list')], untrusted)]).toEqual(['calendar']);
    // A wrapper with a source nobody knows counts as email.
    expect([...untrustedSources([tool('now', '<untrusted source="weird" id="x">hi</untrusted>')], untrusted)]).toEqual(['email']);
  });
});

describe('the click messages', () => {
  it('need a full hash to save', () => {
    expect(ClientMessage.safeParse({ type: 'doc_change_confirm', id: 'card1', hash: 'abc' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'doc_change_confirm', id: 'card1', hash: 'a'.repeat(64) }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'doc_change_discard', id: 'card1' }).success).toBe(true);
  });
});
