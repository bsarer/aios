/**
 * Changing routines from the chat. A model call (routine_change, write tier) only puts a card in
 * the chat showing the change line by line; the file is written in confirm(), reached solely by
 * the user's Save click carrying the card's hash, and only while the file is still what the card
 * was made from. The new text is checked like any routine file, before the card and again on the
 * click. The old file is kept as a hidden `.<name>.md.bak` (hidden files are never read as
 * routines). Like every write-tier tool, routine_change is never offered while an email, invite,
 * document or other outside text is in view, and a scheduled routine can't use it at all.
 *
 * Open in editor (a click on a routines or routine card) names a routine by its slug only; the
 * file is checked again and opened in the user's editor.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { normalizeText, parseRoutine, type RoutineFolder } from './routines.js';

type ChangeItem = Extract<ChatItem, { kind: 'routine_change' }>;
type DiffLine = ChangeItem['diff'][number];

/** Line by line, from a longest common subsequence. Files are at most 16 KB, so this stays small. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: '-', text: a[i++]! });
    else out.push({ op: '+', text: b[j++]! });
  }
  return out;
}

const sideOf = (diff: DiffLine[], drop: '+' | '-') => {
  const lines = diff.filter((d) => d.op !== drop).map((d) => d.text);
  return lines.length ? `${lines.join('\n')}\n` : '';
};

export function routineChangeHash(slug: string, before: string, after: string): string {
  return createHash('sha256').update(['routine_change', slug, before, after].join('\0')).digest('hex');
}

export interface RoutineActionsOptions {
  folder: RoutineFolder;
  store: Pick<Store, 'getItem' | 'saveItem'>;
  audit: AuditLog;
  /** Posts a new card (isNew) or re-renders one. */
  show: (item: ChatItem, isNew: boolean) => void;
  notice: (level: 'info' | 'warning', text: string) => void;
  /** Opens a file in the user's editor; resolves with the editor's name. */
  openEditor?: (path: string) => Promise<string>;
  clock?: () => number;
  newId?: () => string;
}

export class RoutineError extends Error {}

export class RoutineActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: RoutineActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `routine-${randomUUID().slice(0, 8)}`);
  }

  private fileText(slug: string): string {
    return `${this.o.folder.display}/${slug}.md`;
  }

  /** Checks the new text and posts a card. Throws RoutineError with a message for the model. */
  propose(slug: string, text: string): { isNew: boolean; name: string } {
    const after = normalizeText(text);
    const r = parseRoutine(after, slug);
    if (!r.ok) throw new RoutineError(`that file wouldn't load as a routine: ${r.error}. Fix it and call routine_change again`);
    const clash = this.o.folder
      .load()
      .routines.filter((x) => x.slug !== slug)
      .flatMap((x) => r.routine.say.filter((p) => x.say.includes(p)).map((p) => `"${p}" is already ${x.name}'s phrase`));
    if (clash.length) throw new RoutineError(`${clash[0]}; pick another phrase`);
    let current: string | null;
    try {
      current = this.o.folder.read(slug);
    } catch (err) {
      throw new RoutineError((err as Error).message);
    }
    const before = current === null ? '' : normalizeText(current);
    if (current !== null && before === after) throw new RoutineError('that is exactly what the file says already; nothing to change');
    const diff = lineDiff(before, after);
    const item: ChangeItem = {
      kind: 'routine_change',
      id: this.newId(),
      slug,
      name: r.routine.name,
      file: this.fileText(slug),
      isNew: current === null,
      diff,
      hash: routineChangeHash(slug, before, after),
      state: 'pending',
      at: this.clock(),
    };
    this.o.show(item, true);
    return { isNew: item.isNew, name: item.name };
  }

  private settle(item: ChangeItem, state: ChangeItem['state'], result?: string): void {
    this.o.show({ ...item, state, ...(result ? { result } : {}) }, false);
  }

  /** The user's Save click. Writes only what the card showed, only if the file is still as it was. */
  confirm(id: string, hash: string): 'done' | 'failed' | 'refused' {
    const item = this.o.store.getItem(id);
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: 'routine_change', tier: 'write', via: 'click', itemId: id, ...entry });
    if (item?.kind !== 'routine_change' || (item.state !== 'pending' && item.state !== 'failed')) {
      audit({ decision: 'denied', reason: 'not a pending routine change' });
      return 'refused';
    }
    const before = item.isNew ? '' : sideOf(item.diff, '+');
    const after = sideOf(item.diff, '-');
    if (hash !== item.hash || routineChangeHash(item.slug, before, after) !== item.hash) {
      audit({ decision: 'denied', reason: 'hash mismatch', routine: item.slug });
      return 'refused';
    }
    const fail = (why: string) => {
      audit({ decision: 'approved', ok: false, routine: item.slug, error: why });
      this.settle(item, 'failed', `Not saved: ${why}.`);
      return 'failed' as const;
    };
    const r = parseRoutine(after, item.slug);
    if (!r.ok) return fail(r.error);
    let current: string | null;
    try {
      current = this.o.folder.read(item.slug);
    } catch (err) {
      return fail((err as Error).message);
    }
    if (item.isNew ? current !== null : current === null || normalizeText(current) !== before) return fail(`${item.slug}.md changed since this card was made. Ask again to see the change against the file as it is now`);
    try {
      const dir = this.o.folder.dir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(dir).isDirectory()) return fail('the routines folder is not a folder');
      const path = this.o.folder.pathOf(item.slug);
      if (current !== null) copyFileSync(path, join(dir, `.${item.slug}.md.bak`));
      const tmp = join(dir, `.${item.slug}.md.${randomUUID().slice(0, 8)}.tmp`);
      writeFileSync(tmp, after, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (err) {
      return fail((err as Error).message.slice(0, 200));
    }
    audit({ decision: 'approved', ok: true, routine: item.slug, isNew: item.isNew, chars: after.length });
    this.settle(item, 'done', item.isNew ? `Saved: ${item.file} is a new routine.` : `Saved ${item.file}.${current === null ? '' : ` The old version is in .${item.slug}.md.bak next to it.`}`);
    return 'done';
  }

  discard(id: string): void {
    const item = this.o.store.getItem(id);
    if (item?.kind !== 'routine_change' || (item.state !== 'pending' && item.state !== 'failed')) return;
    this.o.audit.append({ kind: 'tool', tool: 'routine_change', tier: 'write', via: 'click', itemId: id, decision: 'discarded', routine: item.slug });
    this.settle(item, 'discarded');
  }

  /** Open in editor: the user's click, naming a routine by its slug. The file is checked again first. */
  async open(slug: string): Promise<void> {
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'routine', event: 'open', routine: slug, via: 'click', ...entry });
    if (!this.o.openEditor) return void this.o.notice('info', `Open ${this.fileText(slug)} in any text editor to change it.`);
    try {
      if (this.o.folder.read(slug) === null) throw new Error(`there is no ${slug}.md any more`);
      const editor = await this.o.openEditor(this.o.folder.pathOf(slug));
      audit({ ok: true, editor });
      this.o.notice('info', `Opened ${this.fileText(slug)} in ${editor}. Save it there; the change applies at once (/routines shows it).`);
    } catch (err) {
      audit({ ok: false });
      this.o.notice('warning', `I couldn't open ${slug}.md: ${(err as Error).message.slice(0, 200)}. It is ${this.fileText(slug)}; open it in any text editor.`);
    }
  }
}
