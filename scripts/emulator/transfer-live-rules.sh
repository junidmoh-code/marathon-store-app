#!/usr/bin/env bash
# Runs src/components/stock/transferLiveRules.emulator.test.jsx against the
# RTDB emulator loaded with the LIVE console rules.
#   - fetches the live rules READ-ONLY (firebase database:get /.settings/rules);
#     database.rules.json in the repo is stale and is never used.
#   - needs a JDK: JAVA_HOME, or a Temurin JDK under ~/.local/jdk.
#   - the emulator is a throwaway (namespace demo-marathon); nothing touches prod.
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="$(mktemp -d)"
if [ -z "${JAVA_HOME:-}" ]; then
  # macOS tarball layout (…/Contents/Home) or a plain Linux JDK directory.
  JAVA_HOME="$( { ls -d "$HOME"/.local/jdk/*/Contents/Home "$HOME"/.local/jdk/*/bin/.. 2>/dev/null || true; } | head -1)"
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "No JDK found: set JAVA_HOME or unpack a Temurin JDK under ~/.local/jdk" >&2; exit 2
fi
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
PORT="${RTDB_EMULATOR_PORT:-9311}"
# The live-DB REST call is occasionally flaky: three tries.
fetched=""
for try in 1 2 3; do
  if firebase database:get /.settings/rules --project marathon-club --instance marathon-club-default-rtdb > "$WORK/live.rules.json" 2>"$WORK/fetch.err" \
     && [ -s "$WORK/live.rules.json" ]; then fetched=1; break; fi
  sleep 3
done
if [ -z "$fetched" ]; then
  echo "Could not fetch the live rules after 3 tries (firebase login?):" >&2; grep -vi deprec "$WORK/fetch.err" >&2 || true; exit 3
fi
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rules || process.exit(1)' "$WORK/live.rules.json" \
  || { echo "Fetched rules are not a rules document: $WORK/live.rules.json" >&2; exit 4; }
cat > "$WORK/firebase.json" <<JSON
{"database":{"rules":"live.rules.json"},"emulators":{"database":{"port":$PORT,"host":"127.0.0.1"},"ui":{"enabled":false},"singleProjectMode":true}}
JSON
export RTDB_EMULATOR="127.0.0.1:$PORT" LIVE_RULES_FILE="$WORK/live.rules.json"
firebase emulators:exec --only database --project demo-marathon --config "$WORK/firebase.json" \
  "npx vitest run src/components/stock/transferLiveRules.emulator.test.jsx $*"
