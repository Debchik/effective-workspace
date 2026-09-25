import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import mime from 'mime-types';
import { Store } from './db.js';
import type { AgentRuntime } from './runtime.js';
import type {
  ArtifactRecord,
  SavedUpload,
  SessionDetail,
  SessionMode,
  SessionRecord
} from './types.js';

function safeName(name: string): string {
  const base = path.basename(name || 'upload.bin');
  return (
    base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload.bin'
  );
}

function sha256(filePath: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function modeInstructions(mode: SessionMode): string {
  if (mode === 'code') {
    return [
      '# Effective Workspace',
      '',
      'This is a coding workspace.',
      'User-provided inputs are in inbox/.',
      'Put finished deliverable files in output/.',
      'Do not read or write outside this workspace.',
      'Prefer concise explanations and concrete artifacts.',
      'Do not use the network.'
    ].join('\n');
  }

  return [
    '# Effective Workspace',
    '',
    'This is an analysis workspace.',
    'User-provided inputs are in inbox/.',
    'Put generated deliverables in output/.',
    'Do not read or write outside this workspace.',
    'Separate observations, hypotheses, and conclusions.',
    'Do not use the network.'
  ].join('\n');
}

export class SessionBusyError extends Error {
  constructor() {
    super('Session is already running.');
    this.name = 'SessionBusyError';
  }
}

export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly runtime: AgentRuntime,
    private readonly dataDir: string
  ) {}

  listSessions(): SessionRecord[] {
    return this.store.listSessions();
  }

  getSession(id: string): SessionDetail | null {
    return this.store.getSessionDetail(id);
  }

  createSession(input: {
    title?: string;
    mode: SessionMode;
  }): SessionRecord {
    const id = randomUUID();
    const workspacePath = path.join(this.dataDir, 'sessions', id);

    fs.mkdirSync(path.join(workspacePath, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'output'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'AGENTS.md'),
      modeInstructions(input.mode)
    );

    const session = this.store.createSession({
      id,
      title:
        input.title?.trim() ||
        (input.mode === 'code' ? 'New coding task' : 'New analysis'),
      mode: input.mode,
      workspacePath
    });

    this.store.audit(session.id, 'session.created', {
      mode: session.mode
    });

    return session;
  }

  async saveUpload(
    sessionId: string,
    filename: string,
    mimeType: string,
    stream: Readable
  ): Promise<SavedUpload> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }

    const id = randomUUID();
    const originalName = safeName(filename);
    const storedName = id + '-' + originalName;
    const absolutePath = path.join(
      session.workspacePath,
      'inbox',
      storedName
    );

    await pipeline(stream, createWriteStream(absolutePath));
    const stat = fs.statSync(absolutePath);

    return {
      id,
      originalName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: stat.size,
      relativePath: path.relative(session.workspacePath, absolutePath),
      absolutePath
    };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    uploads: SavedUpload[]
  ): Promise<SessionDetail> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }

    if (!this.store.trySetSessionRunning(session.id)) {
      throw new SessionBusyError();
    }

    let runId: string | null = null;

    try {
      const effectiveText =
        text.trim() || 'Please analyze the attached input.';
      const userMessage = this.store.insertMessage(
        session.id,
        'user',
        effectiveText
      );

      for (const upload of uploads) {
        this.store.insertAttachment({
          id: upload.id,
          messageId: userMessage.id,
          name: upload.originalName,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          relativePath: upload.relativePath
        });
      }

      runId = this.store.createRun(
        session.id,
        userMessage.id
      );
      this.store.audit(
        session.id,
        'message.received',
        {
          messageId: userMessage.id,
          attachments: uploads.length
        }
      );

      const nonImageFiles = uploads
        .filter(
          (item) =>
            !item.mimeType.startsWith('image/')
        )
        .map(
          (item) => '- ' + item.relativePath
        )
        .join('\n');

      const prompt =
        effectiveText +
        (nonImageFiles
          ? '\n\nAttached files available in the workspace:\n' +
            nonImageFiles
          : '');

      const result = await this.runtime.run({
        threadId: session.codexThreadId,
        workspaceDir: session.workspacePath,
        text: prompt,
        imagePaths: uploads
          .filter((item) =>
            item.mimeType.startsWith('image/')
          )
          .map((item) => item.absolutePath)
      });

      if (
        session.codexThreadId !==
        result.threadId
      ) {
        this.store.setCodexThreadId(
          session.id,
          result.threadId
        );
        this.store.audit(
          session.id,
          'runtime.thread_linked',
          { threadId: result.threadId }
        );
      }

      const assistantMessage =
        this.store.insertMessage(
          session.id,
          'assistant',
          result.text
        );

      this.indexArtifacts(
        session.id,
        assistantMessage.id,
        session.workspacePath
      );

      this.store.finishRun(
        runId,
        'completed',
        result.turnId
      );
      this.store.setSessionStatus(
        session.id,
        'idle'
      );
      this.store.audit(
        session.id,
        'runtime.turn_completed',
        { turnId: result.turnId }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (runId) {
        this.store.finishRun(
          runId,
          'failed',
          undefined,
          message
        );
      }
      this.store.setSessionStatus(
        session.id,
        'error'
      );
      this.store.audit(
        session.id,
        'runtime.turn_failed',
        { error: message }
      );
      throw error;
    }

    const detail =
      this.store.getSessionDetail(session.id);
    if (!detail) {
      throw new Error(
        'Session disappeared after run.'
      );
    }
    return detail;
  }

  resolveArtifact(
    sessionId: string,
    artifactId: string
  ): { record: ArtifactRecord; absolutePath: string } | null {
    const session = this.store.getSession(sessionId);
    const artifact = this.store.getArtifact(artifactId);

    if (!session || !artifact || artifact.sessionId !== session.id) {
      return null;
    }

    const absolutePath = path.resolve(
      this.dataDir,
      artifact.relativePath
    );
    const artifactRoot =
      path.resolve(
        this.dataDir,
        'artifacts',
        session.id
      ) + path.sep;

    if (!absolutePath.startsWith(artifactRoot)) return null;
    if (!fs.existsSync(absolutePath)) return null;

    return { record: artifact, absolutePath };
  }

  private indexArtifacts(
    sessionId: string,
    messageId: string,
    workspacePath: string
  ): void {
    const outputRoot = path.join(
      workspacePath,
      'output'
    );
    if (!fs.existsSync(outputRoot)) return;

    const visit = (directory: string): void => {
      for (
        const entry of fs.readdirSync(directory, {
          withFileTypes: true
        })
      ) {
        const sourcePath = path.join(
          directory,
          entry.name
        );

        if (entry.isDirectory()) {
          visit(sourcePath);
          continue;
        }
        if (!entry.isFile()) continue;

        const stat = fs.statSync(sourcePath);
        const sourceRelativePath =
          path.relative(
            workspacePath,
            sourcePath
          );
        const hash = sha256(sourcePath);

        if (
          this.store.findArtifactBySourceHash(
            sessionId,
            sourceRelativePath,
            hash
          )
        ) {
          continue;
        }

        const artifactId = randomUUID();
        const artifactDirectory = path.join(
          this.dataDir,
          'artifacts',
          sessionId,
          artifactId
        );
        const archivedPath = path.join(
          artifactDirectory,
          safeName(entry.name)
        );

        fs.mkdirSync(artifactDirectory, {
          recursive: true
        });
        fs.copyFileSync(
          sourcePath,
          archivedPath
        );

        const relativePath = path.relative(
          this.dataDir,
          archivedPath
        );

        const artifact =
          this.store.insertArtifact({
            id: artifactId,
            sessionId,
            messageId,
            name: entry.name,
            mimeType:
              mime.lookup(entry.name) ||
              'application/octet-stream',
            sizeBytes: stat.size,
            sourceRelativePath,
            relativePath,
            sha256: hash
          });

        if (!artifact) {
          fs.rmSync(artifactDirectory, {
            recursive: true,
            force: true
          });
          continue;
        }

        this.store.audit(
          sessionId,
          'artifact.indexed',
          {
            artifactId: artifact.id,
            sourceRelativePath
          }
        );
      }
    };

    visit(outputRoot);
  }

}
