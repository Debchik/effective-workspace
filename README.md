# Effective Workspace

A self-hosted agent gateway for using Codex from a browser on another computer.

V0.1 is intentionally narrow:
- the personal Mac runs the gateway and Codex;
- the work Mac only needs a browser;
- sessions are persistent;
- text, screenshots, and files can be attached;
- every session gets an isolated local workspace;
- generated files placed in output/ are returned as downloadable artifacts.

## Architecture

Browser -> HTTP API -> SessionService -> AgentRuntime -> Codex app-server
                         |                 |
                         v                 v
                      SQLite          workspace/
                                         inbox/
                                         output/

The AgentRuntime boundary is deliberate. The UI and storage layer do not depend on Codex protocol details, so a later version can swap the runtime for Codex SDK, Agents API, or a remote executor.

See docs/architecture.md for the design and extension points.

## Requirements

- macOS on the host machine
- Node.js 24+
- pnpm
- Codex CLI installed and authenticated

Install Codex and sign in with the ChatGPT account you want to use:

    npm install -g @openai/codex
    codex login

## Run locally

    cp .env.example .env
    # Set a long random GATEWAY_ACCESS_TOKEN in .env
    pnpm install
    pnpm dev

Open http://127.0.0.1:5173 during development.

For a production-like local build:

    pnpm build
    pnpm start

The gateway serves the built frontend on the configured PORT.

## Remote access

The gateway binds to 127.0.0.1 by default. Keep it that way unless you deliberately place it behind a trusted private network, SSH tunnel, VPN, or TLS reverse proxy.

Do not expose the raw HTTP port to the public internet. The V0.1 bearer token is an application-level guard, not a replacement for transport security.

## Current limitations

- one human user / one Codex identity;
- a single shared access token instead of OIDC;
- requests wait for the current Codex turn to finish; streaming UI comes next;
- approvals are disabled for the tightly sandboxed V0.1 workspace;
- artifacts are files written to output/.
