import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ChatItem } from '@aios/shared';
import Database from 'better-sqlite3';
import type { ChatMessage, ToolCall } from './model.js';

const MIGRATIONS = [
  `CREATE TABLE items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, at INTEGER NOT NULL);
   CREATE TABLE usage (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, ok INTEGER NOT NULL,
                       error_kind TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, latency_ms REAL);
   CREATE INDEX usage_at ON usage(at);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // A3: full-text index over long-term memory files (rebuilt from the files, never the source of truth).
  `CREATE VIRTUAL TABLE memory_fts USING fts5(kind UNINDEXED, ref UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');
   CREATE INDEX turns_at ON turns(at);`,
  // A4: mail watcher state and the triage queue (plan §5).
  `CREATE TABLE mail_state (folder TEXT PRIMARY KEY, uidvalidity TEXT NOT NULL, last_uid INTEGER NOT NULL, checked_at INTEGER NOT NULL);
   CREATE TABLE mail_events (message_id TEXT PRIMARY KEY, mail_id TEXT NOT NULL, from_text TEXT NOT NULL, subject TEXT NOT NULL,
                             date INTEGER, received_at INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, triage TEXT, attempts INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX mail_events_status ON mail_events(status, received_at);
   CREATE TABLE notification_log (at INTEGER NOT NULL);`,
  // A5: drafts and their approval state. The hash is what a Send click must match.
  `CREATE TABLE drafts (id TEXT PRIMARY KEY, to_json TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, in_reply_to TEXT, reply_headers TEXT,
                       hash TEXT NOT NULL, state TEXT NOT NULL, warnings TEXT NOT NULL, error TEXT, message_id TEXT NOT NULL, draft_uid INTEGER,
                       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER);
   CREATE INDEX drafts_state ON drafts(state);`,
  // S1: system changes waiting for a click (Wi-Fi off, switching networks, pairing, forgetting).
  `CREATE TABLE system_actions (id TEXT PRIMARY KEY, spec TEXT NOT NULL, title TEXT NOT NULL, confirm TEXT NOT NULL, hash TEXT NOT NULL,
                               state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX system_actions_state ON system_actions(state);`,
  // S4: each app build, for its progress, build_status and cost estimates. Never the request's words.
  `CREATE TABLE app_builds (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL,
                           step TEXT, error TEXT, cost_usd REAL, budget_usd REAL NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE INDEX app_builds_started ON app_builds(started_at);`,
  // C1: calendar changes waiting for a click. The hash is what the click must match.
  `CREATE TABLE calendar_actions (id TEXT PRIMARY KEY, spec TEXT NOT NULL, card TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
                                 result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX calendar_actions_state ON calendar_actions(state);`,
  // D2: document changes waiting for a click. The hash is what the click must match.
  `CREATE TABLE doc_actions (id TEXT PRIMARY KEY, spec TEXT NOT NULL, card TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
                            result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX doc_actions_state ON doc_actions(state);`,
  // F1: file changes (rename, copy, new folder, new note) waiting for a click.
  `CREATE TABLE file_actions (id TEXT PRIMARY KEY, spec TEXT NOT NULL, card TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
                             result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX file_actions_state ON file_actions(state);`,
  // F2: what is known about each file in the allowed folders, and a full-text index over it.
  // Rebuilt from the disk at any time (/reindex); only tags are the user's own words.
  `CREATE TABLE file_index (path TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL,
                           mtime_ms REAL NOT NULL, birthtime_ms REAL NOT NULL, facts TEXT, facts_state TEXT NOT NULL, summary TEXT, keywords TEXT,
                           summary_state TEXT NOT NULL, summary_attempts INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '', seen_at INTEGER NOT NULL);
   CREATE INDEX file_index_facts ON file_index(facts_state, mtime_ms);
   CREATE INDEX file_index_summary ON file_index(summary_state, mtime_ms);
   CREATE VIRTUAL TABLE file_fts USING fts5(path UNINDEXED, name, folder, title, keywords, tags, summary, details, tokenize = 'unicode61 remove_diacritics 2');`,
  // L1: when each file was last used (opened or changed) apart from the indexer's own reads, and
  // what each morning review card's rows point at (paths, window addresses), never shown to a model,
  // and what the user chose to keep so it isn't suggested again.
  `CREATE TABLE cleanup_cards (id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE cleanup_keep (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
   ALTER TABLE file_index ADD COLUMN used_ms REAL;
   ALTER TABLE file_index ADD COLUMN read_at REAL;`,
  // M1: files attached to a draft (path, name, size and sha256 of the bytes a Send must find again).
  `ALTER TABLE drafts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';`,
];

export interface UsageRow {
  at: number;
  role: string;
  model: string;
  ok: boolean;
  errorKind?: string | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  costUsd?: number | null | undefined;
  latencyMs?: number | undefined;
}

/** SQLite-backed short-term state: chat history for the UI, model turns, usage, settings. */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  // ── UI items ──

  saveItem(item: ChatItem): void {
    this.db
      .prepare('INSERT INTO items (id, json, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(item.id, JSON.stringify(item), item.at);
  }

  getItem(id: string): ChatItem | null {
    const row = this.db.prepare('SELECT json FROM items WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) return null;
    const parsed = ChatItem.safeParse(JSON.parse(row.json));
    return parsed.success ? parsed.data : null;
  }

  recentItems(limit = 200): ChatItem[] {
    const rows = this.db.prepare('SELECT json FROM items ORDER BY seq DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.reverse().flatMap((r) => {
      const parsed = ChatItem.safeParse(JSON.parse(r.json));
      return parsed.success ? [parsed.data] : [];
    });
  }

  // ── Model turns ──

  saveTurn(m: ChatMessage, at: number): void {
    const toolCalls = m.role === 'assistant' && m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null;
    this.db
      .prepare('INSERT INTO turns (role, content, tool_calls, tool_call_id, name, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.role, m.content, toolCalls, m.role === 'tool' ? m.toolCallId : null, m.role === 'tool' ? m.name : null, at);
  }

  /**
   * The last `limit` turns, trimmed so the window starts at a user message: a tool
   * result or tool-calling assistant turn without its pair would be rejected by the API.
   */
  recentTurns(limit = 30): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM turns ORDER BY seq DESC LIMIT ?').all(limit) as {
      role: string;
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
      name: string | null;
    }[];
    const msgs: ChatMessage[] = rows.reverse().map((r) => {
      if (r.role === 'tool') return { role: 'tool', toolCallId: r.tool_call_id ?? '', name: r.name ?? '', content: r.content ?? '' };
      if (r.role === 'assistant') {
        const toolCalls = r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : undefined;
        return { role: 'assistant', content: r.content, ...(toolCalls ? { toolCalls } : {}) };
      }
      return { role: r.role as 'user' | 'system', content: r.content ?? '' };
    });
    const firstUser = msgs.findIndex((m) => m.role === 'user');
    return firstUser < 0 ? [] : msgs.slice(firstUser);
  }

  /** User messages and assistant replies with text in [from, to), oldest first. No tool calls or tool results. */
  chatTurnsBetween(from: number, to: number): { role: 'user' | 'assistant'; content: string; at: number }[] {
    return this.db
      .prepare(
        `SELECT role, content, at FROM turns
         WHERE at >= ? AND at < ? AND role IN ('user', 'assistant') AND content IS NOT NULL AND content != '' AND tool_calls IS NULL
         ORDER BY seq`,
      )
      .all(from, to) as { role: 'user' | 'assistant'; content: string; at: number }[];
  }

  // ── Usage and cost ──

  recordUsage(u: UsageRow): void {
    this.db
      .prepare(
        'INSERT INTO usage (at, role, model, ok, error_kind, prompt_tokens, completion_tokens, cost_usd, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(u.at, u.role, u.model, u.ok ? 1 : 0, u.errorKind ?? null, u.promptTokens ?? null, u.completionTokens ?? null, u.costUsd ?? null, u.latencyMs ?? null);
  }

  /** Cost and call count since `since` (epoch ms). */
  usageSince(since: number): { costUsd: number; calls: number; tokens: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) cost, COUNT(*) calls, COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) tokens FROM usage WHERE at >= ?')
      .get(since) as { cost: number; calls: number; tokens: number };
    return { costUsd: r.cost, calls: r.calls, tokens: r.tokens };
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

/** Local midnight for `now` in the given IANA timezone, as epoch ms. */
export function startOfDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now))
    .reduce<Record<string, number>>((a, p) => (p.type === 'literal' ? a : { ...a, [p.type]: Number(p.value) }), {});
  const sinceMidnight = ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) * 1000 + (now % 1000);
  return now - sinceMidnight;
}
