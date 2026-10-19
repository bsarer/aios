import {
  type ChatMessage,
  type ModelClient,
  ModelError,
  type ModelResult,
  type ToolCall,
  TRIAGE_SYSTEM_PROMPT,
  chatSystemPrompt,
  toolByName,
  toolSpecs,
  wrapUntrusted,
} from '@aios/core';
import { TriageBatch } from '@aios/shared';
import { type ChatTask, type Score, TRIAGE_EXPECT, triageBatches, triageUserMessage } from './tasks.js';

export const EVAL_NOW = 'Monday, 19 October 2026, 09:14 (Europe/Istanbul, UTC+03:00)';
const MAX_ITERATIONS = 4;

export interface ChatTaskResult extends Score {
  id: string;
  group: ChatTask['group'];
  calls: string[];
  ttftMs: number | null;
  totalMs: number;
  costUsd: number;
  tokens: number;
  error?: string;
}

export interface TriageResult {
  batch: number;
  valid: boolean;
  repaired: boolean;
  /** Messages whose urgency fell in the acceptable set. */
  agree: number;
  /** Messages with an expectation (hostile samples are validity-only). */
  graded: number;
  messages: number;
  latencyMs: number;
  costUsd: number;
  tokens: number;
  note: string;
}

export interface ModelRun {
  model: string;
  chat: ChatTaskResult[];
  triage: TriageResult[];
}

type EvalClient = Pick<ModelClient, 'stream' | 'structured'>;

/** Canned answers for read-tier tools so multi-step models can finish. */
function stubToolResult(call: ToolCall): string {
  switch (call.name) {
    case 'now':
      return EVAL_NOW;
    case 'mail_search':
      return JSON.stringify([
        { id: 'm-1042', from: 'Sara Kaya <sara.kaya@northwind.example>', subject: 'Re: Q4 budget review', date: '2026-10-12' },
        { id: 'm-1043', from: 'Tom Becker <tom.becker@acme.example>', subject: 'Re: Contract renewal', date: '2026-10-18' },
      ]);
    default:
      return wrapUntrusted('email', 'm-1042', 'From: Sara Kaya <sara.kaya@northwind.example>\nSubject: Re: Q4 budget review\n\nCould you send me the September all-hands slides by Thursday?');
  }
}

export async function runChatTask(client: EvalClient, task: ChatTask, userName = 'John'): Promise<ChatTaskResult> {
  const messages: ChatMessage[] = [{ role: 'system', content: chatSystemPrompt({ userName, now: EVAL_NOW }) }, ...task.messages];
  const calls: ToolCall[] = [];
  let finalText = '';
  let ttftMs: number | null = null;
  let totalMs = 0;
  let costUsd = 0;
  let tokens = 0;
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let result: ModelResult | undefined;
      for await (const d of client.stream({ role: 'chat', messages, tools: toolSpecs(), toolChoice: 'auto' })) {
        if (d.type === 'done') result = d.result;
      }
      if (!result) throw new Error('stream ended without a result');
      if (i === 0) ttftMs = result.ttftMs;
      totalMs += result.latencyMs;
      costUsd += result.usage?.costUsd ?? 0;
      tokens += result.usage?.totalTokens ?? 0;
      finalText = result.content;
      calls.push(...result.toolCalls);
      // Stop once the model answers, or as soon as it reaches for anything beyond read tier.
      if (!result.toolCalls.length || result.toolCalls.some((c) => toolByName(c.name)?.tier !== 'read')) break;
      messages.push({ role: 'assistant', content: result.content || null, toolCalls: result.toolCalls });
      for (const c of result.toolCalls) messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: stubToolResult(c) });
    }
    const s = task.score(calls, finalText);
    return { id: task.id, group: task.group, ...s, calls: calls.map((c) => c.name), ttftMs, totalMs, costUsd, tokens };
  } catch (err) {
    const msg = err instanceof ModelError ? `${err.kind}: ${err.message}` : (err as Error).message;
    return { id: task.id, group: task.group, pass: false, note: 'error', error: msg, calls: calls.map((c) => c.name), ttftMs, totalMs, costUsd, tokens };
  }
}

export async function runTriage(client: EvalClient): Promise<TriageResult[]> {
  const out: TriageResult[] = [];
  for (const [i, batch] of triageBatches().entries()) {
    const graded = batch.filter((m) => TRIAGE_EXPECT[m.key]).length;
    const base = { batch: i, messages: batch.length, graded };
    try {
      // No tools, by construction: the triage worker only classifies.
      const { value, result, repaired } = await client.structured(
        {
          role: 'triage',
          messages: [
            { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
            { role: 'user', content: triageUserMessage(batch) },
          ],
        },
        'triage_batch',
        TriageBatch,
      );
      const byId = new Map(value.items.map((it) => [it.id, it]));
      const missing = batch.filter((m) => !byId.has(m.key)).map((m) => m.key);
      const agree = batch.filter((m) => {
        const want = TRIAGE_EXPECT[m.key];
        const got = byId.get(m.key);
        return want && got && want.includes(got.urgency);
      }).length;
      const misses = batch
        .filter((m) => TRIAGE_EXPECT[m.key] && byId.get(m.key) && !TRIAGE_EXPECT[m.key]!.includes(byId.get(m.key)!.urgency))
        .map((m) => `${m.key}=${byId.get(m.key)!.urgency}`);
      out.push({
        ...base,
        valid: missing.length === 0 && value.items.length === batch.length,
        repaired,
        agree,
        latencyMs: result.latencyMs,
        costUsd: result.usage?.costUsd ?? 0,
        tokens: result.usage?.totalTokens ?? 0,
        note: [missing.length ? `missing ${missing.join(', ')}` : '', misses.length ? `urgency off: ${misses.join(', ')}` : ''].filter(Boolean).join('; ') || 'ok',
      });
    } catch (err) {
      const msg = err instanceof ModelError ? `${err.kind}: ${err.message}` : (err as Error).message;
      out.push({ ...base, valid: false, repaired: false, agree: 0, latencyMs: 0, costUsd: 0, tokens: 0, note: msg });
    }
  }
  return out;
}
