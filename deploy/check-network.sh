#!/usr/bin/env bash
# Checks that port 4000 can be reached from outside. Run it on the Oracle VM:  bash deploy/check-network.sh
# Never prints the contents of any .env file.
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /opt/tradelens/deploy)" # this script's own folder (works from ~/deploy or /opt/tradelens/deploy)
PORT=4000
PROBLEMS=0

echo "==> Firewall (ufw)"
if command -v ufw >/dev/null 2>&1; then
  if sudo ufw status | grep -Eq "^${PORT}/tcp +ALLOW"; then echo "OK: ufw allows ${PORT}/tcp"
  else echo "PROBLEM: ufw does not allow ${PORT}/tcp. Run: sudo ufw allow ${PORT}/tcp"; PROBLEMS=$((PROBLEMS + 1)); fi
else
  echo "ufw is not installed (run deploy/setup-server.sh)"; PROBLEMS=$((PROBLEMS + 1))
fi

echo
echo "==> iptables"
if sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then echo "OK: iptables accepts ${PORT}/tcp"
else echo "PROBLEM: no iptables ACCEPT rule for ${PORT}/tcp (Oracle images need one). Run deploy/setup-server.sh"; PROBLEMS=$((PROBLEMS + 1)); fi

echo
echo "==> Is the server listening on 0.0.0.0:${PORT}?"
LISTEN=$(ss -ltnp 2>/dev/null | grep -E "[:.]${PORT}\b" || true)
if [ -z "$LISTEN" ]; then
  echo "PROBLEM: nothing is listening on ${PORT}. Run: bash deploy/status.sh"; PROBLEMS=$((PROBLEMS + 1))
else
  echo "$LISTEN"
  if echo "$LISTEN" | grep -Eq "(0\.0\.0\.0|\*|\[::\]):${PORT}"; then echo "OK: listening on all interfaces"
  else echo "PROBLEM: listening only on localhost; the server must listen on 0.0.0.0"; PROBLEMS=$((PROBLEMS + 1)); fi
fi

echo
echo "==> Public IP"
IP=$(curl -s -m 8 https://ifconfig.me || true)
echo "${IP:-unknown (could not reach ifconfig.me)}"

cat <<MSG

==> Oracle Cloud console (the VM firewall is not the only one). Confirm this rule exists:
    Networking > Virtual Cloud Networks > your VCN > Security Lists > Default Security List > Ingress Rules:
      Stateless: No | Source CIDR: 0.0.0.0/0 | IP Protocol: TCP | Destination Port Range: ${PORT}
    (also check Network Security Groups if the VM's VNIC uses one)

==> From YOUR PC, run:
    curl -i http://${IP:-PUBLIC_IP}:${PORT}/health
    A reply with "HTTP/1.1 200 OK" means everything is open. If it hangs, the Oracle ingress rule above is missing.
MSG

[ "$PROBLEMS" -eq 0 ] && echo && echo "Local checks passed." || { echo; echo "$PROBLEMS local problem(s) found above."; exit 1; }
