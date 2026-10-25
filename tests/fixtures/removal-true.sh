set -euo pipefail
APP='music-bot'; DIR='/home/opc/bots/music'
cd "$HOME"
HOME_DIR=$(realpath -e -- "$HOME")
TARGET=$(realpath -m -- "$DIR")
[ "$TARGET" = "$DIR" ] || { echo 'Refusing file deletion through a symlink.'; exit 1; }
case "$TARGET" in "$HOME_DIR"/*) ;; *) echo 'File deletion requires a bot subfolder inside the SSH user home.'; exit 1;; esac
RELATIVE=${TARGET#"$HOME_DIR"/}
case "$RELATIVE" in .*|bots|bots/.*) echo 'Refusing deletion of a shared or hidden home folder.'; exit 1;; esac
OTHER=$(realpath -m -- '/home/opc/bots/other')
case "$TARGET/" in "$OTHER/"*) echo 'Folder overlaps another bot.'; exit 1;; esac
case "$OTHER/" in "$TARGET/"*) echo 'Folder contains another bot.'; exit 1;; esac

PANEL_DIR="$HOME/.bot-panel/test-id"
if [ -L "$HOME/.bot-panel" ] || [ -L "$PANEL_DIR" ]; then echo 'Refusing a symlinked panel configuration folder.'; exit 1; fi

PRESENT=$(pm2 jlist | node -e 'let s='\'''\'';process.stdin.on('\''data'\'',c=>s+=c);process.stdin.on('\''end'\'',()=>{try{const apps=JSON.parse(s);if(!Array.isArray(apps))throw Error();process.stdout.write(apps.some(a=>a.name==="music-bot")?'\''yes'\'':'\''no'\'');}catch{console.error('\''Could not read the PM2 process list.'\'');process.exitCode=1;}});')
if [ "$PRESENT" = yes ]; then pm2 delete "$APP"; fi
pm2 save --force
rm -f -- "$PANEL_DIR/ecosystem.config.cjs"
rmdir -- "$PANEL_DIR" 2>/dev/null || true
rm -rf -- "$TARGET"
echo "Removed bot files: $TARGET"
echo "Removed PM2 app: $APP"
