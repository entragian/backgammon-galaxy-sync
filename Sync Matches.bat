@echo off
title Backgammon Galaxy Match Sync
cd /d "%~dp0"
node sync.js
echo.
echo Press any key to close...
pause >nul
