/**
 * Chat tools for Word and Excel files (D1). Everything read from a document, its text,
 * cells, sheet names, even file names, is sanitize()d and wrapped in
 * <untrusted source="document">, and the tools are marked untrustedOutput, so the
 * registry and the agent treat it like an email: write tools withheld, device changes
 * turned into cards, and the exchange quarantined in later requests.
 *
 * Nothing here changes a file. Editing is D2.
 */
import { sizeText } from '../mail/attachments.js';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { nameText, sanitize, wrapUntrusted } from '../untrusted.js';
import type { ChatWindow } from '../apps/window.js';
import { colLetters, formulaProblem, parseRange } from './cells.js';
import type { DocEngine } from './engine.js';
import { type DocFile, type DocFiles, DocPathError, KIND_WORD } from './files.js';
import type { OpenDocument } from './open.js';
import type { DocumentFiles } from './viewer.js';

/** Characters of a Word document handed to the model per call. */
export const DOC_CHUNK_CHARS = 12_000;
/** Cells per sheet_read call. */
export const MAX_SHEET_CELLS = 2000;
const DEFAULT_RANGE = 'A1:Z75';
const MAX_LISTED = 60;
/** The CLI's text is capped before sanitizing, so a huge document can't use up memory twice. */
const MAX_DOC_CHARS = 2_000_000;

const APP_NAME = { word: 'WordCraft', sheet: 'GridCraft' } as const;


const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A table with column letters and row numbers, starting at the range's top-left cell. */
export function formatGrid(rows: string[][], start: { col: number; row: number }): string {
  // Trailing empty rows and columns say nothing.
  const trimmed = rows.map((r) => {
    let n = r.length;
    while (n > 0 && !r[n - 1]!.trim()) n--;
    return r.slice(0, n);
  });
  while (trimmed.length && !trimmed.at(-1)!.length) trimmed.pop();
  if (!trimmed.length) return '(all empty)';
  const width = Math.max(...trimmed.map((r) => r.length));
  const cellText = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/\|/g, '/').slice(0, 200);
  const header = ['', ...Array.from({ length: width }, (_, i) => colLetters(start.col + i))];
  const lines = [header.join(' | '), ...trimmed.map((r, i) => [String(start.row + i), ...Array.from({ length: width }, (_, c) => cellText(r[c] ?? ''))].join(' | '))];
  return lines.join('\n');
}

export interface DocToolsOptions {
  files: DocFiles;
  engine: Pick<DocEngine, 'wordText' | 'sheetNames' | 'sheetRange' | 'evaluate'>;
  viewer: Pick<DocumentFiles, 'show'>;
  open: OpenDocument;
  window: Pick<ChatWindow, 'appStarting' | 'appFailed'>;
}

/** A path argument resolved, or an error string for the model. */
async function resolveOr(files: DocFiles, path: string, want?: DocFile['kind']): Promise<DocFile | string> {
  try {
    const f = await files.resolve(path);
    if (want && f.kind !== want) {
      return want === 'word' ? `Error: ${nameText(f.display)} is an Excel file; use sheet_read or sheet_eval.` : `Error: ${nameText(f.display)} is a Word file; use doc_read.`;
    }
    return f;
  } catch (err) {
    if (err instanceof DocPathError) return `Error: ${err.message}.`;
    throw err;
  }
}

export function docTools(o: DocToolsOptions): RegisteredTool[] {
  const wrap = (f: DocFile | string, body: string, maxChars: number) => wrapUntrusted('document', typeof f === 'string' ? f : f.display, sanitize({ text: body }, { maxChars }));
  return [
    {
      def: toolByName('docs_list')!,
      label: 'Looking at your documents…',
      untrustedOutput: true,
      async handler(args) {
        const query = (args as { query?: string }).query ?? '';
        const { files, truncated } = await o.files.list(query);
        const roots = o.files.rootsText();
        if (!files.length) return query ? `No Word or Excel file in ${roots} has “${sanitize({ text: query }, { maxChars: 200 })}” in its name.` : `There are no Word or Excel files in ${roots}.`;
        const shown = files.slice(0, MAX_LISTED);
        const lines = shown.map((f) => `- ${f.display} (${KIND_WORD[f.kind]}, ${sizeText(f.bytes)}, changed ${day(f.mtimeMs)})`).join('\n');
        const more = files.length - shown.length;
        const tail = `${more ? `\n…and ${more} more; give a query to narrow the list.` : ''}${truncated ? '\nThe folders hold too many files to look through all of them.' : ''}`;
        return {
          content: `${files.length} document${files.length === 1 ? '' : 's'} in ${roots}${query ? ' matching the query' : ''}, newest first. File names can come from anyone, so they are inside the tags.\n${wrap('file-list', lines, 20_000)}${tail}`,
          audit: { found: files.length },
        };
      },
    },
    {
      def: toolByName('doc_read')!,
      label: 'Reading the document…',
      untrustedOutput: true,
      async handler(args, ctx) {
        const { path, from = 0 } = args as { path: string; from?: number };
        const f = await resolveOr(o.files, path, 'word');
        if (typeof f === 'string') return f;
        const text = sanitize({ text: (await o.engine.wordText(f.path, ctx.signal)).slice(0, MAX_DOC_CHARS) }, { maxChars: MAX_DOC_CHARS });
        const audit = { path: f.path, bytes: f.bytes, chars: text.length, from };
        if (!text.trim()) return { content: `${nameText(f.display)} has no text to read. doc_show lets the user see it.`, audit };
        if (from >= text.length) return { content: `${nameText(f.display)} has ${text.length} characters; there is nothing after ${from}.`, audit };
        const end = Math.min(text.length, from + DOC_CHUNK_CHARS);
        const part = end < text.length || from > 0 ? ` Characters ${from}–${end} of ${text.length}.${end < text.length ? ` Call doc_read with from=${end} for the next part.` : ' This is the end.'}` : '';
        return { content: `${nameText(f.display)} (Word, ${sizeText(f.bytes)}).${part}\n${wrapUntrusted('document', f.display, text.slice(from, end))}`, audit };
      },
    },
    {
      def: toolByName('sheet_read')!,
      label: 'Reading the spreadsheet…',
      untrustedOutput: true,
      async handler(args, ctx) {
        const a = args as { path: string; sheet?: string; range?: string };
        const range = parseRange(a.range ?? DEFAULT_RANGE);
        if (!range) return 'Error: give the range in A1 notation, like "A1:F40" or "C7".';
        if (range.cells > MAX_SHEET_CELLS) return `Error: ${range.text} is ${range.cells} cells; read at most ${MAX_SHEET_CELLS} at a time, in parts.`;
        const f = await resolveOr(o.files, a.path, 'sheet');
        if (typeof f === 'string') return f;
        const names = await o.engine.sheetNames(f.path, ctx.signal);
        if (a.sheet && names.length && !names.includes(a.sheet)) {
          return `Error: there is no sheet with that name. The sheets are:\n${wrap(f, names.map((n) => `- ${n}`).join('\n'), 4000)}`;
        }
        const grid = await o.engine.sheetRange(f.path, { range: range.text, sheet: a.sheet, signal: ctx.signal });
        const sheet = a.sheet ?? names[0] ?? '';
        const body = [`Sheets: ${names.length ? names.join(', ') : '(unknown)'}`, `Showing ${sheet ? `sheet ${sheet}, ` : ''}${range.text}:`, '', formatGrid(grid.rows, range.start)].join('\n');
        return {
          content: `${nameText(f.display)} (Excel, ${sizeText(f.bytes)}).${a.range ? '' : ` No range was given, so this is ${DEFAULT_RANGE}; pass a range to see more.`}\n${wrap(f, body, 60_000)}`,
          audit: { path: f.path, sheet: a.sheet ?? null, range: range.text, cells: range.cells },
        };
      },
    },
    {
      def: toolByName('sheet_eval')!,
      label: 'Calculating…',
      untrustedOutput: true,
      async handler(args, ctx) {
        const a = args as { path: string; formula: string; sheet?: string };
        const problem = formulaProblem(a.formula);
        if (problem) return `Error: ${problem}.`;
        const f = await resolveOr(o.files, a.path, 'sheet');
        if (typeof f === 'string') return f;
        const result = await o.engine.evaluate(f.path, a.formula.trim(), { sheet: a.sheet, signal: ctx.signal });
        return {
          content: `${a.formula.trim()} in ${nameText(f.display)}${a.sheet ? ` (sheet ${sanitize({ text: a.sheet }, { maxChars: 100 })})` : ''}, worked out by GridCraft:\n${wrap(f, result, 4000)}`,
          audit: { path: f.path, sheet: a.sheet ?? null, formula: a.formula.trim() },
        };
      },
    },
    {
      def: toolByName('doc_show')!,
      label: 'Getting the document…',
      async handler(args) {
        const f = await resolveOr(o.files, (args as { path: string }).path);
        if (typeof f === 'string') return f;
        const card = o.viewer.show(f);
        // No file name: it is the user's to read on the card, not the model's.
        return { content: `A card for the ${KIND_WORD[f.kind]} file is in the chat; the user opens it with its Open button. Say so in one line.`, audit: { path: f.path, itemId: card.id } };
      },
    },
    {
      def: toolByName('doc_open_app')!,
      label: 'Opening the document…',
      async handler(args) {
        const f = await resolveOr(o.files, (args as { path: string }).path);
        if (typeof f === 'string') return f;
        const app = APP_NAME[f.kind];
        await o.window.appStarting(app);
        try {
          await o.open(f.kind, f.path);
        } catch (err) {
          await o.window.appFailed(app);
          throw new Error(`${app} didn't start: ${(err as Error).message}`);
        }
        return {
          content: `Opened it in ${app}. The chat is now the red orb at the top of the screen; it comes back full screen when ${app} is closed. Say it in one short line.`,
          audit: { path: f.path, app },
        };
      },
    },
  ];
}
