@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Mail Push Daemon...
node local\mail-watcher-daemon.mjs
pause
