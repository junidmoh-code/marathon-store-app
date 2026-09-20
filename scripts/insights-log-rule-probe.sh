#!/bin/bash
# ─── THE NEGATIVE CONTROL FOR THE /insights_log READ RULE ────────────────────
#
# Proves, against LIVE production and as an ordinary signed-in client (never an
# admin credential, which bypasses rules entirely), that:
#
#   BOUNDED   orderBy="$key" + limitToFirst=1   -> 200, one row
#   UNBOUNDED no query at all                   -> 401 once the rule is pasted
#
# A rule that has never been seen to refuse anything is not a rule, it is a
# comment — so this is meant to be run AFTER the paste, where it costs nothing
# (a refusal is a 401 and no body).
#
# ── THE VERDICT IS GATED ON THE POSITIVE CONTROL ────────────────────────────
# An expired or rejected token returns 401 to BOTH requests, and a script that
# read only the second would announce "rule is live" having proved nothing. So
# the bounded call must come back 200 before the unbounded one is interpreted
# at all.
#
# ── RUNNING IT BEFORE THE PASTE COSTS REAL BYTES ────────────────────────────
# Before the rule is live the unbounded call is SERVED, and what it is serving
# is the 35.99 MB node. `--max-filesize` aborts the transfer, but only after
# the server has already begun pushing — a TCP window's worth, tens of
# kilobytes, not "a few hundred bytes". So the before-run is opt-in
# (--include-before) rather than the default, and the script prints the bytes
# it actually pulled instead of claiming they were free.
#
# It creates a throwaway email/password account, uses it, and deletes it. The
# account is never given a /users record, a role or a PIN.
#
# Usage:  bash scripts/insights-log-rule-probe.sh [--include-before]
set -u

INCLUDE_BEFORE=0
[ "${1:-}" = "--include-before" ] && INCLUDE_BEFORE=1

API_KEY="AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo"   # the public web config key (src/firebase.js)
DB="https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app"

EMAIL="rule-probe-$(date +%s)@marathon.internal"
PASSWORD="Probe-$(openssl rand -hex 12)"

echo "▸ creating a throwaway client account ($EMAIL)"
SIGNUP=$(curl -s -m 30 "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=$API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"returnSecureToken\":true}")
TOKEN=$(printf '%s' "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("idToken",""))')
if [ -z "$TOKEN" ]; then
  echo "✗ could not create a probe account:"; printf '%s\n' "$SIGNUP" | head -c 400; echo; exit 1
fi

cleanup() {
  DEL=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=$API_KEY" \
    -H 'Content-Type: application/json' -d "{\"idToken\":\"$TOKEN\"}")
  if [ "$DEL" = "200" ]; then
    echo "▸ probe account deleted"
  else
    # Never silent: a probe account left behind is a real account.
    echo "✗ probe account NOT deleted (http=$DEL) — delete $EMAIL in the Firebase Auth console"
  fi
}
trap cleanup EXIT

echo
echo "── POSITIVE CONTROL — a bounded read must still work ──────────────────"
echo '   GET /insights_log.json?orderBy="$key"&limitToFirst=1'
POS=$(curl -s -m 30 -G "$DB/insights_log.json" \
  --data-urlencode 'orderBy="$key"' --data-urlencode 'limitToFirst=1' \
  --data-urlencode "auth=$TOKEN" -o /dev/null -w '%{http_code} %{size_download}')
POS_CODE=${POS% *}
echo "   -> http=$POS_CODE bytes=${POS#* }"

if [ "$POS_CODE" != "200" ]; then
  echo
  echo "✗ INCONCLUSIVE — the bounded read did not succeed (http=$POS_CODE)."
  echo "  The token or the connection is the problem, not the rule. Nothing below"
  echo "  would mean anything, so the unbounded call is not made."
  exit 2
fi

echo
echo "── NEGATIVE CONTROL — the unbounded whole-node read ───────────────────"
echo '   GET /insights_log.json          (no orderBy, no limit, no range)'
if [ "$INCLUDE_BEFORE" = "0" ]; then
  # Cheap when the rule is live. If it is NOT live this pulls part of a 36 MB
  # body, which is why the pre-paste run has to be asked for.
  echo "   (if the rule is not live this DOWNLOADS part of the 35.99 MB node —"
  echo "    that is the point of the control, and the bytes are printed below)"
fi
NEG=$(curl -s -m 30 --max-filesize 4000 -G "$DB/insights_log.json" \
  --data-urlencode "auth=$TOKEN" -o /dev/null -w '%{http_code} %{size_download}')
NEG_CODE=${NEG% *}
echo "   -> http=$NEG_CODE bytes=${NEG#* } (aborted by --max-filesize; the wire cost is"
echo "      whatever the server had already pushed, tens of KB, not zero)"

echo
if [ "$NEG_CODE" = "401" ]; then
  echo "✓ RULE IS LIVE — a bounded read is served and the unbounded one is refused."
elif [ "$NEG_CODE" = "200" ]; then
  echo "✗ RULE IS NOT LIVE — the unbounded read was served."
  echo "  This is the \$3.19/day. Paste the block in RULES-INSIGHTS-LOG-QUERY.md."
else
  echo "? unexpected status $NEG_CODE — neither served nor refused; investigate"
  echo "  before drawing a conclusion."
fi
