# Development and tests

Install stable Rust and its native linker prerequisites. Windows MSVC normally requires Visual Studio C++ Build Tools and the Windows SDK; GNU requires compatible MinGW tools. End users need neither Rust nor Node.

```powershell
cargo run -- --config ./config.json --no-browser
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
.\scripts\package.ps1
```

Default config is beside the executable, including target/debug or target/release during Cargo runs. Use --config ./config.json for root settings, and an empty-host fixture for UI development to avoid production status checks. Embedded UI/templates require recompilation after edits. No frontend build is needed.

## Coverage

| Test | Behavior |
| --- | --- |
| profiles.rs | Migration, validation, duplicate isolation, empty fleets and backup/persistence |
| scripts.rs | 52 original action outputs, PM2 and removal parity |
| process.rs | Real process output, split tokens/UTF-8, timeout and cancellation |
| http.rs | Assets, guards, errors, profiles, stale removal, upload cap and lock release |
| cli.rs | Portable config path, flags and invalid options |
| removal_shell.rs | Actual cleanup in disposable folders, selected app, symlinks/junctions and overlap refusal |
| standalone.rs | Copied EXE serves assets, saves beside itself and reports port conflict |

Fixtures were captured from pre-port code. The original Node backend is retained only under tests/legacy as an oracle. Optional Node 18+ development checks:

```powershell
node --test
```

These also run panel-ui.test.cjs and the original backend regressions. Bash fixtures use C:/Program Files/Git/bin/bash.exe on Windows or /bin/bash elsewhere; they skip when Bash is missing and need Node to evaluate the remote PM2 selector. Windows junction fixtures need a writable ordinary directory. Restricted app-container temporary folders may deny junctions/atomic replacement; set TEMP and TMP to an absolute local test folder. No tests use live Oracle or Discord.

## Extending and packaging

UI work lives in root HTML/JS. Profile changes belong in typed structs, allowlists, defaults, validation and docs. Decide explicitly whether duplication copies new fields. Remote actions use embedded templates and scripts::q for data. Build/sync/custom text intentionally executes as shell code.

Local orchestration belongs in http.rs and process.rs. Preserve scoped temp files, POST serialization, concurrent stdout/stderr draining, cancellation and final output markers. HTTP 200 alone never establishes remote success.

package.ps1 builds with Cargo.lock, stages safe files and emits ignored dist outputs. -Target selects an installed target; -SkipBuild packages a verified release. Working config and credentials are never staged. The Windows CI workflow checks Rust/JS and uploads the portable package. Packages are unsigned; signing and public release publication require a separate release process.

Tests do not establish live SSH/SCP compatibility with every VM, successful remote package installation, Discord health, full browser interaction coverage or rollback. Use a disposable VM for end-to-end validation.
