/**
 * The results card of a file search (F3): the best three files, each with its folder, a "why it
 * matched" line made by code, and an Open button that shows the file in the chat's viewer, the
 * same way as file_show's card. The rows' paths were resolved by the index; every Open resolves
 * the file again inside the allowed folders (AttachmentFiles / DocumentFiles).
 *
 * Names and snippets come from files anyone can send: the UI shows them as plain text only.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { Store } from '../store.js';
import { nameText } from '../untrusted.js';
import type { IndexedFile } from './catalog.js';
import { type RankedFiles, whyMatched } from './meaning.js';

export type FileResultsItem = Extract<ChatItem, { kind: 'file_results' }>;
type Row = FileResultsItem['files'][number];

export const RESULTS_ON_CARD = 3;
const SNIPPET_CHARS = 160;
const ROW_ID = /^(fr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9])$/;

/** Plain one-line text for the card: no control characters, collapsed spaces, cut short. */
function line(s: string, n: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** How a row opens: PDFs, text and pictures in the attachment viewer, Word and Excel in the document viewer. */
function opener(f: IndexedFile, documents: boolean): Row['open'] {
  if (f.kind === 'pdf' || f.kind === 'text' || f.kind === 'image') return 'attachment';
  if ((f.kind === 'word' || f.kind === 'sheet') && documents) return 'document';
  return undefined;
}

export function resultsCard(ranked: RankedFiles, o: { documents: boolean; now: number }): FileResultsItem {
  const id = `fr-${randomUUID()}`;
  const files: Row[] = ranked.files.slice(0, RESULTS_ON_CARD).map((f, n) => {
    const { why, snippet } = whyMatched(f.path, ranked);
    const open = opener(f, o.documents);
    return {
      id: `${id}-${n}`,
      name: line(f.name, 200) || 'file',
      folder: line(f.folder, 300),
      fileKind: f.kind === 'folder' ? 'other' : f.kind,
      why,
      ...(snippet ? { snippet: line(snippet, SNIPPET_CHARS) } : {}),
      ...(open ? { open } : {}),
      path: f.path,
    };
  });
  return { kind: 'file_results', id, files, at: o.now };
}

/**
 * The viewer card behind one row's Open button, for /attachments and /documents: an attachment
 * or document item that exists only inside the results card. Null for anything else.
 */
export function resultRowItem(store: Pick<Store, 'getItem'>, rowId: string): ChatItem | null {
  const m = ROW_ID.exec(rowId);
  if (!m) return null;
  const card = store.getItem(m[1]!);
  if (!card || card.kind !== 'file_results') return null;
  const row = card.files.find((r) => r.id === rowId);
  if (!row?.open) return null;
  if (row.open === 'attachment' && (row.fileKind === 'pdf' || row.fileKind === 'text' || row.fileKind === 'image')) {
    return { kind: 'attachment', id: row.id, name: row.name, fileKind: row.fileKind, path: row.path, at: card.at };
  }
  if (row.open === 'document' && (row.fileKind === 'word' || row.fileKind === 'sheet')) {
    return { kind: 'document', id: row.id, name: row.name, fileKind: row.fileKind, path: row.path, at: card.at };
  }
  return null;
}

/** For the model: which files are on the card, named as plain text. */
export function cardNote(card: FileResultsItem): string {
  if (!card.files.length) return '';
  return ` A card with the best ${card.files.length} (${card.files.map((r) => nameText(r.name)).join(', ')}) and their Open buttons is in the chat: don't list them again, say in a line or two which fits best and why.`;
}
