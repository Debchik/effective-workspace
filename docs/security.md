# Security notes

V0.1 assumes the organization permits external AI processing and permits this internal tool.

The design still keeps conservative defaults:
- bind to localhost by default;
- require a high-entropy bearer token for every API request;
- do not put ChatGPT or Codex credentials in the browser;
- use one workspace per session;
- restrict Codex filesystem access to that workspace;
- disable Codex network access;
- sanitize upload names;
- never map a URL path directly to a filesystem path;
- retain audit records for task, run, and artifact lifecycle.

Before exposing the gateway outside the personal Mac, add a secure transport layer such as a trusted VPN, SSH tunnel, or TLS reverse proxy.

The shared bearer token is suitable for a personal MVP, not for a multi-user deployment. The planned replacement is OIDC plus per-user authorization.
