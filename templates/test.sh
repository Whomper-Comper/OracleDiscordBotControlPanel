echo "Connected as $(whoami)@$(hostname)"; . /etc/os-release; echo "$PRETTY_NAME, kernel $(uname -r)"
for tool in node npm pm2 git; do
  if command -v "$tool" >/dev/null 2>&1; then echo "$tool: installed";
  else echo "⚠ $tool: not installed yet — run Initial setup"; fi
done
echo "✔ SSH connection works"