import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { AppConfig } from './config.js';
import { Store } from './db.js';
import {
  CodexAppServerRuntime,
  MockRuntime,
  type AgentRuntime
} from './runtime.js';
import {
  SessionBusyError,
  SessionService
} from './session-service.js';
import type { SavedUpload, SessionMode } from './types.js';

function secretMatches(actualValue: string | undefined, expectedValue: string): boolean {
  if (!actualValue) return false;

  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

function bearerTokenMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return secretMatches(header.slice('Bearer '.length), expectedToken);
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '');
}

function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(normalizeOrigin(origin));
}

type GatewayEvent =
  | {
      type: 'run.completed';
      runId: string;
      sessionId: string;
    }
  | {
      type: 'run.failed';
      runId: string;
      sessionId: string;
      error: string;
    };

export async function buildServer(config: AppConfig) {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const store = new Store(
    path.join(config.dataDir, 'effective-workspace.sqlite')
  );
  const runtime: AgentRuntime =
    config.runtime === 'mock'
      ? new MockRuntime()
      : new CodexAppServerRuntime(
          config.codexBin,
          config.codexModel
        );
  const service = new SessionService(
    store,
    runtime,
    config.dataDir
  );

  const app = Fastify({
    logger: true,
    bodyLimit: 30 * 1024 * 1024
  });

  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024
    }
  });

  await app.register(cors, {
    origin(origin, callback) {
      callback(
        null,
        originAllowed(origin, config.allowedOrigins)
      );
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type'
    ]
  });

  await app.register(multipart, {
    limits: {
      files: 10,
      fileSize: 25 * 1024 * 1024,
      fields: 20
    }
  });

  const eventClients = new Set<WebSocket>();

  function broadcast(event: GatewayEvent): void {
    const payload = JSON.stringify(event);
    for (const client of eventClients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method === 'OPTIONS') return;
    if (request.url === '/api/health') return;
    if (request.url.startsWith('/api/events')) return;

    if (
      !bearerTokenMatches(
        request.headers.authorization,
        config.accessToken
      )
    ) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get(
    '/api/events',
    { websocket: true },
    (socket, request) => {
      let authenticated = false;

      const cleanup = (): void => {
        clearTimeout(authTimeout);
        clearInterval(heartbeat);
        eventClients.delete(socket);
      };

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          socket.close(1008, 'Authentication required');
        }
      }, 5_000);

      const heartbeat = setInterval(() => {
        if (authenticated && socket.readyState === 1) {
          socket.ping();
        }
      }, 30_000);

      socket.on('message', (raw) => {
        if (authenticated) return;

        try {
          const payload = JSON.parse(raw.toString()) as {
            type?: string;
            token?: string;
          };

          if (
            payload.type !== 'auth' ||
            !secretMatches(
              payload.token,
              config.accessToken
            ) ||
            !originAllowed(
              request.headers.origin,
              config.allowedOrigins
            )
          ) {
            socket.close(1008, 'Unauthorized');
            return;
          }

          authenticated = true;
          clearTimeout(authTimeout);
          eventClients.add(socket);
          socket.send(JSON.stringify({ type: 'ready' }));
        } catch {
          socket.close(1003, 'Invalid message');
        }
      });

      socket.on('close', cleanup);
      socket.on('error', cleanup);
    }
  );

  app.get('/api/health', async () => ({
    ok: true,
    runtime: config.runtime,
    events: 'websocket'
  }));

  app.get('/api/runtime/account', async () => {
    return runtime.account();
  });

  app.get('/api/sessions', async () => ({
    sessions: service.listSessions()
  }));

  app.post('/api/sessions', async (request, reply) => {
    const body = (request.body || {}) as {
      title?: string;
      mode?: SessionMode;
    };

    if (
      body.mode !== 'code' &&
      body.mode !== 'analysis'
    ) {
      return reply.code(400).send({
        error: 'mode must be code or analysis'
      });
    }

    const session = service.createSession({
      title: body.title,
      mode: body.mode
    });

    return reply.code(201).send(session);
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = service.getSession(id);

    if (!session) {
      return reply.code(404).send({
        error: 'Session not found'
      });
    }

    return session;
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);

    if (!run) {
      return reply.code(404).send({
        error: 'Run not found'
      });
    }

    return run;
  });

  app.post(
    '/api/sessions/:id/messages',
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = service.getSession(id);
      if (!existing) {
        return reply.code(404).send({
          error: 'Session not found'
        });
      }
      if (existing.status === 'running') {
        return reply.code(409).send({
          error: 'Session is already running'
        });
      }

      let text = '';
      const uploads: SavedUpload[] = [];

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            uploads.push(
              await service.saveUpload(
                id,
                part.filename,
                part.mimetype,
                part.file
              )
            );
          } else if (part.fieldname === 'text') {
            text = String(part.value || '');
          }
        }

        if (!text.trim() && uploads.length === 0) {
          return reply.code(400).send({
            error: 'Message or attachment is required'
          });
        }

        const started = service.startMessage(
          id,
          text,
          uploads
        );

        void started.completion
          .then(() => {
            broadcast({
              type: 'run.completed',
              runId: started.runId,
              sessionId: started.sessionId
            });
          })
          .catch((error: unknown) => {
            broadcast({
              type: 'run.failed',
              runId: started.runId,
              sessionId: started.sessionId,
              error:
                error instanceof Error
                  ? error.message
                  : String(error)
            });
          });

        return reply.code(202).send({
          runId: started.runId,
          sessionId: started.sessionId,
          status: 'running'
        });
      } catch (error) {
        request.log.error(error);
        const statusCode =
          error instanceof SessionBusyError
            ? 409
            : 502;
        return reply.code(statusCode).send({
          error:
            error instanceof Error
              ? error.message
              : 'Agent run failed'
        });
      }
    }
  );

  app.get(
    '/api/sessions/:sessionId/artifacts/:artifactId',
    async (request, reply) => {
      const { sessionId, artifactId } =
        request.params as {
          sessionId: string;
          artifactId: string;
        };

      const resolved = service.resolveArtifact(
        sessionId,
        artifactId
      );

      if (!resolved) {
        return reply.code(404).send({
          error: 'Artifact not found'
        });
      }

      reply.header(
        'content-type',
        resolved.record.mimeType
      );
      reply.header(
        'content-disposition',
        'attachment; filename="' +
          resolved.record.name.replace(/"/g, '') +
          '"'
      );

      return reply.send(
        fs.createReadStream(resolved.absolutePath)
      );
    }
  );

  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/'
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({
          error: 'Not found'
        });
      }

      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    for (const client of eventClients) {
      client.close(1001, 'Gateway shutting down');
    }
    eventClients.clear();
    await runtime.close();
    store.close();
  });

  return app;
}
