# Architecture and Source Walkthrough

This document maps the **supplied implementation**, not a proposed design. The application is a small, dependency-free CommonJS Node.js HTTP server with an HTML/JavaScript browser frontend. It uses CLI programs (`ssh`, `scp`, `tar`) rather than a Node SSH library.

## File responsibility map

| File | Main responsibility | Important names in source |
| --- | --- | --- |
| `Launch-Control-Panel.cmd` | Move to launcher directory, check `node`, open browser, start server | `where node`, `start`, `node server.cjs` |
| `server.cjs` | HTTP API, SSH/SCP, remote shell generation, PM2, status, uploads | `createServer`, `run`, `ssh`, `scp`, `script`, `deploy`, `status`, `ecosystem` |
| `profiles.cjs` | Config migration, isolated profiles, setup duplication, validation, persistent storage | `normalize`, `active`, `update`, `add`, `duplicate`, `validate`, `repository` |
| `index.html` | Dashboard markup, styling, sidebar, dialogs, cards, fleet and output controls | Loads `panel-ui.js`, then `dashboard.js` |
| `dashboard.js` | Browser event handlers, saved settings, profile workflows, actions/uploads, activity, output, status | `cfg`, `run`, `upload`, `save`, `st`, `selectBot`, `loadConfig` |
| `panel-ui.js` | Dependency-free helpers shared by browser code and local tests | `matchesBot`, `fleetSummary`, `sameStatusTarget`, `matchesOutput`, `readActionResponse` |
| `config.json` | Persistent runtime state and **secrets**, not source code | `version`, `server`, `activeBotId`, `bots` |
| `server.test.cjs` | Process/server/script-level regression tests | Node `node:test` |
| `profiles.test.cjs` | Profile migration, uniqueness, PM2 config and API tests | Node `node:test` |
| `removal.test.cjs` | Removal, stale confirmations, concurrency, empty fleets, and disposable shell cleanup tests | Node `node:test`, Git Bash/Bash |
| `duplication.test.cjs` | Copy isolation, allowed settings/overrides, duplicate API persistence, exact script routes | Node `node:test`, temporary fixtures and loopback HTTP |
| `panel-ui.test.cjs` | Fleet/output filters, status-target matching, streaming decoding and final outcomes | Node `node:test`, in-memory response fixtures |

## Initialization and request flow

1. `Launch-Control-Panel.cmd` changes to its own directory, opens `http://localhost:4321`, and runs `node server.cjs`.
2. `server.cjs` sets up `profiles.repository(CFG, DEF)` and binds the HTTP server to **127.0.0.1:4321**.
3. A browser `GET /` receives `index.html`, which loads the exact `/panel-ui.js` and `/dashboard.js` script routes. A browser `GET /api/config` receives a **merged active profile**, all bot profiles, and `activeBotId` (including sensitive configuration fields).
4. The browser populates the sidebar and starts an optional status refresh. Sidebar edits invoke `POST /api/config` and are queued in the frontend so saves occur in order. Loading failures expose a Retry control; saving states appear near the top of the sidebar.
5. Action buttons send `POST /api/run` with `{action, params, cfg}`. The server overlays whitelisted incoming fields onto saved configuration in memory for that action via `resolveConfig`, then generates an appropriate remote shell script.
6. The server starts `ssh.exe` to execute the generated script on the VM, or `scp.exe`/`tar.exe` when uploading. Stdout/stderr are streamed back as plain text to the browser output console.

**Configuration at action time:** `dashboard.js` saves current settings before starting an action or upload, then sends its captured configuration snapshot. The `/api/run` endpoint itself resolves the supplied whitelisted `cfg` in memory; direct API clients must separately persist settings through `/api/config` if desired.

## Backend mechanics

### `run(cmd, args, res, mask, cwd, timeoutMs)`

- Spawns the requested process with `windowsHide: true`, `stdin` ignored, and stdout/stderr piped.
- Streams both output streams to the HTTP response and replaces known token strings (`mask`) with `***` before writing.
- On response `close`, requests child-process termination; removes the listener on settlement.
- Supports a timeout used for status checking, returning code `124` after it kills a stalled process.
- Returns numeric exit code; start failures are reported as messages and nonzero results.
- **Caveat:** Masking is per output chunk, not a guarantee against secrets split between chunks or leaked elsewhere.

### `ssh`, `scp`, `opts`, `wrap`

Remote shell actions use:

```text
ssh [-i KEY_IF_CONFIGURED] -p PORT
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
  -o ConnectTimeout=30
  -o ConnectionAttempts=1
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=9
  -T USER@HOST <encoded-shell-command>
```

- An explicit `-i` is included only if the active config's `key` is nonempty. Windows OpenSSH defaults/agents may otherwise apply.
- `BatchMode=yes` prevents interactive password/passphrase prompts.
- `-T` disables remote pseudo-terminal allocation.
- `wrap()` Base64-encodes the remote script, then invokes `bash -lc` on the remote end. This makes transferring complex shell strings more reliable; **it is encoding, not encryption or sanitization**.
- `scp` uses the same identity/connection flags with `-P PORT` and sends one local file to `USER@HOST:remote-path`.
- Remote scripts require a Linux shell with `bash` and `base64` available.

### `H(c)`, `script(c, action, params)`, `deploy(c, pull)`

- `H(c)` prepares remote environment (`GIT_TERMINAL_PROMPT=0`, `DEBIAN_FRONTEND=noninteractive`), chooses `dnf` when present or `apt-get` otherwise, defines `APP` and `DIR`, and tries to enter the bot folder.
- `script(...)` selects the requested action and builds its shell script. It returns `null` for an unknown action.
- `deploy(c, true)` performs Git pull, dependency install, build, slash-command sync, PM2 start/reload, `pm2 save`, and status display. `deploy(c, false)` omits the Git pull.
- Arbitrary configured `buildCmd`, `cmdSyncCmd`, and `custom` commands run as remote shell text. They are **trusted administrator inputs**, not safe commands to accept from strangers.

## HTTP API contract

**All routes are on the local server.** For writes/actions the frontend includes `X-Panel: 1`. The server also checks that the incoming `Host` header equals localhost or 127.0.0.1 plus its bound port. This is a minimal local-only restriction, **not a full authentication mechanism**.

| Method/endpoint | Request | Response and behavior |
| --- | --- | --- |
| `GET /` | None | `text/html`, contents of `index.html`. Other unrecognized GET paths also fall through to the HTML page. |
| `GET /panel-ui.js`, `GET /dashboard.js` | None | `text/javascript;charset=utf-8`, contents of those two exact local browser-script files. This is an explicit allowlist, not an arbitrary static-file route. |
| `GET /api/config` | None | JSON merged active profile, `bots`, `activeBotId`, `removalRevision`; **sensitive values are included**. With an empty fleet, returns shared settings without an active bot. |
| `POST /api/config` | JSON of changed active profile fields, optionally `botId` | Validates and persists whitelisted fields; returns new JSON config view. |
| `POST /api/profiles` | `{ "action": "add", "name": "...", "repo"?: "...", "entryFile"?: "..." }` or `{ "action": "select", "id": "..." }` | Adds/selects a profile, persists, returns config view. **Add** alone does not provision remote files; frontend calls `prepare` afterwards if host is set. |
| `POST /api/profiles` | `{ "action": "duplicate", "id": "SOURCE_ID", "name": "...", "repo"?: "...", "entryFile"?: "..." }` | Requires an explicit existing source and nonempty string name; optional overrides must be strings. Copies saved deployment preferences into a new managed profile with a unique UUID/app/folder and empty local paths, saves/selects it, and returns config view. No SSH or preparation follows. |
| `POST /api/profiles` | `{ "action": "remove", "id": "...", "revision": "...", "mode": "profile" / "uninstall" / "delete", "confirmation": "PM2_APP", "deleteFilesConfirmed": true }` | Removes a profile. `revision` comes from the config response when the dialog opens. `uninstall`/`delete` run server cleanup using saved settings first; `delete` requires the extra boolean. Returns the new config view and captured `output`; failures return HTTP 400 with `error` and any `output`. |
| `POST /api/status` | `{ "cfg": { ... } }` | JSON `{up,load,mem,disk,app,apps}` or `{error}`. |
| `POST /api/run` | `{ "action": "deploy", "params": {}, "cfg": { ... } }` | Streamed `text/plain` output, with final `✔ Done` or `✖ Failed (exit N)`. HTTP `200` can still represent a failed operation. |
| `POST /api/upload` | Raw bytes, `X-Panel: 1`, `X-Target: encodeURIComponent(absoluteLinuxPath)`, `X-Cfg: encodeURIComponent(JSON.stringify(cfg))` | Streams creation/upload/file-stat messages. Uses SSH mkdir + SCP + SSH verification. |

Unknown `POST` endpoints get HTTP 404. Invalid JSON or profile input can result in errors (for example JSON `{error:...}` with HTTP 400). **Do not equate HTTP 200 with successful deployment:** inspect the final streamed result.

Duplication copies only `repo`, `branch`, `buildCmd`, `cmdSyncCmd`, and `entryFile`. `profiles.add()` generates the new identity, PM2 name, and folder; `localEnv`/`localBot` stay empty. Shared server settings and the source profile remain unchanged. No bot files or environment credentials are duplicated.

### Removal and empty fleets

`profiles.remove()` preserves shared settings and unrelated bots, selects the first remaining bot when removing the active one, and uses an empty `activeBotId` when none remain. Version 2 normalization preserves an empty array, so a removed legacy bot does not reappear after restart. Shared connection fields can still be saved; bot actions require a profile.

Removal requires an explicit existing ID, PM2 app-name confirmation, and a matching revision hash of the saved selected bot and shared settings. The browser captures the revision after flushing queued settings saves. The server rejects removal while another POST is in flight, then blocks new POST work until removal finishes. These guards apply to this server instance; they cannot lock external SSH sessions or another panel process.

For server cleanup, `removalScript()` reads `pm2 jlist`, deletes only the matching app if present, and runs `pm2 save --force` so removing the last app updates the startup dump. Managed launch files are removed outside the checkout. File-deletion guards resolve the absolute path, require a non-hidden bot subfolder under the SSH user's home, reject symlinked targets and overlaps with other saved bots, and run before PM2 changes. A missing app/folder is safe to retry. The local profile is written out only after successful cleanup; partial remote changes are not rolled back.

### Upload paths and checks

The browser supports drag/drop, multi-file chooser, and a browser-based `.env` picker:

- Browser uploads stream each file **in sequence** through the raw-byte `/api/upload` endpoint.
- The HTTP server buffers each full file in memory, writes it to a temporary directory, creates the target directory remotely, SCPs the file, optionally `chmod 600` if the target ends in `.env`, and prints `ls -l`.
- The HTTP upload endpoint accepts only a **Linux absolute destination** matching a restrictive ASCII character pattern and rejects any path containing `..`.
- The **Upload .env** action is different: it reads `localEnv` from the panel process's Windows filesystem, then directly SCPs it to `DIR/.env`.
- **Upload code & deploy** creates a `tar.gz` from `localBot`, skipping `node_modules`, `.git`, `dist`, `.env`, and files matching `*.db*`; it SCPs/extracts the archive before running the no-pull deployment sequence.

The bulk HTTP file upload has **no explicit file-size cap** in this code; large uploads require extra local memory. The local bot-code archive uses a fixed temporary filename, so concurrent callers sharing the same temp directory could interfere.

## Status and UI synchronization

1. **Refresh now** or the enabled **30-second** interval invokes browser `st()` and sends `/api/status`, unless another status request is running, an action has marked the interface busy, or a dialog is open.
2. Server status executes `uptime -p`, `/proc/loadavg`, `free -m`, `df -h /`, and `pm2 jlist` remotely. Marked lines (`@@UP`, `@@PM2`, etc.) are parsed and converted to a JSON response.
3. The status action has a **45-second server-side timeout**; the browser aborts its status request after **50 seconds**.
4. The returned `apps` list supplies matches for **saved profiles** in the **All bots** fleet; unrelated processes are excluded from counts. Search matches profile display/PM2 names without changing selection or totals. The selected app receives uptime, CPU, RAM, restart count, and state. These are PM2 measurements, not Discord API checks.
5. Starting another action aborts an in-progress browser status request to avoid conflicting updates; the browser disables most fields while running the action.
6. The browser shows check progress and the latest success/failure time. Failed checks clear metric cards and invalidate fleet status. Changing SSH connection or selected app/profile also clears readings, and outdated responses are ignored. A status failure can reflect SSH or PM2 parsing problems even when the Node panel itself remains available.

## Activity and retained output

`dashboard.js` shows an action/bot label and elapsed time during actions/uploads, then a completed, failed, cancelled, or incomplete outcome. `panel-ui.js` decodes streamed UTF-8 and checks the last result line: only `✔ Done` means success; `✖ Failed (exit N)` means failure. An otherwise finished stream without either result is incomplete, and HTTP/read errors propagate as failures.

Output rendering keeps at most 5,000 lines in the current page. Search and error-text filtering hide lines without deleting them. Following scrolls appended output when near the bottom; Jump to latest resumes following. Copy all and Save all read the complete retained line set, including hidden lines; Clear discards it. These local controls neither fetch nor flush remote PM2 logs.

## Action flow example: Git deployment

```text
Browser presses Pull & deploy
       |
       v
POST /api/run {action:"deploy", cfg:currentSelectedBot}
       |
       v
resolveConfig -> H(c) + deploy(c,true)
       |
       v
ssh.exe USER@HOST -> bash -lc remote script
       |
       +-- cd DIR; prepare low-memory settings/swap
       +-- git pull --ff-only origin BRANCH
       +-- npm ci (lockfile) OR npm install
       +-- buildCmd (if set)
       +-- cmdSyncCmd (if set)
       +-- pm2 startOrReload ... --only APP --update-env
       +-- pm2 save; pm2 status
       |
       v
stdout/stderr streamed to the browser, then final exit status
```

The remote deployment script starts with `set -e`, so a failing step aborts the remainder rather than attempting PM2 startup.

## Design assumptions

- The local user/browser is trusted, because the panel can run **arbitrary Linux shell commands** as the configured SSH user.
- Bot repositories know how to build and start themselves; the panel handles orchestration, not bot-specific dependencies or secrets.
- All bots share one Linux account and its PM2 daemon unless the SSH user is changed globally (changing shared user settings affects all saved bot profiles).
- Bot data remains on the VM; the built-in database backup is not an offsite backup.
