set -e
command -v git >/dev/null || { echo "git is missing - run Initial setup first"; exit 1; }
U={{repo}}; B={{branch}}
if [ -d "$DIR/.git" ]; then
  echo "• Repo exists, updating"
  git -C "$DIR" remote set-url origin "$U"; git -C "$DIR" fetch origin "$B"; git -C "$DIR" checkout "$B" 2>/dev/null || true; git -C "$DIR" pull --ff-only origin "$B"
else
  mkdir -p "$DIR"
  if [ -z "$(ls -A "$DIR")" ]; then echo "• Cloning"; git clone -b "$B" "$U" "$DIR"
  else echo "• Folder has files, adding the repo in place (checkout stops if files would be overwritten)"; cd "$DIR"; git init -q; git remote add origin "$U"; git fetch origin "$B"; git checkout -B "$B" "origin/$B"; fi
fi
cd "$DIR"; git log -3 --format='%h %ar %s'; {{managed_files}}
cd "$DIR"
if [ ! -e .env ]; then
  (umask 077; if [ -f .env.example ]; then cp .env.example .env; else printf '%s\n' '# Add the environment variables required by this bot.' > .env; fi)
  chmod 600 .env
  echo "• Created .env; upload this bot's credentials before deploying"
fi
mkdir -p backups
echo "✔ Bot folder and launch configuration ready: $DIR ($APP)"

echo "✔ Next: Upload .env, then Pull & deploy"