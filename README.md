# Effective Workspace

A self-hosted browser gateway to Codex running on your personal Mac.

The intended V0.1 deployment is:

```text
Work Mac browser
      |
      | loads static UI
      v
GitHub Pages
      |
      | HTTPS + WebSocket
      v
Cloudflare Tunnel
      |
      | outbound-only tunnel
      v
Personal Mac
  Gateway
    |-- SQLite
    |-- session workspaces
    |-- immutable artifacts
    `-- Codex app-server
```

GitHub Pages only hosts the static React application. Cloudflare Tunnel forwards API/WebSocket traffic to the gateway bound to `127.0.0.1` on the personal Mac. Codex credentials, SQLite, uploaded files, workspaces, and generated artifacts stay on the personal Mac.

## What V0.1 supports

- Code and Analysis sessions.
- Persistent Codex thread IDs.
- Text, screenshots, and file attachments.
- Screenshot paste directly from the clipboard.
- Local SQLite metadata.
- One isolated workspace per session.
- Immutable snapshots of files created in `output/`.
- Bearer-token authentication.
- Cross-origin GitHub Pages frontend.
- Cloudflare Tunnel remote access without router port forwarding.
- Asynchronous runs: message submission returns `202 + run_id`.
- WebSocket completion events, so long Codex turns do not keep one HTTP request open.
- Reconnect-safe UI: the local SQLite database remains the source of truth.

See `docs/architecture.md` and `docs/security.md` for the boundaries and threat model.

## Requirements

The host machine is expected to be macOS.

The bootstrap requires:

- Git.
- Homebrew if Node.js or `cloudflared` must be installed automatically.
- Node.js 24+.

Everything else can be installed by the bootstrap script.

## Fastest setup: completely free

Clone the repository and run one command:

```bash
git clone https://github.com/Debchik/effective-workspace.git
cd effective-workspace
git checkout feat/v0.1-agent-gateway
bash scripts/bootstrap.sh
```

The bootstrap will:

1. verify Node.js 24+;
2. install pnpm if needed;
3. install Codex CLI if needed;
4. install `cloudflared` with Homebrew if needed;
5. run `codex login` if the CLI is not authenticated;
6. create/update `.env`;
7. generate a random 256-bit gateway access token;
8. add the repository owner's GitHub Pages origin to the CORS allowlist;
9. install project dependencies;
10. build the gateway and frontend;
11. initialize `.data/effective-workspace.sqlite`;
12. start the local gateway;
13. start a free Cloudflare Quick Tunnel.

At the end, `cloudflared` prints a URL similar to:

```text
https://random-words.trycloudflare.com
```

Keep that terminal running. The tunnel exists only while `cloudflared` is running.

### Start it again later

```bash
pnpm start:remote
```

This rebuilds the current checkout, starts the gateway, waits for its health endpoint, and then starts the configured Cloudflare tunnel.

## GitHub Pages frontend

The repository contains `.github/workflows/pages.yml`.

One-time GitHub setup:

1. Open repository **Settings -> Pages**.
2. Set **Source** to **GitHub Actions**.
3. Merge/push the code to `main`.
4. Wait for the `deploy-pages` workflow to finish.
5. Open:

```text
https://debchik.github.io/effective-workspace/
```

The UI asks for:

- **Gateway URL** — the Cloudflare URL printed by `cloudflared`;
- **Gateway access token** — `GATEWAY_ACCESS_TOKEN` from the local `.env` file.

The values are stored in that browser's `localStorage`. Codex credentials are never sent to the browser.

## Cloudflare modes

### Option A: Quick Tunnel — $0, no domain

This is the default:

```bash
bash scripts/bootstrap.sh
```

or explicitly:

```bash
bash scripts/bootstrap.sh --quick
```

Properties:

- no Cloudflare account required;
- no domain required;
- no public IP required;
- no router port forwarding;
- random `*.trycloudflare.com` URL;
- URL changes when the tunnel restarts.

Quick Tunnels are intended by Cloudflare for development/testing. They are convenient for this personal V0.1 but do not have an uptime SLA.

Because the frontend stores the gateway URL separately from the static build, a changed Quick Tunnel URL does **not** require redeploying GitHub Pages. Open the connection screen and enter the new URL.

### Option B: stable named tunnel

If you already own a domain managed by Cloudflare:

```bash
bash scripts/bootstrap.sh --hostname agent.example.com
```

The bootstrap additionally:

1. runs `cloudflared tunnel login` if required;
2. creates/reuses the `effective-workspace` tunnel;
3. creates `.cloudflared/config.yml`;
4. creates the Cloudflare DNS route;
5. validates the ingress configuration.

The stable gateway becomes:

```text
https://agent.example.com
```

The local Fastify server still only binds to:

```text
127.0.0.1:8787
```

Cloudflare reaches it through the outbound tunnel. Do not change `HOST` to `0.0.0.0` for this deployment.

To configure without immediately starting:

```bash
bash scripts/bootstrap.sh --hostname agent.example.com --no-start
```

## Local development

For frontend + gateway development without Cloudflare:

```bash
cp .env.example .env
# Replace GATEWAY_ACCESS_TOKEN with a long random value.
pnpm install
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

Leave the Gateway URL field empty. Vite proxies `/api` to the local gateway.

## Data layout

No cloud database is used.

```text
.data/
|-- effective-workspace.sqlite
|-- sessions/
|   `-- <session-id>/
|       |-- AGENTS.md
|       |-- inbox/
|       `-- output/
`-- artifacts/
    `-- <session-id>/
        `-- <artifact-id>/
```

SQLite is automatically created/migrated by the gateway. The bootstrap also initializes it explicitly with:

```bash
pnpm db:init
```

For the current one-user/single-host workload, SQLite is intentional. PostgreSQL can replace the storage adapter later without changing the public API.

## Request lifecycle

Submitting a prompt does **not** keep a Cloudflare HTTP request open for the whole Codex turn.

```text
Browser
  |
  | POST /api/sessions/:id/messages
  v
Gateway
  |
  | persist user message + run
  | start Codex locally
  |
  `----> HTTP 202 { runId }

Codex continues locally...

Codex turn/completed
  |
  v
Gateway
  | persist response/artifacts
  | mark run completed
  |
  `---- WebSocket: run.completed ----> Browser
```

This avoids coupling long-running Codex work to a single reverse-proxied HTTP request.

If the browser is closed or the WebSocket reconnects, nothing is lost: messages, run state, and artifacts are stored locally. On reconnect the UI reloads the current session from SQLite.

## Configuration

The bootstrap manages `.env`. Main settings:

```dotenv
HOST=127.0.0.1
PORT=8787
DATA_DIR=../../.data

GATEWAY_ACCESS_TOKEN=<random secret>
ALLOWED_ORIGINS=https://debchik.github.io,...

RUNTIME=codex
CODEX_BIN=codex
CODEX_MODEL=

TUNNEL_MODE=quick
CLOUDFLARE_TUNNEL_NAME=effective-workspace
CLOUDFLARE_HOSTNAME=
```

For a named tunnel:

```dotenv
TUNNEL_MODE=named
CLOUDFLARE_HOSTNAME=agent.example.com
```

Do not commit `.env` or `.cloudflared/`. Both are ignored by Git.

## Authentication

There are two unrelated credentials:

1. **Codex login** — stays on the personal Mac and is used only by the local Codex CLI/app-server.
2. **Gateway access token** — authorizes the browser to use Effective Workspace.

Never reuse the Codex/OpenAI credential as the gateway token.

HTTP API calls send:

```http
Authorization: Bearer <GATEWAY_ACCESS_TOKEN>
```

Browser WebSocket connections authenticate with the same gateway token as the first WebSocket message. The token is not put into the WebSocket URL.

## API

Authenticated endpoints:

```text
GET  /api/runtime/account
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/messages
GET  /api/runs/:id
GET  /api/sessions/:sessionId/artifacts/:artifactId
WS   /api/events
```

Unauthenticated:

```text
GET /api/health
```

`POST /api/sessions/:id/messages` returns immediately after the request has been persisted and execution started:

```json
{
  "runId": "...",
  "sessionId": "...",
  "status": "running"
}
```

The WebSocket emits:

```json
{
  "type": "run.completed",
  "runId": "...",
  "sessionId": "..."
}
```

or:

```json
{
  "type": "run.failed",
  "runId": "...",
  "sessionId": "...",
  "error": "..."
}
```

## Troubleshooting

### `codex login status` fails

Run:

```bash
codex login
```

Then verify:

```bash
codex login status
```

### GitHub Pages opens, but API requests fail

Check:

1. the personal Mac and `pnpm start:remote` are still running;
2. the Quick Tunnel URL has not changed;
3. the UI contains the current tunnel URL;
4. `https://debchik.github.io` is present in `ALLOWED_ORIGINS`;
5. the gateway token matches `.env`.

### WebSocket says reconnecting

First check the HTTP health endpoint:

```bash
curl https://YOUR_TUNNEL/api/health
```

Then check the `cloudflared` terminal. The browser automatically attempts to reconnect every two seconds and reloads persisted state after reconnection.

### Port 8787 is already in use

Either stop the existing process or change:

```dotenv
PORT=8788
```

For a named tunnel, rerun the bootstrap so the generated ingress config uses the new port.

### Quick Tunnel URL changes

Expected behavior. Quick Tunnel hostnames are temporary. Enter the new URL on the frontend connection screen.

For a permanent hostname, use:

```bash
bash scripts/bootstrap.sh --hostname agent.example.com
```

## Security defaults

- Gateway binds to localhost.
- No router port is opened.
- Cloudflare Tunnel is outbound-only from the personal Mac.
- API requires a high-entropy bearer token.
- WebSocket requires authentication before receiving events.
- Browser origins are allowlisted.
- Codex credentials never cross the host boundary.
- Codex can write only inside the session workspace.
- Codex network access is disabled.
- Artifact downloads resolve immutable DB-backed snapshots rather than arbitrary paths.
- SQLite, uploads, workspaces, messages, and artifacts remain local.

The shared gateway token is appropriate for this personal V0.1. A multi-user version should replace it with user identities and per-user authorization.
