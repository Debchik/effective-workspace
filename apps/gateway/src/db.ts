import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArtifactRecord,
  AttachmentRecord,
  MessageRecord,
  RunRecord,
  SessionDetail,
  SessionMode,
  SessionRecord,
  SessionStatus
} from './types.js';

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.recoverInterruptedRuns();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS sessions (" +
        "id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, " +
        "codex_thread_id TEXT, workspace_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS messages (" +
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
        "role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS attachments (" +
        "id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, " +
        "name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, relative_path TEXT NOT NULL, created_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS artifacts (" +
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
        "message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL, " +
        "size_bytes INTEGER NOT NULL, source_relative_path TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, " +
        "UNIQUE(session_id, source_relative_path, sha256));" +
      "CREATE TABLE IF NOT EXISTS runs (" +
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
        "user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL, " +
        "codex_turn_id TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT);" +
      "CREATE TABLE IF NOT EXISTS audit_events (" +
        "id TEXT PRIMARY KEY, session_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);" +
      "CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);" +
      "CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);" +
      "CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, created_at);"
    );
  }

  private recoverInterruptedRuns(): void {
    const timestamp = now();
    this.db.prepare(
      "UPDATE runs SET status = 'failed', error = ?, completed_at = ? WHERE status = 'running'"
    ).run('Gateway restarted before the run completed.', timestamp);
    this.db.prepare(
      "UPDATE sessions SET status = 'error', updated_at = ? WHERE status = 'running'"
    ).run(timestamp);
  }

  close(): void {
    this.db.close();
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => this.mapSession(row));
  }

  createSession(input: {
    id: string;
    title: string;
    mode: SessionMode;
    workspacePath: string;
  }): SessionRecord {
    const timestamp = now();
    this.db.prepare(
      'INSERT INTO sessions (id, title, mode, status, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      input.id,
      input.title,
      input.mode,
      'idle',
      input.workspacePath,
      timestamp,
      timestamp
    );
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapSession(row) : null;
  }

  getSessionDetail(id: string): SessionDetail | null {
    const session = this.getSession(id);
    if (!session) return null;
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(id) as Row[];
    return {
      ...session,
      messages: rows.map((row) => this.mapMessage(row))
    };
  }

  setSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare(
      'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now(), id);
  }

  trySetSessionRunning(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ? AND status != 'running'"
    ).run(now(), id);
    return Number(result.changes) === 1;
  }

  setCodexThreadId(id: string, threadId: string): void {
    this.db.prepare(
      'UPDATE sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?'
    ).run(threadId, now(), id);
  }

  insertMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    text: string
  ): MessageRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(
      'INSERT INTO messages (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, role, text, timestamp);
    return this.mapMessage(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row
    );
  }

  insertAttachment(input: {
    id: string;
    messageId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    relativePath: string;
  }): void {
    this.db.prepare(
      'INSERT INTO attachments (id, message_id, name, mime_type, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      input.id,
      input.messageId,
      input.name,
      input.mimeType,
      input.sizeBytes,
      input.relativePath,
      now()
    );
  }

  insertArtifact(input: {
    id: string;
    sessionId: string;
    messageId: string | null;
    name: string;
    mimeType: string;
    sizeBytes: number;
    sourceRelativePath: string;
    relativePath: string;
    sha256: string;
  }): ArtifactRecord | null {
    try {
      this.db.prepare(
        'INSERT INTO artifacts (id, session_id, message_id, name, mime_type, size_bytes, source_relative_path, relative_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        input.id,
        input.sessionId,
        input.messageId,
        input.name,
        input.mimeType,
        input.sizeBytes,
        input.sourceRelativePath,
        input.relativePath,
        input.sha256,
        now()
      );
    } catch {
      return null;
    }
    return this.getArtifact(input.id);
  }

  findArtifactBySourceHash(
    sessionId: string,
    sourceRelativePath: string,
    hash: string
  ): ArtifactRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM artifacts WHERE session_id = ? AND source_relative_path = ? AND sha256 = ? LIMIT 1'
    ).get(sessionId, sourceRelativePath, hash) as Row | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  createRun(sessionId: string, userMessageId: string): string {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO runs (id, session_id, user_message_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, userMessageId, 'running', now());
    return id;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM runs WHERE id = ?'
    ).get(id) as Row | undefined;
    return row ? this.mapRun(row) : null;
  }

  finishRun(
    id: string,
    status: 'completed' | 'failed',
    turnId?: string,
    error?: string
  ): void {
    this.db.prepare(
      'UPDATE runs SET status = ?, codex_turn_id = ?, error = ?, completed_at = ? WHERE id = ?'
    ).run(status, turnId || null, error || null, now(), id);
  }

  audit(
    sessionId: string | null,
    action: string,
    metadata: Record<string, unknown> = {}
  ): void {
    this.db.prepare(
      'INSERT INTO audit_events (id, session_id, actor, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      randomUUID(),
      sessionId,
      'gateway',
      action,
      JSON.stringify(metadata),
      now()
    );
  }

  private mapSession(row: Row): SessionRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      mode: row.mode as SessionMode,
      status: row.status as SessionStatus,
      codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
      workspacePath: String(row.workspace_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapMessage(row: Row): MessageRecord {
    const id = String(row.id);
    const attachmentRows = this.db.prepare(
      'SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC'
    ).all(id) as Row[];
    const artifactRows = this.db.prepare(
      'SELECT * FROM artifacts WHERE message_id = ? ORDER BY created_at ASC'
    ).all(id) as Row[];

    return {
      id,
      sessionId: String(row.session_id),
      role: row.role as 'user' | 'assistant',
      text: String(row.text),
      createdAt: String(row.created_at),
      attachments: attachmentRows.map((item) => this.mapAttachment(item)),
      artifacts: artifactRows.map((item) => this.mapArtifact(item))
    };
  }

  private mapAttachment(row: Row): AttachmentRecord {
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      name: String(row.name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      relativePath: String(row.relative_path),
      createdAt: String(row.created_at)
    };
  }

  private mapArtifact(row: Row): ArtifactRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: row.message_id ? String(row.message_id) : null,
      name: String(row.name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      sourceRelativePath: String(row.source_relative_path),
      relativePath: String(row.relative_path),
      sha256: String(row.sha256),
      createdAt: String(row.created_at)
    };
  }

  private mapRun(row: Row): RunRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      userMessageId: String(row.user_message_id),
      status: row.status as RunRecord['status'],
      codexTurnId: row.codex_turn_id ? String(row.codex_turn_id) : null,
      error: row.error ? String(row.error) : null,
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    };
  }
}
