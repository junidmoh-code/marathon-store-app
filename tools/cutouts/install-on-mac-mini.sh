#!/bin/bash
# Product cut-outs on the Mac mini. Runs ON the mini, non-interactively, no
# sudo, no Homebrew. Idempotent: run it again after a change to this folder.
#   1. venv at ~/.marathon-cutouts/venv from /usr/bin/python3, pip install
#      -r requirements.txt, and fetch the rembg model once (~/.u2net);
#   2. launchd: com.marathon.cutouts (nightly 02:00, RunAtLoad false);
#   3. --run-now [extra cutout.py args]: also start ONE background pass now
#      (nohup, appends to logs/cutouts.log). Extra args pass through, e.g.
#      `--run-now --limit 20`.
set -euo pipefail
REPO="${CUTOUTS_REPO:-$HOME/marathon-store-app}"
HOME_DIR="$HOME/.marathon-cutouts"
VENV="$HOME_DIR/venv"
JOB=com.marathon.cutouts
PY=/usr/bin/python3
MODEL="${CUTOUTS_MODEL:-isnet-general-use}"
CREDS="$HOME/.config/marathon/shopify-reconciler-sa.json"

RUN_NOW=0
if [ "${1:-}" = "--run-now" ]; then RUN_NOW=1; shift; fi

[ -f "$REPO/tools/cutouts/cutout.py" ] || { echo "REFUSED: $REPO/tools/cutouts/cutout.py not found (git pull first?)"; exit 1; }
[ -x "$PY" ] || { echo "REFUSED: $PY missing"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "REFUSED: $PY is older than 3.9"; exit 1; }
[ -f "$CREDS" ] || { echo "REFUSED: service-account key missing at $CREDS"; exit 1; }
[ "$(date +%Z)" = "SAST" ] || echo "WARNING: host clock is $(date +%Z), not SAST; 02:00 is host time"
mkdir -p "$HOME_DIR" "$REPO/logs" "$HOME/Library/LaunchAgents"

if [ ! -x "$VENV/bin/python" ]; then "$PY" -m venv "$VENV"; fi
"$VENV/bin/python" -m pip install -q --upgrade pip
"$VENV/bin/python" -m pip install -q -r "$REPO/tools/cutouts/requirements.txt"
"$VENV/bin/python" -c "from rembg import new_session; new_session('$MODEL'); print('rembg model ready: $MODEL')"

cp "$REPO/tools/cutouts/$JOB.plist" "$HOME/Library/LaunchAgents/"
launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too soon fails with
# "5: Input/output error" (seen 1 Nov with the stylist).
for i in $(seq 1 30); do launchctl print "gui/$(id -u)/$JOB" >/dev/null 2>&1 || break; sleep 1; done
for i in 1 2 3; do launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$JOB.plist" && break; sleep 3; done
launchctl print "gui/$(id -u)/$JOB" >/dev/null 2>&1 || { echo "FAILED: $JOB is not loaded"; exit 1; }
echo "installed: $JOB (nightly 02:00), venv $VENV ($("$VENV/bin/python" --version 2>&1))"

if [ "$RUN_NOW" = 1 ]; then
  cd "$REPO"
  GOOGLE_APPLICATION_CREDENTIALS="$CREDS" nohup "$VENV/bin/python" "$REPO/tools/cutouts/cutout.py" --run-now "$@" \
    >> "$REPO/logs/cutouts.log" 2>&1 < /dev/null &
  echo "started one pass now (pid $!); follow: tail -f $REPO/logs/cutouts.log"
fi
