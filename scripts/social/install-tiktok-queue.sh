#!/bin/bash
# Installs (or refreshes) the TikTok handoff queue on the Mac mini: the two
# launchd jobs, the mark-posted token, and the Tailscale Funnel path.
# Safe to run again. docs/tiktok-queue.md.
set -euo pipefail
REPO="$HOME/marathon-social"
AGENTS="$HOME/Library/LaunchAgents"
UIDN=$(id -u)
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)

mkdir -p "$HOME/.marathon-tiktok-queue" "$REPO/logs" "$AGENTS"

# mark-posted token (kept if it exists). Junid's Claude chat sends it as "Authorization: Bearer <token>".
TOKEN="$HOME/.config/marathon/tiktok-queue.token"
if [ ! -s "$TOKEN" ]; then
  mkdir -p "$(dirname "$TOKEN")"
  ( umask 077; openssl rand -hex 32 > "$TOKEN" )
  echo "created $TOKEN"
fi
chmod 600 "$TOKEN"

for job in com.marathon.tiktokqueue.server com.marathon.tiktokqueue.build; do
  cp "$REPO/scripts/social/$job.plist" "$AGENTS/$job.plist"
  launchctl bootout "gui/$UIDN/$job" 2>/dev/null || true
  launchctl bootstrap "gui/$UIDN" "$AGENTS/$job.plist"
  echo "loaded $job"
done

# Funnel: only this path goes to the queue server; /studio stays with Signal Studio.
"$TS" funnel --bg --set-path /studio/tiktok-queue http://127.0.0.1:8798 >/dev/null
"$TS" funnel status | grep -E "tiktok-queue|/studio"
