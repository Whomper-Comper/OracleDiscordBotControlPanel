set -e; cd "$DIR"
{{other_apps}}
pm2 save
{{managed_files}}
pm2 startOrReload {{pm_config}} --only "$APP" --update-env; pm2 save; pm2 status