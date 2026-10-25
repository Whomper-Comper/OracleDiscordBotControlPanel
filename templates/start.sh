set -e; cd "$DIR"; {{managed_files}}
pm2 startOrReload {{pm_config}} --only "$APP" --update-env; pm2 save; pm2 status