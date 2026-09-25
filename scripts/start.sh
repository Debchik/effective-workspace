#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo ".env is missing. Run ./scripts/bootstrap.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

PORT="${PORT:-8787}"
TUNNEL_MODE="${TUNNEL_MODE:-quick}"

echo "Building current checkout..."
pnpm build

echo "Starting local gateway on http://127.0.0.1:$PORT ..."
pnpm start &
GATEWAY_PID=$!

cleanup() {
  if kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  if curl --silent --fail "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    echo "Gateway exited before becoming healthy." >&2
    exit 1
  fi
  sleep 1
done

if ! curl --silent --fail "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Gateway did not become healthy on port $PORT." >&2
  exit 1
fi

echo "Gateway is healthy."

if [[ "$TUNNEL_MODE" == "named" ]]; then
  if [[ ! -f "$ROOT/.cloudflared/config.yml" ]]; then
    echo "Named tunnel config is missing. Run ./scripts/bootstrap.sh --hostname <host>." >&2
    exit 1
  fi

  echo "Starting named Cloudflare Tunnel at https://${CLOUDFLARE_HOSTNAME} ..."
  cloudflared tunnel     --config "$ROOT/.cloudflared/config.yml"     run "${CLOUDFLARE_TUNNEL_NAME:-effective-workspace}"
else
  echo
  echo "Starting free Cloudflare Quick Tunnel."
  echo "Copy the https://*.trycloudflare.com URL printed below into the web UI."
  echo
  cloudflared tunnel --url "http://127.0.0.1:$PORT"
fi
