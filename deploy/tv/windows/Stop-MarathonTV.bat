@echo off
REM Closes the board and stops the launcher reopening it (until the next login
REM or the next double-click of Start-MarathonTV.bat).
powershell -NoProfile -Command ^
  "New-Item -ItemType File -Force -Path (Join-Path $env:LOCALAPPDATA 'MarathonTV\stop') | Out-Null;" ^
  "$dir = Join-Path $env:LOCALAPPDATA 'MarathonTV\chrome-profile';" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Marathon TV stopped.
