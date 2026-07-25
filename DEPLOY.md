# Deploy to Oracle Cloud ARM VM

Target: `alan-holdem.duckdns.org` on `217.142.252.51` (Ubuntu 22.04 ARM).
Coexists with the trade-bot systemd service (no port conflicts — trade-bot doesn't listen on any port).

---

## 0. Prerequisites (do this once)

### 0.1 OCI Security List — open 80 / 443

Oracle Cloud console → Networking → VCN → `trade-vcn` → Security Lists → default → Add Ingress Rules:

| Source CIDR | Protocol | Destination Port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |
| 0.0.0.0/0 | UDP | 443 (for HTTP/3) |

Without this the VM won't receive traffic even if the host firewall is open.

### 0.2 Google OAuth — add prod redirect URI

Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client → Edit:

- **Authorized JavaScript origins**: add `https://alan-holdem.duckdns.org`
- **Authorized redirect URIs**: add `https://alan-holdem.duckdns.org/api/auth/callback/google`

Save. Keep the existing `http://localhost:3000` entries for dev.

### 0.3 First DuckDNS ping (from any machine)

```bash
curl "https://www.duckdns.org/update?domains=alan-holdem&token=32f4f4bf-e479-4e3b-abba-a5f139123413&ip=217.142.252.51"
```

Should return `OK`. Verify with `dig alan-holdem.duckdns.org` — should show `217.142.252.51`. The `duckdns` container in compose will keep this fresh.

---

## 1. SSH to the VM

```bash
ssh -i ~/.ssh/id_rsa ubuntu@217.142.252.51
```

### 1.1 Install Docker (once)

```bash
# Docker Engine + compose plugin (official Docker script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for the group change (or `newgrp docker`)
exit
```

Reconnect, then:

```bash
docker --version
docker compose version
```

### 1.2 Open host firewall (if UFW is enabled)

```bash
sudo ufw status
# If active:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
```

If UFW isn't installed / active, skip. iptables from OCI's default image usually just permits everything.

---

## 2. Transfer the repo

From local Windows PowerShell (project root `D:\Alan\project\Holdem`):

```powershell
# Package current state (excludes node_modules, .next, etc.)
git archive --format=tar HEAD | gzip > holdem.tar.gz
scp -i $HOME/.ssh/id_rsa holdem.tar.gz ubuntu@217.142.252.51:~/
```

If not using git (uncommitted changes), use plain tar excluding heavy dirs:

```powershell
tar --exclude=node_modules --exclude=.next --exclude=.git -czf holdem.tar.gz .
scp -i $HOME/.ssh/id_rsa holdem.tar.gz ubuntu@217.142.252.51:~/
```

On VM:

```bash
mkdir -p ~/Holdem
tar xzf ~/holdem.tar.gz -C ~/Holdem
cd ~/Holdem
```

---

## 3. Create `.env.prod` on VM

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
nano .env.prod
```

Fill in real values:

- `POSTGRES_PASSWORD` — generate: `openssl rand -hex 24`
- `NEXTAUTH_SECRET` — generate: `openssl rand -base64 48`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console (Section 0.2)
- `DUCKDNS_TOKEN` — `32f4f4bf-e479-4e3b-abba-a5f139123413`

---

## 4. Build and start

```bash
cd ~/Holdem
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

First run takes ~5-10 min on ARM (Prisma + Next build). Subsequent runs cached.

Watch logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
# Ctrl+C to detach — containers keep running
```

Expected sequence:
1. `postgres` healthy in ~5s
2. `server` runs `prisma db push` (creates all tables in fresh Neondb-style postgres), then `Socket.IO listening on http://localhost:3001`
3. `web` runs `pnpm start` → `Next.js ... ready`
4. `caddy` fetches Let's Encrypt cert (30-60s) → `certificate obtained`
5. `duckdns` refreshes every 5min

---

## 5. Verify

From any machine:

```bash
curl -v https://alan-holdem.duckdns.org/health
# → {"status":"ok","ts":...}
```

Browser: `https://alan-holdem.duckdns.org` → 應該看到登入頁 → Google 登入 → 進 lobby。

---

## 6. Daily ops

```bash
# View logs
docker compose -f docker-compose.prod.yml logs -f server
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f caddy

# Restart just one service (e.g., after config change)
docker compose -f docker-compose.prod.yml --env-file .env.prod restart server

# Full rebuild (after code update)
# 1. Re-transfer repo (Section 2)
# 2. Rebuild affected images:
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Stop everything (keep data)
docker compose -f docker-compose.prod.yml --env-file .env.prod down

# Nuclear: stop + wipe DB volume
docker compose -f docker-compose.prod.yml --env-file .env.prod down -v
```

---

## 7. Backup Postgres

Cron on VM: `crontab -e`

```
0 3 * * * docker exec holdem-postgres pg_dump -U holdem holdem | gzip > /home/ubuntu/holdem-backups/holdem-$(date +\%Y\%m\%d).sql.gz
0 4 * * 0 find /home/ubuntu/holdem-backups -name '*.sql.gz' -mtime +30 -delete
```

(`mkdir -p /home/ubuntu/holdem-backups` first.)

---

## 8. Known gotchas

- **Let's Encrypt rate limits**: 5 failed cert requests per hostname per hour. Don't restart Caddy in a loop while debugging DNS.
- **Prisma alpine target**: `prisma generate` runs inside the Docker build for the correct musl target. Don't reuse a host-built `node_modules/.prisma/client` on the VM.
- **ARM vs x86 build**: You're building on the VM (which is ARM), so image is ARM-native. Don't try to build on your Windows machine and push — architecture mismatch.
- **Trade-bot coexistence**: Trade-bot uses systemd timers (no listening ports), so no conflict. If you ever add a listening service there, avoid 80/443/3000/3001/5432.
- **First-time schema push**: The server container runs `prisma db push --accept-data-loss` on start. Safe for fresh DB. If you ever migrate schema on a populated prod DB, review the diff first (`prisma migrate diff` locally).
