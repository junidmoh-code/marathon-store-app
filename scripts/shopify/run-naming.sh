#!/bin/bash
# ── The vision-naming backlog run, as a restartable job ───────────────────────
# Wraps scripts/shopify/name-remaining.sh so launchd can own it:
#   · a PID-aware lockfile, so a reboot mid-run (or a manual start) can never
#     put two copies on the same catalogue — each would pay for the same photos
#   · caffeinate, because a laptop's idle sleep timer is short and a launchd job
#     is not a tty, so without it the run stalls the moment nobody is typing
#     (`pmset -g custom` → sleep 1, ttyskeepawake 1 on the machine this runs on)
#   · PHOTO_GATE pointed at a copy INSIDE the checkout, not /tmp, which macOS
#     clears on reboot; without it the scope script dies on every restart
#   · everything appended to logs/, so progress survives the process
#
# Chunked and resumable by construction: each proposal is written the moment it
# is produced and the scope query excludes anything already proposed, so
# stopping at any point loses nothing and starting again resumes where it left.
#
#   bash run-naming.sh          (from a checkout root, or from scripts/shopify)
set -u

# ── WHERE IS THE CHECKOUT? ───────────────────────────────────────────────────
# This file lives in TWO places: committed at scripts/shopify/run-naming.sh,
# and deployed beside a checkout at ~/naming-run/run-naming.sh. A plain
# `cd "$(dirname "$0")"` is right for exactly one of them — from the committed
# copy it lands in scripts/shopify and then looks for
# scripts/shopify/scripts/shopify/name-remaining.sh, which does not exist
# (reviewer finding). So the root is found by looking for the driver rather
# than by assuming a depth.
HERE="$(cd "$(dirname "$0")" && pwd)"
if   [ -f "$HERE/scripts/shopify/name-remaining.sh" ]; then ROOT="$HERE"
elif [ -f "$HERE/../../scripts/shopify/name-remaining.sh" ]; then ROOT="$(cd "$HERE/../.." && pwd)"
else
  echo "run-naming.sh: cannot find scripts/shopify/name-remaining.sh from $HERE" >&2
  exit 2
fi
cd "$ROOT"
mkdir -p logs                       # BEFORE the first append, or the lock
LOG="$ROOT/logs/vision-naming.log"  # message below is lost on a fresh checkout

# ── The lock, and how a dead one is recovered ────────────────────────────────
# mkdir is the atomic part. The PID inside is what makes a lock left behind by
# a SIGKILL (launchd stopping the job, a hard reboot) recoverable instead of
# permanent — a lock whose owner is gone is not a lock, and without this the
# job would refuse to start for ever and the run would silently never resume.
LOCK="$ROOT/.naming-run.lock"
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

# The gate file must live in the checkout: /tmp is cleared on reboot and the
# scope script dies without it — which name-remaining.sh reads as a network
# problem and retries for 200 iterations.
export PHOTO_GATE="${PHOTO_GATE:-$ROOT/config/groupkind2.json}"
export CHUNK="${CHUNK:-100}"
export LOG
echo "── run-naming.sh started $(date '+%F %T') (pid $$) ──" >> "$LOG"

# ── FIRST: the names the reconciler has ASKED for ────────────────────────────
# A publish refused because the storefront address a name produces already
# belongs to another listing has exactly one cure — a different name. The
# reconciler records that request on the node (scripts/shopify/adopt.mjs) and
# this serves it, so nobody has to notice the refusal and go and ask.
#
# It runs BEFORE the backlog and is not gated on the backlog finishing: a
# blocked product is a product off the shop, and it should not wait behind
# 2,000 unnamed ones.
#
# The confirm-batch handshake is honoured, not bypassed — the quote is read and
# echoed back. CAPPED: a run this size means something is wrong upstream (a
# whole batch colliding at once), and spending on it unattended is not the
# answer. It says so and leaves the backlog run to proceed.
REQ_CAP="${REQ_CAP:-50}"
# A NON-NUMERIC CAP IS NOT NO CAP. `[ "$N" -gt "$REQ_CAP" ]` on a non-numeric
# value fails, evaluates false, and the batch is served UNCAPPED — the opposite
# of what setting a cap means (CodeRabbit review, 2026-08-28). Refuse instead.
# SKIP the requested pass, do NOT abort the run: this script's job is the
# backlog, and a malformed cap on the side-pass is no reason to cancel it.
REQ_CAP_OK=1
case "$REQ_CAP" in
  ''|*[!0-9]*)
    echo "$(date '+%F %T') ⚠ REQ_CAP=\"$REQ_CAP\" is not a number — skipping the new-name pass rather than running it uncapped" >> "$LOG"
    REQ_CAP_OK=0
    ;;
esac
REQ_QUOTE=""
[ "$REQ_CAP_OK" -eq 1 ] && REQ_QUOTE=$(caffeinate -i -m node scripts/shopify/vision-name.mjs --requested 2>&1)
REQ_N=$(printf '%s\n' "$REQ_QUOTE" | sed -n 's/^scope: \([0-9][0-9]*\) product.*/\1/p' | head -1)
if [ -n "${REQ_N:-}" ] && [ "$REQ_N" -gt 0 ] 2>/dev/null; then
  if [ "$REQ_N" -gt "$REQ_CAP" ]; then
    echo "$(date '+%F %T') ⚠ $REQ_N new-name requests waiting — over the $REQ_CAP cap, NOT run. Something upstream is refusing in bulk; look at the publishing page." >> "$LOG"
  else
    echo "$(date '+%F %T') serving $REQ_N new-name request(s) from the reconciler" >> "$LOG"
    caffeinate -i -m node scripts/shopify/vision-name.mjs --requested --confirm-batch "$REQ_N" >> "$LOG" 2>&1 \
      || echo "$(date '+%F %T') ⚠ the new-name request pass exited non-zero — the backlog run continues" >> "$LOG"
  fi
fi

# -i no idle sleep, -m keep the disk awake. NOT -d: the display may sleep.
# The lid is still the owner's call — a closed lid sleeps regardless, and
# changing that would mean changing his power settings, which this does not do.
caffeinate -i -m bash scripts/shopify/name-remaining.sh
# CAPTURED ON ITS OWN LINE. Inside `echo "… rc=$? …"` the $(date …) substitution
# runs first, so $? would be date's status and every run would log rc=0
# (reviewer finding).
RC=$?
echo "── run-naming.sh finished $(date '+%F %T') rc=$RC ──" >> "$LOG"
exit "$RC"
