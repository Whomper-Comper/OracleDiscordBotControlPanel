# Path and Dashboard QoL Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and focused parallel workers for independent modules. Track results here.

**Goal:** Deliver the seven approved conveniences with tests, documentation, and a verified v0.2.1 release.

**Architecture:** Resolve local paths at use time relative to the config file, share the resolver with a protected preview endpoint, and keep browser-only preferences/history separate from server configuration.

**Tech Stack:** Rust, Axum, vanilla JavaScript, native HTML; no new dependencies.

**Spec:** ../specs/2026-10-26-path-and-dashboard-qol-design.md

## Global constraints

- Never read real config/credentials or contact the VM for tests.
- Preserve blank-key agent/default identity support and existing removal safeguards.
- Preview is read-only, uncached, Host/Origin/X-Panel guarded, and does not cancel active work.
- Remember preferences is opt-in; history and secrets never enter local storage.
- Build/push/release are authorized for this task; future EXE builds require approval.

## Review focus

- Subprocess working-directory changes must not change key/file resolution.
- Missing optional paths must not block unrelated actions.
- Delayed preview responses must not overwrite a different profile's preview.
- Browser storage failures and corrupt values must preserve usable defaults.
- History navigation must restore draft text without sending blank commands.

### Task 1: Local path resolver and API integration

- [x] Add src/local_paths.rs and tests/local_paths.rs for quotes, home shortcuts, config-relative paths, type errors and .pub warnings.
- [x] Add read-only /api/paths and runtime path preparation in src/http.rs; cover HTTP guards, unchanged config and preflight failures in tests/http.rs.
- [x] Reject blank custom commands before SSH and run focused Rust tests.

### Task 2: Browser conveniences

- [x] Add preference toggle, path-preview descriptions and command-history hint in index.html.
- [x] Add opt-in preferences, session history, blank-command guard and stale-safe preview handling in dashboard.js/panel-ui.js.
- [x] Verify preference failures, draft restoration, blank commands and preview races in panel-ui.test.cjs.

### Task 3: Delivery

- [x] Update AGENTS.md and user/developer/security docs; bump Cargo version to 0.2.1.
- [x] Run Rust/JS suites, formatting/lint, and independent review; resolve material findings.
- [ ] Commit and push the reviewed source, then build the explicitly approved EXE once, package and smoke-test.
- [ ] Publish v0.2.1 with matching EXE/ZIP/checksums; preserve running user processes.

## Verification record

- Rust: 50 tests; JavaScript: 50 tests. Formatting, Clippy with warnings denied, JavaScript syntax and HTML structure/accessibility references checked.
- Independent review found a second trim of normalized local paths. Fixed in resolver and browser configuration capture; regressions now cover saved paths with significant spaces through previews and actions. Reviewer confirmed no outstanding findings.
- Delivery steps run after the source commit; the GitHub release records the source commit and verified artifact checksums.
