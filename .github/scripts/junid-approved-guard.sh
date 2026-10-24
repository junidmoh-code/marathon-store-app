#!/usr/bin/env bash
# ─── JUNID-APPROVED GUARD ────────────────────────────────────────────────────
# Fails when a change touches policy, targets, the refill engine, request
# creation or the Refill Queue and the PR does not carry the label
# "junid-approved". See CLAUDE.md, "Junid's rules".
#
#   .github/scripts/junid-approved-guard.sh <base-sha> <head-sha> <approved: yes|no>
#
# The workflow decides <approved> (label present AND last added by Junid) and
# runs THIS file from the base branch, so a PR cannot rewrite its own judge.
#
# Two tests, either one trips the guard:
#   1. PATHS — any changed file (old or new name) matching GUARDED_PATHS.
#   2. CONTENT — in ANY other code file, an added or removed non-comment line
#      that names a request, target, policy or sale-log path (CONTENT_PATTERN).
#      That is what catches App.jsx and functions/index.js without gating every
#      PR that touches those two big files for unrelated reasons.
set -euo pipefail
BASE="$1"; HEAD="$2"; APPROVED="${3:-no}"

GUARDED_PATHS='^(functions/lib/(refill-engine|policy-[a-z-]+|category-policy[a-z-]*|central-fed|first-batch|shop-source-rule|refusal-writeoff|hold-availability-notify|order-tomorrow-notify|product-merge)\.cjs|functions/refill-scan\.cjs|functions/mirrorChanges/legs\.cjs|src/components/stock/(RefillQueue\.jsx|refillQueueCore\.js|refillSatisfied\.js|saleRowPolicyCap\.js|useExplicitTargetRows\.js|seatingCore\.js|seatingStore\.js|SeatingActions\.jsx|targetOverride\.js|policyTemplate\.js|EnginePolicyCard\.jsx|enginePolicyCore\.js|armingCore\.js|armingStore\.js|centralFed\.js|firstBatchCore\.js|solvePlan\.js|missingFootwearCore\.js|MissingFootwear\.jsx|missingProductsCore\.js|onHoldRefill\.js|releaseWindows\.js|NoTargetQueue\.jsx|IntroduceExisting\.jsx|introduceExistingCore\.js|NetworkTransfer\.jsx|Transfer\.jsx|StockHoldRelease\.jsx|ExcessHubToCentral\.jsx|HealthView\.jsx|RefillHistory\.jsx|refillHistoryCore\.js|actionReasons\.js|displayPairCore\.js|refusalGuard\.js|stockHoldCore\.js|useStock\.js)|src/config/enginePolicy\.js|src/utils/(insights|onlineEscalation)\.js|scripts/(apply-[^/]*|arm-[^/]*|seed-[^/]*|retarget[^/]*)\.mjs|scripts/(targets|repair)/.*|database\.rules\.json|\.github/(CODEOWNERS|scripts/junid-approved-guard\.sh|workflows/junid-approved\.yml)|CLAUDE\.md)$'
CONTENT_PATTERN='refill_requests|refill_engine|restock_requests|restock_log|stock_targets|config/refillEngine|refillEngine/|policyGroups|categoryPolicy|footwearRunByLocation|footwearTargets|saleRowsFor|soldEntriesFor|restockLog|pendingSaleRows|placeRefillRequests'

if [[ "$APPROVED" == "yes" ]]; then
  echo "junid-approved (added by Junid) — guard satisfied."
  exit 0
fi

hits=()
note() { hits+=("$1"); }
# --no-renames: a moved file is listed under BOTH names, so moving a guarded
# file out of its path still trips the path test. -z: names are NUL-separated
# and never quoted, so a non-ASCII name cannot escape the pathspec below.
while IFS= read -r -d '' f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $GUARDED_PATHS ]]; then note "$f (guarded path)"; continue; fi
  # The content test is for code: docs and tests that only MENTION a path are
  # not changes to request logic (a test that loosens a guarded behaviour still
  # ships with the guarded file it tests, which trips the path test).
  if [[ "$f" =~ \.md$ || "$f" =~ ^docs/ || "$f" =~ \.test\.(c|m)?jsx?$ || "$f" =~ (^|/)__tests__/ ]]; then continue; fi
  # Capture first, then match: grep -q exiting early would SIGPIPE the diff and
  # pipefail would turn a real hit into a miss on a large file.
  d=$(git diff --no-renames --unified=0 "$BASE...$HEAD" -- ":(literal)$f" || true)
  changed=$(printf '%s\n' "$d" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | grep -vE '^[+-][[:space:]]*(//|\*|/\*|#)' || true)
  if [[ -n "$changed" ]] && grep -E "$CONTENT_PATTERN" >/dev/null <<<"$changed"; then
    note "$f (changes a line naming requests/targets/policy)"
  fi
done < <(git -c core.quotepath=off diff --no-renames --name-only -z "$BASE...$HEAD")

if (( ${#hits[@]} == 0 )); then
  echo "No guarded change — guard satisfied."
  exit 0
fi
echo "This PR changes policy, targets, the refill engine, request creation or the Refill Queue:"
printf '  - %s\n' "${hits[@]}"
echo
echo "Junid's rule: no such change unless Junid specifically asked for it."
echo "Only Junid (junidmoh-code) adding the label \"junid-approved\" satisfies this check."
exit 1
