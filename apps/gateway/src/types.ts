export type SessionMode = 'code' | 'analysis';
export type SessionStatus = 'idle' | 'running' | 'error';
export type RunStatus = 'running' | 'completed' | 'failed';

export type SessionRecord = {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  codexThreadId: string | null;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
};

export type AttachmentRecord = {
  id: string;
  messageId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
  createdAt: string;
};

export type ArtifactRecord = {
  id: string;
  sessionId: string;
  messageId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sourceRelativePath: string;
  relativePath: string;
  sha256: string;
  createdAt: string;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  attachments: AttachmentRecord[];
  artifacts: ArtifactRecord[];
};

export type RunRecord = {
  id: string;
  sessionId: string;
  userMessageId: string;
  status: RunStatus;
  codexTurnId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type SessionDetail = SessionRecord & {
  messages: MessageRecord[];
};

export type SavedUpload = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
  absolutePath: string;
};
