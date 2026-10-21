# Operator Guide: Buttons, Deployments, Logs, and Recovery

Operations below describe **what the supplied code runs**. Most buttons act on the **currently selected bot** and its `DIR` and PM2 `APP`; system operations affect the **entire Linux VM**. Before destructive actions, confirm the selected bot in the upper-left dashboard selector.

## Normal workflows

### First bot on a new Oracle VM

1. Set **Host/IP**, **SSH user**, **Port**, and **SSH private-key file** in the Windows sidebar.
2. Press **Test connection**. This checks remote OS version, remote identity, and whether `node`, `npm`, `pm2`, and `git` are installed.
3. Confirm repository URL, branch, install folder, and PM2 app name. Expand **Build commands & local files** for the build command, optional slash-command sync, entry file, and Windows upload paths.
4. Press **Initial setup**. This prepares memory if needed, installs OS requirements/Node.js 22/PM2, sets up PM2 startup, and clones/updates the repository or creates its folder.
5. **Upload .env** credentials required by the bot (either through file picker or configured local file path). A placeholder `.env` is not a working credentials file.
6. Press **Pull & deploy** (Git) or **Deploy current files** (non-Git). Monitor streamed output through the final success/failure line.
7. Verify **PM2 status** and **Fetch logs**. If the bot needs privileged actions or additional environment variables, configure them in its own project.

### Add another bot to an existing VM

1. Choose **Add bot** and enter a unique display name, optional repository URL, and optional entry script.
2. Click **Create & prepare**. The profile is saved first; the browser then attempts preparation when a host is set.
3. If automatic preparation fails, correct the issue and use **Prepare bot files** later. No rollback of the saved profile is automatic.
4. Verify its **Install folder**, **PM2 app name**, build/sync commands, and managed app entry file.
5. Upload **that bot's own `.env`**, then deploy. Switching to another profile does not stop this one.
6. Watch RAM/CPU with **Disk & memory**, the dashboard status cards, and **PM2 status** when running multiple bots.

### Duplicate a bot's setup

1. Select the source bot and choose **Duplicate setup**. Current sidebar edits are saved first.
2. Enter a name; the dialog starts with the source repository and entry file, which you can change or clear.
3. Submit **Duplicate setup**. The panel saves and selects a new managed profile with a new UUID, PM2 app name, and install folder. Repository, branch, build, command-sync, and entry-file settings are copied; the source remains unchanged.
4. Review the new target shown above the status cards. No SSH action runs, no bot files or `.env` are copied, and Windows `.env`/source paths are cleared. Set those local paths if needed, choose **Prepare bot files**, upload separate bot credentials, then deploy.

### Deploy changes from Git

**Pull & deploy** executes, in order, with `set -e`:

1. `cd "$DIR"` and prepare memory settings (see below).
2. `git pull --ff-only origin BRANCH` (fails rather than creating a merge commit if fast-forward is not possible).
3. `npm ci --include=dev --no-audit --no-fund` if `package-lock.json` or `npm-shrinkwrap.json` exists; otherwise `npm install --include=dev --no-audit --no-fund`.
4. Run configured `buildCmd`, if provided.
5. Run configured `cmdSyncCmd`, if provided. **This may change globally registered Discord commands if that is what your project script does**; the panel itself does not call Discord APIs.
6. Regenerate managed ecosystem configuration if needed, run `pm2 startOrReload ... --only "$APP" --update-env`, `pm2 save`, and `pm2 status`.

**Deploy current files** runs steps 1 and 3–6 without any Git pull. It still installs dependencies.

**Upload code & deploy** creates a local `.tgz`, excludes `node_modules`, `.git`, `dist`, `.env`, and `*.db*`, uploads it to `/tmp/bot-upload.tgz`, extracts it **over** the remote folder, removes the remote archive, then runs the **no-pull deployment**. Old remote files absent from the new archive are **not** automatically deleted. The local archive is stored at a fixed filename under the local temp directory and the code does not explicitly remove it afterwards.

### Remove an old bot

1. Select the bot and click **Remove**. Verify its display name, PM2 app name, and install folder in the **Remove bot** dialog.
2. Choose **Saved profile only** to forget the profile while preserving the running process and files; this works offline. Choose **Profile and PM2 process** to stop/remove the exact app, update PM2's saved startup list, and keep bot data.
3. To delete files as well, choose **Profile, PM2 process and all bot files** and check the explicit deletion acknowledgement. This removes the entire install folder, including `.env`, databases, and the folder's `backups/`. Make an independent backup first.
4. Type the exact PM2 app name and submit. Other profiles/processes are preserved. Removing the last bot is supported; shared settings remain and **Add bot** stays available.

File deletion only accepts a bot subfolder inside the SSH user's home. It refuses the home directory itself, the shared `bots` container, hidden home folders, symlinked paths, and overlap with another saved bot's folder. For an installation under `/opt`, `/srv`, or another location outside home, keep files and handle that folder separately.

PM2 uninstall checks the process list, removes the app if present, and uses `pm2 save --force`, including when it was the last app. Managed launch files at `~/.bot-panel/<profile-id>/ecosystem.config.cjs` are also cleaned up. A missing process/folder can be retried. If cleanup fails or the connection is cancelled, the profile stays; already-completed server changes are not undone. Reopen the dialog if settings changed, and wait/cancel any other panel action before removal.

## Button reference

### Bot

| Button | Exact effect | Notes |
| --- | --- | --- |
| **Start** | Managed: write profile PM2 config; `pm2 startOrReload CONFIG --only APP --update-env`; then `pm2 save`, `pm2 status` | Legacy uses repository's `ecosystem.config.cjs`. |
| **Stop** | `pm2 stop APP; pm2 save; pm2 status` | Preserves the app definition in PM2; does not delete checkout/files. |
| **Restart** | `pm2 restart APP --update-env; pm2 status` | Requires existing PM2 app; unlike Start, it does not regenerate config. |
| **Stop others & start** | For each **other saved bot** app name: `pm2 describe` then `pm2 stop` if present; `pm2 save`; start selected app; `pm2 save` | May leave others stopped if startup fails; unrelated PM2 apps not in profiles are not enumerated. |
| **PM2 status** | `pm2 status`, then first 30 lines of `pm2 describe APP` | Diagnostic only. |
| **Duplicate setup** | Copies selected deployment preferences into a new selected managed profile | Starts no SSH/preparation action; copies no credentials, bot files, or local upload paths. |
| **Remove** | Opens the scope/confirmation dialog described above | Profile-only by default; server uninstall and permanent file deletion are separate explicit choices. |

### Deploy / repository

| Button | Exact effect | Notes |
| --- | --- | --- |
| **Pull & deploy** | Pull, npm install, build, command sync, PM2 start/reload | Requires existing Git checkout and usable branch. |
| **Deploy current files** | Same except no Git pull | Works without Git if source is present. |
| **Update slash commands globally** | Run the profile's `cmdSyncCmd` from `DIR` | Empty command prints informational message; does **not** itself implement Discord sync. |
| **Upload .env** | SCP configured `localEnv` from Windows to `DIR/.env`; then `chmod 600` | Requires a valid local path. This **replaces** remote `.env` content. |
| **Choose .env file and upload** | Browser picks a file, sends raw bytes to `/api/upload`, writes as `DIR/.env`, chmod 600 | Does not depend on `localEnv` field. |
| **Upload code & deploy** | Tar Windows `localBot`, SCP, extract, then deploy current files | Source excludes local `.env`, Git, database matches, installed modules, and build output. |
| **Show .env keys** | `sed -E 's/=.*/=***/' "$DIR/.env"` | Intended to mask values after `=`; still exposes **key names** and some unusual non-`=` lines. |
| **Clone / update repo** | If Git exists: set origin URL, fetch, try branch checkout, fast-forward pull. If not: clone or initialize checkout in folder. Then scaffold. | May fail on conflicting existing files. Git URL can contain a token. |
| **Prepare bot files** | If configured repo and no Git checkout: clone into an empty/non-conflicting folder. Otherwise ensure directory exists. Scaffold. | Preserves existing `.env`. |
| **Repo status** | `git remote -v`, `git status -sb`, latest 5 commits | Can display repository metadata; output masking is only best-effort. |
| **Reset to remote** | `git fetch`, `git reset --hard origin/BRANCH`, `git clean -fd` with exclusions | **Destructive.** Exceptions include `.env`, `*.db*`, and `backups/`, not arbitrary extra files. |

**Reset to remote warning:** The reset overwrites changes to **tracked** files, even if you hoped to preserve local modifications. `git clean -fd` removes eligible **untracked** files. Never rely on the exclusion list as a complete backup strategy.

### VM-wide server actions

| Button | Exact effect | Scope |
| --- | --- | --- |
| **Test connection** | Print identity/OS/kernel, verify `node`, `npm`, `pm2`, `git` availability | Read-only to the VM. |
| **Initial setup** | Prepare low-memory swap, install Git/build tools/Node.js 22/PM2, attempt PM2 systemd startup, clone/update repo or create folder | Entire VM packages/PM2 + selected folder. |
| **Update OS packages** | `dnf upgrade --refresh` or `apt-get update && apt-get upgrade` | Entire VM; may require reboot. |
| **Update npm & PM2** | Prepare memory, update **global** npm and PM2 (`@latest`), run `pm2 update` | Affects all bots using those tools. |
| **Disk & memory** | `uptime`, `free -h`, `df -h /`, size of selected DIR, top memory processes | Read-only. |
| **Prepare memory** | Conditional creation/activation of `/var/swap.bot-panel` | VM swap config; persists via `/etc/fstab` if created. |
| **Back up database** | Copy top-level `DIR/*.db` files to timestamped `DIR/backups/*.db` | Selected bot folder only; no offsite copy. |
| **Reboot server** | `sudo reboot` | Disconnects all bots on the VM until they start again. |
| **Run command** | Execute the exact custom shell text typed in the dashboard | Runs as configured SSH user; use only trusted commands. |

### Logs and browser controls

| Control | Behavior |
| --- | --- |
| **Fetch logs** | `pm2 logs APP --nostream --raw --lines N` with optional `--err` and grep filter; bounded snapshot. |
| **Follow live** | `timeout 900 pm2 logs APP --raw --lines N` (up to **15 minutes**), optional error-only/grep filter. |
| **Flush logs** | `pm2 flush APP` deletes PM2's existing log history for that app; confirmation shown in browser. |
| **Log line count** | Select 100/200/500/1000/3000 in frontend. Default is 200. |
| **Errors only** in Logs | Requests `--err` from PM2 logs. Applies when Fetch logs/Follow live starts. |
| **Filter remote log text** | Adds case-insensitive line filtering with `grep -i --line-buffered`. Applies to the remote log request. |
| **Cancel action** | Enabled during cancellable actions/uploads. Aborts the browser request; the server listens for response closure and tries to kill the running child. |
| **Search output / Errors only** in Output | Filter lines already retained in the browser without discarding them or changing remote logs. Error matching uses error-like text, not a separate stderr channel. |
| **Follow output / Jump to latest** | Follow scrolls new output when near the bottom; scrolling up lets you review earlier lines. Jump returns to the latest line and enables following. |
| **Copy all / Save all** | Include every retained browser-output line, even when filters hide some. Save downloads a local text file. At most 5,000 lines are retained; older lines are dropped. |
| **Clear** | Removes retained browser output, without flushing PM2 logs. |
| **Find a bot** | Case-insensitive search of saved profile display names and PM2 app names; does not change selection or start/stop bots. |
| **Refresh now** | Requests dashboard status immediately when a bot/host is set and the panel is available for a status check. |
| **Refresh every 30s** | When checked, tries a status refresh every 30 seconds; it avoids overlapping checks, busy actions, and open dialogs. |
| **Retry loading settings** | Appears after initial loading fails. Retry once the local panel is running; bot actions remain unavailable until settings load. |

### Reading status and activity

**All bots** counts only the saved profiles, including profiles hidden by search. A successful check counts an exact PM2 app match with state `online` as online; missing or other states count as offline. Until a usable status result is available, profiles are unchecked. Unrelated PM2 processes do not enter these counts.

The status note shows **Checking status** while a request runs, then **Last checked** or **Last check failed** with a timestamp. Failed checks clear old metric cards and mark the selected bot unreachable. Editing connection fields or the PM2 app, or switching the selected bot, clears readings until another check. These figures describe PM2 and VM resources; they do not establish that a bot is connected to Discord or ready to serve commands.

The activity bar shows the running action and bot plus elapsed time, then **Completed**, **Failed**, **Cancelled**, or **Incomplete — check output**. Actions and uploads require the final streamed `✔ Done` or `✖ Failed (exit N)` result to establish their outcome; an HTTP 200 or an earlier success message is insufficient. A stream that ends without the final result is incomplete. Inspect output and remote state before retrying, because cancellation, failure, or a dropped connection does not roll back changes that already ran.

## Low-memory Oracle VMs

Before setup, deployment, or npm/PM2 update, the code inspects `/proc/meminfo`:

- If detected RAM is **under 2 GiB** and swap is **under 1 GiB**, it tries to create a **2 GiB** `/var/swap.bot-panel` file using sudo. It requires **at least 3 GiB free on `/var`**, creates mode `600`, then runs `mkswap`, `swapon`, and adds an entry to `/etc/fstab`.
- If that file already exists but is not active, preparation **stops** rather than overwriting it.
- On VMs under 2 GiB RAM, it sets `NODE_OPTIONS=--max-old-space-size=512` **only when `NODE_OPTIONS` is not already set**, and uses single-job native-build settings.
- When RAM is under **768 MiB**, it prints an extra warning.

Swap can reduce OOM risk, but it does not guarantee an npm build will fit. Installing packages may be slow when RAM is low.

## Failure diagnosis

### SSH authentication fails, but CMD works

First compare the precise key, user, and port used by the panel. This is a **Windows CMD** diagnostic using placeholder values:

```bat
ssh -vvv -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "C:\Users\Example\.ssh\oracle.key" -T opc@YOUR_VM "echo SSH_OK"
```

A successful `SSH_OK` proves the key can authenticate in noninteractive mode. If the panel still fails, check the active bot/sidebar values (the browser sends current values directly), the `config.json` saved value, and which copy of `server.cjs` is running. Restart the old panel process before retesting. Never paste SSH **private key contents** into the dashboard; the field is for its **local filename**.

### VM is reachable but PM2 status is blank/unreachable

- **Test connection** confirms SSH and tools.
- **PM2 status** checks PM2 itself.
- Status uses `pm2 jlist` plus tagged shell output; its parser can fail if expected output is missing or malformed.
- Status times out in **45 seconds** on the server and is aborted after **50 seconds** by the browser; longer setup/deploy commands have no overall timeout in `run()`.

### Exit code 137 / possible out-of-memory

Exit 137 corresponds to a process receiving SIGKILL; OOM is a common—but not the only—cause. On the VM, review:

```sh
free -h
sudo journalctl -k -b | grep -Ei 'out of memory|oom|killed process'
```

For a previous boot, `-b -1` may work when historical journal logs exist. If the VM no longer answers SSH, use Oracle Cloud console/recovery tools rather than relying on the local panel to revive an unreachable server.

## Backups and downtime expectations

- **Back up database** is a simple file-copy convenience. It copies only `*.db` files in the **top level** of the selected install folder. It is **not** a transaction-consistent database snapshot and does not cover nested databases, non-`.db` formats, attachments, `.env`, or remote/offsite storage.
- `stop`, `restart`, `resetrepo`, `flush`, system updates, and `reboot` can interrupt service or discard data. The browser asks for confirmation on selected actions, but that is not a replacement for backups and validation.
- Deploy uses `pm2 startOrReload`, not a formal health-checked rollout or rollback system. Verify application-specific readiness through PM2 logs and your bot's normal checks.
