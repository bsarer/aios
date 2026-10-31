/**
 * Chat tools that change Word and Excel files (D2): doc_edit, sheet_edit and doc_create.
 * They are write tier and only ever put a card in the chat (`propose`); the file is written
 * by DocActions.confirm(), reached solely by the user's Save click on that card.
 *
 * Decided 2026-10-31: these cards may appear while the only untrusted text in view is a
 * document's (`allowWithDocuments`), with a warning on the card. Never while an email or a
 * calendar event is in view: the registry refuses those calls before they reach here.
 *
 * Saving over the original needs the user's own words in this turn asking for it; the card
 * then says so in red and the original is copied to the backups folder first.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext, ToolResult } from '../tools/registry.js';
import type { DocActions, DocChangeSpec } from './actions.js';
import { type SheetChange, sheetChangesProblem, type WordChange } from './changes.js';
import type { DocEngine } from './engine.js';
import { type DocFile, type DocFiles, DocPathError, type DocKind } from './files.js';
import { type CardLine, type DocCommand, RecipeError, expectedWordText, sheetChecks, sheetCommands, wordCommands } from './recipes.js';

/** The user's own words asking to replace the original. Only these unlock `overwrite`. */
export const OVERWRITE_WORDS = /\b(overwrite|overwriting|save over|saving over|in place|replace the (original|file|existing)|same file|don'?t (make|create|keep) a (copy|new file))\b/i;

export const userAskedOverwrite = (userText: string) => OVERWRITE_WORDS.test(userText);

const DOC_IN_VIEW_WARNING = "Suggested while a document's text was in view. Check these are the changes you asked for.";

export interface EditToolsOptions {
  files: Pick<DocFiles, 'resolve' | 'editedName' | 'newFilePath'>;
  engine: Pick<DocEngine, 'wordText' | 'sheetNames' | 'sheetRoundTrip'>;
  actions: Pick<DocActions, 'propose'>;
}

const neverRuns = async (): Promise<string> => {
  throw new Error('document changes run only from a click on their card');
};

const denied =
  'Error: documents can be changed only at the user\'s request, and not while an email or calendar event is in view. Ask them to say what to change in a new message of their own.';

const asked = async (fn: () => Promise<string | ToolResult>): Promise<string | ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RecipeError || err instanceof DocPathError) return `Error: ${err.message}.`;
    throw err;
  }
};

const summary = (changes: { op: string }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of changes) out[c.op] = (out[c.op] ?? 0) + 1;
  return out;
};

const done = (n: number, change: 'edit' | 'create', overwrite: boolean) =>
  change === 'create'
    ? `A card for the new file is in the chat with Save and Discard. The file does NOT exist yet: only the user's click on Save creates it. Say so in one line.`
    : `A card listing ${n === 1 ? 'the change' : `the ${n} changes`} is in the chat with Save and Discard. Nothing is saved yet: only the user's click on Save writes ${overwrite ? 'over the original, after keeping a backup' : 'a new copy; the original stays as it is'}. Say so in one line.`;

export function editTools(o: EditToolsOptions): RegisteredTool[] {
  const resolveKind = async (path: string, want: DocKind): Promise<DocFile> => {
    const f = await o.files.resolve(path);
    if (f.kind !== want) throw new DocPathError(want === 'word' ? `${f.display} is an Excel file; use sheet_edit` : `${f.display} is a Word file; use doc_edit`);
    return f;
  };

  const overwriteFor = (want: boolean | undefined, ctx: ToolContext): boolean | string => {
    if (!want) return false;
    if (!userAskedOverwrite(ctx.userText)) return 'Error: the user did not ask to overwrite the original. Propose the change without overwrite (it is saved as a new copy), or ask them.';
    return true;
  };

  const baseWarnings = (ctx: ToolContext) => (ctx.untrustedInContext ? [DOC_IN_VIEW_WARNING] : []);

  const sheetWarnings = async (f: DocFile, signal: AbortSignal): Promise<string[]> => {
    const lost = await o.engine.sheetRoundTrip(f.path, signal).catch(() => null);
    if (!lost?.length) return [];
    return [`GridCraft may not keep everything in this workbook when it saves (${lost.slice(0, 5).join(', ')}). Open the new file and check it before relying on it.`];
  };

  /** The sheet to change: the one named, else the first (not whichever was open when the file was saved). */
  const sheetFor = async (f: DocFile, sheet: string | undefined, signal: AbortSignal): Promise<string | undefined> => {
    const names = await o.engine.sheetNames(f.path, signal);
    if (!sheet) return names[0];
    if (names.length && !names.includes(sheet)) throw new RecipeError(`there is no sheet "${sheet.slice(0, 100)}"; call sheet_read to see the sheet names`);
    return sheet;
  };

  return [
    {
      def: toolByName('doc_edit')!,
      label: 'Preparing the changes…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      auditArgs: (args) => {
        const a = args as { path: string; changes: WordChange[]; overwrite?: boolean };
        // Change kinds and counts only: the audit log never holds the document's text.
        return { path: a.path, overwrite: !!a.overwrite, changes: summary(a.changes) };
      },
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { path: string; changes: WordChange[]; overwrite?: boolean };
          const overwrite = overwriteFor(a.overwrite, ctx);
          if (typeof overwrite === 'string') return overwrite;
          const f = await resolveKind(a.path, 'word');
          const text = await o.engine.wordText(f.path, ctx.signal);
          const { commands, lines } = wordCommands(a.changes, text);
          const spec: DocChangeSpec = {
            change: 'edit',
            kind: 'word',
            source: { path: f.path, mtimeMs: f.mtimeMs, bytes: f.bytes },
            output: overwrite ? f.path : await o.files.editedName(f),
            overwrite,
            commands,
            checks: { word: expectedWordText(a.changes, text) },
            summary: summary(a.changes),
          };
          const card = o.actions.propose(spec, lines, baseWarnings(ctx));
          return { content: done(a.changes.length, 'edit', overwrite), audit: { path: f.path, cardId: card.id } };
        }),
    },
    {
      def: toolByName('sheet_edit')!,
      label: 'Preparing the changes…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      auditArgs: (args) => {
        const a = args as { path: string; sheet?: string; changes: SheetChange[]; overwrite?: boolean };
        return { path: a.path, sheet: a.sheet ?? null, overwrite: !!a.overwrite, changes: summary(a.changes) };
      },
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { path: string; sheet?: string; changes: SheetChange[]; overwrite?: boolean };
          const problem = sheetChangesProblem(a.changes);
          if (problem) return `Error: ${problem}.`;
          const overwrite = overwriteFor(a.overwrite, ctx);
          if (typeof overwrite === 'string') return overwrite;
          const f = await resolveKind(a.path, 'sheet');
          const sheet = await sheetFor(f, a.sheet, ctx.signal);
          const { commands, lines } = sheetCommands(a.changes);
          const spec: DocChangeSpec = {
            change: 'edit',
            kind: 'sheet',
            source: { path: f.path, mtimeMs: f.mtimeMs, bytes: f.bytes },
            ...(sheet ? { sheet } : {}),
            output: overwrite ? f.path : await o.files.editedName(f),
            overwrite,
            commands,
            checks: { sheet: sheetChecks(a.changes) },
            summary: summary(a.changes),
          };
          const warnings = [...baseWarnings(ctx), ...(await sheetWarnings(f, ctx.signal))];
          const card = o.actions.propose(spec, lines, warnings);
          return { content: done(a.changes.length, 'edit', overwrite), audit: { path: f.path, cardId: card.id } };
        }),
    },
    {
      def: toolByName('doc_create')!,
      label: 'Preparing the new file…',
      handler: neverRuns,
      deniedMessage: denied,
      allowWithDocuments: true,
      auditArgs: (args) => {
        const a = args as { name: string; kind: DocKind; word?: WordChange[]; sheet?: SheetChange[] };
        return { kind: a.kind, changes: summary(a.word ?? a.sheet ?? []) };
      },
      propose: (args, ctx) =>
        asked(async () => {
          const a = args as { name: string; kind: DocKind; word?: WordChange[]; sheet?: SheetChange[] };
          let commands: DocCommand[];
          let lines: CardLine[];
          let checks: DocChangeSpec['checks'];
          if (a.kind === 'word') {
            ({ commands, lines } = wordCommands(a.word ?? [], ''));
            checks = { word: expectedWordText(a.word ?? [], '') };
          } else {
            const problem = sheetChangesProblem(a.sheet ?? []);
            if (problem) return `Error: ${problem}.`;
            ({ commands, lines } = sheetCommands(a.sheet ?? []));
            checks = { sheet: sheetChecks(a.sheet ?? []) };
          }
          const output = await o.files.newFilePath(a.name, a.kind);
          const changes = a.word ?? a.sheet ?? [];
          const spec: DocChangeSpec = { change: 'create', kind: a.kind, output, overwrite: false, commands, checks, summary: summary(changes) };
          const card = o.actions.propose(spec, lines, baseWarnings(ctx));
          return { content: done(changes.length, 'create', false), audit: { output, cardId: card.id } };
        }),
    },
  ];
}
