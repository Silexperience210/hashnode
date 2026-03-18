#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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

# 5. Clone or update the repo
if [ -d /opt/hashnode ]; then
  echo -e "${YELLOW}Updating existing HashNode installation...${NC}"
  cd /opt/hashnode && sudo git pull || { echo -e "${RED}Error: Failed to update repository.${NC}"; exit 1; }
  echo -e "${GREEN}Repository updated.${NC}"
else
  echo -e "${YELLOW}Cloning HashNode repository...${NC}"
  sudo git clone https://github.com/Silexperience210/hashnode /opt/hashnode || { echo -e "${RED}Error: Failed to clone repository.${NC}"; exit 1; }
  echo -e "${GREEN}Repository cloned.${NC}"
fi

# 6. Install npm dependencies
echo -e "${YELLOW}Installing npm dependencies...${NC}"
cd /opt/hashnode && sudo npm install --production || { echo -e "${RED}Error: npm install failed.${NC}"; exit 1; }
echo -e "${GREEN}Dependencies installed.${NC}"

# 7. Create data directory
sudo mkdir -p /opt/hashnode/data || { echo -e "${RED}Error: Failed to create data directory.${NC}"; exit 1; }

# 8. Copy .env.example to .env if not present
if [ ! -f /opt/hashnode/.env ]; then
  if [ -f /opt/hashnode/.env.example ]; then
    sudo cp /opt/hashnode/.env.example /opt/hashnode/.env
    echo -e "${YELLOW}Created /opt/hashnode/.env from .env.example — edit it with your NWC string before starting.${NC}"
  else
    echo -e "${YELLOW}No .env.example found. You will need to create /opt/hashnode/.env manually.${NC}"
  fi
else
  echo -e "${GREEN}.env already exists, skipping copy.${NC}"
fi

# 9. Create systemd service file
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

[Install]
WantedBy=multi-user.target
EOF
echo -e "${GREEN}Systemd service created.${NC}"

# 10. Set hostname to hashnode
echo -e "${YELLOW}Setting hostname to 'hashnode'...${NC}"
sudo hostnamectl set-hostname hashnode || { echo -e "${RED}Error: Failed to set hostname.${NC}"; exit 1; }
echo -e "${GREEN}Hostname set to 'hashnode'.${NC}"

# 11. Enable + start service
echo -e "${YELLOW}Enabling and starting HashNode service...${NC}"
sudo systemctl daemon-reload || { echo -e "${RED}Error: systemctl daemon-reload failed.${NC}"; exit 1; }
sudo systemctl enable hashnode || { echo -e "${RED}Error: Failed to enable hashnode service.${NC}"; exit 1; }
sudo systemctl start hashnode || { echo -e "${RED}Error: Failed to start hashnode service.${NC}"; exit 1; }
echo -e "${GREEN}HashNode service enabled and started.${NC}"

# 12. Get local IP
LOCAL_IP=$(hostname -I | awk '{print $1}')

# 13. Print success message
echo ""
echo -e "${GREEN}======================================"
echo -e "  HashNode installed successfully!"
echo -e "======================================"
echo -e "  Access your node at:"
echo -e "    http://hashnode.local:3000"
echo -e "    http://${LOCAL_IP}:3000"
echo -e "${NC}"

# 14. Reminder to configure .env
echo -e "${YELLOW}Edit /opt/hashnode/.env with your NWC string then:${NC}"
echo -e "  sudo systemctl restart hashnode"
echo ""
