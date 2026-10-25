echo "@@UP $(uptime -p)"; echo "@@LOAD $(cut -d' ' -f1-3 /proc/loadavg)"
echo "@@MEM $(free -m | awk '/Mem/{print $3"/"$2" MB"}')"; echo "@@DISK $(df -h / | awk 'NR==2{print $3"/"$2" ("$5")"}')"
echo "@@PM2 $(pm2 jlist 2>/dev/null | grep -m1 '^\[')"