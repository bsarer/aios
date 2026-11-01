/**
 * The approval broker for file changes (F1): renaming or copying a file, a new folder, a new
 * note. A model call only puts a card in the chat; the change happens in confirm(), reached
 * solely by a click on that card carrying the hash of what it showed (the D2 pattern).
 *
 *   pending ──confirm click (hash matches)──▶ running ──▶ done
 *      │                                        └──────▶ failed ──confirm click──▶ running
 *      └──── Discard ──▶ discarded
 *
 * Nothing here replaces or deletes a file: a rename links the new name (which fails if it is
 * taken) and only then removes the old one, copies and new files are exclusive writes, and a
 * new folder fails if it exists. A file must be exactly as it was when the card was made.
 */
import { constants } from 'node:fs';
import { copyFile, link, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { FilePathError, type FileRoots, exists, folderOf } from './roots.js';

type ChangeItem = Extract<ChatItem, { kind: 'file_change' }>;
type ChangeState = ChangeItem['state'];

export type FileChangeSpec =
  | { op: 'rename'; from: { path: string; mtimeMs: number; bytes: number }; to: string }
  | { op: 'copy'; from: { path: string; mtimeMs: number; bytes: number }; to: string }
  | { op: 'folder'; to: string }
  | { op: 'note'; to: string; content: string }
  /** F2: the file's tags in the index become exactly these. Changes nothing on disk. */
  | { op: 'tag'; to: string; tags: string[] };

/** What happened, for whoever keeps track of files (F2's index). */
export type FileChanged = { op: 'renamed'; from: string; to: string } | { op: 'copied'; from: string; to: string } | { op: 'created'; path: string; folder: boolean };

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

export interface FileActionsOptions {
  store: Store;
  roots: Pick<FileRoots, 'resolve' | 'display'>;
  audit: AuditLog;
  show: (item: ChatItem, isNew: boolean) => void;
  onChanged?: (change: FileChanged) => void;
  /** F2: sets a file's tags in the index; false when the file isn't indexed. Without it, tag cards fail. */
  setTags?: (path: string, tags: string[]) => boolean;
  clock?: () => number;
  newId?: () => string;
}

export type FileConfirmResult = 'done' | 'failed' | 'refused';

const TOOL: Record<FileChangeSpec['op'], string> = { rename: 'file_rename', copy: 'file_copy', folder: 'folder_create', note: 'note_create', tag: 'file_tag' };

class ChangeError extends Error {}

export class FileActions {
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: FileActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `filechg-${randomUUID().slice(0, 8)}`);
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM file_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): ChangeItem {
    return { kind: 'file_change', id: r.id, ...(JSON.parse(r.card) as CardFields), hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
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
      .prepare(`UPDATE file_actions SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  /** Show a card asking for the change. Changes nothing. */
  propose(spec: FileChangeSpec, warnings: string[]): ChangeItem {
    const id = this.newId();
    const card: CardFields = {
      change: spec.op,
      ...(spec.op === 'rename' || spec.op === 'copy' ? { from: this.o.roots.display(spec.from.path) } : {}),
      to: this.o.roots.display(spec.to),
      ...(spec.op === 'note' ? { preview: spec.content.length > 1200 ? `${spec.content.slice(0, 1200)}…` : spec.content } : {}),
      ...(spec.op === 'tag' ? { tags: spec.tags } : {}),
      warnings,
    };
    const specJson = JSON.stringify(spec);
    const cardJson = JSON.stringify(card);
    const hash = createHash('sha256').update(`${id}\n${specJson}\n${cardJson}`).digest('hex');
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO file_actions (id, spec, card, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, specJson, cardJson, hash, now, now);
    this.o.audit.append({ kind: 'files', event: 'proposed', cardId: id, op: spec.op, from: 'from' in spec ? spec.from.path : null, to: spec.to, chars: spec.op === 'note' ? spec.content.length : undefined, tags: spec.op === 'tag' ? spec.tags.length : undefined, warnings: warnings.length });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  /** The click. Runs only a pending (or failed) card whose hash matches what it showed. */
  async confirm(id: string, shownHash: string): Promise<FileConfirmResult> {
    const r = this.row(id);
    const spec = r ? (JSON.parse(r.spec) as FileChangeSpec) : null;
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: spec ? TOOL[spec.op] : 'file_change', tier: 'write', cardId: id, via: 'click', ...entry });
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
    audit({ decision: 'approved', op: spec.op, from: 'from' in spec ? spec.from.path : null, to: spec.to });
    this.refresh(id);
    try {
      const result = await this.run(spec);
      this.transition(id, ['running'], 'done', result);
      audit({ decision: 'approved', ok: true, to: spec.to });
      this.refresh(id);
      return 'done';
    } catch (err) {
      const why = err instanceof ChangeError || err instanceof FilePathError ? err.message : existsMessage(err, this.o.roots.display(spec.to)) ?? (err as Error).message;
      this.transition(id, ['running'], 'failed', `Didn't work: ${why}`);
      audit({ decision: 'approved', ok: false, error: why });
      this.refresh(id);
      return 'failed';
    }
  }

  discard(id: string): boolean {
    if (!this.transition(id, ['pending', 'failed'], 'discarded')) return false;
    this.o.audit.append({ kind: 'files', event: 'discarded', cardId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: a change left running by a crash is shown as failed, never re-run on its own. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM file_actions WHERE state = 'running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['running'], 'failed', 'The app stopped while doing this. Check the folder, or click again: nothing is ever replaced.');
      this.o.audit.append({ kind: 'files', event: 'interrupted', cardId: id });
      this.refresh(id);
    }
  }

  private async unchanged(from: { path: string; mtimeMs: number; bytes: number }): Promise<void> {
    const now = await this.o.roots.resolve(from.path, 'file');
    if (now.path !== from.path || now.mtimeMs !== from.mtimeMs || now.bytes !== from.bytes) {
      throw new ChangeError('the file changed since this card was made. Ask again so the card shows the file as it is now.');
    }
  }

  /** The folder a new name goes into must still be an allowed folder. */
  private async folderAllowed(p: string): Promise<void> {
    const dir = await this.o.roots.resolve(folderOf(p), 'dir');
    if (dir.path !== folderOf(p)) throw new ChangeError('that folder moved since this card was made. Ask again.');
  }

  private async run(spec: FileChangeSpec): Promise<string> {
    const to = this.o.roots.display(spec.to);
    if (spec.op === 'tag') {
      const f = await this.o.roots.resolve(spec.to, 'file');
      if (f.path !== spec.to) throw new ChangeError('that file moved since this card was made. Ask again.');
      if (!this.o.setTags?.(spec.to, spec.tags)) throw new ChangeError("that file isn't in the file index yet. Try again in a minute.");
      return spec.tags.length ? `✓ Tagged ${to}: ${spec.tags.join(', ')}.` : `✓ Removed the tags from ${to}.`;
    }
    await this.folderAllowed(spec.to);
    switch (spec.op) {
      case 'rename':
        await this.unchanged(spec.from);
        // link() fails if the new name exists, so nothing is ever replaced; then the old name goes.
        try {
          await link(spec.from.path, spec.to);
          await unlink(spec.from.path);
        } catch (err) {
          // Some drives (FAT, some network shares) have no hard links: check, then rename.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err;
          if (await exists(spec.to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          await rename(spec.from.path, spec.to);
        }
        this.o.onChanged?.({ op: 'renamed', from: spec.from.path, to: spec.to });
        return `✓ Renamed to ${to}.`;
      case 'copy':
        await this.unchanged(spec.from);
        await copyFile(spec.from.path, spec.to, constants.COPYFILE_EXCL);
        this.o.onChanged?.({ op: 'copied', from: spec.from.path, to: spec.to });
        return `✓ Copied to ${to}.`;
      case 'folder':
        await mkdir(spec.to);
        this.o.onChanged?.({ op: 'created', path: spec.to, folder: true });
        return `✓ Created the folder ${to}.`;
      case 'note':
        await writeFile(spec.to, spec.content, { flag: 'wx', mode: 0o644 });
        this.o.onChanged?.({ op: 'created', path: spec.to, folder: false });
        return `✓ Created ${to}.`;
    }
  }
}

function existsMessage(err: unknown, to: string): string | null {
  return (err as NodeJS.ErrnoException).code === 'EEXIST' ? `${to} exists now. Ask again for another name.` : null;
}
