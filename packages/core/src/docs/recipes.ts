/**
 * Each D2 change as WordCraft or GridCraft commands, a line for its card, and how to check
 * afterwards that it landed. The command ids and parameters live here and only here.
 *
 * Checked on 2026-10-31 against the apps' source (each command's parameter spec):
 *   WordCraft  select.text {text} (one paragraph at a time) · text.insert {text, raw} (a typed
 *     line break starts a new paragraph; raw: no AutoCorrect) · text.delete · caret.docEnd ·
 *     format.set {props: CharProps: bold, italic, underline "single"|"none", highlight
 *     camelCase, size pt, color "RRGGBB"} · para.style {style: name or id} · para.bullets
 *     {off?} (a toggle, so it is cleared first) · run --script job.json {file?, commands, save}.
 *   GridCraft  range.setValues {range, values} · home.bold/italic/wrapText {range, on} ·
 *     home.numberFormat {range, code} · home.fillColor/fontColor {range, color "#RRGGBB"} ·
 *     home.alignLeft/Center/Right {range} · home.insertRows/deleteRows {rows "3:5"} ·
 *     home.insertColumns/deleteColumns {cols "B:C"} · data.sort {range, header, keys [{column,
 *     order}]} · insert.chart {range, type, title} · insert.table {range, header} ·
 *     edit.fillDown {range} · sheet.activate {sheet}. `run --sheet` only picks the sheet to
 *     print, so the sheet is activated with a command instead.
 */
import { colLetters, colNumber, parseRange } from './cells.js';
import type { SheetChange, WordChange } from './changes.js';

export interface DocCommand {
  command: string;
  params?: Record<string, unknown>;
}

/** One line on a card: what changes, with the text before and after where there is one. */
export interface CardLine {
  what: string;
  before?: string;
  after?: string;
}

export class RecipeError extends Error {}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function countOccurrences(text: string, find: string): number {
  if (!find) return 0;
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

/** WordCraft selects text within one paragraph, so text to find can't span a line break. */
const onePara = (find: string) => {
  if (/[\r\n\u2029]/.test(find)) throw new RecipeError('quote text from within one paragraph (no line breaks) to find it');
};

const STYLE_NAME: Record<string, string> = { Normal: 'Normal', Title: 'Title', Heading1: 'Heading 1', Heading2: 'Heading 2', Heading3: 'Heading 3' };

/** Commands for Word changes, run in order on the open document. `text` is the document's text now. */
export function wordCommands(changes: WordChange[], text: string): { commands: DocCommand[]; lines: CardLine[] } {
  const commands: DocCommand[] = [];
  const lines: CardLine[] = [];
  let current = text;
  for (const c of changes) {
    switch (c.op) {
      case 'replace':
      case 'delete': {
        onePara(c.find);
        const replace = c.op === 'replace' ? c.replace : '';
        const found = countOccurrences(current, c.find);
        if (!found) throw new RecipeError(`“${clip(c.find, 80)}” is not in the document${changes.indexOf(c) ? ' (after the changes before it)' : ''}`);
        const times = c.all ? found : 1;
        if (times > 1 && replace.includes(c.find)) throw new RecipeError(`can't replace every “${clip(c.find, 80)}” with text that contains it; replace them one at a time`);
        // The first occurrence each time: after each replacement, the next one is first.
        for (let i = 0; i < times; i++) {
          commands.push({ command: 'select.text', params: { text: c.find } }, replace ? { command: 'text.insert', params: { text: replace, raw: true } } : { command: 'text.delete' });
        }
        current = c.all ? current.split(c.find).join(replace) : current.replace(c.find, replace);
        const which = times > 1 ? ` (all ${times})` : found > 1 ? ' (the first of ' + found + ')' : '';
        lines.push(c.op === 'replace' ? { what: `Replace${which}`, before: clip(c.find), after: clip(replace) } : { what: `Delete${which}`, before: clip(c.find) });
        break;
      }
      case 'format': {
        onePara(c.find);
        if (!countOccurrences(current, c.find)) throw new RecipeError(`“${clip(c.find, 80)}” is not in the document`);
        const props: Record<string, unknown> = {};
        const words: string[] = [];
        if (c.bold !== undefined) (props.bold = c.bold), words.push(c.bold ? 'bold' : 'not bold');
        if (c.italic !== undefined) (props.italic = c.italic), words.push(c.italic ? 'italic' : 'not italic');
        if (c.underline !== undefined) (props.underline = c.underline ? 'single' : 'none'), words.push(c.underline ? 'underlined' : 'not underlined');
        if (c.highlight !== undefined) (props.highlight = c.highlight), words.push(c.highlight === 'none' ? 'no highlight' : `${c.highlight} highlight`);
        if (c.size !== undefined) (props.size = c.size), words.push(`${c.size} pt`);
        if (c.color !== undefined) (props.color = c.color.replace(/^#/, '').toUpperCase()), words.push(`colour #${c.color.replace(/^#/, '').toUpperCase()}`);
        if (!words.length) throw new RecipeError('a format change needs at least one of bold, italic, underline, highlight, size or color');
        commands.push({ command: 'select.text', params: { text: c.find } }, { command: 'format.set', params: { props } });
        lines.push({ what: `Make ${words.join(', ')}`, before: clip(c.find) });
        break;
      }
      case 'style': {
        onePara(c.find);
        if (!countOccurrences(current, c.find)) throw new RecipeError(`“${clip(c.find, 80)}” is not in the document`);
        commands.push({ command: 'select.text', params: { text: c.find } }, { command: 'para.style', params: { style: STYLE_NAME[c.style] } });
        lines.push({ what: `Style the paragraph as ${STYLE_NAME[c.style]}`, before: clip(c.find) });
        break;
      }
      case 'append': {
        c.paragraphs.forEach((p, i) => {
          if (/[\r\n\u2029]/.test(p.text)) throw new RecipeError('give each paragraph as its own entry, without line breaks');
          // A new paragraph at the end (in a blank document the first one fills the empty
          // paragraph it starts with). It would carry on a list it follows, and para.bullets is
          // a toggle, so the list is cleared first and then set when wanted.
          const lead = i === 0 && current === '' ? '' : '\n';
          commands.push({ command: 'caret.docEnd' });
          if (lead || p.text) commands.push({ command: 'text.insert', params: { text: `${lead}${p.text}`, raw: true } });
          commands.push({ command: 'para.bullets', params: { off: true } });
          if (c.bullets) commands.push({ command: 'para.bullets', params: {} });
          if (p.style) commands.push({ command: 'para.style', params: { style: STYLE_NAME[p.style] } });
        });
        current = `${current}${current === '' ? '' : '\n'}${c.paragraphs.map((p) => p.text).join('\n')}`;
        lines.push({
          what: `Add ${c.paragraphs.length === 1 ? 'a paragraph' : `${c.paragraphs.length} paragraphs`}${c.bullets ? ' as a bulleted list' : ''} at the end`,
          after: clip(c.paragraphs.map((p) => `${c.bullets ? '• ' : ''}${p.style && p.style !== 'Normal' ? `[${STYLE_NAME[p.style]}] ` : ''}${p.text}`).join('\n'), 1200),
        });
        break;
      }
    }
  }
  return { commands, lines };
}

/** What a Word document's text should hold after the changes, to check them against. */
export function expectedWordText(changes: WordChange[], text: string): { contains: string[]; lacks: string[]; text: string } {
  const contains: string[] = [];
  const lacks: string[] = [];
  let current = text;
  for (const c of changes) {
    if (c.op === 'replace' || c.op === 'delete') {
      const replace = c.op === 'replace' ? c.replace : '';
      current = c.all ? current.split(c.find).join(replace) : current.replace(c.find, replace);
      if (replace.trim()) contains.push(replace);
      if (c.all && !replace.includes(c.find)) lacks.push(c.find);
    } else if (c.op === 'append') {
      current = `${current}${current === '' ? '' : '\n'}${c.paragraphs.map((p) => p.text).join('\n')}`;
      for (const p of c.paragraphs) if (p.text.trim()) contains.push(p.text);
    }
  }
  return { contains, lacks, text: current };
}

/** Text compared loosely: whitespace, smart quotes, dashes and bullets as AutoCorrect leaves them. */
export const looseText = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/^[ \t]*[•◦▪*-][ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

const fullRange = (range: string, values: unknown[][]): string => {
  const r = parseRange(range)!;
  const width = Math.max(...values.map((row) => row.length));
  return `${colLetters(r.start.col)}${r.start.row}:${colLetters(r.start.col + width - 1)}${r.start.row + values.length - 1}`;
};

const showValues = (values: (string | number | boolean | null)[][]) =>
  clip(values.map((row) => row.map((v) => (v === null ? '' : String(v))).join(' | ')).join('\n'), 1200);

const ALIGN: Record<string, string> = { left: 'home.alignLeft', center: 'home.alignCenter', right: 'home.alignRight' };

/** Commands for sheet changes, run in order on one sheet. */
export function sheetCommands(changes: SheetChange[]): { commands: DocCommand[]; lines: CardLine[] } {
  const commands: DocCommand[] = [];
  const lines: CardLine[] = [];
  for (const c of changes) {
    switch (c.op) {
      case 'set': {
        const range = fullRange(c.range, c.values);
        commands.push({ command: 'range.setValues', params: { range, values: c.values.map((row) => row.map((v) => (v === null ? '' : v))) } });
        lines.push({ what: `Set ${range}`, after: showValues(c.values) });
        break;
      }
      case 'format': {
        const range = parseRange(c.range)!.text;
        const words: string[] = [];
        if (c.bold !== undefined) commands.push({ command: 'home.bold', params: { range, on: c.bold } }), words.push(c.bold ? 'bold' : 'not bold');
        if (c.italic !== undefined) commands.push({ command: 'home.italic', params: { range, on: c.italic } }), words.push(c.italic ? 'italic' : 'not italic');
        if (c.numberFormat !== undefined) commands.push({ command: 'home.numberFormat', params: { range, code: c.numberFormat } }), words.push(`number format ${c.numberFormat}`);
        if (c.fillColor !== undefined) commands.push({ command: 'home.fillColor', params: { range, color: `#${c.fillColor.replace(/^#/, '').toUpperCase()}` } }), words.push(`fill #${c.fillColor.replace(/^#/, '').toUpperCase()}`);
        if (c.fontColor !== undefined) commands.push({ command: 'home.fontColor', params: { range, color: `#${c.fontColor.replace(/^#/, '').toUpperCase()}` } }), words.push(`text colour #${c.fontColor.replace(/^#/, '').toUpperCase()}`);
        if (c.horizontalAlign !== undefined) commands.push({ command: ALIGN[c.horizontalAlign]!, params: { range } }), words.push(`aligned ${c.horizontalAlign}`);
        if (c.wrapText !== undefined) commands.push({ command: 'home.wrapText', params: { range, on: c.wrapText } }), words.push(c.wrapText ? 'wrapped' : 'not wrapped');
        if (!words.length) throw new RecipeError('a format change needs at least one formatting option');
        lines.push({ what: `Format ${range}: ${words.join(', ')}` });
        break;
      }
      case 'insert_rows':
        commands.push({ command: 'home.insertRows', params: { rows: `${c.before}:${c.before + c.count - 1}` } });
        lines.push({ what: `Insert ${c.count} row${c.count === 1 ? '' : 's'} above row ${c.before}` });
        break;
      case 'delete_rows':
        commands.push({ command: 'home.deleteRows', params: { rows: `${c.from}:${c.from + c.count - 1}` } });
        lines.push({ what: `Delete row${c.count === 1 ? ` ${c.from}` : `s ${c.from}–${c.from + c.count - 1}`}` });
        break;
      case 'insert_columns':
        commands.push({ command: 'home.insertColumns', params: { cols: `${c.before}:${colLetters(colNumber(c.before) + c.count - 1)}` } });
        lines.push({ what: `Insert ${c.count} column${c.count === 1 ? '' : 's'} left of column ${c.before}` });
        break;
      case 'delete_columns':
        commands.push({ command: 'home.deleteColumns', params: { cols: `${c.from}:${colLetters(colNumber(c.from) + c.count - 1)}` } });
        lines.push({ what: `Delete column${c.count === 1 ? ` ${c.from}` : `s ${c.from}–${colLetters(colNumber(c.from) + c.count - 1)}`}` });
        break;
      case 'sort': {
        const range = parseRange(c.range)!.text;
        commands.push({ command: 'data.sort', params: { range, keys: c.by.map((k) => ({ column: k.column, order: k.order })), header: c.header ?? false } });
        lines.push({ what: `Sort ${range} by ${c.by.map((k) => `${k.column} ${k.order === 'asc' ? 'ascending' : 'descending'}`).join(', then ')}${c.header ? ', keeping the header row on top' : ''}` });
        break;
      }
      case 'chart': {
        const range = parseRange(c.range)!.text;
        commands.push({ command: 'insert.chart', params: { range, type: c.type, ...(c.title ? { title: c.title } : {}) } });
        lines.push({ what: `Add a ${c.type} chart of ${range}${c.title ? ` titled “${clip(c.title, 80)}”` : ''}` });
        break;
      }
      case 'table': {
        const range = parseRange(c.range)!.text;
        commands.push({ command: 'insert.table', params: { range, header: c.header ?? true } });
        lines.push({ what: `Make ${range} a table${c.header === false ? ' without a header row' : ''}` });
        break;
      }
      case 'fill_down': {
        const range = parseRange(c.range)!.text;
        commands.push({ command: 'edit.fillDown', params: { range } });
        lines.push({ what: `Fill the top cell of ${range} down` });
        break;
      }
    }
  }
  return { commands, lines };
}

/** Plain-value `set` changes that nothing after them moves, to read back afterwards. */
export function sheetChecks(changes: SheetChange[]): { range: string; values: string[][] }[] {
  const out: { range: string; values: string[][] }[] = [];
  changes.forEach((c, i) => {
    if (c.op !== 'set') return;
    const moved = changes.slice(i + 1).some((d) => ['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'sort'].includes(d.op));
    const plain = c.values.every((row) => row.every((v) => !(typeof v === 'string' && v.trim().startsWith('='))));
    if (moved || !plain) return;
    out.push({ range: fullRange(c.range, c.values), values: c.values.map((row) => row.map((v) => (v === null ? '' : String(v)))) });
  });
  return out;
}

/** A displayed cell matches what was set: the same text, or the same number however it is formatted. */
export function cellMatches(shown: string, want: string): boolean {
  if (shown.trim() === want.trim()) return true;
  const n = (s: string) => Number(s.replace(/[,\s]/g, ''));
  return want.trim() !== '' && Number.isFinite(n(want)) && n(shown) === n(want);
}
