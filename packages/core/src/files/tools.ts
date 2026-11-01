/**
 * Chat tools for files in the allowed folders (F1). Reading tools are read tier; anything
 * that names a file, its text or a folder listing comes from the disk, where files arrive
 * from anywhere, so it is sanitize()d and wrapped in <untrusted source="document"> like D1's
 * documents (and quarantined the same way). Changes (rename, copy, new folder, new note) are
 * write tier and only ever put a card in the chat; FileActions.confirm() does them on a click.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AttachmentFiles, declaredKind, extractPdfText, MAX_ATTACHMENT_BYTES, sizeText, sniff } from '../mail/attachments.js';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext, ToolResult } from '../tools/registry.js';
import { nameText, sanitize, wrapUntrusted } from '../untrusted.js';
import type { FileActions } from './actions.js';
import { checkFileName, exists, type FileEntry, FilePathError, type FileRoots, KIND_TEXT, kindOf } from './roots.js';

/** Characters of a file handed to the model per call, as for doc_read. */
export const FILE_CHUNK_CHARS = 12_000;
const MAX_LISTED = 80;
const MAX_TEXT_CHARS = 2_000_000;

export interface FileToolsOptions {
  roots: FileRoots;
  actions: Pick<FileActions, 'propose'>;
  /** Shows PDFs, pictures and text files from disk. */
  viewer: Pick<AttachmentFiles, 'showFile'>;
  /** D1's card for Word and Excel files, when documents are on. */
  showDocument?: (path: string) => Promise<string>;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const asked = async (fn: () => Promise<string | ToolResult>): Promise<string | ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FilePathError) return `Error: ${err.message}.`;
    throw err;
  }
};

const neverRuns = async (): Promise<string> => {
  throw new Error('file changes run only from a click on their card');
};

const denied =
  "Error: files can be changed only at the user's request, and not while an email or calendar event is in view. Ask them to say what to change in a new message of their own.";

const DOC_IN_VIEW_WARNING = "Suggested while a file's or document's text was in view. Check this is what you asked for.";

export function fileTools(o: FileToolsOptions): RegisteredTool[] {
  const wrap = (id: string, body: string, maxChars: number) => wrapUntrusted('document', id, sanitize({ text: body }, { maxChars }));
  const warnings = (ctx: ToolContext) => (ctx.untrustedInContext ? [DOC_IN_VIEW_WARNING] : []);
  const pending = (what: string) => `A card for ${what} is in the chat. Nothing has changed yet: only the user's click on it does that. Say so in one line.`;

  /** A new path in an allowed folder that must not exist yet. */
  const newPath = async (folder: FileEntry, name: string): Promise<string> => {
    const p = join(folder.path, checkFileName(name));
    if (await exists(p)) throw new FilePathError(`${nameText(o.roots.display(p))} exists already; pick another name`);
    return p;
  };

  return [
    {
      def: toolByName('files_list')!,
      label: 'Looking at your files…',
      untrustedOutput: true,
      handler: (args) =>
        asked(async () => {
          const a = args as { folder?: string; query?: string };
          const folder = a.folder ? await o.roots.resolve(a.folder, 'dir') : null;
          const { entries, truncated } = await o.roots.list(folder?.path ?? null, a.query ?? '');
          const where = folder ? nameText(folder.display) : o.roots.rootsText();
          if (!entries.length) return { content: `Nothing${a.query ? ` matching "${sanitize({ text: a.query }, { maxChars: 200 })}"` : ''} in ${where}.`, audit: { folder: folder?.path ?? null, count: 0 } };
          const lines = [];
          for (const e of entries.slice(0, MAX_LISTED)) {
            const k = e.isDir ? 'folder' : KIND_TEXT[await kindOf(e)];
            lines.push(`${e.display}  (${k}${e.isDir ? '' : `, ${sizeText(e.bytes)}`}, ${day(e.mtimeMs)})`);
          }
          const more = entries.length > MAX_LISTED || truncated ? `\n(${entries.length > MAX_LISTED ? `${entries.length - MAX_LISTED} more` : 'more'} not shown; narrow it with a folder or query.)` : '';
          return { content: `In ${where}${a.query ? `, matching the query` : ''}:\n${wrap('files', lines.join('\n') + more, 20_000)}`, audit: { folder: folder?.path ?? null, count: entries.length } };
        }),
    },
    {
      def: toolByName('file_info')!,
      label: 'Looking at the file…',
      untrustedOutput: true,
      handler: (args) =>
        asked(async () => {
          const f = await o.roots.resolve((args as { path: string }).path);
          const k = await kindOf(f);
          const facts = [`Path: ${f.display}`, `Type: ${KIND_TEXT[k]}`, ...(f.isDir ? [] : [`Size: ${sizeText(f.bytes)}`]), `Created: ${day(f.birthtimeMs)}`, `Modified: ${day(f.mtimeMs)}`];
          return { content: wrap(f.display, facts.join('\n'), 4000), audit: { path: f.path } };
        }),
    },
    {
      def: toolByName('file_show')!,
      label: 'Getting the file…',
      handler: (args) =>
        asked(async () => {
          const f = await o.roots.resolve((args as { path: string }).path, 'file');
          const k = await kindOf(f);
          if (k === 'word' || k === 'sheet') {
            if (!o.showDocument) return 'Error: Word and Excel files are turned off in config [docs].';
            return { content: await o.showDocument(f.path), audit: { path: f.path, kind: k } };
          }
          if (k !== 'pdf' && k !== 'image' && k !== 'text') return { content: `Error: this ${KIND_TEXT[k]} can't be shown in the chat; only PDFs, pictures, text, Word and Excel files can.`, audit: { path: f.path, kind: k } };
          if (f.bytes > MAX_ATTACHMENT_BYTES) return `Error: it is larger than ${sizeText(MAX_ATTACHMENT_BYTES)}, too large to show here.`;
          const card = o.viewer.showFile(f, k);
          return { content: `A card for the ${KIND_TEXT[k]} is in the chat; the user opens it with its Open button. Say so in one line.`, audit: { path: f.path, kind: k, itemId: card.id } };
        }),
    },
    {
      def: toolByName('file_read')!,
      label: 'Reading the file…',
      untrustedOutput: true,
      handler: (args, ctx) =>
        asked(async () => {
          const a = args as { path: string; from?: number };
          const f = await o.roots.resolve(a.path, 'file');
          const k = await kindOf(f);
          if (k === 'word') return `Error: ${nameText(f.display)} is a Word file; use doc_read.`;
          if (k === 'sheet') return `Error: ${nameText(f.display)} is an Excel file; use sheet_read.`;
          if (k === 'image') return `Error: ${nameText(f.display)} is a picture. You cannot see pictures; call file_show so the user can.`;
          if (k !== 'pdf' && k !== 'text') return `Error: ${nameText(f.display)} is not a PDF or text file, so its text can't be read.`;
          if (f.bytes > MAX_ATTACHMENT_BYTES) return `Error: it is larger than ${sizeText(MAX_ATTACHMENT_BYTES)}, too large to read here.`;
          const bytes = await readFile(f.path);
          const s = sniff(bytes, declaredKind({ name: f.name, type: '' }));
          if (!s || (s.kind !== 'pdf' && s.kind !== 'text')) return `Error: ${nameText(f.display)} is not a PDF or text file.`;
          let text: string;
          let note = '';
          if (s.kind === 'pdf') {
            const pdf = await extractPdfText(bytes, { signal: ctx.signal });
            if (!pdf.text.trim()) return { content: `${nameText(f.display)} is a PDF with no text to read (it may be scanned pages). Call file_show so the user can open it.`, audit: { path: f.path } };
            text = pdf.text;
            if (pdf.readPages < pdf.pages) note = ` Only the first ${pdf.readPages} of ${pdf.pages} pages were read.`;
          } else {
            text = bytes.toString('utf8').slice(0, MAX_TEXT_CHARS);
          }
          const from = Math.min(a.from ?? 0, text.length);
          const part = text.slice(from, from + FILE_CHUNK_CHARS);
          const end = from + part.length;
          const more = end < text.length ? ` This is characters ${from}–${end} of ${text.length}; call file_read with from=${end} for more.` : '';
          return { content: `${nameText(f.display)} (${KIND_TEXT[s.kind]}, ${sizeText(f.bytes)}).${note}${more}\n${wrap(f.display, part, FILE_CHUNK_CHARS + 200)}`, audit: { path: f.path, from, chars: part.length } };
        }),
    },
    {
      def: toolByName('file_rename')!,
      label: 'Preparing the rename…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { path: string; newName: string };
          const f = await o.roots.resolve(a.path, 'file');
          const folder = await o.roots.resolve(join(f.path, '..'), 'dir');
          const to = await newPath(folder, a.newName);
          const w = warnings(ctx);
          const oldExt = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')).toLowerCase() : '';
          const newExt = to.includes('.') ? to.slice(to.lastIndexOf('.')).toLowerCase() : '';
          if (oldExt !== newExt) w.push(`The file type ending changes from "${oldExt || 'none'}" to "${newExt || 'none'}"; apps may not open it the same way.`);
          const card = o.actions.propose({ op: 'rename', from: { path: f.path, mtimeMs: f.mtimeMs, bytes: f.bytes }, to }, w);
          return { content: pending('the rename'), audit: { path: f.path, cardId: card.id } };
        }),
    },
    {
      def: toolByName('file_copy')!,
      label: 'Preparing the copy…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { path: string; toFolder: string; newName?: string };
          const f = await o.roots.resolve(a.path, 'file');
          const folder = await o.roots.resolve(a.toFolder, 'dir');
          const to = await newPath(folder, a.newName ?? f.name);
          const card = o.actions.propose({ op: 'copy', from: { path: f.path, mtimeMs: f.mtimeMs, bytes: f.bytes }, to }, warnings(ctx));
          return { content: pending('the copy'), audit: { path: f.path, cardId: card.id } };
        }),
    },
    {
      def: toolByName('folder_create')!,
      label: 'Preparing the folder…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { in: string; name: string };
          const parent = await o.roots.resolve(a.in, 'dir');
          const to = await newPath(parent, a.name);
          const card = o.actions.propose({ op: 'folder', to }, warnings(ctx));
          return { content: pending('the new folder'), audit: { in: parent.path, cardId: card.id } };
        }),
    },
    {
      def: toolByName('note_create')!,
      label: 'Preparing the note…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      // The note's text is the model's writing, perhaps from the user's words: counted, never logged.
      auditArgs: (args) => {
        const a = args as { folder?: string; name: string; text: string };
        return { folder: a.folder ?? null, chars: a.text.length };
      },
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { folder?: string; name: string; text: string };
          const folder = a.folder ? await o.roots.resolve(a.folder, 'dir') : await o.roots.resolve('~/Documents', 'dir').catch(async () => o.roots.resolve((await o.roots.realRoots())[0] ?? '~', 'dir'));
          const name = /\.(txt|md)$/i.test(a.name.trim()) ? a.name : `${a.name.trim()}.txt`;
          const to = await newPath(folder, name);
          const card = o.actions.propose({ op: 'note', to, content: a.text }, warnings(ctx));
          return { content: pending('the new file'), audit: { cardId: card.id } };
        }),
    },
  ];
}
