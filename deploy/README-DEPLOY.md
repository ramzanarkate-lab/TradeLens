# Run TradeLens online all the time (Oracle Cloud free Ubuntu VM)

The server runs as a systemd service (`tradelens-server`) in `/opt/tradelens`, restarts by itself after a crash or reboot,
and listens on port 4000.

## What goes where
| Where | What |
|---|---|
| PC | `deploy/deploy.env` (SSH details, git-ignored), the project |
| VM | `/opt/tradelens/server` (code), `/opt/tradelens/server/.env` (secrets, mode 600, owner `tradelens`), `/opt/tradelens/logs/server.log` |

Secrets (JWT secret, Telegram token and channel ID, Google client ID) live **only** in `/opt/tradelens/server/.env` on the VM. Never put them in Git.

## Steps
1. **Create the VM** (Oracle "Always Free", Ubuntu). Add an ingress rule in the Oracle console: TCP **4000** from `0.0.0.0/0`
   (Networking > Virtual Cloud Networks > your VCN > Security Lists > Default Security List > Add Ingress Rules).
2. **On your PC**: copy `deploy/deploy.env.example` to `deploy/deploy.env` and fill in `VM_HOST` (the VM's public IP), `VM_USER` (ubuntu) and `SSH_KEY_PATH` (path to your private key, permissions 600). Then run `bash deploy/preflight.sh`; it prints PASS or FAIL with the fix for each check.
3. **Copy the scripts to the VM once** with `bash deploy/first-run.sh` (it never copies `deploy.env` or keys), log in, and look at the network:
   a. `bash deploy/check-market.sh` shows which market providers work from the VM.
   b. `bash deploy/check-network.sh` checks ufw, iptables and the listening port, and prints your public IP.
4. **On your PC**: `bash deploy/deploy.sh`. It builds the server, uploads it, runs `setup-server.sh` on the VM (Node.js, `tradelens` user,
   firewall, `.env` created only if missing), runs `check-market.sh` and stops if no provider is reachable, restarts the service, and checks `/health` (10 tries).
5. **On the VM**: `bash /opt/tradelens/deploy/status.sh` shows the service status, logs, `/health` and the active market provider.
6. **From your PC**: `curl -i http://PUBLIC_IP:4000/health` should return `200 OK` with `"market":{"status":"Live","provider":"..."}`.
7. **In the app**: Settings > Server URL = `http://PUBLIC_IP:4000`, then Test connection. For a release build set `SERVER_URL=http://PUBLIC_IP:4000` in `app/local.properties`.

Market data: `MARKET_PROVIDER=auto` (default) starts with the first of Binance, Bybit, OKX, Kraken that answers and switches by itself
if one is blocked (3 failures in a row). Admins can see the provider and the last errors at `GET /api/diagnostics`.

## Troubleshooting
**Health check times out** (`curl http://PUBLIC_IP:4000/health` hangs)
: The port is blocked. Check the Oracle security list ingress rule (TCP 4000 from 0.0.0.0/0) and `sudo ufw status` on the VM. `bash deploy/check-network.sh` checks the VM side.

**Service not running**
: Run `bash /opt/tradelens/deploy/status.sh`. It prints the systemctl status, the journal, the server log and the `/health` result. A missing `JWT_SECRET` or a bad value in `.env` is reported at the top of the journal.

**Binance blocked (HTTP 451 or 403)**
: Run `bash deploy/check-market.sh`, then set `MARKET_PROVIDER` in `/opt/tradelens/server/.env` to the provider that shows OK (or leave `auto`) and run `sudo systemctl restart tradelens-server`.

**Live prices empty in the app**
: Confirm the app's Server URL is `http://PUBLIC_IP:4000` (Settings > Server URL > Test connection), and that `/health` shows `"market":{"status":"Live"}`.

## Optional: Docker and HTTPS
`docker-compose.yml` and `Caddyfile` are an alternative that runs the same server in Docker with automatic HTTPS (needs a domain). The systemd setup above does not need them.
