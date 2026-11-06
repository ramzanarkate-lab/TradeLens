#!/usr/bin/env bash
# Start the server in the background, then preview the Android app.
#   TRADELENS_SEED=1 bash scripts/dev.sh   -> runs `npm run seed` first and serves the sample data (offline demo)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/server/logs"

cd "$ROOT/server"
[ -d node_modules ] || { echo "==> Installing server dependencies..."; npm install; }
# TRADELENS_SEED=1 makes sample data first and runs the server offline on it (no Binance needed).
if [ "${TRADELENS_SEED:-0}" = "1" ]; then
  echo "==> Seeding sample data (TRADELENS_SEED=1)..."
  npm run seed || { echo "Seeding failed"; exit 1; }
  export DEMO_MODE=true
fi
echo "==> Starting server (logs: server/logs/server.log)..."
npm run dev > "$ROOT/server/logs/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  echo "==> Stopping server (pid $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  # npm spawns children; clean them up where possible
  pkill -P "$SERVER_PID" 2>/dev/null || true
  command -v taskkill >/dev/null 2>&1 && taskkill //F //T //PID "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$ROOT/scripts/preview-android.sh"
