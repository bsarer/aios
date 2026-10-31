/**
 * Cell ranges and formulas the chat may pass to GridCraft (D1). A range is plain A1
 * notation. A formula may only call functions from a fixed list of calculations: nothing
 * that reaches outside the workbook (WEBSERVICE, external [book] references, DDE), reads
 * the computer (INFO, CELL) or builds references from text (INDIRECT).
 */

const CELL = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;
export const MAX_COLUMN = 16_384;
export const MAX_ROW = 1_048_576;

export interface Cell {
  col: number;
  row: number;
}

export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function colLetters(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cell(ref: string): Cell | null {
  const m = CELL.exec(ref);
  if (!m) return null;
  const col = colNumber(m[1]!);
  const row = Number(m[2]);
  return col <= MAX_COLUMN && row <= MAX_ROW ? { col, row } : null;
}

export interface Range {
  start: Cell;
  end: Cell;
  /** Normalised, e.g. "A1:F20". */
  text: string;
  cells: number;
}

/** "B4:F15", "b4:f15" or "C7" → a range with its corners in order; null when it isn't A1 notation. */
export function parseRange(input: string): Range | null {
  const parts = input.trim().toUpperCase().replace(/\$/g, '').split(':');
  if (parts.length > 2) return null;
  const a = cell(parts[0]!);
  const b = parts.length === 2 ? cell(parts[1]!) : a;
  if (!a || !b) return null;
  const start = { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) };
  const end = { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) };
  const text = `${colLetters(start.col)}${start.row}:${colLetters(end.col)}${end.row}`;
  return { start, end, text, cells: (end.col - start.col + 1) * (end.row - start.row + 1) };
}

/** Worksheet functions sheet_eval may call: calculations over the workbook's own cells. */
export const ALLOWED_FUNCTIONS = new Set([
  'ABS', 'AND', 'AVERAGE', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS', 'CEILING', 'CHOOSE', 'COLUMNS', 'CONCAT', 'CONCATENATE',
  'CORREL', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'DATE', 'DATEDIF', 'DATEVALUE', 'DAY', 'DAYS', 'DROP',
  'EDATE', 'EOMONTH', 'EXACT', 'FILTER', 'FIND', 'FLOOR', 'FV', 'GEOMEAN', 'HLOOKUP', 'HOUR', 'IF', 'IFERROR', 'IFNA', 'IFS',
  'INDEX', 'INT', 'IRR', 'ISBLANK', 'ISERROR', 'ISNUMBER', 'ISTEXT', 'LARGE', 'LEFT', 'LEN', 'LET', 'LOOKUP', 'LOWER',
  'MATCH', 'MAX', 'MAXA', 'MAXIFS', 'MEDIAN', 'MID', 'MIN', 'MINA', 'MINIFS', 'MINUTE', 'MOD', 'MODE', 'MODE.SNGL', 'MONTH',
  'NETWORKDAYS', 'NOT', 'NOW', 'NPER', 'NPV', 'OR', 'PERCENTILE', 'PERCENTILE.INC', 'PMT', 'POWER', 'PRODUCT', 'PROPER',
  'PV', 'QUARTILE', 'QUARTILE.INC', 'RANK', 'RANK.EQ', 'RATE', 'RIGHT', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'ROWS', 'SEARCH',
  'SECOND', 'SIGN', 'SMALL', 'SORT', 'SORTBY', 'SQRT', 'STDEV', 'STDEV.P', 'STDEV.S', 'SUBSTITUTE', 'SUBTOTAL', 'SUM',
  'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SWITCH', 'TAKE', 'TEXT', 'TEXTJOIN', 'TODAY', 'TRIM', 'TRUNC', 'UNIQUE', 'UPPER',
  'VALUE', 'VAR', 'VAR.P', 'VAR.S', 'VLOOKUP', 'WEEKDAY', 'WEEKNUM', 'XLOOKUP', 'XMATCH', 'XOR', 'YEAR',
]);

/** Null when the formula may run, else why not (for the model). */
export function formulaProblem(formula: string): string | null {
  const f = formula.trim();
  if (!f.startsWith('=')) return 'a formula starts with =';
  if (f.length > 500) return 'that formula is too long';
  if (/[\u0000-\u001f]/.test(f)) return 'that formula has control characters';
  // Text in quotes can't call anything; look at the rest.
  const code = f.replace(/"(?:[^"]|"")*"/g, '0');
  if (code.includes('"')) return 'that formula has an unclosed quote';
  // [book] is an external workbook, | a DDE link. (Braces are array constants, which are fine.)
  if (/[[\]|]/.test(code)) return 'formulas can only refer to cells in this workbook';
  for (const m of code.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
    const name = m[1]!.toUpperCase().replace(/^_XLFN\./, '');
    if (!ALLOWED_FUNCTIONS.has(name)) return `${name} can't be used here; only calculations over this workbook's cells (SUM, AVERAGE, COUNTIF, XLOOKUP…) are allowed`;
  }
  return null;
}
