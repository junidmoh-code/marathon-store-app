#!/bin/bash
# Marathon Labels — the store app in its own Chrome window that prints labels
# with no print dialog (--kiosk-printing sends window.print() straight to the
# macOS default printer). Its own profile, so the flag always takes effect even
# when everyday Chrome is already open. Installed by install.sh as a login item.
URL="https://marathon-club.web.app/"
PROFILE="$HOME/Library/Application Support/MarathonLabels/Chrome"
mkdir -p "$PROFILE"
exec open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --kiosk-printing \
  --no-first-run --no-default-browser-check \
  "$URL"
