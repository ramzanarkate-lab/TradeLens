#!/usr/bin/env bash
# Confirms bash works in this terminal and that the deploy scripts are where they should be. Changes nothing.
echo "bash version: ${BASH_VERSION}"
echo "current folder: $(pwd)"
for f in deploy/deploy.sh deploy/check-market.sh deploy/status.sh; do
  if [ -f "$f" ]; then echo "found:   $f"; else echo "MISSING: $f (run this from the project root)"; fi
done
