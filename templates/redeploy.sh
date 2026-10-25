set -e
cd "$DIR"
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

true
echo "• Installing dependencies"
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  npm ci --include=dev --no-audit --no-fund
else
  npm install --include=dev --no-audit --no-fund
fi
echo "• Building"; {{build_cmd}}
echo "• Command sync"; {{sync_cmd}}
echo "• Restarting bot"; {{managed_files}}
pm2 startOrReload {{pm_config}} --only "$APP" --update-env; pm2 save
pm2 status