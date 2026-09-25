# Security notes

V0.1 assumes the organization permits external AI processing and permits this internal tool.

## Trust boundaries

```text
Work browser
    |
    | HTTPS / WSS
    v
Cloudflare
    |
    | outbound tunnel
    v
Personal Mac
  Gateway -> SQLite/files -> Codex
```

GitHub Pages serves only public static application code. It does not receive API payloads after the bundle is loaded.

Cloudflare is in the transport path for requests routed through Tunnel. Application state is not intentionally persisted there by Effective Workspace.

## Defaults

- Gateway binds to `127.0.0.1`.
- Do not open router ports for the gateway.
- Require a high-entropy bearer token for authenticated HTTP API requests.
- Require token authentication before a WebSocket may receive events.
- Validate WebSocket Origin against the configured browser origin allowlist.
- Keep ChatGPT/Codex credentials only on the personal Mac.
- Use one workspace per session.
- Restrict Codex filesystem writes to that workspace.
- Disable Codex network access.
- Sanitize upload names.
- Never map a client path directly to a filesystem path.
- Store artifact downloads as immutable snapshots outside the Codex-writable workspace.
- Retain local audit records for task, run, and artifact lifecycle.

## Secrets

Never commit:

- `.env`;
- `.cloudflared/`;
- Codex auth material;
- Cloudflare tunnel credential JSON.

The repository ignores the local environment and Cloudflare config directories.

The gateway token and Codex credential are separate secrets. Do not reuse an OpenAI/Codex credential as the gateway bearer token.

## CORS

GitHub Pages and the gateway have different origins, so the gateway explicitly allowlists browser origins using `ALLOWED_ORIGINS`.

The bootstrap derives the GitHub account from the repository remote and adds:

```text
https://<github-user>.github.io
```

The Pages path is not part of the Origin header.

Do not use a wildcard CORS policy with the bearer-token frontend.

## Long-running turns

The browser's message POST returns after the input and run are persisted and execution has started. Codex completion is not tied to the lifetime of that HTTP request.

This avoids treating a reverse-proxy timeout as an agent failure.

Realtime completion uses an authenticated WebSocket. If that channel disconnects, execution continues and durable state remains local.

## Quick Tunnel caveat

Cloudflare positions Quick Tunnels as a development/testing facility. Their hostname is temporary and there is no uptime SLA.

This is acceptable for a personal V0.1 when a completely free/no-domain setup is required. For a stable hostname, use a named tunnel with an existing Cloudflare-managed domain.

## Current authentication limitation

The shared bearer token is suitable for a personal single-user MVP, not a multi-user deployment.

Before multi-user use, replace it with user identity, per-user authorization, revocation, and preferably secure browser session cookies/OIDC.
