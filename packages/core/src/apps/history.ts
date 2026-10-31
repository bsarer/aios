/**
 * The record of app builds (S4): what build_status reports and what cost estimates come from.
 * Holds names, steps, outcomes and costs, never the words of a request.
 */
import type { Store } from '../store.js';

export type BuildState = 'running' | 'done' | 'failed' | 'stopped';

export interface BuildRecord {
  id: string;
  name: string;
  slug: string;
  created: boolean;
  state: BuildState;
  step: string | null;
  error: string | null;
  costUsd: number | null;
  budgetUsd: number;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  slug: string;
  created: number;
  state: BuildState;
  step: string | null;
  error: string | null;
  cost_usd: number | null;
  budget_usd: number;
  started_at: number;
  finished_at: number | null;
}

const record = (r: Row): BuildRecord => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  created: r.created === 1,
  state: r.state,
  step: r.step,
  error: r.error,
  costUsd: r.cost_usd,
  budgetUsd: r.budget_usd,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** How many recent finished builds of a kind an estimate looks at. */
const ESTIMATE_WINDOW = 20;

export class BuildLog {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  start(b: { id: string; name: string; slug: string; created: boolean; budgetUsd: number; at: number }): void {
    this.db
      .prepare(`INSERT INTO app_builds (id, name, slug, created, state, budget_usd, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(b.id, b.name, b.slug, b.created ? 1 : 0, b.budgetUsd, b.at);
  }

  step(id: string, step: string): void {
    this.db.prepare(`UPDATE app_builds SET step = ? WHERE id = ? AND state = 'running'`).run(step, id);
  }

  finish(id: string, f: { state: Exclude<BuildState, 'running'>; costUsd: number | null; error?: string | undefined; at: number }): void {
    this.db
      .prepare(`UPDATE app_builds SET state = ?, cost_usd = ?, error = ?, finished_at = ? WHERE id = ? AND state = 'running'`)
      .run(f.state, f.costUsd, f.error ?? null, f.at, id);
  }

  get(id: string): BuildRecord | null {
    const r = this.db.prepare('SELECT * FROM app_builds WHERE id = ?').get(id) as Row | undefined;
    return r ? record(r) : null;
  }

  recent(limit = 5): BuildRecord[] {
    return (this.db.prepare('SELECT * FROM app_builds ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(record);
  }

  /** Median cost of recent finished builds of this kind (new apps or changes), or null with none to go on. */
  estimate(created: boolean): { medianUsd: number; count: number } | null {
    const costs = (
      this.db
        .prepare(`SELECT cost_usd FROM app_builds WHERE state = 'done' AND created = ? AND cost_usd IS NOT NULL ORDER BY started_at DESC LIMIT ?`)
        .all(created ? 1 : 0, ESTIMATE_WINDOW) as { cost_usd: number }[]
    )
      .map((r) => r.cost_usd)
      .sort((a, b) => a - b);
    if (!costs.length) return null;
    const mid = Math.floor(costs.length / 2);
    const medianUsd = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
    return { medianUsd, count: costs.length };
  }

  /** At startup: a build left running by a crash or restart is recorded as failed. */
  recover(at: number): void {
    this.db.prepare(`UPDATE app_builds SET state = 'failed', error = 'AI OS stopped while it was building', finished_at = ? WHERE state = 'running'`).run(at);
  }
}
