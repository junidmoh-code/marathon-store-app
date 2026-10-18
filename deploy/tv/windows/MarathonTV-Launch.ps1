# =============================================================================
#  Marathon TV - keeps the in-store order-queue board on screen (Windows)
# -----------------------------------------------------------------------------
#  Opens Chrome (or Edge) full-screen in kiosk mode on the queue board with
#  audio allowed from the start, so the pickup voice speaks with no tap - ever.
#  If the browser closes or crashes it is reopened within seconds, and it is
#  restarted once a night (04:30, store shut) so a new app version reaches the
#  TV without the page ever reloading itself.
#
#  HOW TO USE
#    * Run Install-Startup.bat once - the board then opens at every login.
#    * Or double-click Start-MarathonTV.bat to open it now.
#    * To stop it: Stop-MarathonTV.bat.
# =============================================================================

# ---- CONFIG (edit these) ----------------------------------------------------
$Url            = "https://marathon-club.web.app"  # live app address (no trailing slash)
$Section        = ""        # "1" for the Section 1 board; leave "" for the main board
$NightlyRestart = "04:30"   # local time; the browser restarts once a night
$BrowserPath    = ""        # leave "" to auto-detect Chrome, or hard-code chrome.exe
# -----------------------------------------------------------------------------

# One launcher at a time (Startup + a double-click must not open two boards).
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\MarathonTVLauncher", [ref]$created)
if (-not $created) { exit 0 }

if ($Section) { $TvUrl = "$Url/?section=$Section&kiosk=1#tv" } else { $TvUrl = "$Url/?kiosk=1#tv" }
$ProfileDir = Join-Path $env:LOCALAPPDATA "MarathonTV\chrome-profile"
$StopFile   = Join-Path $env:LOCALAPPDATA "MarathonTV\stop"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $StopFile

function Find-Browser {
  if ($BrowserPath -and (Test-Path $BrowserPath)) { return $BrowserPath }
  $candidates = @(
    (Join-Path $env:ProgramFiles        "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA        "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:ProgramFiles        "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$Browser = Find-Browser
if (-not $Browser) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Google Chrome (or Microsoft Edge) was not found. Install Chrome, or set `$BrowserPath in this script.",
    "Marathon TV") | Out-Null
  exit 1
}

# Never let the screen or the PC sleep under the board (current power plan).
foreach ($a in @("monitor-timeout-ac", "standby-timeout-ac")) { powercfg /change $a 0 2>$null | Out-Null }

$flags = @(
  "--kiosk",
  "--autoplay-policy=no-user-gesture-required",   # the pickup voice plays with no tap
  "--noerrdialogs",
  "--disable-session-crashed-bubble",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate",
  "--overscroll-history-navigation=0",
  "--check-for-update-interval=604800",
  # Start-Process joins -ArgumentList with spaces and does NOT quote, so a
  # profile path under a username with a space must carry its own quotes.
  "--user-data-dir=`"$ProfileDir`"",
  "`"$TvUrl`""
)

# Chrome only writes "exited cleanly" on a graceful quit; after a kill or power
# cut it would offer to restore pages. Mark the last exit clean every time.
function Set-CleanExit {
  $prefs = Join-Path $ProfileDir "Default\Preferences"
  if (Test-Path $prefs) {
    try {
      # Preferences is UTF-8 without a BOM; Get/Set-Content in PowerShell 5.1
      # would round-trip it through the ANSI code page and mangle it.
      $utf8 = New-Object System.Text.UTF8Encoding($false)
      $t = [System.IO.File]::ReadAllText($prefs, $utf8)
      $t = $t -replace '"exited_cleanly":false', '"exited_cleanly":true' -replace '"exit_type":"[A-Za-z]*"', '"exit_type":"Normal"'
      [System.IO.File]::WriteAllText($prefs, $t, $utf8)
    } catch { }
  }
}

# Every browser process running on the board's own profile.
function Stop-Board {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProfileDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

while (-not (Test-Path $StopFile)) {
  Set-CleanExit
  $started = Get-Date
  $restartAt = [datetime]::Today.Add([timespan]::Parse($NightlyRestart))
  if ($started -ge $restartAt) { $restartAt = $restartAt.AddDays(1) }

  $p = Start-Process -FilePath $Browser -ArgumentList $flags -PassThru
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 30
    if (Test-Path $StopFile) { Stop-Board; break }
    if ((Get-Date) -ge $restartAt) { Stop-Board; break }   # nightly restart
  }
  Start-Sleep -Seconds 5   # crashed, closed or restarting - open it again
}
Remove-Item -Force -ErrorAction SilentlyContinue $StopFile
