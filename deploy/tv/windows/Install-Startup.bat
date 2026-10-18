@echo off
REM ============================================================================
REM  Run ONCE on the PC plugged into the store TV. Puts a shortcut to
REM  Start-MarathonTV.bat in this user's Startup folder, then opens the board.
REM  Undo: delete "Marathon TV.lnk" from  Win+R -> shell:startup
REM ============================================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\Marathon TV.lnk');" ^
  "$s.TargetPath = '%~dp0Start-MarathonTV.bat';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Save()"
echo Marathon TV will now open by itself every time this PC starts.
call "%~dp0Start-MarathonTV.bat"
