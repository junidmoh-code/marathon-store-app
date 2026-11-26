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
  JAVA_HOME="$(ls -d "$HOME"/.local/jdk/*/Contents/Home 2>/dev/null | head -1)"
fi
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
PORT="${RTDB_EMULATOR_PORT:-9311}"
firebase database:get /.settings/rules --project marathon-club --instance marathon-club-default-rtdb > "$WORK/live.rules.json" 2>/dev/null
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rules || process.exit(1)' "$WORK/live.rules.json"
cat > "$WORK/firebase.json" <<JSON
{"database":{"rules":"live.rules.json"},"emulators":{"database":{"port":$PORT,"host":"127.0.0.1"},"ui":{"enabled":false},"singleProjectMode":true}}
JSON
export RTDB_EMULATOR="127.0.0.1:$PORT" LIVE_RULES_FILE="$WORK/live.rules.json"
firebase emulators:exec --only database --project demo-marathon --config "$WORK/firebase.json" \
  "npx vitest run src/components/stock/transferLiveRules.emulator.test.jsx $*"
