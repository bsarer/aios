import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@aios/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AuditLog } from '../src/audit.js';
import type { Delta, ModelRequest, ModelResult } from '../src/model.js';
import { createServer } from '../src/server.js';
import { Shell } from '../src/shell.js';
import { Store } from '../src/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), 'aios-')), 'a.jsonl'));
  const model = {
    async *stream(_req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      yield { type: 'text', text: 'pong' };
      const r: ModelResult = { content: 'pong', toolCalls: [], finishReason: 'stop', usage: null, model: 'm', provider: null, generationId: null, latencyMs: 1, ttftMs: 1, attempts: 1 };
      yield { type: 'done', result: r };
      return r;
    },
  };
  const shell = new Shell({
    store: new Store(':memory:'),
    model,
    tools: new ToolRegistry(audit),
    audit,
    userName: 'John',
    timeZone: 'UTC',
    modelName: 'm',
    costCapUsd: 2,
    readBattery: async () => null,
    readWifi: async () => null,
  });
  // Port is needed up front for the Host/Origin allowlist, so pick one and listen on it.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  app = await createServer(shell, { port });
  await app.listen({ host: '127.0.0.1', port });
  return { port };
}

function connect(port: number, origin: string, host = `127.0.0.1:${port}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { host } });
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  return { ws, events, closed, opened };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('server', () => {
  it('sends hello, then streams a reply over the WebSocket', async () => {
    const { port } = await start();
    const c = connect(port, `http://127.0.0.1:${port}`);
    await c.opened;
    await until(() => c.events.some((e) => e.type === 'hello'));
    c.ws.send(JSON.stringify({ type: 'send', text: 'ping' }));
    await until(() => c.events.some((e) => e.type === 'patch' && e.item.kind === 'assistant' && !e.item.streaming));
    expect(c.events.map((e) => e.type)).toEqual(expect.arrayContaining(['hello', 'item', 'delta', 'patch', 'status']));
    c.ws.close();
  });

  it('closes WebSockets from foreign origins', async () => {
    const { port } = await start();
    const c = connect(port, 'https://evil.example');
    expect(await c.closed).toBe(1008);
    expect(c.events).toHaveLength(0);
  });

  it('rejects HTTP requests with a foreign Host header (DNS rebinding)', async () => {
    const { port } = await start();
    const ok = await app!.inject({ method: 'GET', url: '/healthz', headers: { host: `127.0.0.1:${port}` } });
    expect(ok.statusCode).toBe(200);
    const bad = await app!.inject({ method: 'GET', url: '/healthz', headers: { host: `evil.example:${port}` } });
    expect(bad.statusCode).toBe(403);
  });

  it('ignores malformed client messages', async () => {
    const { port } = await start();
    const c = connect(port, `http://localhost:${port}`, `localhost:${port}`);
    await c.opened;
    await until(() => c.events.length > 0);
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' }));
    c.ws.send(JSON.stringify({ type: 'send', text: '/help' }));
    await until(() => c.events.some((e) => e.type === 'item' && e.item.kind === 'notice'));
    expect(c.events.filter((e) => e.type === 'item')).toHaveLength(1);
    c.ws.close();
  });
});
