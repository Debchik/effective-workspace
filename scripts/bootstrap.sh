#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

START_AFTER_SETUP=1
MODE_OVERRIDE=""
HOSTNAME_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/bootstrap.sh
  ./scripts/bootstrap.sh --quick
  ./scripts/bootstrap.sh --hostname gateway.example.com
  ./scripts/bootstrap.sh --no-start

Default mode is a free temporary Cloudflare Quick Tunnel.
Use --hostname only if you already own a domain managed by Cloudflare.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      MODE_OVERRIDE="quick"
      shift
      ;;
    --hostname)
      MODE_OVERRIDE="named"
      HOSTNAME_OVERRIDE="${2:-}"
      if [[ -z "$HOSTNAME_OVERRIDE" ]]; then
        echo "--hostname requires a hostname, for example gateway.example.com" >&2
        exit 1
      fi
      shift 2
      ;;
    --no-start)
      START_AFTER_SETUP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

install_with_brew() {
  local package="$1"
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required to auto-install $package." >&2
    echo "Install Homebrew, then re-run this script." >&2
    exit 1
  fi
  brew install "$package"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found; installing it with Homebrew..."
  install_with_brew node
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js 24+ is required; current version: $(node --version)" >&2
  echo "Upgrade Node.js and re-run the bootstrap." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm 10.17.1..."
  npm install -g pnpm@10.17.1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Installing Codex CLI..."
  npm install -g @openai/codex
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Installing cloudflared..."
  install_with_brew cloudflared
fi

if ! codex login status >/dev/null 2>&1; then
  echo
  echo "Codex is not authenticated. Starting interactive ChatGPT sign-in..."
  codex login
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
GITHUB_OWNER="$(printf '%s' "$REMOTE_URL" | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#')"
if [[ -n "$GITHUB_OWNER" && "$GITHUB_OWNER" != "$REMOTE_URL" ]]; then
  PAGES_ORIGIN="https://${GITHUB_OWNER}.github.io"
else
  PAGES_ORIGIN=""
fi

PAGES_ORIGIN="$PAGES_ORIGIN" MODE_OVERRIDE="$MODE_OVERRIDE" HOSTNAME_OVERRIDE="$HOSTNAME_OVERRIDE" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

const file = '.env';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const values = new Map();

for (const line of lines) {
  if (!line || line.trim().startsWith('#')) continue;
  const index = line.indexOf('=');
  if (index < 0) continue;
  values.set(line.slice(0, index), line.slice(index + 1));
}

const set = (key, value) => values.set(key, value);

const token = values.get('GATEWAY_ACCESS_TOKEN') || '';
if (!token || token === 'replace-with-a-long-random-token') {
  set('GATEWAY_ACCESS_TOKEN', crypto.randomBytes(32).toString('hex'));
}

const localOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:8787',
  'http://localhost:8787'
];
const configuredOrigins = (values.get('ALLOWED_ORIGINS') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .filter((item) => !item.includes('YOUR_GITHUB_USER'));
if (process.env.PAGES_ORIGIN) {
  configuredOrigins.push(process.env.PAGES_ORIGIN);
}
set(
  'ALLOWED_ORIGINS',
  [...new Set([...localOrigins, ...configuredOrigins])].join(',')
);

set('HOST', values.get('HOST') || '127.0.0.1');
set('PORT', values.get('PORT') || '8787');
set('DATA_DIR', values.get('DATA_DIR') || '../../.data');
set('RUNTIME', values.get('RUNTIME') || 'codex');
set('CODEX_BIN', values.get('CODEX_BIN') || 'codex');
set('CODEX_MODEL', values.get('CODEX_MODEL') || '');
set('WEB_DIST_DIR', values.get('WEB_DIST_DIR') || '');
set(
  'CLOUDFLARE_TUNNEL_NAME',
  values.get('CLOUDFLARE_TUNNEL_NAME') || 'effective-workspace'
);

if (process.env.MODE_OVERRIDE) {
  set('TUNNEL_MODE', process.env.MODE_OVERRIDE);
} else if (!values.get('TUNNEL_MODE')) {
  set('TUNNEL_MODE', 'quick');
}

if (process.env.HOSTNAME_OVERRIDE) {
  set('CLOUDFLARE_HOSTNAME', process.env.HOSTNAME_OVERRIDE);
} else if (!values.has('CLOUDFLARE_HOSTNAME')) {
  set('CLOUDFLARE_HOSTNAME', '');
}

const preferredOrder = [
  'HOST',
  'PORT',
  'DATA_DIR',
  'GATEWAY_ACCESS_TOKEN',
  'ALLOWED_ORIGINS',
  'RUNTIME',
  'CODEX_BIN',
  'CODEX_MODEL',
  'WEB_DIST_DIR',
  'TUNNEL_MODE',
  'CLOUDFLARE_TUNNEL_NAME',
  'CLOUDFLARE_HOSTNAME'
];

const output = [];
for (const key of preferredOrder) {
  if (values.has(key)) {
    output.push(`${key}=${values.get(key)}`);
    values.delete(key);
  }
}
for (const [key, value] of values) {
  output.push(`${key}=${value}`);
}

fs.writeFileSync(file, output.join('\n') + '\n');
NODE

set -a
# shellcheck disable=SC1091
source .env
set +a

echo
echo "Installing project dependencies..."
pnpm install --no-frozen-lockfile

echo
echo "Building project..."
pnpm build

echo
echo "Initializing local SQLite database..."
pnpm db:init

if [[ "${TUNNEL_MODE:-quick}" == "named" ]]; then
  if [[ -z "${CLOUDFLARE_HOSTNAME:-}" ]]; then
    echo "CLOUDFLARE_HOSTNAME is required for named tunnel mode." >&2
    exit 1
  fi

  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    echo
    echo "Cloudflare authentication is required for a named tunnel."
    cloudflared tunnel login
  fi

  TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-effective-workspace}"
  TUNNEL_ID="$(
    cloudflared tunnel list 2>/dev/null |
      awk -v name="$TUNNEL_NAME" 'NR > 1 && $2 == name { print $1; exit }'
  )"

  if [[ -z "$TUNNEL_ID" ]]; then
    echo
    echo "Creating Cloudflare tunnel: $TUNNEL_NAME"
    CREATE_OUTPUT="$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)"
    printf '%s\n' "$CREATE_OUTPUT"
    TUNNEL_ID="$(
      printf '%s\n' "$CREATE_OUTPUT" |
        grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' |
        tail -1
    )"
  fi

  if [[ -z "$TUNNEL_ID" ]]; then
    echo "Could not determine Cloudflare tunnel UUID." >&2
    exit 1
  fi

  mkdir -p .cloudflared
  CREDENTIALS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
  cat > .cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

ingress:
  - hostname: ${CLOUDFLARE_HOSTNAME}
    service: http://127.0.0.1:${PORT:-8787}
  - service: http_status:404
EOF

  echo
  echo "Creating/updating DNS route for ${CLOUDFLARE_HOSTNAME}..."
  if ! cloudflared tunnel route dns "$TUNNEL_ID" "$CLOUDFLARE_HOSTNAME"; then
    echo "DNS route command reported an error. If the hostname already points to this tunnel, you can continue."
  fi

  cloudflared tunnel --config "$ROOT/.cloudflared/config.yml" ingress validate

  echo
  echo "Named tunnel configured:"
  echo "  https://${CLOUDFLARE_HOSTNAME}"
else
  echo
  echo "Quick Tunnel mode configured."
  echo "A temporary https://*.trycloudflare.com URL will be printed when the app starts."
fi

echo
echo "Local data directory: $ROOT/.data"
if [[ -n "$PAGES_ORIGIN" ]]; then
  echo "GitHub Pages origin allowed by CORS: $PAGES_ORIGIN"
fi

if (( START_AFTER_SETUP == 1 )); then
  echo
  echo "Starting Effective Workspace..."
  exec bash "$ROOT/scripts/start.sh"
else
  echo
  echo "Setup complete. Start later with:"
  echo "  pnpm start:remote"
fi
