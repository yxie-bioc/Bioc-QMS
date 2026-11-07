@echo off
setlocal
cd /d "%~dp0"
if not exist "node\node.exe" goto missing
if not exist "%SystemRoot%\System32\vcruntime140.dll" goto prerequisite
"node\node.exe" "runtime\launch.mjs"
if errorlevel 1 pause
exit /b
:missing
echo BBC QMS: Please extract the COMPLETE Windows package before starting.
echo The bundled Node runtime is missing. Do not use the source-code ZIP.
pause
exit /b 1

:prerequisite
echo Microsoft Visual C++ Runtime is missing.
echo Please double-click the Windows prerequisites helper supplied in this package.
echo It downloads the verified Microsoft installer and may ask for administrator approval.
pause
