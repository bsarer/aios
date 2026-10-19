/**
 * HTTP + WebSocket front of aios-core. Listens on 127.0.0.1 only, and rejects
 * requests whose Host or Origin is not this server, so web pages open in the
 * user's browser cannot drive the assistant (DNS rebinding / cross-site WebSocket).
 */
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ClientMessage } from '@aios/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Shell } from './shell.js';

export interface ServerOptions {
  port: number;
  /** Built UI (packages/ui/dist). Optional so tests and `vite dev` can run without it. */
  uiDir?: string;
  /** Extra allowed origins, e.g. the Vite dev server. */
  devOrigins?: string[];
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export async function createServer(shell: Shell, o: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hosts = allowedHosts(o.port);
  const origins = new Set([...[...hosts].map((h) => `http://${h}`), ...(o.devOrigins ?? [])]);

  app.addHook('onRequest', async (req, reply) => {
    if (!hosts.has(req.headers.host ?? '')) return reply.code(403).send('forbidden host');
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!origins.has(req.headers.origin ?? '')) {
      socket.close(1008, 'forbidden origin');
      return;
    }
    const unsubscribe = shell.subscribe((ev) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(ev));
    });
    socket.on('message', (raw: Buffer) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      const msg = ClientMessage.safeParse(data);
      if (!msg.success) return;
      void shell.handle(msg.data).catch(() => shell.agent.notice('error', 'Something went wrong. It has been logged.'));
    });
    socket.on('close', unsubscribe);
  });

  app.get('/healthz', async () => ({ ok: true }));

  if (o.uiDir && existsSync(o.uiDir)) {
    await app.register(fastifyStatic, { root: o.uiDir });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('UI not built. Run `pnpm --filter @aios/ui build`.'));
  }

  return app;
}
