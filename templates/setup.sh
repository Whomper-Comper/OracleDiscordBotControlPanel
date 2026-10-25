set -e
set -e
RAM_KB=$(awk '/MemTotal:/{print $2}' /proc/meminfo)
SWAP_KB=$(awk '/SwapTotal:/{print $2}' /proc/meminfo)
if [ "$RAM_KB" -lt 2097152 ] && [ "$SWAP_KB" -lt 1048576 ]; then
  echo "• Preparing 2 GiB swap for this low-memory VM"
  SWAPFILE=/var/swap.bot-panel
  if ! sudo swapon --show=NAME --noheadings | grep -Fxq "$SWAPFILE"; then
    if sudo test -e "$SWAPFILE"; then
      echo "✖ $SWAPFILE already exists but is inactive. Inspect it before retrying; it will not be overwritten."; exit 1
    fi
    FREE_KB=$(df -Pk /var | awk 'NR==2{print $4}')
    [ "$FREE_KB" -ge 3145728 ] || { echo "✖ At least 3 GiB free disk space is needed to create swap."; exit 1; }
    sudo install -m 600 /dev/null "$SWAPFILE"
    sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=progress
    sudo mkswap "$SWAPFILE"
    sudo swapon "$SWAPFILE"
  fi
  if ! grep -Eq '^/var/swap[.]bot-panel[[:space:]]' /etc/fstab; then
    echo '/var/swap.bot-panel none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
fi
if [ "$RAM_KB" -lt 2097152 ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
  export npm_config_jobs=1 MAKEFLAGS=-j1
fi
free -h
if [ "$RAM_KB" -lt 786432 ]; then
  echo "⚠ Less than 768 MiB RAM is visible to Linux. Swap helps, but package installation may still stall under memory pressure."
fi

echo "• System packages + Node.js 22 LTS"
if [ "$PM" = dnf ]; then
  echo "• Installing system packages (one download at a time; optional dependencies disabled)"
  sudo dnf -y --setopt=max_parallel_downloads=1 --setopt=install_weak_deps=False install git tar curl gcc-c++ make
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf -y --setopt=max_parallel_downloads=1 --setopt=install_weak_deps=False install nodejs
else
  sudo apt-get update -y
  sudo apt-get install -y git curl build-essential ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "• PM2 + boot autostart"; sudo env "NODE_OPTIONS=${NODE_OPTIONS:-}" npm_config_jobs=1 MAKEFLAGS=-j1 npm i -g pm2@latest --no-audit --no-fund
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null || true
U={{repo}}
if [ -n "$U" ]; then
  if [ -d "$DIR/.git" ]; then git -C "$DIR" remote set-url origin "$U"; git -C "$DIR" pull --ff-only origin {{branch}}; else mkdir -p "$(dirname "$DIR")"; git clone -b {{branch}} "$U" "$DIR"; fi
else mkdir -p "$DIR"; fi
{{managed_files}}
cd "$DIR"
if [ ! -e .env ]; then
  (umask 077; if [ -f .env.example ]; then cp .env.example .env; else printf '%s\n' '# Add the environment variables required by this bot.' > .env; fi)
  chmod 600 .env
  echo "• Created .env; upload this bot's credentials before deploying"
fi
mkdir -p backups
echo "✔ Bot folder and launch configuration ready: $DIR ($APP)"

echo "node $(node -v) | pm2 $(pm2 -v)"; echo "✔ Next: Upload .env, then Pull & deploy"