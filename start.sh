#!/usr/bin/env bash
# One-step local start on macOS/Linux: installs dependencies, creates demo data, starts https://localhost:3000
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this script again." >&2
  exit 1
fi
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" || {
  echo "Node.js 22.13 or newer is required (you have $(node --version)). Install the LTS version from https://nodejs.org" >&2
  exit 1
}

[[ -d node_modules ]] || npm install --no-audit --no-fund
[[ -f .env ]] || cp .env.development.example .env
npm run seed

cat <<'MSG'

  Opening https://localhost:3000
  The browser will warn about the self-signed certificate: choose "Advanced" → "Proceed to localhost".
  Admin: admin@example.org / Password1   ·   User: noa@example.org / Password1
  E-mails are saved in data/outbox. Press Ctrl+C to stop.

MSG
( sleep 3; { command -v open >/dev/null && open https://localhost:3000; } || { command -v xdg-open >/dev/null && xdg-open https://localhost:3000; } || true ) >/dev/null 2>&1 &
exec npm run dev
