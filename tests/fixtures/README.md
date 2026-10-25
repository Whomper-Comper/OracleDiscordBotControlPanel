# Command compatibility fixtures

These expected outputs were captured from the original Node backend at commit
`5e5106f`, before implementing the Rust script renderer. `scripts.json` covers
26 actions for both managed and legacy profiles; the other fixtures cover the
generated CommonJS PM2 program and both removal modes. All values are placeholders.

The Node reference implementation lives in `tests/legacy/` solely for regression
comparison. It is never loaded or shipped by the Rust application. Rust tests
also execute the generated cleanup script against disposable local folders.
