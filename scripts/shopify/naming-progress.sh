#!/bin/bash
# ── How far has the naming got? ──────────────────────────────────────────────
# Reads the run's own log. Costs nothing and needs no network.
#
#   bash ~/naming-run/naming-progress.sh
#
# The per-product lines are printed when a CHUNK finishes, not as each photo is
# read, so between chunks the newest chunk header is the live signal. The
# process line at the bottom is the definitive "is it still going".
set -u
cd "$(dirname "$0")"
LOG=logs/vision-naming.log

# NOTE: grep -c already PRINTS 0 when it matches nothing, and exits 1 while
# doing it — so `|| echo 0` appends a second zero and every later test breaks
# on "0\n0". The exit code is swallowed with `|| :` instead.
DONE=$(grep -c '^✓' "$LOG" 2>/dev/null || :)
REF=$(grep -c '^⚠' "$LOG" 2>/dev/null || :)
BAD=$(grep -c '^✗' "$LOG" 2>/dev/null || :)
DONE=${DONE:-0}; REF=${REF:-0}; BAD=${BAD:-0}
LASTCHUNK=$(grep '^── chunk' "$LOG" 2>/dev/null | tail -1)
STARTED=$(grep '^── vision naming started' "$LOG" 2>/dev/null | tail -1 | sed 's/^── vision naming started //; s/ ──$//')

echo "started      : ${STARTED:-not yet}"
echo "named so far : $DONE"
echo "refused      : $REF   (the name broke a compliance rule — kept, not applied)"
echo "failed       : $BAD"
echo "current      : ${LASTCHUNK:-—}"

if grep -q 'ALL NAMED' "$LOG" 2>/dev/null; then
  echo
  echo "FINISHED — nothing left to name."
elif [ "$DONE" -gt 0 ]; then
  # Rate from the first chunk header to now, products per minute.
  FIRST=$(grep '^── chunk 1 ' "$LOG" | tail -1 | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}')
  if [ -n "$FIRST" ]; then
    S=$(( $(date -j -f "%H:%M:%S" "$(date +%H:%M:%S)" +%s 2>/dev/null) - $(date -j -f "%H:%M:%S" "$FIRST" +%s 2>/dev/null) ))
    [ "$S" -gt 0 ] && echo && echo "rate         : ~$(( DONE * 60 / S )) products/minute"
  fi
fi

echo
if launchctl list 2>/dev/null | grep -q com.marathon.visionnaming; then
  echo "job          : LOADED (restarts after a reboot)"
else
  echo "job          : NOT LOADED"
fi
if pgrep -f 'vision-name.mjs' >/dev/null 2>&1; then
  echo "right now    : reading photos"
else
  echo "right now    : between chunks, or finished"
fi
