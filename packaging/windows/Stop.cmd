@echo off
setlocal
cd /d "%~dp0"
"node\node.exe" "runtime\launch.mjs" --stop
if errorlevel 1 pause
