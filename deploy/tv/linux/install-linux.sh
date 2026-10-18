#!/bin/bash
# One-time install of the Marathon TV board on a Raspberry Pi / Debian desktop.
# Needs: the desktop set to log in automatically, and Chromium installed
# (sudo apt install chromium — Raspberry Pi OS already has it).
# Run:  curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv/linux/install-linux.sh | bash
# Section 1 board:  ... | MARATHON_TV_SECTION=1 bash
# Remove:  systemctl --user disable --now marathon-tv
set -euo pipefail

RAW="https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv"
DIR="$HOME/.local/share/marathon-tv"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$DIR" "$UNIT_DIR" "$HOME/.config/marathon-tv"

SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -f "$(dirname "$SRC")/../marathon-tv.sh" ]; then
  cp "$(dirname "$SRC")/../marathon-tv.sh" "$DIR/marathon-tv.sh"
  cp "$(dirname "$SRC")/marathon-tv.service" "$UNIT_DIR/marathon-tv.service"
else
  curl -fsSL "$RAW/marathon-tv.sh" -o "$DIR/marathon-tv.sh"
  curl -fsSL "$RAW/linux/marathon-tv.service" -o "$UNIT_DIR/marathon-tv.service"
fi
chmod +x "$DIR/marathon-tv.sh"
[ -n "${MARATHON_TV_SECTION:-}" ] && echo "MARATHON_TV_SECTION=$MARATHON_TV_SECTION" > "$HOME/.config/marathon-tv/env"

# Never blank the screen (X11 desktops; harmless elsewhere).
command -v xset >/dev/null 2>&1 && DISPLAY="${DISPLAY:-:0}" xset s off -dpms 2>/dev/null || true

# Hand the desktop session's display variables to the user service manager.
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now marathon-tv.service
echo "Marathon TV installed. It opens now and every time the Pi starts. Log: journalctl --user -u marathon-tv"
