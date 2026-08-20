#!/bin/bash
# ── The vision-naming backlog run, as a restartable job ───────────────────────
# Wraps scripts/shopify/name-remaining.sh so launchd can own it:
#   · a PID-aware lockfile, so a reboot mid-run (or a manual start) can never
#     put two copies on the same catalogue — each would pay for the same photos
#   · caffeinate, because this machine's idle sleep timer is ONE MINUTE and a
#     launchd job is not a tty, so without it the run stalls the moment nobody
#     is typing (`pmset -g custom` → sleep 1, ttyskeepawake 1)
#   · PHOTO_GATE pointed at a copy INSIDE this checkout, not /tmp, which macOS
#     clears on reboot; without it the scope script dies on every restart
#   · everything appended to logs/, so progress survives the process
#
# Chunked and resumable by construction: each proposal is written the moment it
# is produced and the scope query excludes anything already proposed, so
# stopping at any point loses nothing and starting again resumes where it left.
set -u
cd "$(dirname "$0")"
mkdir -p logs
LOG="$PWD/logs/vision-naming.log"

# ── The lock, and how a dead one is recovered ────────────────────────────────
# mkdir is the atomic part. The PID inside is what makes a lock left behind by
# a SIGKILL (launchd stopping the job, a hard reboot) recoverable instead of
# permanent — a lock whose owner is gone is not a lock, and without this the
# job would refuse to start for ever and the run would silently never resume.
LOCK="$PWD/.naming-run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
    echo "$(date '+%F %T') another naming run (pid $OWNER) holds the lock — exiting" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale lock from pid ${OWNER:-unknown} — taking it over" >> "$LOG"
  rmdir "$LOCK" 2>/dev/null || true
  mkdir "$LOCK" 2>/dev/null || { echo "$(date '+%F %T') could not take the lock — exiting" >> "$LOG"; exit 0; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -f "$LOCK/pid" 2>/dev/null; rmdir "$LOCK" 2>/dev/null' EXIT

export PHOTO_GATE="$PWD/config/groupkind2.json"
export CHUNK="${CHUNK:-100}"
export LOG
echo "── run-naming.sh started $(date '+%F %T') (pid $$) ──" >> "$LOG"

# -i no idle sleep, -m keep the disk awake. NOT -d: the display may sleep.
# The lid is still the owner's call — a closed lid sleeps regardless, and
# changing that would mean changing his power settings, which this does not do.
caffeinate -i -m bash scripts/shopify/name-remaining.sh
RC=$?
echo "── run-naming.sh finished $(date '+%F %T') rc=$RC ──" >> "$LOG"
exit $RC
