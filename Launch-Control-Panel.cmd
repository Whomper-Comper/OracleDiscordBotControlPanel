@echo off
title Oracle bot control panel
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
start "" http://localhost:4321
node server.cjs
pause
