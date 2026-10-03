#!/bin/bash
# One-time install of the Marathon Labels launcher on a Mac:
#   1. copies MarathonLabels.command into ~/Library/Application Support/MarathonLabels
#   2. registers it as a login item (a LaunchAgent with RunAtLoad) and opens it now
#   3. if an Xprinter XP-350B print queue exists, makes it the default printer with
#      40 x 30 mm labels (the OS print route prints there)
# Run:  curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/mac/install.sh | bash
set -euo pipefail

RAW="https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/mac"
DIR="$HOME/Library/Application Support/MarathonLabels"
LABEL="club.marathon.labels"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"

# From a checkout use the file beside this script; from curl | bash download it.
SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -f "$(dirname "$SRC")/MarathonLabels.command" ]; then
  cp "$(dirname "$SRC")/MarathonLabels.command" "$DIR/MarathonLabels.command"
else
  curl -fsSL "$RAW/MarathonLabels.command" -o "$DIR/MarathonLabels.command"
fi
chmod +x "$DIR/MarathonLabels.command"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/MarathonLabels.command</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Default printer + label size for the OS print route (skipped if no queue found).
QUEUE="$(lpstat -e 2>/dev/null | grep -i -m1 -E 'xp.?350' || true)"
if [ -n "$QUEUE" ]; then
  lpoptions -d "$QUEUE" >/dev/null
  lpoptions -p "$QUEUE" -o media=Custom.40x30mm >/dev/null
  echo "Default printer: $QUEUE (40 x 30 mm labels)"
else
  echo "No XP-350B print queue found — set the default printer by hand (see README)."
fi
echo "Installed. Marathon Labels opens now and at every login."
