# V0.1 architecture

## Goal

Replace manual screenshot and messenger shuttling with a small self-hosted gateway. The work Mac only needs a browser. The personal Mac owns Codex credentials, agent state, local storage, workspaces, and artifacts.

## Deployment topology

```text
Work Mac
  Browser
    |
    | static assets
    v
GitHub Pages
    |
    | HTTPS / WSS
    v
Cloudflare edge
    |
    | Cloudflare Tunnel
    v
cloudflared on personal Mac
    |
    v
Fastify Gateway on 127.0.0.1:8787
    |
    +--> SQLite
    +--> SessionService
    +--> AgentRuntime
           |
           v
       Codex app-server
```

GitHub Pages is not a proxy. It only serves the React bundle.

`cloudflared` creates the outbound connection from the personal Mac to Cloudflare. No public IP, router port forwarding, or gateway bind to `0.0.0.0` is required.

## Web client

Responsibilities:

- store the gateway URL separately from the static frontend location;
- authenticate with the gateway access token;
- create and select sessions;
- send text and attachments;
- paste screenshots directly from the clipboard;
- render conversation history;
- download generated artifacts;
- keep an authenticated WebSocket to `/api/events`;
- reload persisted state after event reconnects.

The client never talks to Codex directly and never receives Codex credentials.

## HTTP gateway

Fastify is the stable application boundary for browser clients and future native helpers.

REST API:

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `GET /api/runs/:id`
- `GET /api/sessions/:id/artifacts/:artifactId`
- `GET /api/runtime/account`

Realtime API:

- `WS /api/events`

The API is intentionally independent from Codex protocol details.

## Why runs are asynchronous

A Codex turn can exceed a reverse proxy's normal HTTP read timeout. Keeping the browser's message POST open until Codex finishes makes completion depend on that network connection.

The gateway therefore uses two phases.

### Submission

```text
POST message
  -> validate/authenticate
  -> save uploads
  -> atomically mark session running
  -> persist user message
  -> create run row
  -> start local Codex work
  -> HTTP 202 { runId }
```

At this point the durable local state already contains the user message and run identifier.

### Completion

```text
Codex turn/completed
  -> persist assistant message
  -> snapshot artifacts
  -> finish run
  -> set session idle
  -> emit run.completed over WebSocket
```

A failure similarly persists the failed run and emits `run.failed`.

WebSocket events improve latency/UX but are not the source of truth. If an event is missed, the browser reloads the session from SQLite after reconnecting.

## Session service

The service coordinates one user turn:

1. acquire the per-session running lock;
2. persist the user message and attachments;
3. create the local run ID;
4. start or resume the Codex thread;
5. send text plus local image inputs;
6. wait locally for Codex completion;
7. persist the assistant response;
8. index files from `output/` as artifacts;
9. finish the run and update session status;
10. write audit events.

`startMessage()` exposes the run ID before the asynchronous completion promise resolves. The legacy `sendMessage()` helper awaits the same operation and remains useful for tests/internal callers.

## Agent runtime

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

Each application session stores the Codex thread ID. This makes application sessions durable across gateway restarts.

The `AgentRuntime` boundary allows later replacement/addition of another runtime without changing HTTP/UI semantics.

## Workspace

Every session gets:

```text
sessions/<session-id>/
  AGENTS.md
  inbox/
  output/
```

`inbox/` contains user uploads. `output/` is the agent-facing artifact contract.

After a turn completes, new or changed files from `output/` are copied into an immutable artifact store outside the Codex-writable workspace. Historical downloads therefore do not silently change after later turns.

Codex starts with the session directory as cwd. Turn sandbox policy grants writes only inside that workspace and restricts reads to the workspace plus macOS platform defaults. Network access is disabled in V0.1.

## Storage

SQLite on the personal Mac is the source of truth:

- sessions;
- messages;
- attachments;
- artifacts;
- runs;
- audit events.

Large payloads stay on local disk. The database stores paths, source paths, hashes, MIME types, sizes, and run state.

No cloud database is required.

For one user and one gateway process, SQLite avoids an unnecessary service boundary. A future storage interface can move metadata to PostgreSQL when multi-worker or multi-user coordination justifies it.

## Realtime channel

The browser connects to `/api/events` over WebSocket.

Because browser WebSocket APIs cannot attach arbitrary Authorization headers, authentication is performed as the first WebSocket message. The gateway:

1. validates the request Origin against the same allowlist used for HTTP;
2. requires the gateway token within five seconds;
3. adds the socket to the event fan-out only after authentication;
4. sends WebSocket ping frames periodically as keepalive;
5. removes the socket on close/error.

The gateway token is never placed in a URL.

## Cloudflare modes

### Quick Tunnel

`cloudflared tunnel --url http://127.0.0.1:8787`

Used by default for a completely free setup with no domain. The URL is temporary.

### Named Tunnel

The bootstrap can create a locally managed named tunnel and a DNS route for an existing Cloudflare-managed domain. The generated local config routes only the chosen hostname to the gateway and ends with a 404 catch-all.

## Failure model

A run moves through:

```text
running -> completed
        \-> failed
```

User input and the run row exist before the agent starts.

If Codex fails:

- run becomes `failed`;
- session becomes `error`;
- error is audited;
- browser receives `run.failed` if connected.

If the gateway process dies during a run, startup recovery marks leftover running rows failed and the session error.

If the WebSocket dies, the run continues locally. Realtime reconnect is independent from execution.

If the browser closes, the run continues locally.

## Extension points

1. Token streaming: forward Codex deltas over the existing WebSocket.
2. Cancellation: persist cancel requests and map them to Codex turn interruption.
3. Approvals: persist app-server approval requests and UI decisions.
4. Auth: replace the shared bearer token with OIDC without touching SessionService.
5. Mac helper: use the same API for clipboard and screenshot capture.
6. Redaction: add an InputTransform chain before RuntimeInput is created.
7. Work executor: introduce a separate Executor trust boundary.
8. Storage: replace SQLite behind a Store interface if distributed coordination becomes necessary.
9. Multi-user: add owner IDs and isolate runtime/workspace identity per user.

## Main invariants

- Codex credentials never cross the gateway boundary.
- Gateway remains bound to localhost for the Cloudflare deployment.
- Cloudflare connectivity is outbound-only from the host.
- A session may access only its own workspace.
- Only one Codex turn may be active for a session.
- A run is persisted before asynchronous execution is exposed to the client.
- WebSocket delivery is an optimization; SQLite is authoritative.
- Download endpoints resolve immutable artifact snapshots from database records.
- User-controlled filenames are sanitized and stored with generated prefixes.
- Network access from the Codex sandbox is off by default.
