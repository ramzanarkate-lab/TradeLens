#!/usr/bin/env bash
# Checks that your PC is ready to deploy. Run it on YOUR PC:  bash deploy/preflight.sh
# Prints PASS or FAIL for each check, with the fix for each FAIL. Never prints any value from deploy.env.
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-pc.sh
source "$DEPLOY_DIR/lib-pc.sh"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n      Fix: %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

# 1. bash
if [ -n "${BASH_VERSION:-}" ]; then pass "bash is available (version $BASH_VERSION)"
else fail "bash is not available" "run this script with bash (in VS Code use the Git Bash terminal)"; fi

# 2. ssh and scp
for tool in ssh scp; do
  if command -v "$tool" >/dev/null 2>&1; then pass "$tool is available"
  else fail "$tool is not available" "install Git for Windows (includes ssh and scp) or Windows OpenSSH Client, then reopen the terminal"; fi
done
command -v rsync >/dev/null 2>&1 && pass "rsync is available (faster uploads)" || echo "INFO  rsync not found: uploads will use scp -r (slower, still works)"

# 3. settings file and values (loaded in this shell, so the later checks can use them)
LOADLOG="$(mktemp)"
trap 'rm -f "$LOADLOG"' EXIT
if load_deploy_env >"$LOADLOG" 2>&1; then
  pass "deploy/deploy.env is set (VM_HOST, VM_USER, SSH_KEY_PATH)"
else
  fail "deploy/deploy.env: $(head -1 "$LOADLOG")" "copy deploy/deploy.env.example to deploy/deploy.env and fill in VM_HOST, VM_USER and SSH_KEY_PATH"
fi

# 4. VM_HOST
if [ -n "${VM_HOST:-}" ] && [ "${VM_HOST:-}" != "PUBLIC_IP_OF_THE_VM" ]; then pass "VM_HOST is set"
else fail "VM_HOST is not set" "put the Oracle VM's public IP in VM_HOST in deploy/deploy.env"; fi

# 5. key
if [ -z "${SSH_KEY_PATH:-}" ]; then
  fail "SSH_KEY_PATH is not set" "put the path to your private key in SSH_KEY_PATH in deploy/deploy.env"
elif [ ! -f "$SSH_KEY_PATH" ]; then
  fail "SSH key not found at $SSH_KEY_PATH" "download the key from Oracle (or find your .key file) and set SSH_KEY_PATH in deploy/deploy.env"
elif [ -n "$(key_mode)" ] && [ "$(key_mode)" != "600" ] && [ "$(key_mode)" != "400" ]; then
  fail "SSH key permissions are $(key_mode) (must be 600 or 400)" "chmod 600 \"$SSH_KEY_PATH\""
else
  pass "SSH key exists with correct permissions"
fi

# 6. VM answers on port 22
if [ -n "${VM_HOST:-}" ] && [ "${VM_HOST:-}" != "PUBLIC_IP_OF_THE_VM" ]; then
  # 6-second limit so an unreachable IP does not hang the script
  if timeout 6 bash -c "exec 3<>/dev/tcp/$VM_HOST/22" 2>/dev/null; then pass "the VM answers on port 22"
  else fail "the VM does not answer on port 22" "check that the VM is running, VM_HOST is the public IP, and the Oracle security list allows TCP 22"; fi
else
  fail "cannot test port 22 without VM_HOST" "set VM_HOST first"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "All checks passed. Next: bash deploy/first-run.sh"; else echo "$FAILS check(s) failed. Fix them and run this script again."; exit 1; fi
