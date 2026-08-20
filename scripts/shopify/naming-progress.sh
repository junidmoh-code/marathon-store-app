#!/bin/bash
# ── How far has the naming got? ──────────────────────────────────────────────
#
#   bash ~/naming-run/naming-progress.sh
#
# Reads the run's own log. Costs nothing and touches no network.
#
# HONESTY NOTE, because the raw counts mislead: the per-product ✓ lines are
# printed when a CHUNK FINISHES, not as each photo is read. So "named so far"
# lags by up to one chunk (100 products, ~10 minutes) and a rate computed from
# it reads low. The chunk line is the live signal; the estimate below is
# measured from completed chunks only.
set -u
cd "$(dirname "$0")"
LOG=logs/vision-naming.log
[ -f "$LOG" ] || { echo "no log yet — the job has not started"; exit 0; }

DONE=$(grep -c '^✓' "$LOG" 2>/dev/null || :); DONE=${DONE:-0}
REF=$(grep -c '^⚠' "$LOG" 2>/dev/null || :);  REF=${REF:-0}
BAD=$(grep -c '^✗' "$LOG" 2>/dev/null || :);  BAD=${BAD:-0}
CHUNKS=$(grep -c '^── chunk' "$LOG" 2>/dev/null || :); CHUNKS=${CHUNKS:-0}
DONECHUNKS=$(grep -c 'finished (' "$LOG" 2>/dev/null || :); DONECHUNKS=${DONECHUNKS:-0}
# The driver rewrites the worklist before every chunk, so its length IS the
# live remaining count. (name-remaining.sh sends the scope script's stdout to
# /dev/null, so the number is not in the log — the file is the source.)
LEFT=$(python3 -c "import json;print(len(json.load(open('/tmp/naming-scope.json'))))" 2>/dev/null || :)

echo "started      : $(grep '^── vision naming started' "$LOG" | tail -1 | sed 's/^── vision naming started //; s/ ──$//')"
echo "named so far : $DONE      (counted when a chunk finishes, so it lags by up to one chunk)"
echo "refused      : $REF       (name broke a compliance rule — kept for review, never applied)"
echo "failed       : $BAD"
echo "chunks       : $DONECHUNKS finished, $CHUNKS started"
[ -n "${LEFT:-}" ] && echo "still to name: ~$LEFT  (as of the last scope check)"
echo "current      : $(grep '^── chunk' "$LOG" | tail -1)"

if grep -q 'ALL NAMED' "$LOG" 2>/dev/null; then
  echo
  echo "FINISHED — nothing left to name."
elif [ "$DONECHUNKS" -ge 1 ] && [ -n "${LEFT:-}" ]; then
  FIRST=$(grep '^── chunk 1 ' "$LOG" | tail -1 | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}')
  LAST=$(grep '^── chunk' "$LOG" | tail -1 | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}')
  if [ -n "$FIRST" ] && [ -n "$LAST" ] && [ "$DONECHUNKS" -gt 0 ]; then
    A=$(date -j -f "%H:%M:%S" "$FIRST" +%s 2>/dev/null)
    B=$(date -j -f "%H:%M:%S" "$LAST"  +%s 2>/dev/null)
    SPAN=$(( B - A ))
    if [ "$SPAN" -gt 0 ]; then
      PER=$(( SPAN / DONECHUNKS ))                   # seconds per finished chunk
      MINS=$(( LEFT * PER / 100 / 60 ))
      echo
      echo "pace         : ~$(( 100 * 60 / (PER>0?PER:1) )) products/minute"
      echo "should finish: about $MINS minutes from now (~$(date -v+${MINS}M '+%H:%M'))"
    fi
  fi
fi

echo
launchctl list 2>/dev/null | grep -q com.marathon.visionnaming \
  && echo "job          : LOADED — restarts itself after a reboot" \
  || echo "job          : NOT LOADED"
pgrep -f 'vision-name.mjs' >/dev/null 2>&1 \
  && echo "right now    : reading photos" \
  || echo "right now    : between chunks, or finished"
