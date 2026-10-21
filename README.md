# Oracle Discord Bot Control Panel

A **local Windows dashboard** for installing, deploying, and managing multiple Discord bots on an **Oracle Cloud Linux VM**. It controls the VM over SSH/SCP and uses **PM2** for bot processes. This project is a control panel, **not a Discord bot**, and it does not need to run on the Oracle VM.

This repository contains the panel source and safe examples. Actual `config.json` settings, backups, SSH keys, bot credentials, and saved output stay local and are excluded by `.gitignore`.

## Documentation index

- [Architecture & internal data flows](docs/ARCHITECTURE.md) — functions, components, HTTP endpoints, SSH/SCP, status, and uploads.
- [Operations & button reference](docs/OPERATIONS.md) — workflows, every action, deployment, PM2, logs, backups, and recovery.
- [Configuration & bot profiles](docs/CONFIGURATION.md) — schema, defaults, profiles, migration, and PM2 launch rules.
- [Security & current limitations](docs/SECURITY.md) — sensitive data, access model, protection boundaries, and code-backed issues.
- [Development & tests](docs/DEVELOPMENT.md) — local development, regression coverage, extending the panel.

## Requirements

**On the Windows computer running the panel**

- Node.js **18 or newer**. No local npm dependencies or `npm install` are needed for the panel itself.
- OpenSSH client commands `ssh` and `scp` available in `PATH` (typically Windows built-in OpenSSH).
- `tar` in `PATH` for **Upload code & deploy**.
- A private SSH key authorized for the selected Linux account on the VM; no password authentication workflow is implemented by the panel.
- A modern browser able to open `http://localhost:4321`.

**On the Oracle Linux VM**

- Working SSH access to the selected account (`opc` is the code's default SSH user).
- Bash and standard Linux utilities (including `base64`) for remote scripts; `sudo` is needed for system setup, memory preparation, updates, and reboot.
- Git, Node.js, npm, and PM2 for normal bot lifecycle operations. **Initial setup** can install these on supported `dnf`/`apt-get` systems, using Node.js 22.
- Sufficient disk, memory, and access to the required package and Git sources.

## Start the panel

1. Clone or download the entire repository into a local Windows directory. Keep `index.html`, `dashboard.js`, and `panel-ui.js` alongside `server.cjs` and `profiles.cjs`; the browser needs both JavaScript files. For a fresh installation, copy `config.example.json` to `config.json` to start with a managed example bot. Keep an existing `config.json` when updating; it contains your working profiles and credentials.
2. Double-click `Launch-Control-Panel.cmd` or open CMD in that folder and run `node server.cjs`. Without a configuration file, the panel uses generic defaults and saves settings when you edit them.
3. Browse to **http://localhost:4321**. The launcher opens this URL automatically.
4. Fill out the **Server** fields (host/IP, SSH user, port, and **absolute Windows path to your private SSH key**). Values save to `config.json` when fields change; check the saved indicator.
5. Select **Test connection**. Configure the **selected bot**'s repository, folder, and PM2 app name. Expand **Build commands & local files** for optional build/sync commands, the entry file, and Windows upload paths.
6. To prepare an unconfigured VM, run **Initial setup**; to add a bot to an already-configured VM, use **Add bot → Create & prepare** (or **Prepare bot files**).
7. Upload the bot's `.env` credentials, if required by that bot; then choose **Pull & deploy**, **Deploy current files**, or **Upload code & deploy** according to where its code comes from.
8. Check **PM2 status** and **Fetch logs**. Use **Refresh now** for dashboard readings, or leave automatic refresh enabled for a check every 30 seconds. The status note shows when the last check completed or failed.

**After changing backend files:** close the old panel terminal with `Ctrl+C`, launch it again, and refresh the browser. A second copy cannot use port 4321 while the first is running.

## Architecture at a glance

```text
Windows laptop/desktop
  Launch-Control-Panel.cmd
             |
             v
  server.cjs (Node.js HTTP on 127.0.0.1:4321)
    |-- serves index.html and its browser JavaScript
    |-- profiles.cjs <--> config.json (private local settings)
    |-- ssh.exe ------> Oracle Linux VM: bash, git, npm, PM2, sudo
    |-- scp.exe ------> Oracle Linux VM: .env and uploaded files
    `-- tar.exe ------> archive local bot source before SCP
                                      |
                                      v
                         /home/<user>/... bot folders
                           |-- Bot 1 (PM2 app)
                           `-- Bot 2 (different PM2 app)
```

The **browser** controls the local HTTP service; the **local Node.js service** is the component that launches SSH/SCP. The dashboard is **not** hosted on the VM. The panel binds to `127.0.0.1` and the default port is `4321`.

## Multi-bot model

- A single `config.json` stores **shared** SSH connection settings and GitHub token (`server`), plus a list of independent bot settings (`bots`) and the selected bot's ID (`activeBotId`).
- Each bot must use a **unique PM2 app name** and a **separate non-nested absolute Linux install folder**.
- Selecting another bot changes which bot the actions, uploads, logs, and PM2 status target; it does **not** stop a previously running bot.
- **Start** can leave several bots running. **Stop others & start** stops the other PM2 app names present in the panel's saved profiles first; it is not a global `pm2 stop all`.
- The original migrated profile (`legacy`) is **unmanaged** and expects its repository's own `ecosystem.config.cjs`. Newly added **managed** profiles generate launch configuration at `~/.bot-panel/<profile-id>/ecosystem.config.cjs`.

For exact behavior of generated launch files, see [Configuration](docs/CONFIGURATION.md).

## Dashboard controls

- **All bots** searches saved profiles by display name or PM2 app name. Counts cover saved profiles only: online, offline, or unchecked. Unrelated PM2 processes are not included.
- **Duplicate setup** saves and selects a new managed profile with its own UUID, PM2 name, and install folder. It copies repository, branch, build command, command-sync command, and entry file; the dialog can change the name, repository, and entry file. Local `.env`/source paths are cleared. It copies no bot files or `.env` credentials and starts no SSH or preparation action. Use **Prepare bot files**, upload separate credentials, then deploy when ready.
- **Refresh now** and the freshness note apply to PM2/server measurements. Failed checks clear previous readings; changing the connection, selected bot, or PM2 app also clears readings until another check. These are not Discord connectivity or application-health checks.
- The activity bar shows the action, selected bot, elapsed time, and final **Completed**, **Failed**, **Cancelled**, or **Incomplete — check output** result. HTTP 200 alone is not a successful deployment; completion depends on the final streamed result.
- Output has local search, **Errors only**, **Follow output**, and **Jump to latest** controls. **Copy all** and **Save all** include all retained output, including lines hidden by filters. At most 5,000 lines are retained in the browser; **Clear** removes them. Filters do not change remote PM2 logs.
- If settings cannot load, start/restart the local panel and use **Retry loading settings**. The save indicator near the top of the sidebar shows pending saves and failures.

## Remove old bots

Select the old bot, click **Remove**, and choose the scope in the **Remove bot** dialog:

| Choice | Effect |
| --- | --- |
| **Saved profile only** (default) | Removes the local profile; the server process and all files remain. Works without SSH. |
| **Profile and PM2 process** | Stops/removes that exact PM2 app and saves the updated startup list. Keeps the bot's install folder. |
| **Profile, PM2 process and all bot files** | Also permanently deletes the entire install folder, including `.env`, databases, and in-folder backups. Requires the extra checkbox. |

Every choice requires typing the bot's PM2 app name. Check the displayed name and folder first. Server cleanup keeps the profile if SSH or cleanup fails, so you can retry; completed remote changes are not rolled back. Removal waits for other requests to finish and rejects confirmations if bot or connection settings changed after the dialog opened.

File deletion is restricted to a bot subfolder inside the SSH user's home. The home itself, the shared `bots` folder, hidden home folders, symlinked paths, and folders overlapping other saved bots are refused. For bots installed elsewhere, use the option that keeps files and manage that folder separately. No live bot is removed merely by updating this panel.

Removing the last bot leaves an empty fleet and retains shared connection settings. Use **Add bot** to begin again.

## Choose the right deployment method

| Action | Use it when | Important behavior |
| --- | --- | --- |
| **Initial setup** | VM needs Node, PM2, Git, and tooling | Installs OS packages/Node 22/PM2, prepares repo or folder; requires sudo |
| **Prepare bot files** | A saved profile needs its folder/config | Can clone a configured repo; creates `.env` placeholder only if absent |
| **Clone / update repo** | Need to clone or update just the checkout | Does not install npm dependencies or launch the bot |
| **Pull & deploy** | Git checkout exists and remote branch should be pulled | Pulls with `--ff-only`, installs packages, builds/syncs, starts/reloads PM2 |
| **Deploy current files** | Checkout/file tree is already up to date | Same install/build/start workflow **without** `git pull` |
| **Upload code & deploy** | Source is on the Windows computer | Packs/uploads local source, extracts over remote folder, deploys without a pull |
| **Upload .env** | A known local `.env` path is configured | Uses SCP to place it at the selected bot's `DIR/.env` and chmod 600 |
| **Choose .env file and upload** | Prefer selecting a file in the browser | Uploads the chosen file to `DIR/.env` using the HTTP upload endpoint |

The panel does **not** infer the right build or slash-command deployment command for every repository; set these explicitly when needed. New managed bots default to `npm run build --if-present` and **no** command-sync command.

## Where things live

| Location | Contents |
| --- | --- |
| `config.example.json` | Safe starter configuration with empty credential and local-path fields |
| `.env.example` | Blank example bot environment variables; the panel itself does not load this file |
| `config.json` on Windows | **Sensitive.** SSH settings, absolute local paths, shared GitHub token, and all bot profiles |
| `config.json.pre-profiles.bak` on Windows | **Sensitive.** First-write backup of the existing config |
| Linux `DIR` per bot | Git checkout/app files, `.env`, `backups/`, and potentially repo PM2 config |
| Linux `~/.bot-panel/<profile-id>/ecosystem.config.cjs` | Generated PM2 config for **managed** bots |
| Linux `DIR/backups/` | Simple timestamped copies of top-level `*.db` files from **Back up database** |
| PM2's user process list | Runtime state monitored and controlled by the panel |

## Troubleshooting: most common cases

| Symptom | Check |
| --- | --- |
| `Permission denied (publickey,...)` | Correct **private** key file path, SSH username, saved panel config, and noninteractive SSH test (`BatchMode=yes`) |
| CMD SSH works but panel fails | Test the exact key path with `ssh -o BatchMode=yes -i "C:\\path\\key" -T opc@YOUR_VM "echo SSH_OK"`; restart panel and refresh browser |
| `Connection timed out` or SSH banner timeout | VM status/load, public IP, firewall/Oracle ingress, SSH daemon; use Oracle console recovery if VM cannot be reached |
| Panel says port 4321 is in use | Stop the previous panel process, then relaunch |
| PM2 app not found | Confirm the selected profile's PM2 **app name**; run Start if not running; check generated/repo ecosystem config |
| Deploy fails during `npm ci` | Inspect dependency/build output and resource usage; lockfile install is not automatically retried with `npm install` |
| Exit code **137** | Process received SIGKILL; out-of-memory is one possible explanation—check kernel OOM logs |
| Status says unreachable but bot works | Status separately runs a remote `pm2 jlist` and has a timeout; use Test connection and PM2 status |

See [Operations](docs/OPERATIONS.md) for steps and [Security](docs/SECURITY.md) for data handling.

## Test the local code

```sh
node --test
```

These are **local regression tests**, not live Oracle/Discord integration tests. They cover profiles, setup duplication, removal, generated PM2 configs, HTTP routes, fleet/output helpers, streamed action outcomes, process cancellation, deployment scripts, and port conflicts. Removal shell tests use disposable local folders and Git Bash on Windows (Bash on Linux/macOS); they skip if Bash is absent. See [Development](docs/DEVELOPMENT.md).

## Handling secrets

The included `.gitignore` excludes `config.json` and its backup/temp variants, SSH keys, real `.env` files, databases, backups, archives, and runtime logs. Commit `config.example.json` and `.env.example` with placeholder or empty values instead. The panel itself needs no `.env` file; each managed bot defines its own required environment variables.

Before publishing changes, review the staged files with `git diff --cached --name-only` and `git diff --cached`. Ignore rules do not remove secrets that are already in Git history. A GitHub token supplied for HTTPS cloning can also be recorded in the remote bot checkout's `origin` URL; treat that checkout's `.git/config` as sensitive. See [Security](docs/SECURITY.md) for the remaining limitations.

## Support boundaries

This tool is intended for a **trusted person controlling a local Windows machine and their own server**. Its HTTP API is not a multi-user application or a securely authenticated remote admin service. Avoid publishing the local port to the internet or using it on an untrusted/shared computer.

Current functionality and code-backed limitations are documented in detail under [`docs/`](docs/). No live SSH connection, Discord deployment, or cloud change is required to read or use this documentation.
