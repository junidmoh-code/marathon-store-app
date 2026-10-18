#!/bin/zsh -l
# ─── LOOKBOOK V2: FINISH THE ONE-OFF RUNS ONCE GEMINI HAS CREDIT AGAIN ───────
# On 18 Oct 2026 the Gemini prepaid credits ran out (HTTP 402) after 160 of the
# 1,030 clean product shots. This waits for credit, then finishes the owner's
# brief on the Mac mini, each stage once (resume.state):
#
#   1. prewarm   the rest of the clean-shot cache, two runs (front and back half)
#   2. sample04  a concrete poster
#   3. sample05  a garden poster
#   4. publish   both into the Social card as SAMPLE items + emailed to Junid
#
# The probe is one real shot (prewarm --limit 1): a 402 costs nothing, and a
# success is a shot the cache needed anyway. Every 15 minutes.
#
#   nohup scripts/social/lookbook-v2-resume.sh > ~/Desktop/lookbook-samples/resume.log 2>&1 &
set -u
cd "$(dirname "$0")/../.." || exit 1
export GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json
DIR=~/Desktop/lookbook-samples
STATE=$DIR/resume.state
mkdir -p "$DIR/thumbs"; touch "$STATE"
done_() { grep -qx "$1" "$STATE"; }
mark() { echo "$1" >> "$STATE"; echo "$(date '+%F %T') ✓ $1"; }
say() { echo "$(date '+%F %T') $*"; }

if ! done_ prewarm; then
  while true; do
    out=$(node scripts/social/lookbook-thumbs-prewarm.mjs --limit 1 2>&1)
    if echo "$out" | grep -q "to generate 0"; then break; fi
    if echo "$out" | grep -q "→ generated"; then say "Gemini answers again"; break; fi
    say "no credit yet ($(echo "$out" | grep -o 'HTTP 40[0-9]' | head -1)) — next try in 15 min"
    sleep 900
  done
  node scripts/social/lookbook-thumbs-prewarm.mjs --concurrency 4 > "$DIR/thumbs/prewarm-c.log" 2>&1 &
  a=$!
  sleep 120   # let the first run read the queue before the second starts behind it
  node scripts/social/lookbook-thumbs-prewarm.mjs --from 430 --concurrency 4 > "$DIR/thumbs/prewarm-d.log" 2>&1 &
  b=$!
  wait $a $b
  if grep -q "HTTP 402" "$DIR/thumbs/prewarm-c.log" "$DIR/thumbs/prewarm-d.log"; then
    say "credit ran out again during the pre-warm — restarting the wait"; exec "$0"
  fi
  mark prewarm
fi

for spec in "04 concrete" "05 garden"; do
  n=${spec% *}; scene=${spec#* }
  done_ "sample$n" && continue
  if node scripts/social/lookbook-samples.mjs --n "$n" --scene "$scene" --override-cap > "$DIR/sample-$n.log" 2>&1; then
    mark "sample$n"
  else
    say "sample $n failed: $(tail -c 400 "$DIR/sample-$n.log")"; exit 2
  fi
done

if ! done_ publish; then
  node scripts/social/lookbook-samples-publish.mjs --email > "$DIR/publish-v2.log" 2>&1 && mark publish || { say "publish failed: $(tail -c 400 "$DIR/publish-v2.log")"; exit 3; }
fi
say "lookbook v2 one-off runs finished"
