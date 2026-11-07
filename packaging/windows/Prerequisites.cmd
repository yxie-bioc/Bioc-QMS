@echo off
setlocal
echo This optional step downloads Microsoft Visual C++ Runtime from Microsoft.
echo The Microsoft installer will ask you to accept its terms and may request administrator approval.
echo No database, developer tools, firewall rules or startup services are installed.
pause
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP 'BBC-QMS-VC-redist.x64.exe'; Invoke-WebRequest -UseBasicParsing -Uri 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe' -OutFile $p; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() -ne '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c') { throw 'Checksum mismatch' }; $s=Get-AuthenticodeSignature -LiteralPath $p; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft signature validation failed' }; $r=Start-Process -FilePath $p -ArgumentList '/install','/norestart' -Wait -PassThru; if ($r.ExitCode -notin 0,3010,1638) { throw 'Microsoft installer failed or was cancelled' }"
if errorlevel 1 pause
