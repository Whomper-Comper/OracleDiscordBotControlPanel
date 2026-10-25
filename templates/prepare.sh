set -e
U={{repo}}
if [ -n "$U" ] && [ ! -d "$DIR/.git" ]; then
  command -v git >/dev/null || { echo "✖ Git is missing. Run Initial setup first."; exit 1; }
  mkdir -p "$(dirname "$DIR")"
  if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
    echo "✖ Folder already contains files. Use Clone / update repo or choose an empty install folder."; exit 1
  fi
  git clone -b {{branch}} "$U" "$DIR"
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
