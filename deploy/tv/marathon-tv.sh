#!/bin/bash
# =============================================================================
#  Marathon TV — keeps the in-store order-queue board on screen (Mac + Linux/Pi)
# -----------------------------------------------------------------------------
#  Opens Chrome (Chromium on a Pi) full-screen in kiosk mode on the queue board
#  with audio allowed from the start, so the pickup voice speaks with no tap —
#  ever. If the browser closes or crashes it is reopened within seconds, and it
#  is restarted once a night (04:30 by default, store shut) so a new app version
#  reaches the TV without the page ever reloading itself.
#
#  Run by launchd (mac/install-mac.sh) or systemd (linux/install-linux.sh); you
#  never start it by hand. Settings below can be overridden in the environment.
# =============================================================================
set -u

BASE_URL="${MARATHON_TV_URL:-https://marathon-club.web.app}"
SECTION="${MARATHON_TV_SECTION:-}"          # "1" for the Section 1 board, empty for the main board
RESTART_AT="${MARATHON_TV_RESTART_AT:-04:30}" # nightly browser restart, local time, HH:MM

if [ -n "$SECTION" ]; then TV_URL="$BASE_URL/?section=$SECTION&kiosk=1#tv"; else TV_URL="$BASE_URL/?kiosk=1#tv"; fi

case "$(uname -s)" in
  Darwin)
    PROFILE="$HOME/Library/Application Support/MarathonTV/chrome-profile"
    BROWSER=""
    for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
             "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
             "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      [ -x "$b" ] && BROWSER="$b" && break
    done
    ;;
  *)
    PROFILE="$HOME/.config/marathon-tv/chrome-profile"
    BROWSER=""
    for b in chromium chromium-browser google-chrome google-chrome-stable; do
      command -v "$b" >/dev/null 2>&1 && BROWSER="$(command -v "$b")" && break
    done
    ;;
esac

if [ -z "$BROWSER" ]; then
  echo "$(date '+%F %T') marathon-tv: Chrome/Chromium not found — install it and this retries." >&2
  sleep 60
  exit 1   # launchd/systemd start us again
fi
mkdir -p "$PROFILE"

FLAGS=(
  --kiosk
  --autoplay-policy=no-user-gesture-required   # the pickup voice plays with no tap
  --noerrdialogs
  --disable-session-crashed-bubble
  --disable-infobars
  --no-first-run
  --no-default-browser-check
  --disable-features=Translate
  --overscroll-history-navigation=0
  --check-for-update-interval=604800
  "--user-data-dir=$PROFILE"
)
[ "$(uname -s)" != "Darwin" ] && FLAGS+=(--password-store=basic --ozone-platform-hint=auto)

# Chrome only writes "exited cleanly" on a graceful quit; after a kill or power
# cut it would offer to restore pages. Mark the last exit clean every time.
mark_clean_exit() {
  local prefs="$PROFILE/Default/Preferences"
  [ -f "$prefs" ] && sed -i.bak -e 's/"exited_cleanly":false/"exited_cleanly":true/' \
                                -e 's/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' "$prefs" 2>/dev/null
  rm -f "$prefs.bak"
}

hhmm() { date +%H%M; }
RESTART_HHMM="${RESTART_AT/:/}"

while true; do
  mark_clean_exit
  echo "$(date '+%F %T') marathon-tv: opening $TV_URL"
  "$BROWSER" "${FLAGS[@]}" "$TV_URL" >/dev/null 2>&1 &
  pid=$!
  # Keep the screen awake while the board is up (macOS).
  [ "$(uname -s)" = "Darwin" ] && caffeinate -dimsu -w "$pid" &

  started_day="$(date +%F)"; started_hhmm="$(hhmm)"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30
    # Restart once a night: the first check at/after RESTART_AT on a day where
    # the browser was already running before RESTART_AT.
    if [ "$(hhmm)" -ge "$RESTART_HHMM" ] && { [ "$(date +%F)" != "$started_day" ] || [ "$started_hhmm" -lt "$RESTART_HHMM" ]; }; then
      echo "$(date '+%F %T') marathon-tv: nightly restart"
      kill -TERM "$pid" 2>/dev/null
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -KILL "$pid" 2>/dev/null
      break
    fi
  done
  wait "$pid" 2>/dev/null
  echo "$(date '+%F %T') marathon-tv: browser closed — reopening in 5 s"
  sleep 5
done
