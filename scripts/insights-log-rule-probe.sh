#!/bin/bash
# ─── THE NEGATIVE CONTROL FOR THE /insights_log READ RULE ────────────────────
#
# Proves, against LIVE production and as an ordinary signed-in client (never an
# admin credential, which bypasses rules entirely), that:
#
#   BOUNDED   orderBy="$key" + limitToFirst=1   -> 200, one row
#   UNBOUNDED no query at all                   -> 401 once the rule is pasted
#
# Run it BEFORE pasting and again AFTER. Before, both return 200 — that is the
# whole problem: the unbounded read is a 35.99 MB response and nothing refuses
# it. After, the second must be 401. A rule that has never been seen to refuse
# anything is not a rule, it is a comment.
#
# It creates a throwaway email/password account, uses it, and deletes it. The
# account exists only for the length of the run and is never given a /users
# record, a role or a PIN. Nothing else in the project is touched, and the
# script reads at most a few hundred bytes of /insights_log: the unbounded call
# is capped with --max-filesize so the control does not itself cost 36 MB.
#
# Usage:  bash scripts/insights-log-rule-probe.sh
set -u

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
  curl -s -m 30 "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=$API_KEY" \
    -H 'Content-Type: application/json' -d "{\"idToken\":\"$TOKEN\"}" >/dev/null
  echo "▸ probe account deleted"
}
trap cleanup EXIT

echo
echo "── POSITIVE CONTROL — a bounded read must still work ──────────────────"
echo '   GET /insights_log.json?orderBy="$key"&limitToFirst=1'
POS=$(curl -s -m 30 -G "$DB/insights_log.json" \
  --data-urlencode 'orderBy="$key"' --data-urlencode 'limitToFirst=1' \
  --data-urlencode "auth=$TOKEN" -o /dev/null -w '%{http_code} %{size_download}')
echo "   -> http=${POS% *} bytes=${POS#* }"

echo
echo "── NEGATIVE CONTROL — the unbounded whole-node read ───────────────────"
echo '   GET /insights_log.json          (no orderBy, no limit, no range)'
NEG=$(curl -s -m 30 --max-filesize 4000 -G "$DB/insights_log.json" \
  --data-urlencode "auth=$TOKEN" -o /dev/null -w '%{http_code}')
echo "   -> http=$NEG"

echo
if [ "$NEG" = "401" ]; then
  echo "✓ RULE IS LIVE — the unbounded read is refused."
elif [ "$NEG" = "200" ]; then
  echo "✗ RULE IS NOT LIVE — the unbounded read was served."
  echo "  This is the \$3.19/day. Paste the block in RULES-INSIGHTS-LOG-QUERY.md."
else
  echo "? unexpected status $NEG — neither served nor refused; investigate before drawing a conclusion."
fi
