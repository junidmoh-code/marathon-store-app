#!/bin/bash
# One-time setup of the local stylist on the Mac mini (no Homebrew on the path,
# nothing for Junid or staff to do afterwards). Idempotent: run it again after
# a change to this folder.
#   1. Ollama.app (macOS build from ollama.com) into ~/Applications;
#   2. launchd: com.marathon.ollama (the model server, KeepAlive, survives a
#      reboot) and com.marathon.stylist (the daily pick);
#   3. the model (STYLIST_MODEL, default gemma4:12b-it-qat);
#   4. the Fashion-CLIP venv (~/.marathon-stylist/venv, python3.13) and the
#      open weights patrickjohncyh/fashion-clip.
set -euo pipefail
MODEL="${STYLIST_MODEL:-gemma4:12b-it-qat}"
REPO="${STYLIST_REPO:-$HOME/marathon-social}"
HOME_DIR="$HOME/.marathon-stylist"
OLLAMA="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
mkdir -p "$HOME_DIR/logs" "$HOME/Applications"
[ "$(date +%Z)" = "SAST" ] || { echo "REFUSED: the host clock is $(date +%Z), not SAST"; exit 1; }
if [ ! -x "$OLLAMA" ]; then
  curl -fsSL -o /tmp/Ollama-darwin.zip https://ollama.com/download/Ollama-darwin.zip
  ditto -x -k /tmp/Ollama-darwin.zip "$HOME/Applications/"
fi
for job in com.marathon.ollama com.marathon.stylist; do
  cp "$REPO/stylist/launchd/$job.plist" "$HOME/Library/LaunchAgents/"
  launchctl bootout "gui/$(id -u)/$job" 2>/dev/null || true
  # bootout returns before the job is gone; bootstrapping too soon fails with
  # "5: Input/output error" (1 Nov, it left the model server down).
  for i in $(seq 1 30); do launchctl print "gui/$(id -u)/$job" >/dev/null 2>&1 || break; sleep 1; done
  for i in 1 2 3; do launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$job.plist" && break; sleep 3; done
  launchctl print "gui/$(id -u)/$job" >/dev/null 2>&1 || { echo "FAILED: $job is not loaded"; exit 1; }
done
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 2; done
"$OLLAMA" pull "$MODEL"
if [ ! -x "$HOME_DIR/venv/bin/python" ]; then /opt/homebrew/bin/python3.13 -m venv "$HOME_DIR/venv"; fi
"$HOME_DIR/venv/bin/pip" install -q --upgrade pip torch transformers pillow
"$HOME_DIR/venv/bin/python" -c 'from transformers import CLIPModel, CLIPProcessor; CLIPModel.from_pretrained("patrickjohncyh/fashion-clip"); CLIPProcessor.from_pretrained("patrickjohncyh/fashion-clip"); print("fashion-clip ready")'
echo "local stylist installed: $MODEL, $(launchctl list | grep -c 'com.marathon.\(ollama\|stylist\)') launchd jobs"
