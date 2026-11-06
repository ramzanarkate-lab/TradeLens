#!/usr/bin/env bash
# Shared helpers for the scripts that run on YOUR PC (deploy.sh, first-run.sh, preflight.sh). Source it, do not run it.
# The caller must set DEPLOY_DIR (the folder of the calling script) before sourcing this file.
#
# Variables read from deploy/deploy.env:
#   VM_HOST       the Oracle VM's public IP
#   VM_USER       login user on the VM (default: ubuntu)
#   SSH_KEY_PATH  path to the private key file

ROOT="$(dirname "$DEPLOY_DIR")"

# Reads deploy/deploy.env (Windows line endings are tolerated). Sets VM_HOST, VM_USER, SSH_KEY_PATH.
# Returns 1 and prints a message if the file or a value is missing; never prints any value from the file.
load_deploy_env() {
  local file="$DEPLOY_DIR/deploy.env"
  if [ ! -f "$file" ]; then
    echo "deploy/deploy.env is missing. Copy deploy/deploy.env.example to deploy/deploy.env and fill it in."
    return 1
  fi
  # shellcheck disable=SC1090
  source <(tr -d '\r' < "$file")
  VM_USER="${VM_USER:-ubuntu}"
  SSH_KEY_PATH="${SSH_KEY_PATH:-}"
  SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}" # expand a leading ~
  if [ -z "${VM_HOST:-}" ] || [ "$VM_HOST" = "PUBLIC_IP_OF_THE_VM" ]; then
    echo "VM_HOST is not set in deploy/deploy.env. Put the Oracle VM's public IP there."
    return 1
  fi
  if [ -z "$SSH_KEY_PATH" ]; then
    echo "SSH_KEY_PATH is not set in deploy/deploy.env. Put the path to your private key there."
    return 1
  fi
  return 0
}

# Prints the key's permission digits (e.g. 600), or nothing if they cannot be read or cannot be checked.
# On Windows (Git Bash) chmod does not change what stat reports and ssh uses Windows file permissions, so nothing is printed there.
key_mode() {
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  stat -c '%a' "$SSH_KEY_PATH" 2>/dev/null || stat -f '%Lp' "$SSH_KEY_PATH" 2>/dev/null || true
}

# Exits 1 (via return 1) with the exact fix if the key is missing or has loose permissions.
check_key() {
  if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "SSH key not found at $SSH_KEY_PATH. Check SSH_KEY_PATH in deploy/deploy.env."
    return 1
  fi
  local mode
  mode="$(key_mode)"
  if [ -n "$mode" ] && [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    echo "SSH key permissions are $mode, they must be 600 or 400. Fix with:"
    echo "  chmod 600 \"$SSH_KEY_PATH\""
    return 1
  fi
  return 0
}

# Loads the settings and checks the key; stops the calling script on any problem.
require_vm_access() {
  load_deploy_env || exit 1
  check_key || exit 1
  SSH_OPTS=(-i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new)
  SSH=(ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST")
}

# Copies the deploy folder to a temporary folder without anything private (deploy.env, keys).
stage_deploy_dir() { # target_dir
  mkdir -p "$1/deploy"
  tar -C "$DEPLOY_DIR" --exclude='deploy.env' --exclude='*.key' --exclude='*.pem' -cf - . | tar -C "$1/deploy" -xf -
}

# Uploads a local folder's contents to a folder on the VM. Uses rsync when it exists, otherwise scp -r.
upload_dir() { # local_dir remote_dir
  if command -v rsync >/dev/null 2>&1; then
    rsync -az --delete -e "ssh -i '$SSH_KEY_PATH' -o StrictHostKeyChecking=accept-new" "$1/" "$VM_USER@$VM_HOST:$2/"
  else
    echo "Note: rsync is not installed here, using scp -r instead (it copies everything every time)."
    "${SSH[@]}" "rm -rf '$2' && mkdir -p '$2'"
    scp -r "${SSH_OPTS[@]}" "$1/." "$VM_USER@$VM_HOST:$2/"
  fi
}
