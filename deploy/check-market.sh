#!/usr/bin/env bash
# Tests which market data providers answer from THIS machine (run it on the Oracle VM):  bash deploy/check-market.sh
# Prints OK or the HTTP status for each REST endpoint, tests the Binance WebSocket upgrade (101 or blocked), and ends with
# a summary table that includes the value to use for MARKET_PROVIDER.
# Exit code: 0 if at least one REST provider works, 1 if none does. Uses only curl, needs no keys, writes nothing.
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /opt/tradelens/deploy)" # this script's own folder (works from ~/deploy or /opt/tradelens/deploy)

TIMEOUT=8

rest_check() { # url, text that a good answer contains
  local out code body
  out=$(curl -s -m "$TIMEOUT" -w '\n%{http_code}' "$1" 2>/dev/null) || { echo "unreachable"; return; }
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" = "200" ] && echo "$body" | grep -q "$2"; then echo "OK"; else echo "HTTP $code"; fi
}

ws_check() { # HTTP upgrade to a WebSocket host
  local code
  code=$(curl -s -m "$TIMEOUT" -i --http1.1 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$1" -o /dev/null -w '%{http_code}' 2>/dev/null) || true
  case "$code" in
    101) echo "101 OK" ;;
    000|"") echo "blocked (no answer)" ;;
    *) echo "blocked (HTTP $code)" ;;
  esac
}

echo "Testing from public IP: $(curl -s -m 5 https://ifconfig.me 2>/dev/null || echo unknown)"
echo
echo "==> REST"
BINANCE=$(rest_check "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1" '^\[\[');            echo "Binance: $BINANCE"
BYBIT=$(rest_check   "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=1" '"retCode":0'); echo "Bybit:   $BYBIT"
OKX=$(rest_check     "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=1" '"code":"0"');       echo "OKX:     $OKX"
KRAKEN=$(rest_check  "https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=60" '"error":\[\]');                 echo "Kraken:  $KRAKEN"

echo
echo "==> WebSocket (Binance only; the server polls by default, so this is optional)"
BINANCE_WS=$(ws_check "https://stream.binance.com:9443/ws/btcusdt@kline_1m"); echo "Binance: $BINANCE_WS"

echo
echo "==> Summary"
printf '%-10s %-14s %s\n' PROVIDER STATUS "MARKET_PROVIDER"
printf '%-10s %-14s %s\n' ---------- -------------- ---------------
WORKING=0
FIRST=""
row() { # name status value
  local value="-"
  if [ "$2" = "OK" ]; then value="$3"; WORKING=$((WORKING + 1)); [ -z "$FIRST" ] && FIRST="$3"; fi
  printf '%-10s %-14s %s\n' "$1" "$2" "$value"
}
row Binance "$BINANCE" binance
row Bybit   "$BYBIT"   bybit
row OKX     "$OKX"     okx
row Kraken  "$KRAKEN"  kraken
printf '%-10s %-14s %s\n' "Binance WS" "$BINANCE_WS" "(MARKET_STREAM=websocket only)"
echo
if [ "$WORKING" -gt 0 ]; then
  echo "$WORKING of 4 REST providers work. Recommended: MARKET_PROVIDER=auto (starts with $FIRST and switches if one gets blocked)."
  echo "To force one, set MARKET_PROVIDER=$FIRST in /opt/tradelens/server/.env and restart the service."
  exit 0
fi
echo "No REST provider answered. Check the VM's outbound internet access: curl -I https://example.com"
exit 1
