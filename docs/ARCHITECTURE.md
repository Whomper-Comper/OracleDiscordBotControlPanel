# Architecture and API

The backend is a Rust executable using Axum, Tokio and Serde. Existing vanilla HTML/JavaScript and Bash/PM2 templates are embedded at compile time. No local Node process or webview is involved.

| Files | Responsibility |
| --- | --- |
| src/main.rs, src/cli.rs | Options, loopback binding, browser launch and startup errors |
| src/http.rs | API, exclusive POST operations, uploads and orchestration |
| src/profiles.rs | Typed config, migration, validation, duplication/removal and persistence |
| src/process.rs | Hidden-window subprocesses, output, redaction, timeout/cancellation |
| src/scripts.rs, templates/ | Embedded remote programs, managed PM2 configuration and status parsing |
| index.html, dashboard.js, panel-ui.js | Embedded browser UI |
| tests/*.rs | Rust regression/integration tests and standalone EXE |
| tests/legacy/ | Original Node backend and tests, comparison only |
| scripts/package.ps1 | Portable EXE/ZIP packaging |

## Configuration and concurrency

V2 JSON and flat legacy migration remain compatible. Config writes validate the complete typed store, preserve a first-write .pre-profiles.bak, write/sync a private temporary file in the same folder and atomically replace the destination. Parse errors preserve the existing file. See Configuration for fields.

The frontend saves before actions, then submits a captured snapshot. /api/run applies whitelisted fields in memory; direct clients must save separately. Profile IDs and managed flags cannot be overwritten by config edits. SSH host/user/port, profile IDs, PM2 names and non-nested Linux paths are validated.

Every POST takes the operation mutex. Mutations cancel the background status token. Requests wait at most two seconds before HTTP 409. Removal checks its saved revision after acquiring the mutex and forgets the profile only after remote cleanup succeeds. Another panel process or external SSH session is outside this lock.

## HTTP contract

Bind: **127.0.0.1**, default **4321**. Host must equal localhost:PORT or 127.0.0.1:PORT. POST requires X-Panel: 1 and rejects a supplied Origin differing from its HTTP origin. This is not user authentication.

| Route | Contract |
| --- | --- |
| GET / | Embedded HTML |
| GET /panel-ui.js, /dashboard.js | Exact embedded assets |
| GET /api/config | Merged active config, bots, activeBotId, removalRevision; includes secrets |
| POST /api/config | Whitelisted updates, optional botId; persist and return config |
| POST /api/profiles | Add/select/duplicate/remove with existing UI payloads |
| POST /api/status | {cfg} to readings/PM2 apps or {error} |
| POST /api/run | {action,params,cfg} to text output and final result |
| POST /api/upload | Raw body, encoded X-Target and JSON X-Cfg headers |

Unknown routes return 404; other methods 405; invalid JSON/config 400; guards 403; oversized uploads 413. JSON bodies are capped at 1 MiB. Uploads stream to disk with a 64 MiB per-file cap and scoped temporary cleanup.

## Processes and remote programs

process::run drains stdout/stderr concurrently through bounded channels. Each stream has a stateful redactor preserving split UTF-8 and token matches across reads. It masks the configured token and its encodeURIComponent form, not every possible credential.

Closing a streamed body cancels its job. Cancellation, closed output receivers and timeouts kill and wait for the local child. Windows commands start suspended, join a kill-on-close Job Object, then resume, so local SSH/SCP descendants are owned too; Unix uses a separate process group. Ctrl+C cancels operation tokens and bounds HTTP draining to three seconds. Status has a 45-second deadline, with a 50-second browser timeout. Other actions have no overall deadline. Killing SSH does not guarantee every remote descendant stops and does not undo changes.

OpenSSH retains optional identity/agent/config handling, BatchMode, accept-new host keys, connect timeout and keepalives. Remote scripts are Base64-wrapped for Bash, not sanitized by encoding. SCP uses the local file's parent as cwd to avoid drive-letter ambiguity.

Code upload creates a unique local temporary folder and remote /tmp/bot-panel-UUID.tgz. It excludes node_modules, .git, dist, .env and *.db*, overlays files and deploys without pulling. An EXIT trap removes the remote archive after extraction starts; interrupted SCP can leave a partial remote archive. Local archives are scoped and cleaned.

The template renderer scans once, shell-quotes data, and never re-expands marker text inside values. Build/sync/custom commands remain trusted shell input. Managed PM2 CommonJS still runs through Node on the VM and preserves entry-file priority and repository app settings. Fixtures compare 52 generated actions against the old backend.

Removal retains canonical-home, shared/hidden-folder, symlink and overlap guards, exact app targeting and pm2 save --force. Actual Bash fixtures test these in disposable folders. Dashboard status reflects SSH/PM2, not Discord readiness. Existing fleet/status invalidation, output retention and terminal-result parsing remain.
