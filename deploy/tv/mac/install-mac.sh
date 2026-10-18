#!/bin/bash
# One-time install of the Marathon TV board on a Mac plugged into the store TV:
#   1. copies marathon-tv.sh into ~/Library/Application Support/MarathonTV
#   2. registers it as a LaunchAgent (starts at login, restarts if it stops)
# Run:  curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv/mac/install-mac.sh | bash
# Section 1 board:  ... | MARATHON_TV_SECTION=1 bash
# Remove:  launchctl bootout gui/$(id -u)/club.marathon.tv; rm ~/Library/LaunchAgents/club.marathon.tv.plist
set -euo pipefail

RAW="https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv"
DIR="$HOME/Library/Application Support/MarathonTV"
LABEL="club.marathon.tv"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/marathon-tv.log"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -f "$(dirname "$SRC")/../marathon-tv.sh" ]; then
  cp "$(dirname "$SRC")/../marathon-tv.sh" "$DIR/marathon-tv.sh"
  cp "$(dirname "$SRC")/club.marathon.tv.plist" "$DIR/template.plist"
else
  curl -fsSL "$RAW/marathon-tv.sh" -o "$DIR/marathon-tv.sh"
  curl -fsSL "$RAW/mac/club.marathon.tv.plist" -o "$DIR/template.plist"
fi
chmod +x "$DIR/marathon-tv.sh"

# A Section 1 board keeps its setting across restarts.
if [ -n "${MARATHON_TV_SECTION:-}" ]; then
  sed -i '' "2a\\
export MARATHON_TV_SECTION=\"$MARATHON_TV_SECTION\"
" "$DIR/marathon-tv.sh"
fi

sed -e "s#__SCRIPT__#$DIR/marathon-tv.sh#" -e "s#__LOG__#$LOG#g" "$DIR/template.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# Re-run safe: bootout is asynchronous, so retry the bootstrap briefly.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  sleep 1
done
echo "Marathon TV installed. The board opens now and at every login. Log: $LOG"
