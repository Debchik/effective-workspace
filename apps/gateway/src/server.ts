import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
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

function tokenMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;

  const actual = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

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

  await app.register(multipart, {
    limits: {
      files: 10,
      fileSize: 25 * 1024 * 1024,
      fields: 20
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/health') return;

    if (
      !tokenMatches(
        request.headers.authorization,
        config.accessToken
      )
    ) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/api/health', async () => ({
    ok: true,
    runtime: config.runtime
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

        return await service.sendMessage(
          id,
          text,
          uploads
        );
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
    await runtime.close();
    store.close();
  });

  return app;
}
