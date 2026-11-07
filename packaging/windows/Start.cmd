@echo off
setlocal
cd /d "%~dp0"
if not exist "node\node.exe" goto missing
"node\node.exe" "runtime\launch.mjs"
if errorlevel 1 pause
exit /b
:missing
echo BBC QMS: Please extract the COMPLETE Windows package before starting.
echo The bundled Node runtime is missing. Do not use the source-code ZIP.
pause
