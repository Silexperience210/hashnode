#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# 1. Check not running as root
if [ "$EUID" -eq 0 ]; then
  echo -e "${RED}Error: Do not run this script as root. Run as a regular user with sudo access.${NC}"
  exit 1
fi

# 2. Banner
echo -e "${YELLOW}"
echo "  ⛏  HashNode Installer"
echo "  Self-hosted Bitcoin Miner Rental Platform"
echo -e "${NC}"

# 3. Install Node.js 20 via NodeSource if not present
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  echo -e "${YELLOW}Installing Node.js 20...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || { echo -e "${RED}Error: Failed to set up NodeSource repository.${NC}"; exit 1; }
  sudo apt-get install -y nodejs || { echo -e "${RED}Error: Failed to install Node.js.${NC}"; exit 1; }
  echo -e "${GREEN}Node.js $(node --version) installed.${NC}"
else
  echo -e "${GREEN}Node.js $(node --version) already installed.${NC}"
fi

# 4. Install avahi-daemon (mDNS) if not present
if ! dpkg -s avahi-daemon &>/dev/null 2>&1; then
  echo -e "${YELLOW}Installing avahi-daemon (mDNS)...${NC}"
  sudo apt-get install -y avahi-daemon || { echo -e "${RED}Error: Failed to install avahi-daemon.${NC}"; exit 1; }
  sudo systemctl enable avahi-daemon
  sudo systemctl start avahi-daemon
  echo -e "${GREEN}avahi-daemon installed and started.${NC}"
else
  echo -e "${GREEN}avahi-daemon already installed.${NC}"
fi

# 5. Install cloudflared (Cloudflare Tunnel) for public internet access
echo -e "${YELLOW}Installing cloudflared (Cloudflare Tunnel)...${NC}"
if ! command -v cloudflared &>/dev/null; then
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    arm64)  CF_DEB="cloudflared-linux-arm64.deb" ;;
    armhf)  CF_DEB="cloudflared-linux-arm.deb" ;;
    amd64)  CF_DEB="cloudflared-linux-amd64.deb" ;;
    *)
      echo -e "${YELLOW}Unknown arch $ARCH — skipping cloudflared install. Install manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${NC}"
      CF_DEB=""
      ;;
  esac

  if [ -n "$CF_DEB" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_DEB}" -o /tmp/cloudflared.deb \
      || { echo -e "${YELLOW}Could not download cloudflared — skipping.${NC}"; CF_DEB=""; }
    if [ -n "$CF_DEB" ]; then
      sudo dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb
      echo -e "${GREEN}cloudflared installed.${NC}"
    fi
  fi
else
  echo -e "${GREEN}cloudflared already installed: $(cloudflared --version 2>&1 | head -1).${NC}"
fi

# 6. Clone or update the repo
if [ -d /opt/hashnode ]; then
  echo -e "${YELLOW}Updating existing HashNode installation...${NC}"
  cd /opt/hashnode && sudo git pull || { echo -e "${RED}Error: Failed to update repository.${NC}"; exit 1; }
  echo -e "${GREEN}Repository updated.${NC}"
else
  echo -e "${YELLOW}Cloning HashNode repository...${NC}"
  sudo git clone https://github.com/Silexperience210/hashnode /opt/hashnode || { echo -e "${RED}Error: Failed to clone repository.${NC}"; exit 1; }
  echo -e "${GREEN}Repository cloned.${NC}"
fi

# 8. Install npm dependencies
echo -e "${YELLOW}Installing npm dependencies...${NC}"
cd /opt/hashnode && sudo npm install --production || { echo -e "${RED}Error: npm install failed.${NC}"; exit 1; }
echo -e "${GREEN}Dependencies installed.${NC}"

# 9. Create data directory and fix ownership
sudo mkdir -p /opt/hashnode/data
sudo chown -R pi:pi /opt/hashnode/data

# 10. Copy .env.example to .env if not present
if [ ! -f /opt/hashnode/.env ]; then
  if [ -f /opt/hashnode/.env.example ]; then
    sudo cp /opt/hashnode/.env.example /opt/hashnode/.env
    sudo chown pi:pi /opt/hashnode/.env
    echo -e "${YELLOW}Created /opt/hashnode/.env — edit it before starting.${NC}"
  fi
else
  echo -e "${GREEN}.env already exists.${NC}"
fi

# 11. Create HashNode systemd service
echo -e "${YELLOW}Creating systemd service...${NC}"
sudo tee /etc/systemd/system/hashnode.service > /dev/null <<'EOF'
[Unit]
Description=HashNode Bitcoin Miner Rental
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/hashnode
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=-/opt/hashnode/.env

[Install]
WantedBy=multi-user.target
EOF
echo -e "${GREEN}Systemd service created.${NC}"

# 12. Set hostname to hashnode
echo -e "${YELLOW}Setting hostname to 'hashnode'...${NC}"
sudo hostnamectl set-hostname hashnode || { echo -e "${RED}Error: Failed to set hostname.${NC}"; exit 1; }

# 13. Enable + start HashNode service
echo -e "${YELLOW}Enabling HashNode service...${NC}"
sudo systemctl daemon-reload
sudo systemctl enable hashnode
sudo systemctl start hashnode || { echo -e "${RED}Error: Failed to start hashnode service.${NC}"; exit 1; }
echo -e "${GREEN}HashNode service started.${NC}"

# 14. Get local IP and wait for tunnel URL to appear in logs
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo -e "${YELLOW}Waiting for Cloudflare Tunnel URL (up to 30s)...${NC}"
TUNNEL_URL=""
for i in $(seq 1 15); do
  sleep 2
  TUNNEL_URL=$(sudo journalctl -u hashnode -n 100 --no-pager 2>/dev/null \
    | grep -oP 'https://[a-z0-9\-]+\.trycloudflare\.com' | head -1 || echo "")
  if [ -n "$TUNNEL_URL" ]; then break; fi
done

# 15. Success
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗"
echo -e "║    ⛏  HashNode installed!             ║"
echo -e "╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}  Local network (same WiFi):${NC}"
echo -e "    http://hashnode.local:3000"
echo -e "    http://${LOCAL_IP}:3000"
echo ""
if [ -n "$TUNNEL_URL" ]; then
  echo -e "${CYAN}  Public internet (Cloudflare Tunnel):${NC}"
  echo -e "    ${GREEN}${TUNNEL_URL}${NC}"
  echo ""
  echo -e "${GREEN}  ✓ The setup wizard will auto-detect this URL.${NC}"
else
  echo -e "${CYAN}  Public URL:${NC}"
  echo -e "    Still connecting to Cloudflare — open the setup wizard,"
  echo -e "    step 2 will show the URL automatically when ready."
fi
echo ""
echo -e "${YELLOW}  → Open the setup wizard:${NC}"
echo -e "    http://hashnode.local:3000"
echo ""
