# Delivery preferences

- Ask the user before rebuilding the release EXE. Do not run release builds, rebuild the EXE through packaging scripts, or dispatch CI packaging without explicit approval for that build. Routine source checks and tests are allowed.
- Commit and push completed changes to the working branch, and publish corresponding GitHub releases. Use only verified artifacts matching the released source. If no matching build exists, ask before building release binaries; never attach an older EXE as the new version.
- Reusing or packaging an already verified build does not require recompiling it. Never stop a running user application just to replace a locked EXE.
