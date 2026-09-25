import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from './db.js';
import type {
  AgentRuntime,
  RuntimeInput,
  RuntimeResult
} from './runtime.js';
import {
  SessionBusyError,
  SessionService
} from './session-service.js';

class ArtifactRuntime implements AgentRuntime {
  readonly inputs: RuntimeInput[] = [];
  private turn = 0;

  async run(
    input: RuntimeInput
  ): Promise<RuntimeResult> {
    this.inputs.push(input);
    this.turn += 1;

    const outputDir = path.join(
      input.workspaceDir,
      'output'
    );
    fs.mkdirSync(outputDir, {
      recursive: true
    });
    fs.writeFileSync(
      path.join(outputDir, 'result.txt'),
      'version ' + String(this.turn)
    );

    return {
      threadId:
        input.threadId || 'test-thread-1',
      turnId: 'turn-' + String(this.turn),
      text: 'reply ' + String(this.turn)
    };
  }

  async account(): Promise<unknown> {
    return { account: { type: 'test' } };
  }

  async close(): Promise<void> {}
}

class BlockingRuntime implements AgentRuntime {
  private resolveRun:
    | ((value: RuntimeResult) => void)
    | null = null;

  run(
    input: RuntimeInput
  ): Promise<RuntimeResult> {
    return new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  release(): void {
    if (!this.resolveRun) {
      throw new Error(
        'Blocking runtime was not started.'
      );
    }

    this.resolveRun({
      threadId: 'blocking-thread',
      turnId: 'blocking-turn',
      text: 'done'
    });
  }

  async account(): Promise<unknown> {
    return {};
  }

  async close(): Promise<void> {}
}

function createFixture(runtime: AgentRuntime) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'effective-workspace-')
  );
  const store = new Store(
    path.join(dataDir, 'test.sqlite')
  );
  const service = new SessionService(
    store,
    runtime,
    dataDir
  );

  return {
    dataDir,
    store,
    service,
    cleanup() {
      store.close();
      fs.rmSync(dataDir, {
        recursive: true,
        force: true
      });
    }
  };
}

test(
  'persists a Codex thread and snapshots artifacts immutably',
  async () => {
    const runtime = new ArtifactRuntime();
    const fixture = createFixture(runtime);

    try {
      const session =
        fixture.service.createSession({
          mode: 'code'
        });

      const first =
        await fixture.service.sendMessage(
          session.id,
          'first request',
          []
        );

      assert.equal(
        first.codexThreadId,
        'test-thread-1'
      );
      assert.equal(first.messages.length, 2);
      assert.equal(
        runtime.inputs[0]?.threadId,
        null
      );

      const firstArtifact =
        first.messages[1]?.artifacts[0];
      assert.ok(firstArtifact);

      const firstResolved =
        fixture.service.resolveArtifact(
          session.id,
          firstArtifact.id
        );
      assert.ok(firstResolved);
      assert.equal(
        fs.readFileSync(
          firstResolved.absolutePath,
          'utf8'
        ),
        'version 1'
      );

      const second =
        await fixture.service.sendMessage(
          session.id,
          'second request',
          []
        );

      assert.equal(
        runtime.inputs[1]?.threadId,
        'test-thread-1'
      );

      const secondArtifact =
        second.messages[3]?.artifacts[0];
      assert.ok(secondArtifact);
      assert.notEqual(
        secondArtifact.id,
        firstArtifact.id
      );

      assert.equal(
        fs.readFileSync(
          firstResolved.absolutePath,
          'utf8'
        ),
        'version 1'
      );

      const secondResolved =
        fixture.service.resolveArtifact(
          session.id,
          secondArtifact.id
        );
      assert.ok(secondResolved);
      assert.equal(
        fs.readFileSync(
          secondResolved.absolutePath,
          'utf8'
        ),
        'version 2'
      );
    } finally {
      fixture.cleanup();
    }
  }
);

test(
  'exposes a durable run id before a long turn completes',
  async () => {
    const runtime = new BlockingRuntime();
    const fixture = createFixture(runtime);

    try {
      const session =
        fixture.service.createSession({
          mode: 'analysis'
        });

      const started =
        fixture.service.startMessage(
          session.id,
          'long analysis',
          []
        );

      const running =
        fixture.service.getRun(started.runId);
      assert.equal(running?.status, 'running');
      assert.equal(
        fixture.service.getSession(session.id)
          ?.status,
        'running'
      );

      runtime.release();
      await started.completion;

      const completed =
        fixture.service.getRun(started.runId);
      assert.equal(
        completed?.status,
        'completed'
      );
      assert.equal(
        completed?.codexTurnId,
        'blocking-turn'
      );
    } finally {
      fixture.cleanup();
    }
  }
);

test(
  'rejects a concurrent turn for the same session',
  async () => {
    const runtime = new BlockingRuntime();
    const fixture = createFixture(runtime);

    try {
      const session =
        fixture.service.createSession({
          mode: 'analysis'
        });

      const firstRun =
        fixture.service.sendMessage(
          session.id,
          'long analysis',
          []
        );

      await assert.rejects(
        fixture.service.sendMessage(
          session.id,
          'racing request',
          []
        ),
        SessionBusyError
      );

      runtime.release();
      await firstRun;

      const detail =
        fixture.service.getSession(session.id);
      assert.equal(detail?.status, 'idle');
      assert.equal(
        detail?.messages.length,
        2
      );
    } finally {
      fixture.cleanup();
    }
  }
);
