#!/usr/bin/env bash
# Shows the state of the TradeLens server. Run it on the Oracle VM:  bash deploy/status.sh
# Never prints the contents of any .env file.
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /opt/tradelens/deploy)" # this script's own folder (works from ~/deploy or /opt/tradelens/deploy)

echo "==> systemctl status"
sudo systemctl status tradelens-server --no-pager --lines=0 || true
echo "==> enabled at boot: $(systemctl is-enabled tradelens-server 2>&1 || true)"

echo
echo "==> Last 30 lines of the journal"
sudo journalctl -u tradelens-server -n 30 --no-pager || true

echo
echo "==> Last 20 lines of /opt/tradelens/logs/server.log"
sudo tail -n 20 /opt/tradelens/logs/server.log 2>/dev/null || echo "(no log file yet)"

echo
echo "==> curl localhost:4000/health"
BODY=$(curl -s -m 8 http://localhost:4000/health || true)
if [ -z "$BODY" ]; then
  echo "No answer. The service is not running or not listening yet."
  exit 1
fi
echo "$BODY"

echo
PROVIDER=$(echo "$BODY" | sed -n 's/.*"provider":"\([^"]*\)".*/\1/p')
FEED=$(echo "$BODY" | sed -n 's/.*"market":{"status":"\([^"]*\)".*/\1/p')
echo "Active market provider: ${PROVIDER:-unknown}"
echo "Market feed status:     ${FEED:-unknown}"
[ "$FEED" = "Live" ] || { echo "The feed is not Live. Run: bash deploy/check-market.sh"; exit 1; }
