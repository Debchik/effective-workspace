import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export type RuntimeInput = {
  threadId: string | null;
  workspaceDir: string;
  text: string;
  imagePaths: string[];
};

export type RuntimeResult = {
  threadId: string;
  turnId: string;
  text: string;
};

export interface AgentRuntime {
  run(input: RuntimeInput): Promise<RuntimeResult>;
  account(): Promise<unknown>;
  close(): Promise<void>;
}

type RpcMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
};

export class MockRuntime implements AgentRuntime {
  async run(input: RuntimeInput): Promise<RuntimeResult> {
    return {
      threadId: input.threadId || 'mock-thread-' + Date.now(),
      turnId: 'mock-turn-' + Date.now(),
      text: 'Mock runtime received: ' + input.text
    };
  }

  async account(): Promise<unknown> {
    return { account: { type: 'mock' } };
  }

  async close(): Promise<void> {}
}

export class CodexAppServerRuntime implements AgentRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly loadedThreads = new Set<string>();

  constructor(
    private readonly codexBin: string,
    private readonly model?: string
  ) {}

  async run(input: RuntimeInput): Promise<RuntimeResult> {
    await this.ensureStarted();
    const threadId = await this.ensureThread(input);

    let expectedTurnId: string | null = null;
    let finalText = '';
    let streamedText = '';

    let completionResolve:
      | ((value: { turnId: string; status: string; error?: string }) => void)
      | undefined;

    const completion = new Promise<{ turnId: string; status: string; error?: string }>(
      (resolve) => {
        completionResolve = resolve;
      }
    );

    const listener = (message: RpcMessage) => {
      const params = message.params || {};
      const messageThreadId = params.threadId || params.thread?.id;
      const messageTurnId = params.turnId || params.turn?.id;

      if (messageThreadId && messageThreadId !== threadId) return;
      if (expectedTurnId && messageTurnId && messageTurnId !== expectedTurnId) return;

      if (
        message.method === 'item/agentMessage/delta' &&
        typeof params.delta === 'string'
      ) {
        streamedText += params.delta;
      }

      if (message.method === 'item/completed') {
        const item = params.item;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') {
          if (item.phase === 'final_answer' || !finalText) {
            finalText = item.text;
          }
        }
      }

      if (message.method === 'turn/completed') {
        const turn = params.turn;
        this.listeners.delete(listener);
        completionResolve?.({
          turnId: String(turn?.id || expectedTurnId || ''),
          status: String(turn?.status || 'completed'),
          error: turn?.error?.message ? String(turn.error.message) : undefined
        });
      }
    };

    this.listeners.add(listener);

    const inputItems: any[] = [{ type: 'text', text: input.text }];
    for (const imagePath of input.imagePaths) {
      inputItems.push({ type: 'localImage', path: imagePath });
    }

    const params: Record<string, unknown> = {
      threadId,
      input: inputItems,
      cwd: input.workspaceDir,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [input.workspaceDir],
        readOnlyAccess: {
          type: 'restricted',
          includePlatformDefaults: true,
          readableRoots: [input.workspaceDir]
        },
        networkAccess: false
      }
    };
    if (this.model) params.model = this.model;

    try {
      const started = await this.request('turn/start', params);
      expectedTurnId = String(started.turn.id);

      const done = await this.withTimeout(
        completion,
        10 * 60 * 1000,
        'Codex turn timed out after 10 minutes.'
      );

      if (done.status === 'failed') {
        throw new Error(done.error || 'Codex turn failed.');
      }

      return {
        threadId,
        turnId: done.turnId || expectedTurnId,
        text: finalText || streamedText || 'Codex completed without a text response.'
      };
    } finally {
      this.listeners.delete(listener);
    }
  }

  async account(): Promise<unknown> {
    await this.ensureStarted();
    return this.request('account/read', { refreshToken: false });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = null;
    this.initialized = false;
    this.loadedThreads.clear();
  }

  private async ensureThread(input: RuntimeInput): Promise<string> {
    if (input.threadId) {
      if (!this.loadedThreads.has(input.threadId)) {
        await this.request('thread/resume', {
          threadId: input.threadId,
          cwd: input.workspaceDir
        });
        this.loadedThreads.add(input.threadId);
      }
      return input.threadId;
    }

    const params: Record<string, unknown> = {
      cwd: input.workspaceDir,
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
      serviceName: 'effective_workspace'
    };
    if (this.model) params.model = this.model;

    const result = await this.request('thread/start', params);
    const threadId = String(result.thread.id);
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;

    this.child = spawn(this.codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stderr.on('data', (chunk) => {
      process.stderr.write('[codex] ' + chunk.toString());
    });

    this.child.on('exit', (code) => {
      const error = new Error(
        'Codex app-server exited with code ' + String(code)
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
      this.loadedThreads.clear();
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      clientInfo: {
        name: 'effective_workspace',
        title: 'Effective Workspace',
        version: '0.1.0'
      }
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message || 'Codex RPC request failed.')
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === 'number' && message.method) {
      this.respondUnsupported(message.id, message.method);
      return;
    }

    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>
  ): Promise<any> {
    if (!this.child) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }

    const id = this.nextRequestId++;
    const result = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
    return result;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  private respondUnsupported(id: number, method: string): void {
    if (!this.child) return;
    this.child.stdin.write(
      JSON.stringify({
        id,
        error: {
          code: -32601,
          message: 'Client does not support server request: ' + method
        }
      }) + '\n'
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
