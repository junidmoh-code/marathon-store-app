#!/bin/bash
# The local stylist's daily run on the Mac mini (launchd: com.marathon.stylist).
# Runs from the live marathon-social checkout, appends to a dated log and
# keeps 30 days of logs. A run that already picked today exits at once, so the
# second fire (the retry) costs nothing when the first worked.
set -u
REPO="${STYLIST_REPO:-$HOME/marathon-social}"
LOGDIR="$HOME/.marathon-stylist/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/stylist-$(date +%Y-%m-%d).log"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/marathon/shopify-reconciler-sa.json"
# The live checkout follows origin/main by itself (fast-forward only, and only
# when nobody has local edits there), so a merged change to stylist/ or the
# shared functions/lib rules needs no hand step on the mini.
if [ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  git -C "$REPO" fetch -q origin main && git -C "$REPO" merge -q --ff-only origin/main >> "$LOG" 2>&1 || echo "stylist: could not fast-forward $REPO (kept as is)" >> "$LOG"
fi
# The Ollama service may still be starting after a reboot: wait up to 2 minutes.
for i in $(seq 1 24); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 5; done
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') stylist run ($(git -C "$REPO" rev-parse --short HEAD)) ==="
  /opt/homebrew/bin/node --dns-result-order=ipv4first "$REPO/stylist/run.mjs" "$@"
  echo "=== exit $? ==="
} >> "$LOG" 2>&1
find "$LOGDIR" -name 'stylist-*.log' -mtime +30 -delete
