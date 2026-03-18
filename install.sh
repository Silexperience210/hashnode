#!/usr/bin/env bash
# HashNode Installer — Raspberry Pi / Debian / Ubuntu
# Safe to run multiple times (idempotent update).
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m';  BOLD='\033[1m';      NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }
ask()  { echo -e "${CYAN}  ? $*${NC}"; }

# ── Guard: not root ──────────────────────────────────────────────────────────
[ "$EUID" -eq 0 ] && err "Do not run as root. Run as a regular user with sudo access."

# ── Guard: sudo works ────────────────────────────────────────────────────────
sudo true 2>/dev/null || err "This script requires sudo. Run: sudo -v"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1 — Collect all information BEFORE doing anything
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${YELLOW}  ⛏  HashNode — Self-hosted Bitcoin Miner Rental${NC}"
echo -e "  ─────────────────────────────────────────────"
echo -e "  This installer will ask a few questions, show"
echo -e "  a summary, then set everything up automatically."
echo ""

# Detect current user and home
CURRENT_USER=$(whoami)
INSTALL_DIR="/opt/hashnode"
IS_UPDATE=false
[ -d "$INSTALL_DIR" ] && IS_UPDATE=true

# 1.1 — Port
ask "Port to run on? [default: 3000]"
read -r INPUT_PORT
PORT=${INPUT_PORT:-3000}
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  warn "Invalid port '$PORT', using 3000"
  PORT=3000
fi

# 1.2 — Hostname (for hashnode.local mDNS)
ask "Local hostname? (used for http://XXX.local) [default: hashnode]"
read -r INPUT_HOST
NODE_HOSTNAME=${INPUT_HOST:-hashnode}
# Sanitize: lowercase, no spaces, only alphanumeric and dash
NODE_HOSTNAME=$(echo "$NODE_HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/^-//;s/-$//')
[ -z "$NODE_HOSTNAME" ] && NODE_HOSTNAME="hashnode"

# 1.3 — Cloudflare Tunnel token (optional — for permanent public URL)
echo ""
echo -e "${CYAN}  ── Internet Access (Cloudflare Tunnel) ──────────────────${NC}"
echo -e "  Without a token: a temporary URL is generated (changes on reboot)."
echo -e "  With a token   : you get a permanent URL (never changes)."
echo ""
echo -e "  To get a free permanent token:"
echo -e "    1. Create free account at ${BOLD}cloudflare.com${NC}"
echo -e "    2. Zero Trust → Networks → Tunnels → Create tunnel → Cloudflared"
echo -e "    3. Copy the token shown on screen"
echo ""
ask "Paste your Cloudflare tunnel token (or press Enter to skip):"
read -r CF_TOKEN

# 1.4 — Summary + confirm
echo ""
echo -e "${BOLD}  ── Installation Summary ──────────────────────────────────${NC}"
echo -e "  User:            ${BOLD}$CURRENT_USER${NC}"
echo -e "  Install dir:     ${BOLD}$INSTALL_DIR${NC}"
echo -e "  Port:            ${BOLD}$PORT${NC}"
echo -e "  Local hostname:  ${BOLD}${NODE_HOSTNAME}.local${NC}"
if [ -n "$CF_TOKEN" ]; then
  echo -e "  Cloudflare:      ${GREEN}Permanent URL (token provided)${NC}"
else
  echo -e "  Cloudflare:      ${YELLOW}Quick tunnel (temporary URL, can add later in wizard)${NC}"
fi
if $IS_UPDATE; then
  echo -e "  Mode:            ${CYAN}UPDATE existing installation${NC}"
else
  echo -e "  Mode:            ${CYAN}FRESH install${NC}"
fi
echo ""
ask "Proceed? [Y/n]"
read -r CONFIRM
case "${CONFIRM:-Y}" in
  [Yy]*|"") : ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2 — Install system dependencies
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ── Installing dependencies ──────────────────────────────${NC}"

# 2.1 — Node.js 20+
NODE_VERSION=0
command -v node &>/dev/null && NODE_VERSION=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo 0)
if [ "$NODE_VERSION" -lt 20 ] 2>/dev/null; then
  echo -e "${YELLOW}  Installing Node.js 20…${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
    || err "Failed to set up NodeSource repository."
  sudo apt-get install -y nodejs \
    || err "Failed to install Node.js."
  ok "Node.js $(node --version) installed."
else
  ok "Node.js $(node --version) already present."
fi
NODE_BIN=$(command -v node)

# 2.2 — avahi-daemon (mDNS — for hashnode.local)
if ! dpkg -s avahi-daemon &>/dev/null 2>&1; then
  echo -e "${YELLOW}  Installing avahi-daemon…${NC}"
  sudo apt-get install -y avahi-daemon || err "Failed to install avahi-daemon."
  sudo systemctl enable --now avahi-daemon
  ok "avahi-daemon installed."
else
  ok "avahi-daemon already present."
fi

# 2.3 — cloudflared
if ! command -v cloudflared &>/dev/null; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "$ARCH" in
    arm64|aarch64) CF_DEB="cloudflared-linux-arm64.deb" ;;
    armhf|armv7l)  CF_DEB="cloudflared-linux-arm.deb"   ;;
    amd64|x86_64)  CF_DEB="cloudflared-linux-amd64.deb" ;;
    *)
      warn "Unknown arch '$ARCH' — cloudflared skipped. Add permanent URL in the wizard later."
      CF_DEB=""
      ;;
  esac

  if [ -n "$CF_DEB" ]; then
    echo -e "${YELLOW}  Installing cloudflared…${NC}"
    if curl -fsSL \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_DEB}" \
        -o /tmp/cloudflared.deb 2>/dev/null; then
      sudo dpkg -i /tmp/cloudflared.deb && rm -f /tmp/cloudflared.deb
      ok "cloudflared installed."
    else
      warn "Could not download cloudflared — internet tunnel unavailable. Skip for now."
    fi
  fi
else
  ok "cloudflared already present ($(cloudflared --version 2>&1 | head -1))."
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3 — Clone / update the repo (as current user, not root)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ── Setting up HashNode files ─────────────────────────────${NC}"

if $IS_UPDATE; then
  echo -e "${YELLOW}  Updating repository…${NC}"
  # Stop service before file update to avoid partial reads
  sudo systemctl stop hashnode 2>/dev/null || true
  sudo -u "$CURRENT_USER" git -C "$INSTALL_DIR" pull \
    || err "Failed to pull latest code. Check network or repo."
  ok "Repository updated."
else
  echo -e "${YELLOW}  Cloning repository…${NC}"
  sudo mkdir -p "$INSTALL_DIR"
  sudo chown "$CURRENT_USER:$CURRENT_USER" "$INSTALL_DIR"
  git clone https://github.com/Silexperience210/hashnode "$INSTALL_DIR" \
    || err "Failed to clone repository."
  ok "Repository cloned."
fi

# 3.2 — npm install as current user (never as root)
echo -e "${YELLOW}  Installing npm dependencies…${NC}"
cd "$INSTALL_DIR"
npm install --production --no-fund --no-audit \
  || err "npm install failed."
ok "Dependencies installed."

# 3.3 — data directory (writable by current user)
mkdir -p "$INSTALL_DIR/data"
ok "Data directory ready."

# 3.4 — .env file: create from template, write known values
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" <<ENVEOF
PORT=${PORT}
NODE_ENV=production
ENVEOF
  ok ".env created."
else
  # Update PORT in existing .env if it changed
  sed -i "s/^PORT=.*/PORT=${PORT}/" "$INSTALL_DIR/.env" 2>/dev/null || true
  ok ".env already exists — PORT updated."
fi

# 3.5 — Write Cloudflare token to .env if provided
# (tunnel.js reads from DB, but keeping it in .env is a recovery fallback)
if [ -n "$CF_TOKEN" ]; then
  # Remove old entry if present, append new one
  sed -i '/^CF_TOKEN=/d' "$INSTALL_DIR/.env" 2>/dev/null || true
  echo "CF_TOKEN=${CF_TOKEN}" >> "$INSTALL_DIR/.env"
  ok "Cloudflare token saved."
fi

# Ensure everything is owned by current user
sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$INSTALL_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 4 — systemd service (uses detected values, no hardcoded 'pi')
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ── Configuring system service ────────────────────────────${NC}"

sudo tee /etc/systemd/system/hashnode.service > /dev/null <<SVCEOF
[Unit]
Description=HashNode Bitcoin Miner Rental
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=-${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
SVCEOF
ok "systemd service written (user=${CURRENT_USER}, node=${NODE_BIN})."

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 5 — Hostname + enable + start
# ─────────────────────────────────────────────────────────────────────────────
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "$NODE_HOSTNAME" ]; then
  sudo hostnamectl set-hostname "$NODE_HOSTNAME"
  ok "Hostname set to '${NODE_HOSTNAME}'."
else
  ok "Hostname already '${NODE_HOSTNAME}'."
fi

sudo systemctl daemon-reload
sudo systemctl enable hashnode
sudo systemctl restart hashnode \
  || err "Failed to start hashnode service. Run: sudo journalctl -u hashnode -n 50"
ok "HashNode service running."

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 6 — Wait for Cloudflare URL then show results
# ─────────────────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "unknown")

echo ""
echo -e "${YELLOW}  Waiting for Cloudflare Tunnel URL (up to 30s)…${NC}"
TUNNEL_URL=""
for i in $(seq 1 15); do
  sleep 2
  TUNNEL_URL=$(sudo journalctl -u hashnode -n 150 --no-pager 2>/dev/null \
    | grep -o 'https://[a-z0-9-]*\.\(trycloudflare\|cfargotunnel\)\.com' \
    | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
done

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 7 — Final summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗"
echo -e "  ║   ⛏  HashNode installed successfully!   ║"
echo -e "  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Local network${NC} (same WiFi / Ethernet):"
echo -e "    ${CYAN}http://${NODE_HOSTNAME}.local:${PORT}${NC}"
echo -e "    ${CYAN}http://${LOCAL_IP}:${PORT}${NC}"
echo ""

if [ -n "$TUNNEL_URL" ]; then
  echo -e "  ${BOLD}Public internet${NC}:"
  echo -e "    ${GREEN}${TUNNEL_URL}${NC}"
  if [ -n "$CF_TOKEN" ]; then
    echo -e "    ${GREEN}(permanent URL — never changes)${NC}"
  else
    echo -e "    ${YELLOW}(temporary URL — changes on reboot, upgrade in wizard)${NC}"
  fi
  echo ""
else
  echo -e "  ${BOLD}Public URL${NC}:"
  echo -e "    ${YELLOW}Still connecting — open the wizard, the URL will appear${NC}"
  echo -e "    ${YELLOW}automatically in step 2 when Cloudflare is ready.${NC}"
  echo ""
fi

echo -e "  ${BOLD}→ Open the setup wizard in your browser:${NC}"
echo -e "    ${CYAN}http://${NODE_HOSTNAME}.local:${PORT}${NC}"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    sudo systemctl status hashnode      # service status"
echo -e "    sudo journalctl -u hashnode -f      # live logs"
echo -e "    sudo systemctl restart hashnode     # restart"
echo ""
