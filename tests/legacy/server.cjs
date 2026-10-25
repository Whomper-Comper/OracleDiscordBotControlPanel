// Oracle VM Control Panel - zero-dependency local server (needs Node 18+ and Windows OpenSSH ssh/scp/tar)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const PORT = 4321, CFG = path.join(__dirname, 'config.json');
const DEF = { name: 'My bot', host: '', port: '22', user: 'opc', key: '', repo: '', token: '', branch: 'main',
  dir: '/home/opc/bots/my-bot', app: 'my-bot', buildCmd: 'npm run build --if-present', cmdSyncCmd: '', localEnv: '', localBot: '' };
const profiles = require('./profiles.cjs'), storage = profiles.repository(CFG, DEF);
const removalRevision = (store, id = store.activeBotId) => require('crypto').createHash('sha256').update(JSON.stringify(profiles.active(store, id))).digest('hex');
const configView = (store, id = store.activeBotId) => ({ ...(store.bots.length ? profiles.active(store, id) : store.server), bots: store.bots, activeBotId: id, removalRevision: store.bots.length ? removalRevision(store, id) : '' });
const resolveConfig = (input, store = storage) => profiles.active(profiles.update(store.read(), input || {}), input?.botId);
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

// ---- process helpers (output streamed to res, secrets masked) ----
function run(cmd, args, res, mask, cwd, timeoutMs = 0) {
  return new Promise(ok => {
    if (res.destroyed) return ok(1);
    const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const w = d => { let s = d.toString(); for (const m of mask) if (m) s = s.split(m).join('***'); if (!res.destroyed) res.write(s); };
    let settled = false, timer;
    const cancel = () => { p.kill(); finish(1); };
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); res.removeListener?.('close', cancel); ok(code);
    };
    if (timeoutMs) timer = setTimeout(() => { w('✖ SSH status check timed out. The VM may be overloaded or unreachable.\n'); p.kill(); finish(124); }, timeoutMs);
    p.stdout.on('data', w); p.stderr.on('data', w);
    p.on('error', e => { w('✖ ' + e.message + '\n'); finish(1); });
    p.on('close', c => finish(c === null ? 1 : c));
    res.on('close', cancel);
  });
}
const keyArg = c => c.key ? ['-i', c.key] : [];
const opts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=9'];
const wrap = s => `bash -lc "$(echo ${Buffer.from(s).toString('base64')}|base64 -d)"`;
const ssh = (c, s, res, m, timeoutMs) => run('ssh', [...keyArg(c), '-p', c.port, ...opts, '-T', `${c.user}@${c.host}`, wrap(s)], res, m, undefined, timeoutMs);
const scp = (c, file, remote, res, m) => run('scp', [...keyArg(c), '-P', c.port, ...opts, path.basename(file), `${c.user}@${c.host}:${remote}`], res, m, path.dirname(file));

// ---- remote scripts ----
// Use disk-backed swap on small VMs before package managers consume memory.
const MEMORY = `set -e
RAM_KB=$(awk '/MemTotal:/{print $2}' /proc/meminfo)
SWAP_KB=$(awk '/SwapTotal:/{print $2}' /proc/meminfo)
if [ "$RAM_KB" -lt 2097152 ] && [ "$SWAP_KB" -lt 1048576 ]; then
  echo "• Preparing 2 GiB swap for this low-memory VM"
  SWAPFILE=/var/swap.bot-panel
  if ! sudo swapon --show=NAME --noheadings | grep -Fxq "$SWAPFILE"; then
    if sudo test -e "$SWAPFILE"; then
      echo "✖ $SWAPFILE already exists but is inactive. Inspect it before retrying; it will not be overwritten."; exit 1
    fi
    FREE_KB=$(df -Pk /var | awk 'NR==2{print $4}')
    [ "$FREE_KB" -ge 3145728 ] || { echo "✖ At least 3 GiB free disk space is needed to create swap."; exit 1; }
    sudo install -m 600 /dev/null "$SWAPFILE"
    sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=progress
    sudo mkswap "$SWAPFILE"
    sudo swapon "$SWAPFILE"
  fi
  if ! grep -Eq '^/var/swap[.]bot-panel[[:space:]]' /etc/fstab; then
    echo '/var/swap.bot-panel none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
fi
if [ "$RAM_KB" -lt 2097152 ]; then
  export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=512}"
  export npm_config_jobs=1 MAKEFLAGS=-j1
fi
free -h
if [ "$RAM_KB" -lt 786432 ]; then
  echo "⚠ Less than 768 MiB RAM is visible to Linux. Swap helps, but package installation may still stall under memory pressure."
fi
`;
const H = c => `export GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive
PM=apt-get; command -v dnf >/dev/null 2>&1 && PM=dnf
APP=${q(c.app)}; DIR=${q(c.dir)}
cd "$DIR" 2>/dev/null || true
`;
const authUrl = c => c.token ? c.repo.replace('https://', 'https://' + encodeURIComponent(c.token) + '@') : c.repo;
function ecosystem(c) {
  return `// Generated by Oracle bot panel. Repository files are left intact.
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(c.dir)};
const name = ${JSON.stringify(c.app)};
const entry = ${JSON.stringify(c.entryFile || '')};
let app;
const source = path.join(dir, 'ecosystem.config.cjs');
if (entry) app = { script: entry };
else if (fs.existsSync(source)) {
  const apps = require(source).apps;
  if (!Array.isArray(apps) || !apps.length) throw new Error('Repository ecosystem has no apps. Set an entry file in the panel.');
  app = apps.find(a => a.name === name) || (apps.length === 1 ? apps[0] : null);
  if (!app) throw new Error('Repository defines multiple apps. Set an entry file or match the PM2 app name.');
} else app = { script: 'npm', args: 'start', interpreter: 'none' };
module.exports = { apps: [{ ...app, name, cwd: dir }] };
`;
}
const managedFiles = c => c.managed ? `
PANEL_DIR="$HOME/.bot-panel/${c.id}"
mkdir -p "$PANEL_DIR"
printf '%s' ${q(Buffer.from(ecosystem(c)).toString('base64'))} | base64 -d > "$PANEL_DIR/ecosystem.config.cjs"
` : '';
const pmStart = c => `${managedFiles(c)}
pm2 startOrReload ${c.managed ? '"$PANEL_DIR/ecosystem.config.cjs"' : 'ecosystem.config.cjs'} --only "$APP" --update-env`;
const scaffold = c => `${managedFiles(c)}
cd "$DIR"
if [ ! -e .env ]; then
  (umask 077; if [ -f .env.example ]; then cp .env.example .env; else printf '%s\\n' '# Add the environment variables required by this bot.' > .env; fi)
  chmod 600 .env
  echo "• Created .env; upload this bot's credentials before deploying"
fi
mkdir -p backups
echo "✔ Bot folder and launch configuration ready: $DIR ($APP)"
`;
const deploy = (c, pull) => `set -e
cd "$DIR"
${MEMORY}
${pull ? 'git pull --ff-only origin ' + q(c.branch || 'main') : 'true'}
echo "• Installing dependencies"
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  npm ci --include=dev --no-audit --no-fund
else
  npm install --include=dev --no-audit --no-fund
fi
echo "• Building"; ${c.buildCmd || 'true'}
echo "• Command sync"; ${c.cmdSyncCmd || 'echo "Skipped (no command configured)"'}
echo "• Restarting bot"; ${pmStart(c)}; pm2 save
pm2 status`;
const script = (c, a, p) => {
  const L = Math.max(1, parseInt(p.lines) || 200), F = p.filter ? ` | grep -i --line-buffered -e ${q(p.filter)}` : '', E = p.err ? ' --err' : '';
  const S = {
    test: `echo "Connected as $(whoami)@$(hostname)"; . /etc/os-release; echo "$PRETTY_NAME, kernel $(uname -r)"
for tool in node npm pm2 git; do
  if command -v "$tool" >/dev/null 2>&1; then echo "$tool: installed";
  else echo "⚠ $tool: not installed yet — run Initial setup"; fi
done
echo "✔ SSH connection works"`,
    setup: `set -e
${MEMORY}
echo "• System packages + Node.js 22 LTS"
if [ "$PM" = dnf ]; then
  echo "• Installing system packages (one download at a time; optional dependencies disabled)"
  sudo dnf -y --setopt=max_parallel_downloads=1 --setopt=install_weak_deps=False install git tar curl gcc-c++ make
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf -y --setopt=max_parallel_downloads=1 --setopt=install_weak_deps=False install nodejs
else
  sudo apt-get update -y
  sudo apt-get install -y git curl build-essential ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "• PM2 + boot autostart"; sudo env "NODE_OPTIONS=\${NODE_OPTIONS:-}" npm_config_jobs=1 MAKEFLAGS=-j1 npm i -g pm2@latest --no-audit --no-fund
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null || true
U=${q(authUrl(c))}
if [ -n "$U" ]; then
  if [ -d "$DIR/.git" ]; then git -C "$DIR" remote set-url origin "$U"; git -C "$DIR" pull --ff-only origin ${q(c.branch || 'main')}; else mkdir -p "$(dirname "$DIR")"; git clone -b ${q(c.branch || 'main')} "$U" "$DIR"; fi
else mkdir -p "$DIR"; fi
${scaffold(c)}
echo "node $(node -v) | pm2 $(pm2 -v)"; echo "✔ Next: Upload .env, then Pull & deploy"`,
    sysupdate: `if [ "$PM" = dnf ]; then sudo dnf -y upgrade --refresh; else sudo apt-get update && sudo apt-get -y upgrade; fi
[ -f /var/run/reboot-required ] && echo "⚠ Reboot required"; true`,
    memory: MEMORY,
    npmupdate: `${MEMORY}\nsudo env "NODE_OPTIONS=\${NODE_OPTIONS:-}" npm_config_jobs=1 MAKEFLAGS=-j1 npm i -g npm@latest pm2@latest --no-audit --no-fund && pm2 update; echo "npm $(npm -v) | pm2 $(pm2 -v)"`,
    deploy: deploy(c, true), redeploy: deploy(c, false),
    prepare: `set -e
U=${q(authUrl(c))}
if [ -n "$U" ] && [ ! -d "$DIR/.git" ]; then
  command -v git >/dev/null || { echo "✖ Git is missing. Run Initial setup first."; exit 1; }
  mkdir -p "$(dirname "$DIR")"
  if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
    echo "✖ Folder already contains files. Use Clone / update repo or choose an empty install folder."; exit 1
  fi
  git clone -b ${q(c.branch || 'main')} "$U" "$DIR"
else mkdir -p "$DIR"; fi
${scaffold(c)}`,
    pull: `set -e; cd "$DIR"; git pull --ff-only origin ${q(c.branch || 'main')}; git log -3 --oneline`,
    clone: `set -e
command -v git >/dev/null || { echo "git is missing - run Initial setup first"; exit 1; }
U=${q(authUrl(c))}; B=${q(c.branch || 'main')}
if [ -d "$DIR/.git" ]; then
  echo "• Repo exists, updating"
  git -C "$DIR" remote set-url origin "$U"; git -C "$DIR" fetch origin "$B"; git -C "$DIR" checkout "$B" 2>/dev/null || true; git -C "$DIR" pull --ff-only origin "$B"
else
  mkdir -p "$DIR"
  if [ -z "$(ls -A "$DIR")" ]; then echo "• Cloning"; git clone -b "$B" "$U" "$DIR"
  else echo "• Folder has files, adding the repo in place (checkout stops if files would be overwritten)"; cd "$DIR"; git init -q; git remote add origin "$U"; git fetch origin "$B"; git checkout -B "$B" "origin/$B"; fi
fi
cd "$DIR"; git log -3 --format='%h %ar %s'; ${scaffold(c)}
echo "✔ Next: Upload .env, then Pull & deploy"`,
    resetrepo: `set -e; cd "$DIR"; B=${q(c.branch || 'main')}; git fetch origin "$B"; git reset --hard "origin/$B"; git clean -fd -e .env -e '*.db*' -e backups/; git log -3 --format='%h %ar %s'`,
    gitstatus: `cd "$DIR" && git remote -v && git status -sb && git log -5 --format='%h %ar %s'`,
    cmds: `set -e; cd "$DIR"; ${c.cmdSyncCmd || 'echo "No command sync configured for this bot"'}`,
    start: `set -e; cd "$DIR"; ${pmStart(c)}; pm2 save; pm2 status`,
    solo: `set -e; cd "$DIR"
${(c.otherApps || []).map(app => `if pm2 describe ${q(app)} >/dev/null 2>&1; then pm2 stop ${q(app)}; fi`).join('\n')}
pm2 save
${pmStart(c)}; pm2 save; pm2 status`,
    stop: `pm2 stop "$APP"; pm2 save; pm2 status`,
    restart: `pm2 restart "$APP" --update-env; pm2 status`,
    status: `pm2 status; echo; pm2 describe "$APP" 2>&1 | head -30`,
    logs: `pm2 logs "$APP" --nostream --raw --lines ${L}${E} 2>&1${F}; true`,
    follow: `timeout 900 pm2 logs "$APP" --raw --lines ${L}${E} 2>&1${F}; true`,
    flush: `pm2 flush "$APP"; echo "Logs flushed"`,
    sysinfo: `uptime; echo; free -h; echo; df -h /; echo; du -sh "$DIR" 2>/dev/null; echo; ps aux --sort=-%mem | head -6`,
    backup: `cd "$DIR"; mkdir -p backups; for f in *.db; do [ -f "$f" ] && cp "$f" "backups/\${f%.db}-$(date +%Y%m%d-%H%M%S).db" && echo "saved $f"; done; ls -lh backups | tail -8`,
    envshow: `sed -E 's/=.*/=***/' "$DIR/.env" 2>&1`,
    reboot: `sudo reboot`,
    custom: p.cmd || 'echo "Type a command first"',
  };
  return S[a] != null ? H(c) + S[a] : null;
};
const STATUS = `echo "@@UP $(uptime -p)"; echo "@@LOAD $(cut -d' ' -f1-3 /proc/loadavg)"
echo "@@MEM $(free -m | awk '/Mem/{print $3"/"$2" MB"}')"; echo "@@DISK $(df -h / | awk 'NR==2{print $3"/"$2" ("$5")"}')"
echo "@@PM2 $(pm2 jlist 2>/dev/null | grep -m1 '^\\[')"`;
async function status(c, res) {
  const cap = { b: '', write(s) { this.b += s; }, get destroyed() { return res.destroyed; },
    on(...args) { res.on(...args); }, removeListener(...args) { res.removeListener(...args); } };
  const code = await ssh(c, STATUS, cap, [c.token, encodeURIComponent(c.token || '')], 45000);
  const g = k => (cap.b.match(new RegExp('@@' + k + ' (.*)')) || [])[1];
  if (code || !g('UP')) return { error: cap.b.trim().split('\n').slice(-2).join(' ') || 'No response from server' };
  let app = null, apps = [];
  try { apps = JSON.parse(g('PM2') || '[]').map(a => ({ name: a.name, status: a.pm2_env.status, uptime: a.pm2_env.pm_uptime, mem: a.monit.memory, cpu: a.monit.cpu, restarts: a.pm2_env.restart_time })); app = apps.find(a => a.name === c.app) || null; } catch {}
  return { up: g('UP'), load: g('LOAD'), mem: g('MEM'), disk: g('DISK'), app, apps };
}

function removalScript(c, otherDirs, deleteFiles) {
  if (!/^[a-zA-Z0-9_-]+$/.test(c.id)) throw new Error('Invalid bot profile ID.');
  const dir = path.posix.normalize(c.dir).replace(/\/$/, '') || '/';
  return `set -euo pipefail
APP=${q(c.app)}; DIR=${q(dir)}
cd "$HOME"
${deleteFiles ? `HOME_DIR=$(realpath -e -- "$HOME")
TARGET=$(realpath -m -- "$DIR")
[ "$TARGET" = "$DIR" ] || { echo 'Refusing file deletion through a symlink.'; exit 1; }
case "$TARGET" in "$HOME_DIR"/*) ;; *) echo 'File deletion requires a bot subfolder inside the SSH user home.'; exit 1;; esac
RELATIVE=\${TARGET#"$HOME_DIR"/}
case "$RELATIVE" in .*|bots|bots/.*) echo 'Refusing deletion of a shared or hidden home folder.'; exit 1;; esac
${otherDirs.map(other => `OTHER=$(realpath -m -- ${q(other)})
case "$TARGET/" in "$OTHER/"*) echo 'Folder overlaps another bot.'; exit 1;; esac
case "$OTHER/" in "$TARGET/"*) echo 'Folder contains another bot.'; exit 1;; esac`).join('\n')}
` : ''}
${c.managed ? `PANEL_DIR="$HOME/.bot-panel/${c.id}"
if [ -L "$HOME/.bot-panel" ] || [ -L "$PANEL_DIR" ]; then echo 'Refusing a symlinked panel configuration folder.'; exit 1; fi
` : ''}
PRESENT=$(pm2 jlist | node -e ${q(`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const apps=JSON.parse(s);if(!Array.isArray(apps))throw Error();process.stdout.write(apps.some(a=>a.name===${JSON.stringify(c.app)})?'yes':'no');}catch{console.error('Could not read the PM2 process list.');process.exitCode=1;}});`)})
if [ "$PRESENT" = yes ]; then pm2 delete "$APP"; fi
pm2 save --force
${c.managed ? `rm -f -- "$PANEL_DIR/ecosystem.config.cjs"
rmdir -- "$PANEL_DIR" 2>/dev/null || true` : ''}
${deleteFiles ? 'rm -rf -- "$TARGET"\necho "Removed bot files: $TARGET"' : 'echo "Kept bot files: $DIR"'}
echo "Removed PM2 app: $APP"
`;
}

// ---- HTTP ----
function createServer(store = storage, remote = ssh) {
let removing = false;
const activeRequests = new Set();
return http.createServer(async (req, res) => {
  try {
  const u = req.url.split('?')[0], host = req.headers.host;
  if (host !== `localhost:${req.socket.localPort}` && host !== `127.0.0.1:${req.socket.localPort}`) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method === 'GET') {
    if (u === '/api/config') return json(res, configView(store.read()));
    if (u === '/panel-ui.js' || u === '/dashboard.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript;charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, '../..', u.slice(1))));
    }
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, '../..', 'index.html')));
  }
  if (req.headers['x-panel'] !== '1') { res.writeHead(403); return res.end('Forbidden'); }
  if (removing) throw new Error('Bot removal is in progress. Wait before starting another action.');
  activeRequests.add(res);
  res.once('close', () => activeRequests.delete(res));
  if (u === '/api/upload') {
    const ch = []; for await (const x of req) ch.push(x);
    const data = Buffer.concat(ch), target = decodeURIComponent(req.headers['x-target'] || '');
    const c = resolveConfig(JSON.parse(decodeURIComponent(req.headers['x-cfg'] || '%7B%7D')), store), m = [c.token, encodeURIComponent(c.token || '')];
    res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-cache' });
    let code = 1;
    if (!c.host) res.write('✖ Set the host / IP in the sidebar first.\n');
    else if (!/^\/[\w.\/ @+-]+$/.test(target) || target.includes('..')) res.write('✖ Invalid destination "' + target + '". Use an absolute path (set the install folder in the sidebar).\n');
    else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), f = path.join(tmp, 'file');
      fs.writeFileSync(f, data); res.write(`• Uploading ${(data.length / 1024).toFixed(1)} KB to ${target}\n`);
      code = await ssh(c, 'mkdir -p ' + q(path.posix.dirname(target)), res, m) || await scp(c, f, target, res, m)
        || await ssh(c, (/\.env$/.test(target) ? 'chmod 600 ' + q(target) + '; ' : '') + 'ls -l ' + q(target), res, m);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    res.write(code ? `\n✖ Failed (exit ${code})\n` : '\n✔ Done\n'); return res.end();
  }
  const b = await body(req);
  if (removing) throw new Error('Bot removal is in progress. Wait before changing settings.');
  if (u === '/api/config') { const next = profiles.update(store.read(), b); store.write(next); return json(res, configView(next, b.botId || next.activeBotId)); }
  if (u === '/api/profiles') {
    let next = store.read();
    if (b.action === 'remove') {
      if (activeRequests.size > 1) throw new Error('Another panel request is active. Wait or cancel that action before removing a bot.');
      if (typeof b.id !== 'string' || !b.id) throw new Error('Choose a bot profile to remove.');
      const c = profiles.active(next, b.id);
      if (b.revision !== removalRevision(next, b.id)) throw new Error('Bot or server settings have changed. Close and reopen the removal dialog before confirming.');
      if (!['profile', 'uninstall', 'delete'].includes(b.mode)) throw new Error('Choose a removal mode.');
      if (b.confirmation !== c.app) throw new Error('Type the selected bot PM2 app name to confirm removal.');
      if (b.mode === 'delete' && b.deleteFilesConfirmed !== true) throw new Error('Confirm permanent deletion of all bot files, credentials and backups.');
      let output = '';
      removing = true;
      try {
        if (b.mode !== 'profile') {
          if (!c.host) throw new Error('Set the host / IP before server cleanup, or choose profile-only removal.');
          profiles.validate(next);
          const shell = removalScript(c, next.bots.filter(bot => bot.id !== c.id).map(bot => bot.dir), b.mode === 'delete');
          const cap = { write(s) { output = (output + s).slice(-65536); }, get destroyed() { return res.destroyed; },
            on(...args) { res.on(...args); }, removeListener(...args) { res.removeListener(...args); } };
          const code = await remote(c, shell, cap, [c.token, encodeURIComponent(c.token || '')]);
          if (code || res.destroyed) throw new Error('Server cleanup failed or was cancelled. The profile was kept for retry. Some server changes may already have completed.');
        }
        next = profiles.remove(store.read(), b.id);
        store.write(next);
        return json(res, { ...configView(next), output });
      } catch (e) {
        if (res.destroyed) return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message, output }));
      } finally { removing = false; }
    }
    if (b.action === 'add') next = profiles.add(next, b);
    else if (b.action === 'duplicate') next = profiles.duplicate(next, b);
    else if (b.action === 'select') { profiles.active(next, b.id); next.activeBotId = b.id; }
    else throw new Error('Unknown profile action');
    store.write(next); return json(res, configView(next));
  }
  if (u === '/api/status') return json(res, await status(resolveConfig(b.cfg, store), res));
  if (u !== '/api/run') { res.writeHead(404); return res.end(); }

  const c = resolveConfig(b.cfg, store), a = b.action, p = b.params || {}, m = [c.token, encodeURIComponent(c.token || '')];
  if (a === 'solo') c.otherApps = store.read().bots.filter(bot => bot.id !== c.botId).map(bot => bot.app);
  res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  let code = 0;
  if (a === 'fixkey') {
    code = await run('icacls', [c.key, '/inheritance:r'], res, m) || await run('icacls', [c.key, '/grant:r', os.userInfo().username + ':R'], res, m);
  } else if (!c.host) { res.write('✖ Set the host / IP in the sidebar first.\n'); code = 1; }
  else if (a === 'env') {
    if (!c.localEnv || !fs.existsSync(c.localEnv)) { res.write('✖ Local .env file not found. Set its path in the sidebar.\n'); code = 1; }
    else code = await scp(c, c.localEnv, c.dir + '/.env', res, m) || await ssh(c, H(c) + 'chmod 600 "$DIR/.env"; echo "✔ .env uploaded"', res, m);
  } else if (a === 'code') {
    if (!c.localBot || !fs.existsSync(c.localBot)) { res.write('✖ Local bot folder not found. Set its path in the sidebar.\n'); code = 1; }
    else {
      const tgz = path.join(os.tmpdir(), 'bot-upload.tgz'); res.write('• Packing ' + c.localBot + '\n');
      code = await run('tar', ['--exclude=node_modules', '--exclude=.git', '--exclude=dist', '--exclude=.env', '--exclude=*.db*', '-czf', tgz, '-C', c.localBot, '.'], res, m)
        || await scp(c, tgz, '/tmp/bot-upload.tgz', res, m)
        || await ssh(c, H(c) + 'mkdir -p "$DIR" && tar xzf /tmp/bot-upload.tgz -C "$DIR" && rm /tmp/bot-upload.tgz\n' + deploy(c, false), res, m);
    }
  } else {
    const s = script(c, a, p);
    if (s) code = await ssh(c, s, res, m); else { res.write('✖ Unknown action\n'); code = 1; }
  }
  if (code === 137) res.write('\n⚠ Exit 137 means SIGKILL, often caused by running out of memory. Once SSH is reachable, use Prepare memory, then retry. Check kernel OOM logs to confirm.\n');
  if (code === 255) res.write('\n⚠ SSH failed. If it timed out, verify the VM is running, its public IP is current, and Oracle ingress allows your IP on the configured SSH port. An overloaded VM may need recovery through the Oracle console.\n');
  res.write(code ? `\n✖ Failed (exit ${code})\n` : '\n✔ Done\n'); res.end();
  } catch (e) {
    if (res.destroyed) return;
    if (res.headersSent) res.end('\n✖ ' + e.message + '\n');
    else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  }
}); }
function startServer(port = PORT, log = console.log) {
  const server = createServer();
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use. If the panel is already running, use its browser tab. To load updated server code, close the original panel terminal with Ctrl+C, then launch again. If no panel is running, another program is using this port.`);
    } else {
      log('Could not start the panel: ' + error.message); process.exitCode = 1;
    }
  });
  return server.listen(port, '127.0.0.1', () => log(`Control panel running at http://localhost:${server.address().port}  (Ctrl+C to stop)`));
}
if (require.main === module) startServer();
module.exports = { run, script, createServer, startServer, opts, ecosystem, removalScript };
