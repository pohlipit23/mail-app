#!/bin/bash
#
# Set up the WSL2 development environment for Exo.
#
# Prerequisites: WSL2 with Ubuntu 22.04+ and WSLg enabled (default on Windows 11).
#
# What this script does:
#   1. Installs system dependencies (build tools, xvfb for headless tests, zip for log export)
#   2. Installs nvm + Node.js LTS if not present
#   3. Runs npm install
#   4. Reminds you to copy .env from the main worktree
#
# Usage:
#   ./scripts/setup-wsl.sh
#

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Verify we're actually in WSL
if ! grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
  log_error "This script is intended for WSL2. Run it inside your WSL distribution."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Check if project is on the Linux filesystem (not /mnt/c/)
if [[ "$PROJECT_DIR" == /mnt/* ]]; then
  log_warn "Project is on the Windows filesystem ($PROJECT_DIR)."
  log_warn "Performance will be significantly worse. Clone to ~/src/mail-app instead:"
  log_warn "  git clone <repo> ~/src/mail-app && cd ~/src/mail-app"
  echo ""
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

log_info "=== Installing system dependencies ==="
sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential \
  python3 \
  xvfb \
  zip \
  libgtk-3-0 \
  libnotify4 \
  libnss3 \
  libxss1 \
  libasound2 \
  libgbm1 \
  libsecret-1-0

log_info "System dependencies installed."

# Install Node.js via nvm if not present
if ! command -v node &> /dev/null; then
  log_info "=== Installing Node.js via nvm ==="
  if ! command -v nvm &> /dev/null && [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  else
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi
  nvm install --lts
  nvm use --lts
  log_info "Node.js $(node --version) installed."
else
  log_info "Node.js $(node --version) already installed."
fi

# npm install
log_info "=== Running npm install ==="
cd "$PROJECT_DIR"
npm install

# Check for .env
if [ ! -f "$PROJECT_DIR/.env" ]; then
  log_warn ""
  log_warn "No .env file found. You need to copy it from the main worktree:"
  log_warn "  cp /path/to/main-worktree/.env $PROJECT_DIR/.env"
  log_warn ""
  log_warn "Required variables: ANTHROPIC_API_KEY, MAIN_VITE_GOOGLE_CLIENT_ID, MAIN_VITE_GOOGLE_CLIENT_SECRET"
fi

echo ""
log_info "=== WSL setup complete ==="
log_info ""
log_info "To start the app:"
log_info "  cd $PROJECT_DIR"
log_info "  npm run dev"
log_info ""
log_info "Notes:"
log_info "  - OAuth will open your Windows default browser automatically."
log_info "  - The OAuth callback (localhost:3847) works via WSL2 localhost forwarding."
log_info "  - The app window renders via WSLg (Wayland). GPU acceleration is limited."
log_info "  - For tests: npm test (xvfb is used automatically for headless Electron)."
