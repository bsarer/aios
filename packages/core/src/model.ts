/**
 * The only path to a model (CLAUDE.md). Plain fetch against an OpenAI-compatible
 * /chat/completions endpoint: no vendor SDK. Endpoints, model names and
 * provider-specific fields come from config.
 *
 * Handles streaming (SSE), tool calls, structured output with zod validation and
 * one repair retry, per-attempt timeouts, retries with backoff before any output
 * has reached the caller, provider error mapping and usage capture.
 */
import type { ModelRole, ModelRoleConfig, SecretRef } from '@aios/shared';
import { z } from 'zod';
import type { Secret } from './secrets/keyring.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as produced by the model; validate before use. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ModelRequest {
  role: ModelRole;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  /** Ask for JSON matching this schema. Use structured() to also validate it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Reported by the provider (OpenRouter: `usage.cost`), else null. */
  costUsd: number | null;
}

export interface ModelResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  /** Model the provider reports having used. */
  model: string | null;
  /** Upstream provider, when the response says. */
  provider: string | null;
  generationId: string | null;
  latencyMs: number;
  /** Time to first content or tool-call delta (streaming only). */
  ttftMs: number | null;
  attempts: number;
}

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'done'; result: ModelResult };

/** One record per finished or failed call, for the audit log and cost meter. */
export interface CallRecord {
  role: ModelRole;
  baseUrl: string;
  model: string;
  ok: boolean;
  errorKind?: ModelErrorKind;
  /** HTTP status and the provider's own error message (never request content), so failures can be diagnosed from the audit log. */
  errorStatus?: number;
  errorDetail?: string;
  result?: ModelResult;
}

export type ModelErrorKind =
  | 'auth'
  | 'credits'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'context_length'
  | 'bad_request'
  | 'network'
  | 'malformed_output'
  | 'aborted';

const USER_MESSAGES: Record<ModelErrorKind, string> = {
  auth: 'The model provider rejected the API key. Run setup to update it.',
  credits: 'The model account is out of credits.',
  forbidden: 'The model provider refused this request (permissions, budget limit or moderation).',
  rate_limited: 'The model provider is rate limiting us. I will retry shortly.',
  timeout: 'The model took too long to answer.',
  unavailable: 'The model is unavailable right now. I will retry shortly.',
  context_length: 'That conversation is too long for the model. Try a narrower request.',
  bad_request: 'The model provider rejected the request. This is a bug; it has been logged.',
  network: 'I cannot reach the model provider. Check the network connection.',
  malformed_output: 'The model returned something I could not understand.',
  aborted: 'Stopped.',
};

export class ModelError extends Error {
  override readonly name = 'ModelError';
  readonly userMessage: string;
  constructor(
    readonly kind: ModelErrorKind,
    readonly detail: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${kind}${status ? ` (${status})` : ''}: ${detail}`);
    this.userMessage = USER_MESSAGES[kind];
  }
  get retryable(): boolean {
    return ['rate_limited', 'timeout', 'unavailable', 'network'].includes(this.kind);
  }
}

export interface ModelClientOptions {
  models: Record<ModelRole, ModelRoleConfig>;
  resolveKey: (ref: SecretRef) => Promise<Secret>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onCall?: (record: CallRecord) => void;
  /** Total attempts per call, including the first. Default 3. */
  maxAttempts?: number;
}

// ── Wire schemas (provider responses are external input) ─────────────────────

const WireToolCall = z.looseObject({
  id: z.string().optional(),
  index: z.number().optional(),
  function: z.looseObject({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});

const WireUsage = z.looseObject({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  cost: z.number().optional(),
});

const WireError = z.looseObject({
  code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  metadata: z.looseObject({ error_type: z.string().optional() }).optional(),
});

const WireResponse = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  error: WireError.optional(),
  usage: WireUsage.nullish(),
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullish(),
        message: z
          .looseObject({ content: z.string().nullish(), tool_calls: z.array(WireToolCall).nullish() })
          .optional(),
        delta: z
          .looseObject({ content: z.string().nullish(), tool_calls: z.array(WireToolCall).nullish() })
          .optional(),
      }),
    )
    .optional(),
});
type WireResponse = z.infer<typeof WireResponse>;

// ── Client ───────────────────────────────────────────────────────────────────

export class ModelClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: ModelClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => performance.now());
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Non-streaming call. */
  async complete(req: ModelRequest): Promise<ModelResult> {
    const cfg = this.opts.models[req.role];
    const started = this.now();
    try {
      const { json, attempts } = await this.withRetries(req, async (signal) => {
        const res = await this.send(req, false, signal);
        const text = await res.text();
        return parseBody(text);
      });
      const result = toResult(json, this.now() - started, null, attempts);
      this.record(req.role, cfg, { ok: true, result });
      return result;
    } catch (err) {
      throw this.fail(req.role, cfg, err);
    }
  }

  /** Streaming call. Retries only happen before the first delta is yielded. */
  async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
    const cfg = this.opts.models[req.role];
    const started = this.now();
    let attempts = 0;
    let yielded = false;
    for (;;) {
      attempts++;
      const signal = this.attemptSignal(cfg, req.signal);
      const acc = new StreamAccumulator();
      let ttft: number | null = null;
      try {
        const res = await this.send(req, true, signal);
        if (!res.body) throw new ModelError('malformed_output', 'empty stream body');
        for await (const chunk of sseEvents(res.body)) {
          for (const d of acc.push(chunk)) {
            ttft ??= this.now() - started;
            yielded = true;
            yield d;
          }
        }
        const result = acc.result(this.now() - started, ttft, attempts);
        this.record(req.role, cfg, { ok: true, result });
        yield { type: 'done', result };
        return result;
      } catch (err) {
        const e = toModelError(err, req.signal);
        if (!yielded && e.retryable && attempts < this.maxAttempts) {
          await this.sleep(backoff(attempts, e.retryAfterMs));
          continue;
        }
        throw this.fail(req.role, cfg, e);
      }
    }
  }

  /**
   * Structured output: asks for JSON matching `schema`, validates with zod and, on
   * failure, retries once with the validation error so the model can repair it.
   */
  async structured<T extends z.ZodType>(
    req: Omit<ModelRequest, 'jsonSchema'>,
    name: string,
    schema: T,
  ): Promise<{ value: z.infer<T>; result: ModelResult; repaired: boolean }> {
    const jsonSchema = { name, schema: z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown> };
    const first = await this.complete({ ...req, jsonSchema });
    const parsed = parseStructured(first.content, schema);
    if (parsed.ok) return { value: parsed.value, result: first, repaired: false };

    const repairMessages: ChatMessage[] = [
      ...req.messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: `That output was invalid: ${parsed.error}\nReply again with only JSON that matches the schema "${name}".`,
      },
    ];
    const second = await this.complete({ ...req, messages: repairMessages, jsonSchema });
    const reparsed = parseStructured(second.content, schema);
    if (reparsed.ok) return { value: reparsed.value, result: second, repaired: true };
    throw new ModelError('malformed_output', `structured output failed validation twice: ${reparsed.error}`);
  }

  // ── internals ──

  private async withRetries<T>(req: ModelRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<{ json: T; attempts: number }> {
    const cfg = this.opts.models[req.role];
    for (let attempt = 1; ; attempt++) {
      try {
        return { json: await fn(this.attemptSignal(cfg, req.signal)), attempts: attempt };
      } catch (err) {
        const e = toModelError(err, req.signal);
        if (!e.retryable || attempt >= this.maxAttempts) throw e;
        await this.sleep(backoff(attempt, e.retryAfterMs));
      }
    }
  }

  private attemptSignal(cfg: ModelRoleConfig, outer?: AbortSignal): AbortSignal {
    const t = AbortSignal.timeout(cfg.timeoutMs);
    return outer ? AbortSignal.any([outer, t]) : t;
  }

  private async send(req: ModelRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    const cfg = this.opts.models[req.role];
    const key = await this.opts.resolveKey(cfg.apiKeyRef);
    const body = buildBody(cfg, req, stream);
    let res: Response;
    try {
      res = await this.fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          ...cfg.extraHeaders,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.reveal()}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw toModelError(err, req.signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(res.status, text, res.headers.get('retry-after'));
    }
    return res;
  }

  private record(role: ModelRole, cfg: ModelRoleConfig, r: Omit<CallRecord, 'role' | 'baseUrl' | 'model'>): void {
    this.opts.onCall?.({ role, baseUrl: cfg.baseUrl, model: cfg.model, ...r });
  }

  private fail(role: ModelRole, cfg: ModelRoleConfig, err: unknown): ModelError {
    const e = err instanceof ModelError ? err : toModelError(err);
    this.record(role, cfg, { ok: false, errorKind: e.kind, errorDetail: e.detail, ...(e.status !== null ? { errorStatus: e.status } : {}) });
    return e;
  }
}

// ── Request building ─────────────────────────────────────────────────────────

export function buildBody(cfg: ModelRoleConfig, req: ModelRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...cfg.extraBody,
    model: cfg.model,
    messages: req.messages.map(toWireMessage),
    max_tokens: cfg.maxTokens,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    stream,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (req.toolChoice) {
      body.tool_choice =
        typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } };
    }
  }
  if (req.jsonSchema) {
    body.response_format =
      cfg.structuredOutput === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } }
        : { type: 'json_object' };
    if (cfg.structuredOutput === 'json_object') {
      // Without schema enforcement, put the schema in front of the model instead.
      const msgs = body.messages as Record<string, unknown>[];
      msgs.unshift({ role: 'system', content: `Reply with only a JSON object matching this JSON Schema:\n${JSON.stringify(req.jsonSchema.schema)}` });
    }
  }
  return body;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseBody(text: string): WireResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ModelError('malformed_output', 'response was not JSON');
  }
  const parsed = WireResponse.safeParse(raw);
  if (!parsed.success) throw new ModelError('malformed_output', 'unexpected response shape');
  // A 200 can still carry an error and no choices.
  if (parsed.data.error && !parsed.data.choices?.length) throw bodyError(parsed.data.error);
  return parsed.data;
}

function toUsage(u: z.infer<typeof WireUsage> | null | undefined): Usage | null {
  if (!u) return null;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u.total_tokens ?? promptTokens + completionTokens, costUsd: u.cost ?? null };
}

function toResult(w: WireResponse, latencyMs: number, ttftMs: number | null, attempts: number): ModelResult {
  const choice = w.choices?.[0];
  const msg = choice?.message;
  return {
    content: msg?.content ?? '',
    toolCalls: (msg?.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? '',
      arguments: c.function?.arguments ?? '',
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: toUsage(w.usage),
    model: w.model ?? null,
    provider: w.provider ?? null,
    generationId: w.id ?? null,
    latencyMs,
    ttftMs,
    attempts,
  };
}

class StreamAccumulator {
  private content = '';
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private finishReason: string | null = null;
  private usage: Usage | null = null;
  private model: string | null = null;
  private provider: string | null = null;
  private id: string | null = null;

  push(data: string): Delta[] {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw new ModelError('malformed_output', 'stream chunk was not JSON');
    }
    const parsed = WireResponse.safeParse(raw);
    if (!parsed.success) throw new ModelError('malformed_output', 'unexpected stream chunk shape');
    const c = parsed.data;
    // Mid-stream errors arrive as a chunk with `error` and finish_reason "error".
    if (c.error) throw bodyError(c.error);
    this.model ??= c.model ?? null;
    this.provider ??= c.provider ?? null;
    this.id ??= c.id ?? null;
    if (c.usage) this.usage = toUsage(c.usage);

    const out: Delta[] = [];
    const choice = c.choices?.[0];
    if (!choice) return out;
    if (choice.finish_reason) {
      if (choice.finish_reason === 'error') throw new ModelError('unavailable', 'stream ended with an error');
      this.finishReason = choice.finish_reason;
    }
    const d = choice.delta;
    if (d?.content) {
      this.content += d.content;
      out.push({ type: 'text', text: d.content });
    }
    for (const [pos, tc] of (d?.tool_calls ?? []).entries()) {
      const index = tc.index ?? pos;
      const cur = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      const argumentsDelta = tc.function?.arguments ?? '';
      cur.arguments += argumentsDelta;
      this.calls.set(index, cur);
      out.push({
        type: 'tool_call',
        index,
        ...(tc.id ? { id: tc.id } : {}),
        ...(tc.function?.name ? { name: tc.function.name } : {}),
        argumentsDelta,
      });
    }
    return out;
  }

  result(latencyMs: number, ttftMs: number | null, attempts: number): ModelResult {
    return {
      content: this.content,
      toolCalls: [...this.calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments })),
      finishReason: this.finishReason,
      usage: this.usage,
      model: this.model,
      provider: this.provider,
      generationId: this.id,
      latencyMs,
      ttftMs,
      attempts,
    };
  }
}

/** Yields the `data:` payloads of an SSE stream, skipping comments, until [DONE]. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) {
            const payload = data.join('\n');
            data = [];
            if (payload === '[DONE]') return;
            yield payload;
          }
        } else if (line.startsWith(':')) {
          // Keepalive comment, e.g. ": OPENROUTER PROCESSING".
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        const payload = data.join('\n');
        if (payload && payload !== '[DONE]') yield payload;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseStructured<T extends z.ZodType>(content: string, schema: T): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  // Tolerate a fenced code block around the JSON.
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}

// ── Errors and retries ───────────────────────────────────────────────────────

function kindForStatus(status: number, errorType?: string): ModelErrorKind {
  if (errorType === 'context_length_exceeded') return 'context_length';
  switch (status) {
    case 401:
      return 'auth';
    case 402:
      return 'credits';
    case 403:
      return 'forbidden';
    case 408:
    case 524:
      return 'timeout';
    case 429:
      return 'rate_limited';
    case 413:
      return 'context_length';
    default:
      return status >= 500 ? 'unavailable' : 'bad_request';
  }
}

function httpError(status: number, text: string, retryAfter: string | null): ModelError {
  let detail = `HTTP ${status}`;
  let errorType: string | undefined;
  try {
    const e = WireError.safeParse((JSON.parse(text) as { error?: unknown }).error);
    if (e.success) {
      detail = e.data.message ?? detail;
      errorType = e.data.metadata?.error_type;
    }
  } catch {
    // Non-JSON error body; keep the status only.
  }
  const secs = retryAfter ? Number(retryAfter) : NaN;
  return new ModelError(kindForStatus(status, errorType), detail.slice(0, 300), status, Number.isFinite(secs) ? secs * 1000 : null);
}

function bodyError(e: z.infer<typeof WireError>): ModelError {
  const status = typeof e.code === 'number' ? e.code : 502;
  return new ModelError(kindForStatus(status, e.metadata?.error_type), (e.message ?? 'provider error').slice(0, 300), status);
}

function toModelError(err: unknown, outer?: AbortSignal): ModelError {
  if (err instanceof ModelError) return err;
  if (outer?.aborted) return new ModelError('aborted', 'cancelled by caller');
  const name = (err as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ModelError('timeout', 'request timed out');
  return new ModelError('network', (err as Error | undefined)?.message ?? 'network error');
}

/** Exponential backoff with jitter, honouring Retry-After up to 30s. */
export function backoff(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 30_000);
  const base = 500 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base * 0.25);
}
