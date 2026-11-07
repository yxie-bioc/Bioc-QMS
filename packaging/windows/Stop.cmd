@echo off
setlocal
cd /d "%~dp0"
"node\node.exe" "runtime\launch.mjs" --stop
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
