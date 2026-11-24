#!/bin/zsh
# launchd entry for the daily Missing Products accuracy check (see
# missing-accuracy-daily.mjs). Runs from its OWN clone (~/missing-accuracy) so
# the other jobs' checkout is never moved: pull main, install only when a
# lockfile changed, run the check.
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd "$HOME/missing-accuracy"
git fetch -q gh main && git reset -q --hard gh/main
if ! cmp -s package-lock.json .lock-installed 2>/dev/null; then npm ci --no-audit --no-fund --loglevel=error && cp package-lock.json .lock-installed; fi
if ! cmp -s functions/package-lock.json .flock-installed 2>/dev/null; then npm ci --prefix functions --no-audit --no-fund --loglevel=error && cp functions/package-lock.json .flock-installed; fi
exec node scripts/diag/missing-accuracy-daily.mjs "$@"
