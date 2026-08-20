#!/bin/bash
# ── Name the remaining catalogue, in chunks that survive interruption ─────────
#
# Vision naming reads each product's photo and proposes a public listing name
# plus an internal identity. It runs at roughly 9 products a minute, so the
# ~2,400 still unnamed take about four and a half hours — longer than any single
# session reliably lasts.
#
# So it runs in chunks. Each proposal is written the moment it is produced, and
# the scope query excludes anything already proposed, so:
#   • stopping it at any point loses nothing
#   • starting it again resumes exactly where it stopped
#   • nothing is ever named or charged for twice
#
# Safe to run under nohup, in a screen, or from cron. Ctrl-C is safe.
#
#   bash scripts/shopify/name-remaining.sh
#
# Requires GEMINI_API_KEY in the repo-root .env (or the environment), and
# Application Default Credentials for RTDB.
set -u
cd "$(dirname "$0")/../.."

CHUNK="${CHUNK:-200}"
LOG="${LOG:-logs/vision-naming.log}"
mkdir -p "$(dirname "$LOG")"

echo "── vision naming started $(date) ──" | tee -a "$LOG"

for i in $(seq 1 200); do
  if ! node scripts/shopify/_scope-unnamed.mjs > /dev/null 2>>"$LOG"; then
    echo "scope read failed (network?); waiting 30s" | tee -a "$LOG"
    sleep 30
    continue
  fi
  N=$(python3 -c "import json;print(min($CHUNK,len(json.load(open('/tmp/naming-scope.json')))))")
  if [ "$N" -eq 0 ]; then
    echo "ALL NAMED — nothing left in scope. Stopped after $((i-1)) chunks." | tee -a "$LOG"
    exit 0
  fi
  PIDS=$(python3 -c "import json;print(','.join(json.load(open('/tmp/naming-scope.json'))[:$N]))")
  echo "── chunk $i · $N products · $(date +%H:%M:%S) ──" | tee -a "$LOG"
  node scripts/shopify/vision-name.mjs --pids "$PIDS" --confirm-batch "$N" >>"$LOG" 2>&1
  DONE_NOW=$(grep -c '^✓\|^⚠' "$LOG" 2>/dev/null || :); DONE_NOW=${DONE_NOW:-0}
  echo "   chunk $i finished ($DONE_NOW decided so far)" | tee -a "$LOG"

  # ── A CHUNK THAT DECIDES NOTHING MUST NOT BE RETRIED FOR EVER ──────────────
  # The scope is sorted and this driver always takes the HEAD slice, so a
  # product only leaves the head once a proposal (or a refusal) is written for
  # it. Two of vision-name.mjs's outcomes write nothing: "unusable" — the call
  # completed AND WAS CHARGED but the answer did not parse — and "failed", an
  # exception such as a photo that never downloads.
  #
  # So a chunk where every product lands in one of those two selects exactly
  # the same pids next time, and pays for the unusable ones again, for up to
  # 200 iterations. That is a bill with nothing to show for it and no message
  # saying so (reviewer finding). Two consecutive no-progress chunks stop the
  # run and say what to look at.
  if [ "$DONE_NOW" -le "${PREV_DECIDED:-0}" ]; then
    STALL=$(( ${STALL:-0} + 1 ))
    echo "   ⚠ chunk $i decided nothing (stall $STALL of 2)" | tee -a "$LOG"
    if [ "$STALL" -ge 2 ]; then
      echo "STOPPED: two chunks in a row produced no decision. The same products are being" | tee -a "$LOG"
      echo "retried and any 'unusable' ones are being paid for each time. Look at the last" | tee -a "$LOG"
      echo "✗/unusable lines above before restarting." | tee -a "$LOG"
      exit 3
    fi
  else
    STALL=0
  fi
  PREV_DECIDED=$DONE_NOW
done
echo "reached the chunk ceiling — run it again to continue" | tee -a "$LOG"
