/**
 * Document cards in the chat and what their Open button shows (D1). A card's id is random
 * and is the only way to fetch what is behind it, so GET /documents/<id> serves exactly the
 * files the chat has shown. The file is resolved again on every open, so a file moved
 * out of the folders, or swapped for a link, is refused then too.
 *
 * Word files are shown as a PDF that WordCraft makes, drawn by the same pdf.js viewer as
 * email attachments (S2). Excel files are sent as JSON cells and drawn as a plain table.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { cleanName } from '../system/controls.js';
import { colLetters } from './cells.js';
import type { DocEngine } from './engine.js';
import { type DocFile, type DocFiles, DocPathError } from './files.js';

type DocumentItem = Extract<ChatItem, { kind: 'document' }>;

/** What the viewer shows of a workbook: the first sheets, each up to this many rows and columns. */
export const VIEW_SHEETS = 10;
export const VIEW_ROWS = 200;
export const VIEW_COLS = 26;

export interface SheetView {
  sheets: { name: string; rows: string[][] }[];
  /** More sheets than were sent. */
  moreSheets: number;
  rows: number;
  cols: number;
}

export type DocumentFile = { kind: 'pdf'; bytes: Buffer } | { kind: 'sheet'; view: SheetView } | { error: string };

export interface DocumentFilesOptions {
  store: Store;
  files: Pick<DocFiles, 'resolve'>;
  engine: Pick<DocEngine, 'wordPdf' | 'sheetNames' | 'sheetRange'>;
  audit: AuditLog;
  post: (item: ChatItem) => void;
  clock?: () => number;
}

/** Without the empty cells after the last value in each row, and the empty rows at the end. */
export function trimEmpty(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    let n = r.length;
    while (n > 0 && !r[n - 1]!.trim()) n--;
    return r.slice(0, n);
  });
  while (out.length && !out.at(-1)!.length) out.pop();
  return out;
}

export class DocumentFiles {
  private readonly clock: () => number;

  constructor(private readonly o: DocumentFilesOptions) {
    this.clock = o.clock ?? Date.now;
  }

  /** Post a card with an Open button. Reads nothing; the file is read when opened. */
  show(file: DocFile): DocumentItem {
    const item: DocumentItem = { kind: 'document', id: `doc-${randomUUID()}`, name: cleanName(file.name) || 'document', fileKind: file.kind, path: file.path, at: this.clock() };
    this.o.post(item);
    return item;
  }

  /** What is behind a card. Null when there is no such card. */
  async file(itemId: string, signal?: AbortSignal): Promise<DocumentFile | null> {
    const item = this.o.store.getItem(itemId);
    if (!item || item.kind !== 'document') return null;
    const log = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'docs', event: 'document_opened', itemId, path: item.path, ...entry });
    let file: DocFile;
    try {
      file = await this.o.files.resolve(item.path);
    } catch (err) {
      const why = err instanceof DocPathError ? err.message : "the file couldn't be found";
      log({ ok: false, error: why });
      return { error: `This file can't be opened now: ${why}.` };
    }
    if (file.kind !== item.fileKind) {
      log({ ok: false, error: 'kind changed' });
      return { error: "This file can't be opened now." };
    }
    try {
      if (file.kind === 'word') {
        const bytes = await this.o.engine.wordPdf(file.path, signal);
        if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new Error('WordCraft did not make a PDF');
        log({ ok: true, fileKind: 'word', bytes: file.bytes, pdfBytes: bytes.length });
        return { kind: 'pdf', bytes };
      }
      const names = await this.o.engine.sheetNames(file.path, signal);
      const range = `A1:${colLetters(VIEW_COLS)}${VIEW_ROWS}`;
      const sheets: SheetView['sheets'] = [];
      for (const name of names.length ? names.slice(0, VIEW_SHEETS) : ['']) {
        const grid = await this.o.engine.sheetRange(file.path, { range, sheet: name || undefined, signal });
        sheets.push({ name: cleanName(name) || 'Sheet', rows: trimEmpty(grid.rows.slice(0, VIEW_ROWS).map((r) => r.slice(0, VIEW_COLS))) });
      }
      log({ ok: true, fileKind: 'sheet', bytes: file.bytes, sheets: sheets.length });
      return { kind: 'sheet', view: { sheets, moreSheets: Math.max(0, names.length - VIEW_SHEETS), rows: VIEW_ROWS, cols: VIEW_COLS } };
    } catch (err) {
      log({ ok: false, error: (err as Error).message });
      return { error: `I couldn't show it: ${(err as Error).message}.` };
    }
  }
}
