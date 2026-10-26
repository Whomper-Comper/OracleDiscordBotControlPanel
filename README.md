# 100% AI SLOP

# Oracle Discord Bot Control Panel

A **local Windows dashboard** for deploying and managing Discord bots on an Oracle Cloud Linux VM over SSH/SCP and PM2. The backend is **Rust**, with the existing HTML/JavaScript dashboard embedded in a portable executable. This panel runs on your Windows PC, not on the VM.

## Run the Windows executable

1. Download `OracleBotControlPanel-windows-x64.zip` from [GitHub Releases](https://github.com/Whomper-Comper/OracleDiscordBotControlPanel/releases), or build it below. Extract the ZIP into a writable user folder.
2. Keep your existing `config.json` beside `oracle-bot-panel.exe` when upgrading. For a new installation, optionally copy `config.example.json` to `config.json`. Private settings are never packaged.
3. Double-click the EXE or `Launch-Control-Panel.cmd`. It opens **http://localhost:4321** after binding successfully. Keep the terminal open; Ctrl+C stops the panel.
4. Enter the server host, SSH user/port and local private-key filename (or leave it blank for SSH agent/default identities). Use **Test connection**, then set the selected bot's repository, folder and unique PM2 app name.
5. Use **Initial setup** for a fresh VM or **Add bot → Create & prepare** for an existing VM. Upload each bot's own .env, deploy, then check PM2 status and logs.

**Running the EXE requires no local Node.js, Rust, npm install, frontend build or webview runtime.** Windows `ssh`, `scp` and `tar` must be on PATH for remote operations. SSH must work without interactive password/passphrase prompts, typically through an agent. Node/npm/PM2 remain requirements on the VM; Initial setup installs the usual tooling on supported dnf/apt-get systems.

All UI assets and remote templates are embedded. The default settings path is **config.json beside the executable**, regardless of the working directory. Use a writable folder, or choose another location:

```powershell
.\oracle-bot-panel.exe --help
.\oracle-bot-panel.exe --config C:\private\panel-config.json --port 4322 --no-browser
```

The listener always binds to **127.0.0.1**. This is a trusted local administrator tool, not an authenticated public service. Do not expose it through public tunnels or proxies.

## Build and package

Install stable Rust and its native linker prerequisites. Windows MSVC builds normally need Visual Studio C++ Build Tools and the Windows SDK.

Automated contributors must ask before rebuilding the release EXE; routine source checks and tests do not need build approval.

```powershell
cargo test --locked
cargo build --release --locked
.\scripts\package.ps1
```

Outputs:

- `target/release/oracle-bot-panel.exe` — release executable.
- `dist/oracle-bot-panel.exe` — portable copy.
- `dist/OracleBotControlPanel-windows-x64.zip` — EXE, launcher, safe examples and docs.

The repository launcher passes root config.json explicitly when using target/release. For development use `cargo run -- --config ./config.json --no-browser`. The package script accepts `-Target x86_64-pc-windows-msvc` (or an installed GNU target) and `-SkipBuild` to package an already verified matching build. GitHub Actions runs checks on pushes and pull requests; packaging requires an approved manual workflow run.

## Documentation

- [Architecture and API](docs/ARCHITECTURE.md)
- [Operations and every button](docs/OPERATIONS.md)
- [Configuration and profiles](docs/CONFIGURATION.md)
- [Security and limitations](docs/SECURITY.md)
- [Development and tests](docs/DEVELOPMENT.md)

## Choose a deployment

| Action | Use when | Behavior |
| --- | --- | --- |
| Initial setup | VM needs Node/Git/PM2 | System tooling, memory preparation and selected bot files; sudo required |
| Prepare bot files | Profile needs folder/config | Can clone repository; preserves existing .env |
| Clone / update repo | Need checkout changes only | No install/build/start |
| Pull & deploy | Git branch should be pulled | Fast-forward pull, install, build, optional sync, PM2 start/reload |
| Deploy current files | Remote files are current | Same workflow without pulling |
| Upload code & deploy | Source is on Windows | Unique temporary archive, SCP, extract over folder, deploy without pulling |
| Upload .env | Credentials are ready | Upload to selected bot and chmod 600 |

Configure build/sync commands for each bot. New managed profiles default to `npm run build --if-present` and no command sync.

## Multiple bots and removal

SSH settings/token are shared; each bot has a unique PM2 name and separate non-nested folder. Selecting a bot does not stop others. **Stop others & start** affects other saved profiles, not every PM2 process.

**Duplicate setup** copies deployment preferences into a new managed profile. It copies no files, credentials or local paths and runs no SSH action. Prepare and deploy separately.

**Remove** defaults to forgetting the profile. Other scopes remove the exact PM2 app or also all bot files, including .env, databases and in-folder backups. Typed confirmation is required; deletion requires another acknowledgement and refuses home/shared folders, symlinks and overlap with other profiles. Cleanup failure keeps the profile for retry, but remote steps cannot be rolled back. Removing the final bot leaves an empty fleet with shared settings retained.

Legacy profiles retain repository PM2 configs. Managed profiles use `~/.bot-panel/<id>/ecosystem.config.cjs`, choosing explicit entry file, matching/sole repository app, then npm-start fallback.

## Output and settings

Local key, `.env` and source-folder paths accept quoted paths, leading `~` and case-insensitive `%USERPROFILE%`. Relative paths resolve from the config file's folder when used, while saved settings retain their portable form. Previews below these fields show the resolved location, missing/wrong-type errors and a warning for `.pub` keys. Only paths needed by an action are validated; unused upload paths do not block status checks.

Settings save on field changes; check the save indicator. Only the final streamed `✔ Done` establishes success. HTTP 200 alone does not. Cancel stops local subprocess work, not completed remote changes. Output filters hide lines; Copy all/Save all include all retained lines, up to 5,000. Status refreshes every 30 seconds and measures SSH/PM2, not Discord readiness.

**Remember preferences** is off by default. Opt in to remember log line count, both **Errors only** controls and auto-refresh in this browser. Turning it off clears saved choices while keeping the current view. Commands, searches, output and credentials are never stored as UI preferences. In **Run command**, Up/Down recalls up to 50 commands for this page session and restores your unfinished draft; blank commands are blocked.

Browser uploads stream to temporary disk files with a **64 MiB limit per file**. Action POST operations are serialized; conflicting work returns an error after a short wait. Mutations cancel background status checks. Read-only path previews run independently of action locking and cancellation.

## Troubleshooting and private data

For port conflicts stop the previous panel or use --port. For save errors use a writable config folder. For SSH errors check the exact private-key path, user, port, agent and Oracle ingress. Exit 137 means SIGKILL, possibly remote OOM; inspect kernel logs. Missing settings usually mean the config was not copied beside the EXE or selected with --config.

Configuration, backups, SSH keys, real .env, databases and logs remain private local files excluded by Git. A GitHub token can still persist in remote Git origin URLs; see Security. Review staged files before publishing; ignore rules cannot remove secrets from existing history.

Source lives in src/, templates/ and root HTML/JS. The original Node backend under tests/legacy is only a test oracle; the application never invokes or ships it.
