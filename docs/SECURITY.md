# Security, Trust Boundaries, and Known Limitations

**Scope:** These notes describe the panel source as implemented. This is a **local administrator tool**, not a hardened public-facing web service.

## Threat model / trusted components

The project intentionally lets a local operator execute shell commands on a VM via the SSH account configured in the sidebar. Accordingly, treat the **Windows computer, browser session, panel folder, and local API** as highly trusted. Anyone who can operate this panel may deploy arbitrary code and change server settings with the privileges of the SSH account (plus sudo where available).

The HTTP listener binds to `127.0.0.1:4321` and checks that the request's `Host` header is a localhost address with its current port. POST actions require `X-Panel: 1`. **These checks are not authentication, authorization, or CSRF-hardening sufficient for a public admin interface.** Do not expose the server with tunnels, port forwards, reverse proxies, or changed bind addresses unless you design appropriate authentication and security first.

## Sensitive information map

| Information | Where it appears | Recommended practice |
| --- | --- | --- |
| GitHub personal access token | `config.json` as `server.token`; browser's `/api/config` response; possibly Git `origin` on the VM when HTTPS credentials are injected | Prefer scoped, least-privileged token; rotate if exposed; don't paste it into issues or logs. |
| SSH private-key **file path** | `config.json` as `server.key`; browser config | File path is not key contents, but keep configuration private; protect the actual `.key`/`.pem` file. |
| SSH private-key **contents** | Local key file | Not uploaded by the panel (unless you explicitly upload the file); never commit or share. |
| Bot credentials | Each bot's `DIR/.env`; your Windows local `.env` | Upload per bot; never commit `.env`; review who can read the VM filesystem. |
| Prior settings | `config.json.pre-profiles.bak` | Treat just like `config.json`; it can preserve old exposed secrets after rotation. |
| Console output / PM2 logs | Local browser console and potentially saved `.txt` files; remote PM2 logs | Outputs can reveal tokens, environment details, paths, or user data. Share sanitized excerpts. |
| Remote repo metadata | `DIR/.git/config` when token is injected into HTTPS remote URL | Credential-bearing Git remote URLs are sensitive; verify/replace token after compromise. |

The server masks the configured token and its URL-encoded form in **each stdout/stderr chunk** before returning output. This reduces accidental exposure, but is **not reliable universal redaction** (a secret split across chunks or transformed differently could slip through). Never rely on the output filter alone to make logs safe to publish.

### Repository exclusions and examples

The root `.gitignore` excludes runtime configuration and backups, SSH identities, actual environment files, databases, archives, and logs. `config.example.json` and `.env.example` are safe starter files with empty credentials. Keep them free of real values. Core exclusions include:

```gitignore
# Local panel configuration and credential-bearing backups
/config.json
/config.json.tmp
/config.json.pre-profiles.bak
/config.json.*

# SSH private keys or secrets accidentally kept in project tree
*.key
*.pem
.env
.env.*
!.env.example

# Temporary logs/archives from local investigations
*.log
bot-upload.tgz
```

If `config.json` is **already tracked by Git**, adding `.gitignore` does not remove it from history. Remove it from Git tracking and rotate any credentials disclosed by prior commits; do not delete the local working configuration accidentally.

## How SSH access is secured (and what it doesn't do)

- With `key` set, the panel passes `ssh -i <absolute Windows private-key path>` (and the analogous SCP option). Without it, OpenSSH searches its usual identities and agent.
- `BatchMode=yes` prevents password/passphrase prompts. A key that needs an interactive passphrase without an agent can fail, even if manual interactive SSH works.
- `StrictHostKeyChecking=accept-new` records previously unseen hosts automatically. It does **not** independently verify the identity of a new host; verify your Oracle instance's server fingerprint by a trusted method on a new machine/network.
- The remote script is Base64-wrapped then run through `bash -lc`. Base64 **does not** sanitize shell code, grant security, or hide secrets from users/processes with access.

For testing SSH without leaking credentials, use a command of the form:

```bat
ssh -o BatchMode=yes -i "C:\Users\Example\.ssh\oracle.key" -T opc@YOUR_VM "echo SSH_OK"
```

Use your own actual key **filename** (never its contents). A successful `SSH_OK` proves SSH public-key login works for that invocation; it does not guarantee the panel is currently using the same settings or running the latest code.

## Data destructive or service-impacting actions

**Reset to remote** calls `git reset --hard` on tracked files and `git clean -fd` on eligible untracked files. It excludes `.env`, `*.db*`, and `backups/` from the clean step, **not** from resetting tracked changes. Make independent backups before resetting.

**Back up database** copies only top-level `*.db` files into the same VM's `DIR/backups/`; it is not verified, transactionally consistent, or offsite. Bot-specific storage (other extensions, subfolders, SQLite WAL state, cloud databases) needs its own backup method.

**Stop others & start** stops every *other saved profile's* PM2 process name before starting the selected bot. A startup failure can leave those other bots stopped. **Reboot server**, **Update OS packages**, **Update npm & PM2**, and memory changes affect the entire machine.

**Run command**, `buildCmd`, and `cmdSyncCmd` are deliberate arbitrary shell execution capabilities for a trusted administrator. Do not accept these commands from an untrusted webpage/user or convert this into an internet-facing service without redesign.

**Remove bot** defaults to deleting only the saved profile. Server uninstall removes only its exact PM2 app and persists the startup list; full file deletion additionally removes `.env`, databases, and all in-folder backups. File deletion requires typed app-name confirmation and an extra acknowledgement, checks canonical paths under the SSH user's home, and refuses shared/hidden home folders, symlinks, and overlap with other saved bots. Settings-revision and same-server request guards prevent stale confirmations or overlapping panel work. External SSH sessions or another panel process remain outside these locks. Failure keeps the local profile but cannot reverse remote steps that already completed.

## Code-backed limitations to keep in mind

These are useful places for future engineering work; they are **not fixed by this documentation**.

1. **Local HTTP API is not user-authenticated.** `GET /api/config` returns secrets to the local browser. The API's localhost/Host and `X-Panel` restrictions must not be mistaken for strong authentication.
2. **Token-in-remote-URL behavior:** `authUrl()` inserts the shared token into an HTTPS URL, then `git clone` or `git remote set-url` can persist it in the remote checkout's `.git/config`. Review token rotation and prefer credential handling that avoids leaving tokens in remote URLs.
3. **Streaming token masking is best-effort:** because replacement runs independently on each output chunk, a secret split across chunks can evade masking. Commands or Git tools can emit other encoded forms too.
4. **Upload size and cleanup:** `/api/upload` buffers the full incoming body in RAM and doesn't impose a request size limit. The temporary directory is removed in the normal code path, but errors before cleanup can leave local temporary files.
5. **Fixed-name code archive:** local bot upload uses the shared temp filename `bot-upload.tgz` and remote `/tmp/bot-upload.tgz`; overlapping uploads/processes could clash, and the local archive is not explicitly deleted.
6. **Permission repair flow:** the **Fix key permissions** action uses two `icacls` invocations joined by JavaScript `||`. The second runs when the first returns `0` (success) and is **skipped** if the first returns a truthy failure code; repair is not guaranteed. This button changes Windows ACLs and should be used with care.
7. **No end-to-end rollback:** deployments execute package install, build, command sync, and PM2 restart, but there is no versioned release switch, health gate, automatic rollback, or offsite database restore.
8. **Cancellation isn't undo:** clicking Cancel aborts the HTTP request and asks to kill the local child. A remote command that has already made changes may not be rolled back just because the dashboard disconnects.
9. **Validation is specialized:** bot app names and directory separation are validated, but build/sync/custom command strings and many remote paths are trusted administrator input; remote server actions assume the operator knows the consequences.
10. **Status is operational, not application health:** the cards reflect SSH and `pm2 jlist` values, not Discord API connection state, ready-to-serve checks, or gateway shard health.
11. **No remote key-file existence verification before action:** blank/missing/wrong local SSH paths surface as SSH failures instead of a dedicated key diagnostics page.
12. **PM2 startup initialization isn't guaranteed:** `pm2 startup systemd ...` in Initial setup is followed by `|| true`; startup-hook failure won't necessarily stop setup. Verify bot restoration after a reboot.
13. **GET route fallback is broad:** other unknown GET paths receive the HTML dashboard, not an HTTP 404. This is acceptable for a simple local app but isn't a conventional router.
14. **Single local user/session assumption:** most actions rely on browser busy state, without a general server-wide queue or multi-user authorization. Removal is stricter: it requires other POST requests to finish and blocks new POST work during cleanup, within that server instance.

## Practical protection checklist

- [ ] Keep the panel bound to loopback only; do not publish it to the public internet.
- [ ] Restrict OS permissions on private keys, `.env`, `config.json`, backups, and saved console outputs.
- [ ] Keep GitHub token permissions as narrow as possible; avoid tokens for public read-only repositories.
- [ ] Put each bot in its own folder with a unique PM2 app name.
- [ ] Verify backups cover your **actual** databases and are stored away from the VM as well.
- [ ] Confirm the selected bot before resetting files, flushing logs, or stopping other processes.
- [ ] Test restoration after reboot, especially on memory-constrained VMs.
- [ ] Review the source before adding authentication, remote access, or additional file upload capabilities.
