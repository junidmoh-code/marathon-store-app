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

# The ✓/⚠/✗ tallies are CUMULATIVE across every run in this log — that is the
# honest "how many names exist now". The chunk counters are scoped to the
# CURRENT run, because the driver restarts its own chunk numbering each time it
# is loaded, and mixing the two read as "4 finished" next to "chunk 1".
DONE=$(grep -c '^✓' "$LOG" 2>/dev/null || :); DONE=${DONE:-0}
REF=$(grep -c '^⚠' "$LOG" 2>/dev/null || :);  REF=${REF:-0}
BAD=$(grep -c '^✗' "$LOG" 2>/dev/null || :);  BAD=${BAD:-0}
RUNLOG=$(mktemp)
trap 'rm -f "$RUNLOG"' EXIT   # one place, so its lifetime cannot be got wrong
awk '/^── vision naming started/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$LOG" > "$RUNLOG"
CHUNKS=$(grep -c '^── chunk' "$RUNLOG" 2>/dev/null || :); CHUNKS=${CHUNKS:-0}
DONECHUNKS=$(grep -c 'finished (' "$RUNLOG" 2>/dev/null || :); DONECHUNKS=${DONECHUNKS:-0}
# The driver rewrites the worklist before every chunk, so its length IS the
# live remaining count. (name-remaining.sh sends the scope script's stdout to
# /dev/null, so the number is not in the log — the file is the source.)
LEFT=$(python3 -c "import json;print(len(json.load(open('/tmp/naming-scope.json'))))" 2>/dev/null || :)

echo "started      : $(grep '^── vision naming started' "$LOG" | tail -1 | sed 's/^── vision naming started //; s/ ──$//')"
# THE HONEST HEADLINE IS WHAT IS LEFT, NOT WHAT THE LOG COUNTED.
# The ✓ lines are printed by a chunk when it FINISHES, so a chunk killed part
# way through (a reboot, a restart, launchd stopping the job) writes its
# proposals to the database and prints none of them. Measured 2026-08-20 after
# three restarts: the log said 399, the database held 1,202. The worklist below
# is rebuilt from the database before every chunk, so it is the number to trust.
echo "still to do  : ${LEFT:-?}   ← the real one; rebuilt from the database each chunk"
echo "named (log)  : $DONE      (UNDERCOUNTS — a chunk stopped part way prints none of its names)"
echo "refused      : $REF       (name broke a compliance rule — kept for review, never applied)"
echo "failed       : $BAD"
echo "chunks       : $DONECHUNKS finished, $CHUNKS started   (this run)"
echo "current      : $(grep '^── chunk' "$RUNLOG" | tail -1)"

if grep -q 'ALL NAMED' "$LOG" 2>/dev/null; then
  echo
  echo "FINISHED — nothing left to name."
elif [ "$DONECHUNKS" -ge 1 ] && [ -n "${LEFT:-}" ]; then
  FIRST=$(grep '^── chunk 1 ' "$RUNLOG" | tail -1 | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}')
  LAST=$(grep '^── chunk' "$RUNLOG" | tail -1 | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}')
  if [ -n "$FIRST" ] && [ -n "$LAST" ] && [ "$DONECHUNKS" -gt 0 ]; then
    A=$(date -j -f "%H:%M:%S" "$FIRST" +%s 2>/dev/null)
    B=$(date -j -f "%H:%M:%S" "$LAST"  +%s 2>/dev/null)
    SPAN=$(( B - A ))
    if [ "$SPAN" -gt 0 ]; then
      # The chunk SIZE, not a literal 100: run-naming.sh exports CHUNK=100 but
      # name-remaining.sh defaults it to 200, so a run started directly from the
      # driver reported half the pace and double the ETA (reviewer finding).
      SIZE="${CHUNK:-100}"
      PER=$(( SPAN / DONECHUNKS ))                   # seconds per finished chunk
      MINS=$(( LEFT * PER / SIZE / 60 ))
      echo
      echo "pace         : ~$(( SIZE * 60 / (PER>0?PER:1) )) products/minute"
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
