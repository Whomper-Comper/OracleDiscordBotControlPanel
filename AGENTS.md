# Delivery preferences

- Suggest optional QoL improvements first and wait for the user's acceptance before implementing them. After approval, implement the selected scope and update this file and relevant user/developer documentation.
- Ask the user before rebuilding the release EXE. Do not run release builds, rebuild the EXE through packaging scripts, or dispatch CI packaging without explicit approval for that build. Routine source checks and tests are allowed.
- Commit and push completed changes to the working branch, and publish corresponding GitHub releases. Use only verified artifacts matching the released source. If no matching build exists, ask before building release binaries; never attach an older EXE as the new version.
- Reusing or packaging an already verified build does not require recompiling it. Never stop a running user application just to replace a locked EXE.

# QoL contracts

- Resolve local paths at use time relative to the config file; preserve portable user-entered spelling in saved settings. Use the same resolver for previews and operations.
- Support leading `~` and `%USERPROFILE%` in local paths. Validate only paths needed by the action; a blank SSH key keeps agent/default identity support and `.pub` is a warning only.
- Preference persistence is opt-in and limited to display controls. Command history is session-only; never persist credentials, output, search terms or command history as UI preferences.
- Remember only log line count, both Errors only controls and auto-refresh; disabling persistence clears the saved choices. Keep command recall capped at 50 entries, restore the unfinished draft, and reject blank commands in both UI and API.
- Keep read-only previews independent of action cancellation/serialization, and retain local Host/Origin/X-Panel protections.
