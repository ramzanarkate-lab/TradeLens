#!/usr/bin/env bash
# One-time (and safe to repeat) setup of the Ubuntu Oracle VM. Run it ON the VM:
#   bash setup-server.sh        (or from your PC:  ssh -i KEY ubuntu@IP 'bash -s' < deploy/setup-server.sh)
# Installs Node.js, creates the tradelens user and folders, opens the firewall, installs the systemd service.
# Never prints the contents of any .env file.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /opt/tradelens/deploy)" # this script's own folder
APP=/opt/tradelens
SERVICE_SRC="$DEPLOY_DIR/tradelens-server.service"
[ -f "$SERVICE_SRC" ] || SERVICE_SRC=/opt/tradelens/deploy/tradelens-server.service

echo "==> Node.js 22 (skipped if Node 20+ is installed)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y curl openssl >/dev/null

echo "==> User and folders"
id tradelens >/dev/null 2>&1 || sudo useradd --system --home "$APP" --shell /usr/sbin/nologin tradelens
sudo install -d -o tradelens -g tradelens -m 755 "$APP" "$APP/server" "$APP/logs" "$APP/deploy"

echo "==> Firewall (ufw)"
sudo ufw allow OpenSSH
sudo ufw allow 4000/tcp
sudo ufw --force enable

echo "==> iptables (Oracle images block everything but SSH until this rule exists)"
sudo iptables -C INPUT -p tcp --dport 4000 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 4000 -j ACCEPT
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | sudo debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
sudo netfilter-persistent save

echo "==> Server environment file (created only if missing)"
ENV_FILE="$APP/server/.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "NODE_ENV=production"
    echo "PORT=4000"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ADMIN_USER_IDS="
    echo "GOOGLE_WEB_CLIENT_ID="
    echo "MARKET_PROVIDER=auto"
    echo "MARKET_STREAM=poll"
    echo "TELEGRAM_ENABLED=false"
    echo "TELEGRAM_TIMEZONE=Asia/Riyadh"
  } | sudo tee "$ENV_FILE" >/dev/null
  echo "Created $ENV_FILE with a new random JWT_SECRET (not shown)."
else
  echo "$ENV_FILE already exists: left unchanged."
fi
sudo chown tradelens:tradelens "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

echo "==> systemd service"
if [ -f "$SERVICE_SRC" ]; then
  sudo cp "$SERVICE_SRC" /etc/systemd/system/tradelens-server.service
  sudo systemctl daemon-reload
  sudo systemctl enable tradelens-server
else
  echo "tradelens-server.service not found in $DEPLOY_DIR; deploy.sh installs it."
fi

cat <<'MSG'

==> ALSO REQUIRED in the Oracle Cloud console (the VM firewall is not the only one):
    Networking > Virtual Cloud Networks > your VCN > Security Lists > Default Security List > Add Ingress Rule:
      Source CIDR 0.0.0.0/0 | IP Protocol TCP | Destination Port Range 4000

Next: from your PC run  bash deploy/deploy.sh
MSG
