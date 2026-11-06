#!/usr/bin/env bash
# Runs every server and Android check and prints a pass/fail table. Exit code is 1 if anything failed.
#   bash scripts/check.sh            all checks
#   SKIP_ANDROID=1 bash scripts/check.sh   server only
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/server/logs"
mkdir -p "$LOG_DIR"

NAMES=(); RESULTS=(); SECONDS_TAKEN=()

run() { # run "<label>" "<dir>" <command...>
  local label="$1" dir="$2"; shift 2
  local log="$LOG_DIR/check-$(echo "$label" | tr -c 'A-Za-z0-9' '-').log"
  printf '==> %s ...\n' "$label"
  local start=$SECONDS
  if (cd "$dir" && "$@") >"$log" 2>&1; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); fi
  NAMES+=("$label"); SECONDS_TAKEN+=("$((SECONDS - start))s")
  [ "${RESULTS[-1]}" = "FAIL" ] && printf '    failed, see %s\n' "$log"
}

[ -d "$ROOT/server/node_modules" ] || (cd "$ROOT/server" && npm install >/dev/null 2>&1)
run "Server lint"  "$ROOT/server" npm run lint
run "Server tests" "$ROOT/server" npm test
run "Server build" "$ROOT/server" npm run build
if [ "${SKIP_ANDROID:-0}" != "1" ]; then
  # preview-android.sh writes app/local.properties; make sure the SDK location exists for Gradle
  run "Android unit tests" "$ROOT/app" ./gradlew test --console=plain
  run "Android lint"       "$ROOT/app" ./gradlew lint --console=plain
fi

echo
printf '%-24s %-6s %s\n' "CHECK" "RESULT" "TIME"
printf '%-24s %-6s %s\n' "------------------------" "------" "------"
FAILED=0
for i in "${!NAMES[@]}"; do
  printf '%-24s %-6s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${SECONDS_TAKEN[$i]}"
  [ "${RESULTS[$i]}" = "FAIL" ] && FAILED=1
done
echo
[ "$FAILED" = "0" ] && echo "All checks passed." || echo "Some checks failed. Logs are in server/logs/check-*.log"
exit "$FAILED"
