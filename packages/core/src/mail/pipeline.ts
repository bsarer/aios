/**
 * From queued mail to a chat notification (plan §5): wait out a short batch window,
 * triage the batch in one model call, then post one notification. Respects pause,
 * quiet hours and a per-hour limit by holding triaged mail and posting it later as
 * one catch-up. A failed triage keeps the mail queued and retries.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem, MailRow, ModelRole } from '@aios/shared';
import { ModelError } from '../model.js';
import { type TriageModel, fallbackItem, triage } from './triage.js';
import type { MailEvent, MailState } from './state.js';

const HOUR = 60 * 60 * 1000;
const BATCH_MAX = 20;
const RETRY_MS = 60_000;
/** After this many failed triage attempts, post the mail with a plain fallback summary. */
const MAX_ATTEMPTS = 5;
/** Mail older than this when finally posted is presented as a catch-up. */
const CATCH_UP_AFTER_MS = 10 * 60 * 1000;

export interface PipelineOptions {
  state: MailState;
  model: TriageModel;
  post: (item: ChatItem) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  isPaused: () => boolean;
  timeZone: string;
  batchWindowMs: number;
  maxPerHour: number;
  quietHours?: { start: string; end: string } | undefined;
  /** L1: 'local' when mail triage runs on the local model. Default 'triage'. */
  role?: ModelRole;
  now?: () => number;
  newId?: () => string;
}

const minutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** True when `at` falls in the quiet window, which may wrap past midnight (e.g. 22:00–07:00). */
export function inQuietHours(at: number, timeZone: string, q?: { start: string; end: string }): boolean {
  if (!q) return false;
  const [h = 0, m = 0] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(at))
    .split(':')
    .map(Number);
  const now = h * 60 + m;
  const start = minutes(q.start);
  const end = minutes(q.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** Chat text for a batch, written by code: counts only, nothing taken from the emails. */
export function headline(rows: MailRow[], catchUp: boolean): string {
  const n = rows.length;
  const urgent = rows.filter((r) => r.urgency === 'high').length;
  const quiet = rows.filter((r) => r.urgency === 'low').length;
  const parts = [`${catchUp ? 'While you were away: ' : ''}${n} new email${n === 1 ? '' : 's'}.`];
  if (urgent) parts.push(`${urgent} look${urgent === 1 ? 's' : ''} urgent.`);
  if (quiet && quiet < n) parts.push(`${quiet} low-priority.`);
  return parts.join(' ');
}

export class MailPipeline {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private failing = false;
  private capped = false;
  private retryAt = 0;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => randomUUID());
  }

  /** New mail was queued: process it once the batch window has passed. */
  onNew(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.o.batchWindowMs);
    this.timer.unref?.();
  }

  /** Periodic catch-up: retries, end of quiet hours, rate limit window, resume. */
  async run(): Promise<void> {
    if (this.busy || this.o.isPaused()) return;
    this.busy = true;
    try {
      await this.triagePending();
      this.release();
    } finally {
      this.busy = false;
    }
  }

  private async triagePending(): Promise<void> {
    if (this.now() < this.retryAt) return;
    for (let batch = this.o.state.withStatus('pending', BATCH_MAX); batch.length; batch = this.o.state.withStatus('pending', BATCH_MAX)) {
      const stale = batch.filter((e) => e.attempts >= MAX_ATTEMPTS);
      stale.forEach((e) => this.o.state.saveTriage(e.messageId, fallbackItem(e)));
      batch = batch.filter((e) => e.attempts < MAX_ATTEMPTS);
      if (!batch.length) continue;
      try {
        const items = await triage(this.o.model, batch, this.o.role);
        batch.forEach((e, i) => this.o.state.saveTriage(e.messageId, items[i]!));
        if (this.failing || this.capped) this.o.notice('info', 'Mail summaries are working again.');
        this.failing = false;
        this.capped = false;
      } catch (err) {
        if (err instanceof ModelError && err.kind === 'cost_cap') {
          // Mail still arrives under the cap, listed by sender and subject without a summary.
          batch.forEach((e) => this.o.state.saveTriage(e.messageId, fallbackItem(e)));
          if (!this.capped) this.o.notice('warning', "Today's model cost cap is reached, so new mail is listed without summaries until tomorrow.");
          this.capped = true;
          continue;
        }
        this.o.state.failedAttempt(batch.map((e) => e.messageId));
        this.retryAt = this.now() + RETRY_MS;
        const why = err instanceof ModelError ? ` ${err.userMessage}` : '';
        if (!this.failing) this.o.notice('warning', `New mail arrived but I couldn't summarise it.${why} I'll keep trying and post it when I can.`);
        this.failing = true;
        return;
      }
      if (this.o.isPaused()) return;
    }
  }

  private release(): void {
    const ready = this.o.state.withStatus('triaged', 200);
    if (!ready.length) return;
    const now = this.now();
    if (inQuietHours(now, this.o.timeZone, this.o.quietHours)) return;
    if (this.o.state.notificationsSince(now - HOUR) >= this.o.maxPerHour) return;
    const rows = ready.map(toRow);
    const oldest = Math.min(...ready.map((e) => e.date ?? e.receivedAt));
    const order = { high: 0, normal: 1, low: 2 } as const;
    rows.sort((a, b) => order[a.urgency] - order[b.urgency]);
    this.o.post({ kind: 'notification', id: this.newId(), text: headline(rows, now - oldest > CATCH_UP_AFTER_MS), at: now, mails: rows });
    this.o.state.markNotified(
      ready.map((e) => e.messageId),
      now,
    );
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

function toRow(e: MailEvent): MailRow {
  const t = e.triage!;
  return {
    id: e.mailId,
    from: e.from.slice(0, 200),
    subject: e.subject.slice(0, 300),
    summary: t.summary,
    urgency: t.urgency,
    needsReply: t.needs_reply,
  };
}
