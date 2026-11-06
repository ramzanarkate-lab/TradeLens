#!/usr/bin/env bash
# Deploys the TradeLens server to the Oracle VM. Run it on YOUR PC, from the project root or from inside deploy/:
#   bash deploy/deploy.sh
# Reads VM_HOST, VM_USER and SSH_KEY_PATH from deploy/deploy.env (git-ignored). Never prints any .env contents.
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-pc.sh
source "$DEPLOY_DIR/lib-pc.sh"
require_vm_access
SERVER_DIR="$ROOT/server"
[ -f "$SERVER_DIR/package.json" ] || { echo "Cannot find the server folder at $SERVER_DIR"; exit 1; }

echo "==> Building the server locally"
(cd "$SERVER_DIR" && npm ci && npm run build)

echo "==> Preparing the upload (no .env, data or logs are included)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server"
cp -r "$SERVER_DIR/dist" "$SERVER_DIR/config" "$SERVER_DIR/package.json" "$SERVER_DIR/package-lock.json" "$STAGE/server/"
stage_deploy_dir "$STAGE"

echo "==> Uploading to $VM_USER@$VM_HOST"
upload_dir "$STAGE" /tmp/tradelens-upload
"${SSH[@]}" 'sudo mkdir -p /opt/tradelens/server \
  && sudo rm -rf /opt/tradelens/server/dist /opt/tradelens/deploy \
  && sudo cp -r /tmp/tradelens-upload/server/. /opt/tradelens/server/ \
  && sudo cp -r /tmp/tradelens-upload/deploy /opt/tradelens/deploy \
  && rm -rf /tmp/tradelens-upload'

echo "==> Preparing the VM (first run installs everything; later runs change nothing that exists)"
"${SSH[@]}" 'bash /opt/tradelens/deploy/setup-server.sh'
"${SSH[@]}" 'sudo chown -R tradelens:tradelens /opt/tradelens && cd /opt/tradelens/server && sudo -u tradelens npm ci --omit=dev --no-audit --no-fund'
"${SSH[@]}" 'sudo chmod 600 /opt/tradelens/server/.env && sudo chown tradelens:tradelens /opt/tradelens/server/.env'

echo "==> Which market providers work from the server?"
if ! "${SSH[@]}" 'bash /opt/tradelens/deploy/check-market.sh'; then
  echo
  echo "No market provider reachable from this server. Run check-market.sh output in VS Code Claude for next steps."
  exit 1
fi

echo "==> Restarting the service"
"${SSH[@]}" 'sudo systemctl daemon-reload && (sudo systemctl enable tradelens-server >/dev/null 2>&1 || true) && sudo systemctl restart tradelens-server'

echo "==> Health check (10 tries)"
for i in $(seq 1 10); do
  if BODY=$("${SSH[@]}" 'curl -fsS -m 5 http://localhost:4000/health' 2>/dev/null); then
    echo "$BODY"
    PROVIDER=$(echo "$BODY" | sed -n 's/.*"provider":"\([^"]*\)".*/\1/p')
    if echo "$BODY" | grep -q '"market":{"status":"Live"'; then
      echo "OK: the server is up, the feed is Live, provider: ${PROVIDER:-unknown}"
      echo "From your PC: curl -i http://$VM_HOST:4000/health"
      exit 0
    fi
  fi
  echo "  attempt $i/10: not ready yet"
  sleep 4
done
echo "The server did not become healthy. On the VM run: bash /opt/tradelens/deploy/status.sh"
exit 1
