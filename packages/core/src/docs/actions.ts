/**
 * The approval broker for document changes (D2). A model call can only put a card in the
 * chat. The change happens only in confirm(), reached solely by a click on that card
 * carrying the hash of what it showed.
 *
 *   pending ──confirm click (hash matches)──▶ running ──▶ done
 *      │                                        └──────▶ failed ──confirm click──▶ running
 *      └──── Discard ──▶ discarded                 (failed can be discarded too)
 *
 * The apps write into a private temporary folder; the result is copied into place only if
 * it is there and starts like a document. A new name is never one that exists (the copy
 * refuses to replace a file). Overwriting the original, which only the user's own words can
 * ask for, first copies it to the backups folder. Before running, the original must be
 * exactly as it was when the card was made.
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import type { DocEngine } from './engine.js';
import { type DocFiles, type DocKind, DocPathError } from './files.js';
import { type CardLine, type DocCommand, cellMatches, looseText } from './recipes.js';
import type { DocumentFiles } from './viewer.js';

type ChangeItem = Extract<ChatItem, { kind: 'doc_change' }>;
type ChangeState = ChangeItem['state'];

export interface DocChangeSpec {
  change: 'edit' | 'create';
  kind: DocKind;
  /** The original, as it was when the card was made (edit). */
  source?: { path: string; mtimeMs: number; bytes: number };
  sheet?: string;
  /** Absolute path the click writes. */
  output: string;
  overwrite: boolean;
  commands: DocCommand[];
  /** How to tell afterwards that the changes landed. */
  checks: { word?: { contains: string[]; lacks: string[]; text: string }; sheet?: { range: string; values: string[][] }[] };
  /** Change kinds and counts, for the audit log (never the text). */
  summary: Record<string, number>;
}

interface Row {
  id: string;
  spec: string;
  card: string;
  hash: string;
  state: ChangeState;
  result: string | null;
  created_at: number;
}

type CardFields = Omit<ChangeItem, 'kind' | 'id' | 'hash' | 'state' | 'result' | 'at'>;

export interface DocActionsOptions {
  store: Store;
  files: Pick<DocFiles, 'resolve' | 'display'>;
  engine: Pick<DocEngine, 'applyWord' | 'applySheet' | 'wordText' | 'sheetRange'>;
  viewer: Pick<DocumentFiles, 'show'>;
  audit: AuditLog;
  /** Where originals go before an overwrite. */
  backupDir: string;
  show: (item: ChatItem, isNew: boolean) => void;
  clock?: () => number;
  newId?: () => string;
}

export type DocConfirmResult = 'done' | 'failed' | 'refused';

const TOOL = (s: DocChangeSpec) => (s.change === 'create' ? 'doc_create' : s.kind === 'word' ? 'doc_edit' : 'sheet_edit');

class ChangeError extends Error {}

export class DocActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: DocActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `docchg-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM doc_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): ChangeItem {
    return { kind: 'doc_change', id: r.id, ...(JSON.parse(r.card) as CardFields), hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
  }

  get(id: string): ChangeItem | null {
    const r = this.row(id);
    return r ? this.item(r) : null;
  }

  private refresh(id: string): void {
    const r = this.row(id);
    if (r) this.o.show(this.item(r), false);
  }

  private transition(id: string, from: ChangeState[], to: ChangeState, result: string | null = null): boolean {
    const r = this.db
      .prepare(`UPDATE doc_actions SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  /** Show a card asking for the change. Writes nothing. */
  propose(spec: DocChangeSpec, lines: CardLine[], warnings: string[]): ChangeItem {
    const id = this.newId();
    const card: CardFields = {
      change: spec.change,
      fileKind: spec.kind,
      ...(spec.source ? { file: this.o.files.display(spec.source.path) } : {}),
      output: this.o.files.display(spec.output),
      overwrite: spec.overwrite,
      lines,
      warnings,
    };
    const specJson = JSON.stringify(spec);
    const cardJson = JSON.stringify(card);
    const hash = createHash('sha256').update(`${id}\n${specJson}\n${cardJson}`).digest('hex');
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO doc_actions (id, spec, card, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, specJson, cardJson, hash, now, now);
    this.o.audit.append({ kind: 'docs', event: 'proposed', cardId: id, change: spec.change, fileKind: spec.kind, path: spec.source?.path ?? null, output: spec.output, overwrite: spec.overwrite, changes: spec.summary, warnings: warnings.length });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  /** The Save click. Runs only a pending (or failed) card whose hash matches what it showed. */
  async confirm(id: string, shownHash: string): Promise<DocConfirmResult> {
    const r = this.row(id);
    const spec = r ? (JSON.parse(r.spec) as DocChangeSpec) : null;
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: spec ? TOOL(spec) : 'doc_change', tier: 'write', cardId: id, via: 'click', ...entry });
    if (!r || !spec) {
      audit({ decision: 'denied', reason: 'unknown card' });
      return 'refused';
    }
    if (r.hash !== shownHash) {
      audit({ decision: 'denied', reason: 'hash does not match the card' });
      this.refresh(id);
      return 'refused';
    }
    if (!this.transition(id, ['pending', 'failed'], 'running')) {
      audit({ decision: 'denied', reason: `card is ${r.state}` });
      return 'refused';
    }
    audit({ decision: 'approved', path: spec.source?.path ?? null, output: spec.output, overwrite: spec.overwrite, changes: spec.summary });
    this.refresh(id);
    try {
      const { result, problems } = await this.run(spec);
      this.transition(id, ['running'], 'done', result);
      audit({ decision: 'approved', ok: true, output: spec.output, problems: problems.length });
      this.refresh(id);
      return 'done';
    } catch (err) {
      const why = err instanceof ChangeError || err instanceof DocPathError ? err.message : `${(err as Error).message}`;
      this.transition(id, ['running'], 'failed', `Didn't work: ${why}`);
      audit({ decision: 'approved', ok: false, error: why });
      this.refresh(id);
      return 'failed';
    }
  }

  discard(id: string): boolean {
    if (!this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'docs', event: 'discarded', cardId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: a change left running by a crash is shown as failed, never re-run on its own. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM doc_actions WHERE state = 'running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['running'], 'failed', 'The app stopped while saving this. Check the folder, or click again: an existing file is never replaced by a new copy.');
      this.o.audit.append({ kind: 'docs', event: 'interrupted', cardId: id });
      this.refresh(id);
    }
  }

  private async run(spec: DocChangeSpec): Promise<{ result: string; problems: string[] }> {
    // The original must be exactly what the card was made from.
    let source: string | null = null;
    if (spec.source) {
      const now = await this.o.files.resolve(spec.source.path);
      if (now.path !== spec.source.path || now.mtimeMs !== spec.source.mtimeMs || now.bytes !== spec.source.bytes) {
        throw new ChangeError('the file changed since this card was made. Ask again so the card shows the changes to the file as it is now.');
      }
      source = now.path;
    }
    const dir = await mkdtemp(join(tmpdir(), 'aios-doc-out-'));
    try {
      const temp = join(dir, basename(spec.output));
      if (spec.kind === 'word') await this.o.engine.applyWord(source, spec.commands, temp);
      else await this.o.engine.applySheet(source, spec.sheet, spec.commands, temp);
      if (!(await startsWithZip(temp))) throw new ChangeError(`${spec.kind === 'word' ? 'WordCraft' : 'GridCraft'} did not save a document`);
      const problems = await this.check(spec, temp);
      if (spec.overwrite && source) {
        await mkdir(this.o.backupDir, { recursive: true, mode: 0o700 });
        const backup = join(this.o.backupDir, `${new Date(this.clock()).toISOString().replace(/[:.]/g, '-')}-${basename(source)}`);
        await copyFile(source, backup, constants.COPYFILE_EXCL);
        await copyFile(temp, spec.output);
      } else {
        try {
          await copyFile(temp, spec.output, constants.COPYFILE_EXCL);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ChangeError(`${this.o.files.display(spec.output)} exists now. Ask again for a new name.`);
          throw err;
        }
      }
      const saved = await this.o.files.resolve(spec.output);
      this.o.viewer.show(saved);
      const where = this.o.files.display(spec.output);
      const head = spec.overwrite ? `✓ Saved over ${where}; the original is in the backups folder.` : spec.change === 'create' ? `✓ Created ${where}.` : `✓ Saved as ${where}; the original is unchanged.`;
      return { result: problems.length ? `${head} ⚠ ${problems.join(' ')}` : head, problems };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Read the new file back: did each change land, and is the rest as it was? */
  private async check(spec: DocChangeSpec, temp: string): Promise<string[]> {
    const problems: string[] = [];
    try {
      if (spec.checks.word) {
        const got = looseText(await this.o.engine.wordText(temp));
        const missing = spec.checks.word.contains.filter((t) => !got.includes(looseText(t)));
        const left = spec.checks.word.lacks.filter((t) => got.includes(looseText(t)));
        if (missing.length || left.length) problems.push("Some changes didn't land; check the new file.");
        const want = looseText(spec.checks.word.text);
        if (Math.abs(got.length - want.length) > Math.max(40, want.length * 0.03)) problems.push('Some text outside these changes looks different; check the new file before relying on it.');
      }
      for (const c of spec.checks.sheet ?? []) {
        const grid = await this.o.engine.sheetRange(temp, { range: c.range, sheet: spec.sheet });
        const ok = c.values.every((row, i) => row.every((v, j) => cellMatches(grid.rows[i]?.[j] ?? '', v)));
        if (!ok) problems.push(`${c.range} doesn't hold what was set; check the new file.`);
      }
    } catch (err) {
      problems.push(`It couldn't be read back to check (${(err as Error).message}).`);
    }
    return problems;
  }
}

async function startsWithZip(p: string): Promise<boolean> {
  const fh = await open(p, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  } finally {
    await fh.close();
  }
}
