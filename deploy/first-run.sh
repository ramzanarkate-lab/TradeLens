#!/usr/bin/env bash
# Copies the deploy/ folder to the VM's home folder (~/deploy) so you can run the check scripts there.
# Run it on YOUR PC, from the project root or from inside deploy/:  bash deploy/first-run.sh
# deploy.env, keys and .pem files are never copied.
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-pc.sh
source "$DEPLOY_DIR/lib-pc.sh"
require_vm_access

echo "==> Copying deploy/ to $VM_USER@$VM_HOST:~/deploy"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
stage_deploy_dir "$STAGE"
if command -v rsync >/dev/null 2>&1; then
  upload_dir "$STAGE/deploy" deploy
else
  echo "Note: rsync is not installed here, using scp -r instead."
  "${SSH[@]}" 'rm -rf ~/deploy'
  scp -r "${SSH_OPTS[@]}" "$STAGE/deploy" "$VM_USER@$VM_HOST:~/"
fi
"${SSH[@]}" 'chmod +x ~/deploy/*.sh'

cat <<MSG

Done. Now log in to the VM and run the checks there:

  ssh -i "$SSH_KEY_PATH" $VM_USER@$VM_HOST
  bash ~/deploy/check-market.sh
  bash ~/deploy/check-network.sh

Then, back on your PC:  bash deploy/deploy.sh
MSG
