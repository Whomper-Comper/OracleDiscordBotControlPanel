set -euo pipefail
APP='music-bot'; DIR='/home/opc/bots/music'
cd "$HOME"

PANEL_DIR="$HOME/.bot-panel/test-id"
if [ -L "$HOME/.bot-panel" ] || [ -L "$PANEL_DIR" ]; then echo 'Refusing a symlinked panel configuration folder.'; exit 1; fi

PRESENT=$(pm2 jlist | node -e 'let s='\'''\'';process.stdin.on('\''data'\'',c=>s+=c);process.stdin.on('\''end'\'',()=>{try{const apps=JSON.parse(s);if(!Array.isArray(apps))throw Error();process.stdout.write(apps.some(a=>a.name==="music-bot")?'\''yes'\'':'\''no'\'');}catch{console.error('\''Could not read the PM2 process list.'\'');process.exitCode=1;}});')
if [ "$PRESENT" = yes ]; then pm2 delete "$APP"; fi
pm2 save --force
rm -f -- "$PANEL_DIR/ecosystem.config.cjs"
rmdir -- "$PANEL_DIR" 2>/dev/null || true
echo "Kept bot files: $DIR"
echo "Removed PM2 app: $APP"
