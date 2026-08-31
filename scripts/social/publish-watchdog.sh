#!/bin/bash
# ── THE PUBLISHER'S DEAD-MAN SWITCH, AND ITS REVIVE BUTTON ───────────────────
# On 31 Aug 2026 the publish agent stopped firing at 01:16 and did not fire
# again for 625 minutes. No crash, no stderr, exit code 0, agent still loaded,
# machine awake throughout. Four approved posts sat past due until somebody
# noticed. launchd simply stopped running it.
#
# The cause is still unproven — the likeliest candidate is a run overrunning
# its own 120s StartInterval (a reel encode plus four posts took ~2.5 minutes
# the morning this was written) and the timer never coming back. This script
# deliberately does NOT try to be right about that. It watches for the
# SYMPTOM, so it works whatever the cause turns out to be.
#
# It does two jobs:
#   1. AUTOMATIC — if the publisher's log has not moved in 15 minutes, restart
#      it. This is the part that means nobody has to notice.
#   2. ON REQUEST — if the Social screen's "Revive publisher" button has been
#      pressed, restart it now. This is the part for when somebody HAS noticed
#      and does not want to wait, or open an ssh session to do it by hand.
#
# ── COST ─────────────────────────────────────────────────────────────────────
# Job 1 reads a local file's timestamp: free. Job 2 reads one small RTDB key
# per run: a few hundred bytes every two minutes, which is pennies a year and
# the only reason the button can work at all without opening a port on this
# machine.
#
# ── WHY IT WILL NOT FIGHT A HEALTHY RUN ──────────────────────────────────────
# A reel encode is slow and legitimately quiet. Kickstarting on top of a run in
# progress would post the same thing twice. An in-flight publish.mjs is
# therefore a hard veto, checked before anything else — including before the
# revive request, because "revive" cannot sensibly mean "run a second copy".
set -euo pipefail

HOME_DIR="$HOME/marathon-social"
LOG="$HOME_DIR/logs/social-publish.log"
WLOG="$HOME_DIR/logs/social-watchdog.log"
LABEL="gui/501/com.marathon.socialpublish"
NODE="/opt/homebrew/bin/node"
STALE_SECONDS=900        # 15 min — the publisher ticks every 2, so ~7 missed
                         # ticks: long enough never to trip on a slow reel,
                         # short enough to catch a stall inside one slot.

say() { printf '%s  %s\n' "$(date '+%Y/%m/%d, %H:%M:%S')" "$1" >> "$WLOG"; }

kick() {
  say "$1 — kickstarting"
  if launchctl kickstart -k "$LABEL" >/dev/null 2>&1; then
    say "kickstart issued"
  else
    say "KICKSTART FAILED — the agent may be unloaded; needs a human"
  fi
}

# A publish already in flight is not a stall, however quiet it is.
if pgrep -f "scripts/social/publish.mjs" >/dev/null 2>&1; then
  exit 0
fi

# ── 1. did somebody press the button? ────────────────────────────────────────
# Failure here is not allowed to stop the staleness check below: a network blip
# or an expired credential must not disable the automatic half.
if [ -x "$NODE" ] && [ -f "$HOME_DIR/scripts/social/revive-check.mjs" ]; then
  if "$NODE" "$HOME_DIR/scripts/social/revive-check.mjs" 2>/dev/null | grep -q REVIVE; then
    kick "revive requested from the Social screen"
    exit 0
  fi
fi

# ── 2. has it gone quiet by itself? ──────────────────────────────────────────
if [ ! -f "$LOG" ]; then
  say "publisher log missing — cannot judge, leaving alone"
  exit 0
fi

now=$(date +%s)
touched=$(stat -f %m "$LOG")
quiet=$(( now - touched ))

if [ "$quiet" -lt "$STALE_SECONDS" ]; then
  exit 0                 # healthy; say nothing, so this log stays readable
fi

kick "publisher silent for $(( quiet / 60 )) min"
