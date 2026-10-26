# Security, trust boundaries and limitations

This is a **trusted local administrator tool**. Anyone operating the panel can deploy arbitrary code and execute commands on the configured SSH account, including sudo where available. Rust does not change that authority.

## Local access

The listener binds only to 127.0.0.1, checks localhost/127.0.0.1 Host with its port, requires X-Panel: 1 for POST and rejects mismatched supplied Origin headers. These restrictions are not user authentication or protection against untrusted local software. GET /api/config returns credentials to the browser. Every response uses Cache-Control: no-store so browsers and intermediaries are instructed not to retain settings, output or errors in HTTP caches. Do not expose the listener through tunnels, proxies or changed network boundaries without designing authentication and authorization.

Action/configuration POST operations are serialized within this server process; mutations cancel background status checks. Read-only POST /api/paths retains the same Host, Origin and X-Panel guards but bypasses action locking and cancellation. It reports resolved paths and filesystem metadata errors without reading file contents. Removal also requires an unchanged config revision, typed app confirmation and an extra file-deletion acknowledgement. These checks do not coordinate other panel instances or external SSH sessions.

## Sensitive data

| Data | Locations |
| --- | --- |
| GitHub token | config.json, first-write backup, browser config; possibly remote Git origin URL |
| SSH identity | Local private key file; its filename is stored in config/browser |
| Bot credentials | Local .env, remote bot folder/.env |
| Logs/output | Browser retained output, exports, remote PM2 logs |
| Configuration backup | config.json.pre-profiles.bak; can retain old credentials |

**Remember preferences** is opt-in and stores only log line count, the two Errors only controls and auto-refresh in this browser's local storage. Disabling it clears those saved choices without changing the current view. Credentials, output, search terms and commands are never persisted as UI preferences. Command recall is limited to 50 entries in page memory and clears on reload; it can still contain sensitive command text during that session.

Keep these files private. Git excludes working config, backup/temp variants, keys, real .env, databases, archives and logs. Safe example files contain placeholders. Ignore rules do not remove already committed credentials from history; rotate exposed secrets.

Config writes use a private temporary file, sync and atomic replacement. On Windows, protect the containing folder and key/config ACLs; Unix creation modes do not substitute for Windows ACLs.

Each stdout/stderr stream masks the configured token and its URL-encoded form across read boundaries while preserving UTF-8. Other credentials, encodings, transformed text, echoed custom commands or remote logs can still expose secrets. Output filters only hide lines. Copy all/Save all include every retained line, up to 5,000; review exports before sharing.

## SSH and shell execution

OpenSSH uses optional -i, agent/default identities, BatchMode=yes, accept-new host keys and keepalives. A passphrase-protected key needs an agent because interactive prompts are disabled. Verify new host fingerprints independently: accept-new does not establish first-contact identity.

Configured local key files are resolved and checked for existence/type before SSH/SCP. A blank key continues to use agent/default identities. A `.pub` suffix prompts a warning; it does not inspect key contents or validate authentication. Only paths needed by the operation are checked. Empty custom commands are rejected by both the browser and API before save or execution.

Scripts are Base64-encoded before Bash execution. Encoding is not sanitization or encryption. Data values are shell-quoted and templates are expanded once. buildCmd, cmdSyncCmd and Run command are intentional arbitrary shell execution by the trusted operator.

A GitHub token supplied for HTTPS repositories **can still be written into the remote checkout's Git origin URL**. Treat .git/config there as sensitive. Prefer public anonymous URLs where possible and scoped tokens when necessary. The port preserves this behavior; it does not introduce a credential manager.

## Uploads and cancellation

Browser uploads stream to scoped temporary disk files and have a 64 MiB per-file cap; JSON bodies have a 1 MiB cap. Destinations must be absolute Linux paths without parent traversal and match the allowed character set. The operator can intentionally upload anywhere the SSH account can write; there is no per-bot upload sandbox.

Code archives use unique local and remote filenames. Local temporary data is cleaned on normal/error scope exit. After extraction begins, a remote EXIT trap removes its archive; an interrupted SCP can leave a partial /tmp/bot-panel-UUID.tgz. Process crashes or forced termination can bypass normal cleanup.

Closing a streamed response cancels the job and kills/waits for the local child. Windows Job Objects also own local descendants; Ctrl+C cancels jobs and bounds HTTP draining. **Cancellation is not undo** and is not a guarantee all remote descendants terminate. Long actions have no overall deadline; status has 45 seconds. The Windows key-permission repair runs its second icacls step only after the first succeeds and reports failures, but changing ACLs still requires operator care.

## Destructive actions and recovery

- Reset to remote hard-resets tracked files and cleans eligible untracked files. Clean exclusions for .env, *.db* and backups do not preserve tracked modifications.
- Database backup copies only top-level *.db files into the same VM folder. It is not verified, transaction-consistent, WAL-aware or offsite, and does not cover other storage layouts.
- Stop others & start stops other saved profiles before starting the selected app. Failure can leave those apps stopped.
- Full removal deletes the entire bot folder, including .env, databases and in-folder backups. Canonical paths must lie under the SSH home; home/shared/hidden folders, symlinked paths and overlaps are refused before PM2 changes. Remote failure keeps the local profile but cannot reverse completed steps.
- Reboot, package updates and swap preparation affect the whole VM. Initial PM2 startup setup still tolerates startup-hook failure; verify restoration after reboot.

## Remaining limitations

There is no health-gated release switch, automatic rollback or offsite restore. Status describes SSH/PM2 resource state, not Discord connectivity/readiness. Local-path previews check location and type, not key permissions, key contents or SSH authentication. Remote actions assume Bash, utilities and a privileged trusted operator. No live Oracle/Discord deployment is exercised by the automated regression suite.

Keep the panel folder and local machine trusted, use separate bot folders/credentials, check the selected target before destructive work, and maintain bot-specific backups outside the VM.
