# Portable Rust control panel

The user requested a Rust port, executable packaging, and a new branch pushed to GitHub after verification, delegating implementation choices. Use the existing checkout and create the branch at completion as requested. Preserve the current browser dashboard and local-only SSH/SCP/PM2 workflows.

## Approach

Use a Rust HTTP backend with embedded HTML/JS and external Windows OpenSSH/tar commands. This produces a portable EXE without Node on the local PC. A Tauri wrapper would introduce an unnecessary webview/build dependency; a native UI rewrite would discard working UI behavior. The browser remains the UI. Node/npm/PM2 remain remote bot requirements.

## Contracts

- Bind only 127.0.0.1, default port 4321; preserve the HTTP routes and final streamed result markers.
- Preserve v2 JSON, legacy migration, empty fleets, duplication isolation, managed/legacy PM2 launch behavior, removal revision checks and shell safety guards.
- Embed all frontend and remote templates. Default config lives beside the EXE; allow --config, --port and --no-browser for development and tests.
- Use typed profiles and explicit validation. Shell actions remain trusted administrator input.
- Stream and bound uploads, use unique temporary archives and RAII cleanup, serialize POST operations, redact tokens across process read boundaries, cancel local child processes on disconnect.
- Retain original Node backend only as a test oracle under tests/legacy, never invoked by the packaged application.
- Add a PowerShell packaging script and Windows CI artifact build. Ship the EXE, examples and user documentation, excluding private settings.

## Verification

Cargo tests cover configuration, HTTP, cancellation, redaction and status parsing. Compare generated scripts and generated PM2 programs against the original backend; execute safe cleanup fixtures locally. Run existing JS regression tests with no production SSH. Build a release EXE and exercise its embedded UI/config/API from a separate fixture directory. Run formatting and Clippy, request an independent review, fix material issues, then branch/commit/push. Live Oracle/Discord deployment is outside this test scope.
