if [ "$PM" = dnf ]; then sudo dnf -y upgrade --refresh; else sudo apt-get update && sudo apt-get -y upgrade; fi
[ -f /var/run/reboot-required ] && echo "⚠ Reboot required"; true