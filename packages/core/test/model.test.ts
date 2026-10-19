import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ModelRoleConfig, ModelRoleConfig as RoleSchema } from '@aios/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type CallRecord, ModelClient, ModelError, type ModelRequest } from '../src/model.js';
import { Secret } from '../src/secrets/keyring.js';

// ── Mock OpenAI-compatible server ────────────────────────────────────────────

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
let server: Server;
let baseUrl: string;
let handlers: Handler[] = [];
let seen: { body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Record<string, unknown>;
    seen.push({ body, headers: req.headers });
    const h = handlers.shift();
    if (!h) {
      res.writeHead(500).end('no handler');
      return;
    }
    await h(body, req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  handlers = [];
  seen = [];
});

const json = (status: number, payload: unknown, headers: Record<string, string> = {}): Handler => (_b, _q, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(payload));
};

const sse = (chunks: (string | object)[], delayMs = 0): Handler => async (_b, _q, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) {
    res.write(typeof c === 'string' ? `${c}\n\n` : `data: ${JSON.stringify(c)}\n\n`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  res.end();
};

const reply = (content: string, extra: object = {}) => ({
  id: 'gen-1',
  model: 'vendor/model-x',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00012 },
  ...extra,
});

// ── Client under test ────────────────────────────────────────────────────────

const API_KEY = 'sk-test-SECRET-value';

function client(over: Partial<ModelRoleConfig> = {}, maxAttempts = 3) {
  const cfg = RoleSchema.parse({
    baseUrl,
    model: 'vendor/model-x',
    apiKeyRef: 'keyring:model-chat',
    timeoutMs: 2000,
    extraBody: { provider: { data_collection: 'deny' }, model: 'should-be-overridden' },
    extraHeaders: { 'X-Title': 'AI OS' },
    ...over,
  });
  const calls: CallRecord[] = [];
  const sleeps: number[] = [];
  const c = new ModelClient({
    models: { chat: cfg, triage: cfg, nightly: cfg },
    resolveKey: async () => new Secret(API_KEY),
    sleep: async (ms) => void sleeps.push(ms),
    onCall: (r) => calls.push(r),
    maxAttempts,
  });
  return { c, calls, sleeps };
}

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  role: 'chat',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ModelClient.complete', () => {
  it('sends an OpenAI-compatible request and captures usage and cost', async () => {
    handlers.push(json(200, reply('hello')));
    const { c, calls } = client();
    const r = await c.complete(req());
    expect(r.content).toBe('hello');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.00012 });
    expect(r.model).toBe('vendor/model-x');

    const { body, headers } = seen[0]!;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['x-title']).toBe('AI OS');
    expect(body.model).toBe('vendor/model-x'); // core fields beat extraBody
    expect(body.provider).toEqual({ data_collection: 'deny' });
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('temperature'); // unset in config, so not sent
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
  });

  it('sends temperature only when configured', async () => {
    handlers.push(json(200, reply('ok')));
    await client({ temperature: 0.2 }).c.complete(req());
    expect(seen[0]!.body.temperature).toBe(0.2);
  });

  it('sends tools and parses tool calls', async () => {
    handlers.push(
      json(200, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mail_search', arguments: '{"query":"sara"}' } }] },
          },
        ],
      }),
    );
    const { c } = client();
    const r = await c.complete(req({ tools: [{ name: 'mail_search', description: 'd', parameters: { type: 'object' } }], toolChoice: 'auto' }));
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'mail_search', arguments: '{"query":"sara"}' }]);
    expect(seen[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'mail_search', description: 'd', parameters: { type: 'object' } } }]);
    expect(seen[0]!.body.tool_choice).toBe('auto');
  });

  it('serialises tool results back in wire format', async () => {
    handlers.push(json(200, reply('done')));
    await client().c.complete(
      req({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'now', arguments: '{}' }] },
          { role: 'tool', toolCallId: 'c1', name: 'now', content: '2026-10-19' },
        ],
      }),
    );
    const msgs = seen[0]!.body.messages as Record<string, unknown>[];
    expect(msgs[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }] });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'c1', name: 'now', content: '2026-10-19' });
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    handlers.push(json(429, { error: { code: 429, message: 'slow down' } }, { 'Retry-After': '2' }), json(200, reply('ok')));
    const { c, sleeps } = client();
    const r = await c.complete(req());
    expect(r.attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries 502 with backoff and gives up after maxAttempts', async () => {
    for (let i = 0; i < 3; i++) handlers.push(json(502, { error: { code: 502, message: 'down' } }));
    const { c, sleeps, calls } = client();
    const err = await c.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('unavailable');
    expect(sleeps).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({ ok: false, errorKind: 'unavailable' });
  });

  it("records the provider's reason for a rejected request", async () => {
    handlers.push(json(404, { error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } }));
    const { c, calls } = client();
    const err = await c.complete(req()).catch((e: unknown) => e);
    expect((err as ModelError).kind).toBe('bad_request');
    expect(calls.at(-1)).toMatchObject({ ok: false, errorKind: 'bad_request', errorStatus: 404, errorDetail: 'No endpoints found that can handle the requested parameters.' });
  });

  it.each([
    [401, 'auth'],
    [402, 'credits'],
    [403, 'forbidden'],
    [400, 'bad_request'],
  ] as const)('does not retry %i (%s) and maps it to a friendly message', async (status, kind) => {
    handlers.push(json(status, { error: { code: status, message: 'nope' } }));
    const { c, sleeps } = client();
    const err = (await c.complete(req()).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe(kind);
    expect(err.userMessage.length).toBeGreaterThan(5);
    expect(sleeps).toHaveLength(0);
  });

  it('maps context_length_exceeded from error metadata', async () => {
    handlers.push(json(400, { error: { code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } } }));
    const err = (await client().c.complete(req()).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('context_length');
  });

  it('treats a 200 carrying only an error as a failure', async () => {
    handlers.push(json(200, { error: { code: 503, message: 'no provider' } }), json(200, reply('ok')));
    const r = await client().c.complete(req());
    expect(r.attempts).toBe(2);
  });

  it('times out slow responses', async () => {
    handlers.push(async (_b, _q, res) => {
      await new Promise((r) => setTimeout(r, 400));
      json(200, reply('late'))(_b, _q, res);
    });
    const err = (await client({ timeoutMs: 100 }, 1).c.complete(req()).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('timeout');
  });

  it('reports caller cancellation as aborted without retrying', async () => {
    handlers.push(async (_b, _q, res) => {
      await new Promise((r) => setTimeout(r, 300));
      json(200, reply('late'))(_b, _q, res);
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const { c, sleeps } = client();
    const err = (await c.complete(req({ signal: ac.signal })).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('aborted');
    expect(sleeps).toHaveLength(0);
  });
});

describe('ModelClient.stream', () => {
  it('streams text, skips keepalive comments, accumulates tool calls and reads final usage', async () => {
    handlers.push(
      sse([
        ': OPENROUTER PROCESSING',
        { id: 'gen-2', model: 'vendor/model-x', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'mail_read', arguments: '{"id":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"42"}' } }] } }] },
        { choices: [{ delta: { content: '' }, finish_reason: 'tool_calls' }] },
        { choices: [{ delta: { content: '' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.001 } },
        'data: [DONE]',
      ]),
    );
    const { c } = client();
    const out = (await drain(c.stream(req()))) as { type: string; text?: string; result?: unknown }[];
    expect(out.filter((d) => d.type === 'text').map((d) => d.text).join('')).toBe('Hello');
    const done = out.at(-1) as { type: 'done'; result: import('../src/model.js').ModelResult };
    expect(done.type).toBe('done');
    expect(done.result.toolCalls).toEqual([{ id: 'c9', name: 'mail_read', arguments: '{"id":"42"}' }]);
    expect(done.result.finishReason).toBe('tool_calls');
    expect(done.result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7, costUsd: 0.001 });
    expect(done.result.ttftMs).not.toBeNull();
    expect(seen[0]!.body.stream).toBe(true);
  });

  it('retries a failure that happens before any output', async () => {
    handlers.push(json(503, { error: { code: 503, message: 'busy' } }), sse([{ choices: [{ delta: { content: 'ok' } }] }, 'data: [DONE]']));
    const out = await drain(client().c.stream(req()));
    expect(out.at(-1)).toMatchObject({ type: 'done', result: { content: 'ok', attempts: 2 } });
  });

  it('surfaces a mid-stream error and does not retry once output was shown', async () => {
    handlers.push(
      sse([
        { choices: [{ delta: { content: 'partial' } }] },
        { error: { code: 502, message: 'Provider disconnected' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] },
      ]),
    );
    const { c, sleeps } = client();
    const seenDeltas: unknown[] = [];
    const err = await (async () => {
      try {
        for await (const d of c.stream(req())) seenDeltas.push(d);
      } catch (e) {
        return e as ModelError;
      }
      return null;
    })();
    expect(seenDeltas).toEqual([{ type: 'text', text: 'partial' }]);
    expect(err?.kind).toBe('unavailable');
    expect(sleeps).toHaveLength(0);
  });

  it('handles events split across network chunks', async () => {
    handlers.push(async (_b, _q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: 'split' } }] })}\n\ndata: [DONE]\n\n`;
      for (const part of [payload.slice(0, 7), payload.slice(7, 30), payload.slice(30)]) {
        res.write(part);
        await new Promise((r) => setTimeout(r, 10));
      }
      res.end();
    });
    const out = await drain(client().c.stream(req()));
    expect(out.at(-1)).toMatchObject({ result: { content: 'split' } });
  });
});

describe('ModelClient.structured', () => {
  const Schema = z.strictObject({ urgency: z.enum(['low', 'high']), summary: z.string() });

  it('requests strict json_schema and validates the result', async () => {
    handlers.push(json(200, reply('{"urgency":"high","summary":"contract deadline"}')));
    const { value, repaired } = await client().c.structured(req(), 'triage', Schema);
    expect(value).toEqual({ urgency: 'high', summary: 'contract deadline' });
    expect(repaired).toBe(false);
    const rf = seen[0]!.body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: object } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema).toMatchObject({ name: 'triage', strict: true });
    expect(rf.json_schema.schema).toMatchObject({ type: 'object', required: ['urgency', 'summary'] });
  });

  it('repairs once with the validation error', async () => {
    handlers.push(json(200, reply('{"urgency":"urgent"}')), json(200, reply('```json\n{"urgency":"low","summary":"fine"}\n```')));
    const { value, repaired } = await client().c.structured(req(), 'triage', Schema);
    expect(value).toEqual({ urgency: 'low', summary: 'fine' });
    expect(repaired).toBe(true);
    const repairMsg = (seen[1]!.body.messages as { content: string }[]).at(-1)!.content;
    expect(repairMsg).toMatch(/invalid/);
  });

  it('fails after a second invalid answer', async () => {
    handlers.push(json(200, reply('nope')), json(200, reply('still nope')));
    const err = (await client().c.structured(req(), 'triage', Schema).catch((e: unknown) => e)) as ModelError;
    expect(err.kind).toBe('malformed_output');
  });

  it('falls back to json_object mode with the schema in a system message', async () => {
    handlers.push(json(200, reply('{"urgency":"low","summary":"x"}')));
    await client({ structuredOutput: 'json_object' }).c.structured(req(), 'triage', Schema);
    expect(seen[0]!.body.response_format).toEqual({ type: 'json_object' });
    const first = (seen[0]!.body.messages as { role: string; content: string }[])[0]!;
    expect(first.role).toBe('system');
    expect(first.content).toContain('"urgency"');
  });
});
