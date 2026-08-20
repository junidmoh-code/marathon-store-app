#!/bin/bash
# ── The vision-naming backlog run, as a restartable job ───────────────────────
# Wraps scripts/shopify/name-remaining.sh so launchd can own it:
#   · a lockfile, so a reboot mid-run (or a manual start) can never put two
#     copies on the same catalogue — each would pay for the same photos
#   · PHOTO_GATE pointed at a copy INSIDE this checkout, not /tmp, which macOS
#     clears on reboot; without it the scope script dies on every restart
#   · everything appended to logs/, so progress survives the process
#
# Chunked and resumable by construction: each proposal is written the moment it
# is produced and the scope query excludes anything already proposed, so
# stopping at any point loses nothing and starting again resumes where it left.
set -u
cd "$(dirname "$0")"

LOCK="$PWD/.naming-run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') another naming run holds the lock — exiting" >> logs/vision-naming.log
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

export PHOTO_GATE="$PWD/config/groupkind2.json"
export CHUNK="${CHUNK:-100}"
export LOG="$PWD/logs/vision-naming.log"
mkdir -p logs

echo "── run-naming.sh started $(date '+%F %T') (pid $$) ──" >> "$LOG"
bash scripts/shopify/name-remaining.sh
echo "── run-naming.sh finished $(date '+%F %T') rc=$? ──" >> "$LOG"
