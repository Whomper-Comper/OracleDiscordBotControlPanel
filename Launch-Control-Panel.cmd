@echo off
title Oracle bot control panel
cd /d "%~dp0"
if exist "oracle-bot-panel.exe" (
  "oracle-bot-panel.exe"
) else if exist "target\release\oracle-bot-panel.exe" (
  "target\release\oracle-bot-panel.exe" --config "%~dp0config.json"
) else (
  echo Build the Rust executable first: cargo build --release
  echo Or download the portable Windows package from GitHub Actions.
)
pause
