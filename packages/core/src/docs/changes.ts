/**
 * The changes D2 can make to a document, and nothing else. The model describes changes in
 * these shapes; code turns each one into WordCraft or GridCraft commands from a fixed list
 * (recipes.ts). Commands that open, save, export, run macros, insert pictures or objects,
 * or reach files or the network can't be expressed here at all.
 */
import { z } from 'zod';
import { formulaProblem, parseRange } from './cells.js';

const Text = z.string().min(1).max(2000);
const LongText = z.string().max(20_000);

export const WORD_STYLES = ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3'] as const;
export const HIGHLIGHTS = ['none', 'yellow', 'brightGreen', 'turquoise', 'pink', 'blue', 'red', 'green', 'gray25'] as const;
const Colour = z.string().regex(/^#?[0-9A-Fa-f]{6}$/, 'a colour is six hex digits, like "1F4E79"');

export const WordChange = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('replace'), find: Text, replace: LongText, all: z.boolean().optional().describe('Every occurrence; default only the first') }),
  z.strictObject({ op: z.literal('delete'), find: Text, all: z.boolean().optional() }),
  z.strictObject({
    op: z.literal('format'),
    find: Text,
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    highlight: z.enum(HIGHLIGHTS).optional(),
    size: z.number().min(4).max(96).optional().describe('Points'),
    color: Colour.optional(),
  }),
  z.strictObject({ op: z.literal('style'), find: Text.describe('Text in the paragraph to restyle'), style: z.enum(WORD_STYLES) }),
  z.strictObject({
    op: z.literal('append'),
    paragraphs: z.array(z.strictObject({ text: LongText, style: z.enum(WORD_STYLES).optional() })).min(1).max(100),
    bullets: z.boolean().optional().describe('As a bulleted list'),
  }),
]);
export type WordChange = z.infer<typeof WordChange>;

const RangeText = z
  .string()
  .min(2)
  .max(30)
  .refine((r) => parseRange(r) !== null, 'give the range in A1 notation, like "B2:D9" or "C7"');
const CellValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const SheetChange = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set'),
    range: RangeText.describe('Top-left cell or the whole range, e.g. "E1" or "E1:E9"'),
    values: z.array(z.array(CellValue).min(1).max(50)).min(1).max(500).describe('Rows of values; text starting with = is a formula'),
  }),
  z.strictObject({
    op: z.literal('format'),
    range: RangeText,
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    numberFormat: z.string().min(1).max(50).optional().describe('e.g. "#,##0.00", "0%", "yyyy-mm-dd"'),
    fillColor: Colour.optional(),
    fontColor: Colour.optional(),
    horizontalAlign: z.enum(['left', 'center', 'right']).optional(),
    wrapText: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal('insert_rows'), before: z.int().min(1).max(1_048_576), count: z.int().min(1).max(1000) }),
  z.strictObject({ op: z.literal('delete_rows'), from: z.int().min(1).max(1_048_576), count: z.int().min(1).max(1000) }),
  z.strictObject({ op: z.literal('insert_columns'), before: z.string().regex(/^[A-Z]{1,3}$/), count: z.int().min(1).max(100) }),
  z.strictObject({ op: z.literal('delete_columns'), from: z.string().regex(/^[A-Z]{1,3}$/), count: z.int().min(1).max(100) }),
  z.strictObject({
    op: z.literal('sort'),
    range: RangeText,
    by: z.array(z.strictObject({ column: z.string().regex(/^[A-Z]{1,3}$/), order: z.enum(['asc', 'desc']) })).min(1).max(3),
    header: z.boolean().optional().describe('The first row is a header and stays on top'),
  }),
  z.strictObject({ op: z.literal('chart'), range: RangeText, type: z.enum(['column', 'bar', 'line', 'pie']), title: z.string().max(200).optional() }),
  z.strictObject({ op: z.literal('table'), range: RangeText, header: z.boolean().optional() }),
  z.strictObject({ op: z.literal('fill_down'), range: RangeText.describe('The formula in the top cell is copied down the rest') }),
]);
export type SheetChange = z.infer<typeof SheetChange>;

export const MAX_CHANGES = 30;
export const MAX_SET_CELLS = 5000;

/** Null when the sheet changes may be proposed, else why not (for the model). */
export function sheetChangesProblem(changes: SheetChange[]): string | null {
  let cells = 0;
  for (const c of changes) {
    if (c.op !== 'set') continue;
    for (const row of c.values) {
      cells += row.length;
      for (const v of row) {
        if (typeof v === 'string' && v.trim().startsWith('=')) {
          const p = formulaProblem(v);
          if (p) return `${v.slice(0, 60)}: ${p}`;
        }
      }
    }
  }
  if (cells > MAX_SET_CELLS) return `that sets ${cells} cells; set at most ${MAX_SET_CELLS} at a time`;
  return null;
}
