@echo off
cd /d "I:\AIstore\16.mail\qq-mail-push"
"C:\Program Files\nodejs\node.exe" "local\run.mjs" >> "logs\watcher.log" 2>&1
