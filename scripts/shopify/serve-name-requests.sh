#!/bin/bash
# ── Serving the reconciler's new-name requests, on a schedule ────────────────
# When a publish is refused because the storefront address a name produces
# already belongs to another listing, the cure is a different name and nothing
# else. The reconciler records the request on the node (adopt.mjs,
# requestFreshName) — and a request nobody serves is a manual step wearing a
# hat, which is the one thing this codebase does not accept. This is the server.
#
# It is DELIBERATELY NOT run-naming.sh. That script drives the whole naming
# BACKLOG: thousands of products, hours of wall clock, real money. Putting it on
# a schedule to serve the occasional collision would be a spending decision
# nobody made. This does the requested pass and stops.
#
# COST WHEN THERE IS NOTHING TO DO: zero. The quote run resolves scope and exits
# before a single model call, so an idle tick is one RTDB walk and a node boot.
#
#   bash scripts/shopify/serve-name-requests.sh
#
# Env: REQ_CAP (default 50) — refuse to spend unattended above this. A run that
# size means something upstream is refusing in bulk, and the answer to that is
# a person looking at the publishing page, not a bill.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
if   [ -f "$HERE/scripts/shopify/vision-name.mjs" ]; then ROOT="$HERE"
elif [ -f "$HERE/../../scripts/shopify/vision-name.mjs" ]; then ROOT="$(cd "$HERE/../.." && pwd)"
else
  echo "serve-name-requests.sh: cannot find scripts/shopify/vision-name.mjs from $HERE" >&2
  exit 2
fi
cd "$ROOT"
mkdir -p logs
LOG="$ROOT/logs/name-requests.log"

# ── Lock, PID-aware ──────────────────────────────────────────────────────────
# mkdir is the atomic part; the pid inside is what makes a lock left by a
# SIGKILL recoverable instead of permanent. Two copies would pay twice for the
# same photos. It is a SEPARATE lock from run-naming.sh's on purpose — the two
# never touch the same product (the backlog run's scope excludes anything that
# already carries a proposal), and sharing one would let a four-hour backlog run
# block every collision cure for the afternoon.
LOCK="$ROOT/.name-requests.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then exit 0; fi
  echo "$(date '+%F %T') stale lock from pid ${OWNER:-unknown} — taking it over" >> "$LOG"
  rmdir "$LOCK" 2>/dev/null || true
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -f "$LOCK/pid" 2>/dev/null; rmdir "$LOCK" 2>/dev/null' EXIT

REQ_CAP="${REQ_CAP:-50}"
QUOTE=$(node scripts/shopify/vision-name.mjs --requested 2>&1)
# "scope: N product(s)". N counts only SERVABLE requests — vision-name drops a
# product with no photo before it reaches the scope, so a photoless request
# cannot inflate this number or push a real batch over the cap.
N=$(printf '%s\n' "$QUOTE" | sed -n 's/^scope: \([0-9][0-9]*\) product.*/\1/p' | head -1)

if [ -z "${N:-}" ]; then
  echo "$(date '+%F %T') ⚠ could not read a scope from the quote — the pass did not run:" >> "$LOG"
  printf '%s\n' "$QUOTE" | tail -5 >> "$LOG"
  exit 1
fi
if [ "$N" -eq 0 ] 2>/dev/null; then exit 0; fi   # the quiet, free, ordinary case
if [ "$N" -gt "$REQ_CAP" ] 2>/dev/null; then
  echo "$(date '+%F %T') ⚠ $N new-name requests waiting — over the $REQ_CAP cap, NOT run. Something upstream is refusing in bulk; look at the publishing page." >> "$LOG"
  exit 1
fi

echo "$(date '+%F %T') serving $N new-name request(s) from the reconciler" >> "$LOG"
node scripts/shopify/vision-name.mjs --requested --confirm-batch "$N" >> "$LOG" 2>&1
RC=$?
echo "$(date '+%F %T') done rc=$RC" >> "$LOG"
exit "$RC"
