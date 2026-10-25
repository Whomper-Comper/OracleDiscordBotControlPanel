export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive
PM=apt-get; command -v dnf >/dev/null 2>&1 && PM=dnf
APP={{app}}; DIR={{dir}}
cd "$DIR" 2>/dev/null || true
