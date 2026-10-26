# Path and dashboard conveniences

The user approved all seven proposed changes, including an opt-in preference toggle and preserving unfinished commands during history navigation. This implementation, documentation update, Git push, EXE build and GitHub release are explicitly approved.

## Behavior

- SSH key, local .env and local bot-folder fields accept quoted paths, leading `~` and `%USERPROFILE%`. Relative paths use the directory containing config.json. Saved spelling stays portable; only runtime paths become absolute.
- Inline previews show the resolved location and explain missing paths or wrong file/directory types. A .pub key gets a warning to choose the private key. No file contents are read for previews.
- Missing or invalid configured key files fail before starting SSH/SCP. A blank key continues using the SSH agent/default identities. Unused .env/source paths cannot block status checks or unrelated actions.
- Remember preferences starts off. Opting in stores only log line count, remote/output Errors only and auto-refresh in browser local storage. Turning it off deletes only those saved preferences and keeps the current view until reload. Invalid/unavailable browser storage must not break the panel.
- Up/Down recalls up to 50 commands in memory and restores the unfinished draft after the newest entry. Commands are never persisted to browser storage or disk by this feature.
- Empty or whitespace-only commands cannot trigger a save or SSH action; both UI and API enforce this.

## Approach

Keep the existing Rust/Axum backend and embedded HTML/JavaScript. Use one local-path resolver for preview and execution, plus a guarded read-only POST /api/paths endpoint. Keep settings portable instead of rewriting shorthand to machine-specific absolute paths. Use small browser helpers and native controls rather than new dependencies or a frontend framework.

No remote operations or production credentials are needed for validation. Release builds remain opt-in after this explicitly approved build.
