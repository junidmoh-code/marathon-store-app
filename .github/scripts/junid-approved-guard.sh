#!/usr/bin/env bash
# ─── JUNID-APPROVED GUARD ────────────────────────────────────────────────────
# Fails when a change touches policy, targets, the refill engine, request
# creation or the Refill Queue and the PR does not carry the label
# "junid-approved". See CLAUDE.md, "Junid's rules".
#
#   .github/scripts/junid-approved-guard.sh <base-ref> <head-ref> "<labels, comma-separated>"
#
# Two tests, either one trips the guard:
#   1. PATHS — any changed file matching GUARDED_PATHS below.
#   2. CONTENT — in ANY other file, an added or removed line that names a
#      request, target, policy or sale-log path (CONTENT_PATTERN). This is what
#      catches App.jsx and functions/index.js without gating every PR that
#      touches those two large files for unrelated reasons.
set -euo pipefail
BASE="$1"; HEAD="$2"; LABELS="${3:-}"

GUARDED_PATHS='^(functions/lib/(refill-engine|policy-[a-z-]+|category-policy[a-z-]*|central-fed|first-batch|shop-source-rule|refusal-writeoff)\.cjs|functions/refill-scan\.cjs|src/components/stock/(RefillQueue\.jsx|refillQueueCore\.js|refillSatisfied\.js|saleRowPolicyCap\.js|seatingCore\.js|seatingStore\.js|SeatingActions\.jsx|targetOverride\.js|policyTemplate\.js|EnginePolicyCard\.jsx|enginePolicyCore\.js|armingCore\.js|armingStore\.js|centralFed\.js|firstBatchCore\.js|solvePlan\.js|missingFootwearCore\.js|MissingFootwear\.jsx|missingProductsCore\.js|onHoldRefill\.js|releaseWindows\.js|NoTargetQueue\.jsx|IntroduceExisting\.jsx|introduceExistingCore\.js)|src/config/enginePolicy\.js|src/utils/(insights|onlineEscalation)\.js|database\.rules\.json|\.github/(CODEOWNERS|scripts/junid-approved-guard\.sh|workflows/junid-approved\.yml)|CLAUDE\.md)$'
CONTENT_PATTERN='refill_requests|stock_targets|config/refillEngine|refillEngine/|policyGroups|categoryPolicy|footwearRunByLocation|footwearTargets|restock_log|saleRowsFor|soldEntriesFor|restockLog|pendingSaleRows|placeRefillRequests'

if [[ ",${LABELS}," == *",junid-approved,"* ]]; then
  echo "junid-approved label present — guard satisfied."
  exit 0
fi

hits=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $GUARDED_PATHS ]]; then hits+=("$f (guarded path)"); continue; fi
  # Test files are guarded through the code they test, not on their own.
  if [[ "$f" =~ (\.test\.|__tests__/|/test/) ]]; then continue; fi
  if git diff --unified=0 "$BASE...$HEAD" -- "$f" | grep -E '^[+-][^+-]' | grep -qE "$CONTENT_PATTERN"; then
    hits+=("$f (changes a line naming requests/targets/policy)")
  fi
done < <(git diff --name-only "$BASE...$HEAD")

if (( ${#hits[@]} == 0 )); then
  echo "No guarded change — guard satisfied."
  exit 0
fi
echo "This PR changes policy, targets, the refill engine, request creation or the Refill Queue:"
printf '  - %s\n' "${hits[@]}"
echo
echo "Junid's rule: no such change unless Junid specifically asked for it."
echo "Add the label \"junid-approved\" only when he has."
exit 1
