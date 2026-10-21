# Development Notes and Test Coverage

These notes are for maintaining this **local panel codebase**, not the Discord bot projects it manages.

## Run locally

From the project folder, with **Node.js 18+**:

```sh
node server.cjs
```

Then open <http://localhost:4321>. On Windows, `Launch-Control-Panel.cmd` runs this and opens the URL. The control panel uses Node's built-in modules (`http`, `fs`, `path`, `os`, `child_process`, `crypto`) and doesn't need local npm packages for itself.

Keep the full repository together. `index.html` loads `panel-ui.js` and `dashboard.js`, both beside `server.cjs` and served by exact JavaScript routes. Copying only the HTML/server files leaves an incomplete dashboard. No npm install or frontend build step is needed. Restart the local server after backend changes and refresh the browser after browser-code changes.

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

### `duplication.test.cjs`

Tests exercise copying the allowed deployment settings into a separate managed profile, UUID/app/folder uniqueness and collision suffixes, source/shared-setting preservation, cleared local paths, and exclusion of credentials from bot fields. Explicit source/name validation, string-only repository/entry-file overrides, saved API selection, and rejection without writes are covered. API tests use temporary fixture configuration and a remote-call guard, without provisioning or SSH. Route tests verify that `/panel-ui.js` and `/dashboard.js` return their JavaScript contents while other source-file paths do not become static-file access.

### `panel-ui.test.cjs`

Tests cover case-insensitive fleet search by display/PM2 name, counts restricted to saved profiles, status-target invalidation, combined output search/error filtering, and final streamed outcomes. In-memory response fixtures exercise split UTF-8 decoding, earlier misleading success text, missing completion markers, readable API failures, and dropped streams. These helper tests do not establish live Discord/Oracle integration or full browser-layout coverage.

## Where to implement a new feature

1. **UI button/control:** edit markup/styles in `index.html` and handlers in `dashboard.js`. Action buttons generally use `data-a="ACTION"` and its global click listener. A control needing parameters may need updates to the parameter object sent to `/api/run`. Put independently testable filtering/stream logic in `panel-ui.js`.
2. **Remote action:** add a corresponding case to the `S` action map in `server.cjs`'s `script(c, a, p)`. Prefer existing shell quoting helper `q()` for values interpreted by Bash.
3. **Local action or upload:** operations needing `tar`, `scp`, `icacls`, or binary upload handling belong in `createServer()` in `server.cjs`; note the different `/api/run` vs `/api/upload` contracts.
4. **New bot preference:** add a whitelisted per-bot field to `BOT` in `profiles.cjs`, appropriate defaults to `profiles.add()` (and possibly legacy defaults), then expose it in `index.html` and add validation/tests. Decide explicitly whether duplication should copy it; `profiles.duplicate()` uses a narrow deployment-setting allowlist.
5. **New shared preference:** add it to `SHARED` in `profiles.cjs` and ensure it intentionally applies to **all** profiles.
6. **Status metric:** extend remote `STATUS` tags, server-side `status()` parsing, and browser `st()`/`metrics` in `dashboard.js`. Preserve clearing/invalidation when status fails or its target changes.
7. **Regression tests:** add focused `node:test` coverage in the relevant test file, including failure/cancellation cases. Keep HTTP fixtures separate from production configuration and remote services.
8. **Documentation:** update `README.md` and the matching file under `docs/` in the same change as implementation.

## Code conventions from the current codebase

- Uses CommonJS (`require`, `module.exports`) for the Node backend.
- Builds remote shell scripts in template strings; values that become shell arguments generally use `q()` or exported quoted `APP`/`DIR`.
- The frontend uses vanilla markup/CSS in `index.html`, browser behavior in `dashboard.js`, and reusable browser/CommonJS helpers in `panel-ui.js`; no frontend build tool or npm dependency.
- Streams process output as **plain text**, not JSON, for action endpoints.
- Persists settings with `profiles.repository` and whitelist-filtered updates; don't bypass validation with direct `config.json` writes in feature code.
- Keeps generated managed PM2 configs outside the Git working tree.
- Treats `config.json` and real `.env` as local runtime data, not tracked source fixtures.

## Caveats for contributors

- An HTTP 200 on `/api/run` signals that a response was streamed, **not** that the requested remote command succeeded. Parse or display its terminal result.
- `readActionResponse()` classifies only the final completion/failure marker. Keep incomplete streams distinct from success, and preserve all retained output when filtering the display or exporting it.
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
