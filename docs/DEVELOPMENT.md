# Development Notes and Test Coverage

These notes are for maintaining this **local panel codebase**, not the Discord bot projects it manages.

## Run locally

From the project folder, with **Node.js 18+**:

```sh
node server.cjs
```

Then open <http://localhost:4321>. On Windows, `Launch-Control-Panel.cmd` runs this and opens the URL. The control panel uses Node's built-in modules (`http`, `fs`, `path`, `os`, `child_process`, `crypto`) and doesn't need local npm packages for itself.

**Avoid accidental operations:** loading the page with a saved host triggers a background status request every 30 seconds when auto-refresh is on. To inspect UI-only behavior without connecting to a VM, use a temporary local `config.json` with an empty host, not your production configuration.

## Automated tests

Run from the project root:

```sh
node --test
```

The tests use Node's built-in test runner; no extra test framework is required. They are primarily **local unit/regression tests**, not integration tests involving live SSH, GitHub, Oracle, or Discord.

### `removal.test.cjs`

Tests cover profile removal and selection, persistent empty fleets, offline profile-only deletion, explicit ID/mode/confirmation validation, stale settings revisions, server-cleanup failures, and concurrent request exclusion. Shell tests execute generated cleanup scripts against disposable local folders with a fake PM2 command, checking selected-app uninstall, `save --force`, file preservation/deletion, safe retries, and rejection of home/shared/hidden folders, symlinks, and overlapping bots. These use Git Bash at `Program Files/Git/bin/bash.exe` on Windows or `/bin/bash` elsewhere and skip when Bash is unavailable. They never connect to a production VM or remove a real bot.

### `profiles.test.cjs`

| Coverage | What it verifies |
| --- | --- |
| Legacy migration | Flat fields survive migration, legacy bot remains unmanaged, v2 normalization idempotent. |
| New profiles | Unique generated app names/folders and shared credentials; no bot-specific credentials copied unintentionally. |
| Editing and validation | One profile's per-bot fields change independently; duplicate PM2 names/nested folders are rejected. |
| Generated ecosystem config | Explicit entry file priority, repository app preservation, `npm start` fallback, multi-app ambiguity detection. |
| Profile API | Creates/selects/edits profiles over local HTTP and writes a first-write backup. |

### `server.test.cjs`

| Coverage | What it verifies |
| --- | --- |
| `run()` | Output streaming, masking configured secrets, removal of response listeners. |
| Timeout | A stalled child exits with the expected timeout behavior. |
| Disconnect | Closing the client response cancels a process and avoids new spawns on an already destroyed response. |
| Spawn error | Missing executable error is emitted and listeners cleaned up. |
| Generated remote scripts | Swap preparation occurs before installs, `npm ci` isn't silently retried, selected SSH keepalive/system-install options exist. |
| Port conflict | A second server reports occupied port instead of crashing with an unhandled error. |

The spawn-error test currently expects the literal string `ENOENT`. In some restricted runtimes, an attempted spawn may instead report `EACCES`, leading to an environment-specific failing assertion. Such a failure does **not** mean the Oracle VM or your Windows SSH authentication failed; inspect the output and environment before changing runtime behavior.

## Where to implement a new feature

1. **UI button/control:** edit `index.html`. Action buttons generally use `data-a="ACTION"` and are handled by the global click listener. A control needing parameters may need updates to the parameter object sent to `/api/run`.
2. **Remote action:** add a corresponding case to the `S` action map in `server.cjs`'s `script(c, a, p)`. Prefer existing shell quoting helper `q()` for values interpreted by Bash.
3. **Local action or upload:** operations needing `tar`, `scp`, `icacls`, or binary upload handling belong in `createServer()` in `server.cjs`; note the different `/api/run` vs `/api/upload` contracts.
4. **New bot preference:** add whitelisted per-bot field to `BOT` in `profiles.cjs`, appropriate defaults to `profiles.add()` (and possibly legacy defaults), then expose it in `index.html` and add validation/tests.
5. **New shared preference:** add it to `SHARED` in `profiles.cjs` and ensure it intentionally applies to **all** profiles.
6. **Status metric:** extend remote `STATUS` tags, server-side `status()` parsing, browser `st()`, and its status-card `KS` list.
7. **Regression tests:** add focused `node:test` coverage to `server.test.cjs` or `profiles.test.cjs`, including failure/cancellation cases.
8. **Documentation:** update `README.md` and the matching file under `docs/` in the same change as implementation.

## Code conventions from the current codebase

- Uses CommonJS (`require`, `module.exports`) for the Node backend.
- Builds remote shell scripts in template strings; values that become shell arguments generally use `q()` or exported quoted `APP`/`DIR`.
- The frontend is vanilla HTML, CSS, and browser JavaScript in one `index.html`; no frontend build tool.
- Streams process output as **plain text**, not JSON, for action endpoints.
- Persists settings with `profiles.repository` and whitelist-filtered updates; don't bypass validation with direct `config.json` writes in feature code.
- Keeps generated managed PM2 configs outside the Git working tree.
- Treats `config.json` and real `.env` as local runtime data, not tracked source fixtures.

## Caveats for contributors

- An HTTP 200 on `/api/run` signals that a response was streamed, **not** that the requested remote command succeeded. Parse or display its terminal result.
- Some action scripts have `set -e`; not all are identical. A `; true`, `|| true`, or pipeline may intentionally suppress a specific command failure. Preserve or explicitly change that behavior when refactoring.
- SSH output redaction is token-specific and chunk-based. Don't add direct logging of credentials or rely on it as a complete secret scrubber.
- Browser-only busy flags are not a process-wide mutex. If you introduce concurrency, use unique per-request temporary filenames and ensure cleanup in `finally` blocks.
- `scp` and remote paths require Windows vs Linux path awareness. Local key and local source paths are Windows paths; `dir` and upload destinations are **Linux** absolute paths.
- For security/operations implications of current implementation, see [Security](SECURITY.md) and [Operations](OPERATIONS.md).

## Suggested regression tests to add next

1. Confirm `POST /api/run` with missing/bad `key` produces safe diagnostics without leaking credentials.
2. Verify the **Fix key permissions** action calls both intended `icacls` steps on Windows success and handles errors explicitly.
3. Exercise `/api/upload` size limits, invalid targets, cleanup on error, and cancellation behavior after any future hardening.
4. Validate all bot management actions target the selected profile and do not accidentally affect other PM2 apps.
5. Test token masking when a secret is split across multiple stream chunks.
6. Test that managed and legacy PM2 paths resolve correctly for single-app, multi-app, and missing-ecosystem repos.
7. Test fallback and timeouts when remote `pm2 jlist` output is unavailable or malformed.
8. Add a safe, opt-in end-to-end test against a **disposable** test VM rather than a production Discord bot.

## File ownership and documentation maintenance

Put `README.md` and `docs/` at the **same level** as `server.cjs`. Keep source behavior and written claims in sync; when replacing this snapshot with a newer implementation, review differences before copying specific tables or warnings forward.
