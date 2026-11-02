#!/bin/bash
# Install / refresh com.marathon.sbportalrecon on the Mac mini. Idempotent.
#   bash ~/marathon-store-app/tools/sb-portal-recon/install.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOOL="$REPO/tools/sb-portal-recon"
NODE="$(command -v node || true)"; [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || { echo "✗ node not found"; exit 1; }
POLLER="$HOME/Library/LaunchAgents/com.marathon.cardreconpoll.plist"
# The SAME service-account key the mailbox poller uses (it mints the poller's identity).
SA="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:GOOGLE_APPLICATION_CREDENTIALS' "$POLLER" 2>/dev/null || true)"
[ -n "$SA" ] && [ -f "$SA" ] || { echo "✗ the card recon poller's GOOGLE_APPLICATION_CREDENTIALS was not found in $POLLER"; exit 1; }
[ -d "/Applications/Google Chrome.app" ] || echo "⚠ Google Chrome is not installed — run: (cd $TOOL && npx playwright install chromium)"
(cd "$TOOL" && npm ci --omit=dev --no-audit --no-fund --silent)
(cd "$REPO/functions" && [ -d node_modules/firebase-admin ] || npm ci --omit=dev --no-audit --no-fund --silent)
mkdir -p "$REPO/logs" "$HOME/.marathon/sb-portal"; chmod 700 "$HOME/.marathon/sb-portal"
DEST="$HOME/Library/LaunchAgents/com.marathon.sbportalrecon.plist"
sed -e "s#/opt/homebrew/bin/node#$NODE#" \
    -e "s#/Users/marathonclub/marathon-store-app#$REPO#g" \
    -e "s#/Users/marathonclub/.config/marathon/shopify-reconciler-sa.json#$SA#" \
    "$TOOL/com.marathon.sbportalrecon.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null
launchctl bootout "gui/$(id -u)/com.marathon.sbportalrecon" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$(id -u)/com.marathon.sbportalrecon" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl print "gui/$(id -u)/com.marathon.sbportalrecon" | grep -E "state =|path =" | head -3
echo "✓ installed: 18:00 and 18:20 SAST → $REPO/logs/sb-portal-recon.log"
