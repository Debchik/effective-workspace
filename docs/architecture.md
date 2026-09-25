# V0.1 architecture

## Goal

Replace manual screenshot and messenger shuttling with a small self-hosted gateway. The browser is a thin client. The personal Mac owns credentials, Codex state, storage, and workspaces.

## Boundaries

### Web client

Responsibilities:
- authenticate with the gateway access token;
- create and select sessions;
- send text and attachments;
- paste screenshots directly from the clipboard;
- render conversation history;
- download generated artifacts.

It never talks to Codex directly and never receives Codex credentials.

### HTTP gateway

Fastify is the stable application boundary for browser clients and future native helpers.

The REST API is intentionally independent from Codex:
- GET /api/sessions
- POST /api/sessions
- GET /api/sessions/:id
- POST /api/sessions/:id/messages
- GET /api/sessions/:id/artifacts/:artifactId
- GET /api/runtime/account

Future Mac helpers can use the same API without changing the agent runtime.

### Session service

The service coordinates one user turn:
1. persist the user message;
2. persist attachments inside the session workspace;
3. mark the session and run as running;
4. start or resume the Codex thread;
5. send text plus local image inputs;
6. wait for turn completion;
7. persist the assistant response;
8. index files from output/ as artifacts;
9. write audit events.

This layer depends on the AgentRuntime interface, not on JSON-RPC.

### Agent runtime

V0.1 implements Codex app-server over stdio.

The runtime owns:
- one long-lived local app-server child process;
- JSON-RPC request correlation;
- the initialize handshake;
- thread start/resume;
- turn start;
- event collection;
- final assistant response extraction;
- account inspection.

Each application session stores the Codex thread id. This makes application sessions durable across gateway restarts.

### Workspace

Every session gets:

    sessions/<session-id>/
      AGENTS.md
      inbox/
      output/

inbox/ contains user uploads. output/ is the agent-facing artifact contract.

After a turn completes, new or changed files from output/ are copied into an immutable artifact store outside the Codex-writable workspace. The UI downloads those snapshots rather than the mutable working copy, so historical artifacts cannot silently change after later turns.

Codex is started with the session directory as cwd. Turn sandbox policy grants writes only inside that workspace and restricts reads to the workspace plus macOS platform defaults. Network access is disabled in V0.1.

### Storage

SQLite is the local source of truth for application metadata:
- sessions;
- messages;
- attachments;
- artifacts;
- runs;
- audit events.

Large payloads stay on disk and the database stores paths, source paths, hashes, MIME types, and sizes. Artifact snapshots live under the gateway data directory, outside the session workspace.

## Why not store Codex history ourselves?

Codex app-server already persists thread history. Effective Workspace stores the thread id plus its own user-facing message log.

This separation lets us:
- resume native Codex context;
- render a stable application history;
- migrate runtimes later;
- keep an explicit audit trail.

## Failure model

A run moves through running -> completed or failed.

User input is persisted before the agent starts. If Codex fails, the session remains recoverable and the next request can retry against the same thread.

The gateway does not delete workspaces automatically.

## V0.2 extension points

1. Streaming: expose app-server notifications through SSE or WebSocket while keeping the REST mutation endpoint.
2. Approvals: map app-server approval requests to persisted approval records and UI actions.
3. Auth: replace the shared bearer token with OIDC without touching SessionService.
4. Mac helper: use the same REST API for clipboard and screenshot capture.
5. Redaction: add an InputTransform chain before RuntimeInput is created.
6. Work executor: introduce a separate Executor interface rather than giving the gateway arbitrary local-machine access.
7. Multi-user: add owner_id to domain tables and allocate workspace/runtime identity per owner.

## Main invariants

- Codex credentials never cross the gateway boundary.
- A session may only access its own workspace.
- Only one turn may be active for a session at a time.
- Download endpoints resolve immutable artifact snapshots from database records; clients cannot request arbitrary paths.
- All user-controlled filenames are sanitized and stored with generated prefixes.
- Network access from the Codex sandbox is off by default.
