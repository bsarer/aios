/**
 * Nightly consolidation (plan §6): once a day, after `nightlyAt` local time, summarise
 * yesterday's chat into summaries/YYYY-MM-DD.md. Input is user messages and assistant
 * replies only, never tool results, so email bodies are not copied in. (Triage
 * metadata joins the input in A4.)
 */
import type { ModelRole } from '@aios/shared';
import type { ModelClient } from '../model.js';
import { NIGHTLY_SYSTEM_PROMPT } from '../prompts.js';
import { type Store, startOfDay } from '../store.js';
import type { Memory } from './memory.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 60_000;

/** YYYY-MM-DD for `at` in `timeZone`. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

function localMinutes(at: number, timeZone: string): number {
  const [h = 0, m = 0] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(at))
    .split(':')
    .map(Number);
  return h * 60 + m;
}

export interface NightlyOptions {
  memory: Memory;
  store: Store;
  model: Pick<ModelClient, 'complete'>;
  userName: string;
  timeZone: string;
  /** "HH:MM" local. */
  runAfter: string;
  /** L1: 'local' when the nightly summary runs on the local model. Default 'nightly'. */
  role?: ModelRole;
  onError?: (err: unknown) => void;
}

export type NightlyOutcome = 'not_due' | 'done_already' | 'nothing_to_summarise' | 'written' | 'failed';

export class Nightly {
  private running = false;

  constructor(private readonly o: NightlyOptions) {}

  /** Summarise yesterday if it is due. Safe to call often; the timer calls it every few minutes. */
  async runIfDue(now: number): Promise<NightlyOutcome> {
    const { memory, store, timeZone } = this.o;
    const [h = 0, m = 0] = this.o.runAfter.split(':').map(Number);
    if (localMinutes(now, timeZone) < h * 60 + m) return 'not_due';
    const todayStart = startOfDay(now, timeZone);
    // Midnight of the previous local day; +2h then startOfDay keeps DST days right.
    const yesterdayStart = startOfDay(todayStart - DAY + 2 * 60 * 60 * 1000, timeZone);
    const date = localDate(yesterdayStart, timeZone);
    if (store.getSetting('nightly.last') === date || memory.files.summary(date) !== null) return 'done_already';
    if (this.running) return 'done_already';
    // After a failure, wait an hour before paying for another attempt.
    if (now - Number(store.getSetting('nightly.failedAt') ?? 0) < 60 * 60 * 1000) return 'not_due';

    const turns = store.chatTurnsBetween(yesterdayStart, todayStart);
    if (!turns.length) {
      store.setSetting('nightly.last', date);
      return 'nothing_to_summarise';
    }
    this.running = true;
    try {
      let transcript = turns
        .map((t) => `${t.role === 'user' ? this.o.userName : 'Assistant'}: ${t.content.replace(/<\/?transcript>/gi, '')}`)
        .join('\n\n');
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
      const r = await this.o.model.complete({
        role: this.o.role ?? 'nightly',
        messages: [
          { role: 'system', content: NIGHTLY_SYSTEM_PROMPT },
          { role: 'user', content: `Date: ${date}\nUser: ${this.o.userName}\n\n<transcript>\n${transcript}\n</transcript>` },
        ],
      });
      memory.files.writeSummary(date, `# ${date}\n\n${r.content.trim()}\n`);
      memory.reindex();
      store.setSetting('nightly.last', date);
      return 'written';
    } catch (err) {
      store.setSetting('nightly.failedAt', String(now));
      this.o.onError?.(err);
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}
