#!/bin/bash
# ─── UNATTENDED TRADING-HOURS RTDB CAPTURE ────────────────────────────────────
#
# Runs on the Mac mini under launchd (com.marathon.costcapture) at 10:00 SAST
# on Mondays. The Saturday-evening capture in docs/firebase-cost-sept19.md is
# the after-hours FLOOR; this is the same measurement while the shops trade,
# which is the only way to attribute the staff-phone traffic that is 84% of the
# RTDB bill.
#
# ─── WHY THE MINI AND NOT CI ─────────────────────────────────────────────────
#
# The first version of this was a GitHub Actions workflow, on the reasoning that
# a runner has both halves of the job: FIREBASE_SERVICE_ACCOUNT to authenticate
# the profiler, and GITHUB_TOKEN to open the PR. That reasoning was wrong on the
# first half. **This repository has no secrets at all** (`gh secret list` is
# empty), which is also why every hosting deploy since at least 17 September has
# failed on `Input required and not supplied: firebaseServiceAccount`. A CI
# capture would have failed silently every Monday for the same reason.
#
# The mini can authenticate — it holds the owner's gcloud ADC — so the capture
# runs here. What the mini lacked was the ability to DELIVER: its gh token is
# expired and it had no key, so `git push` failed with "could not read Username".
# That half is now closed by a repository deploy key (read-write, scoped to this
# one repo, generated on the mini 2026-09-19, revocable from Settings → Deploy
# keys). Nothing Google-side was minted for this.
#
# FAILURE IS LOUD, NEVER SILENT. Every abort prints a line beginning
# COSTCAPTURE_ALARM, the same marker convention the social engine's silence
# alarm uses, and leaves the raw capture on disk rather than discarding it.

set -uo pipefail

# ─── THE ARTEFACTS ARE NOT WORLD-READABLE ────────────────────────────────────
# The raw capture is the one thing here that keeps what the published analysis
# deliberately strips: real client addresses, user agents and full paths, for
# every read in the hour. It never leaves the mini, and on a shared machine
# "never leaves" should not depend on nobody looking. umask before anything is
# created, and the directory itself locked down, so a capture cannot be written
# readable and tightened afterwards.
umask 077

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
# Application Default Credentials carry no quota project of their own, and
# firebasedatabase.googleapis.com refuses a request without one — a 403
# SERVICE_DISABLED naming project 764086051850, which is gcloud's shared
# project and not this estate's. Naming the project is what makes the profiler
# start at all; without it the first attempt failed outright.
export GOOGLE_CLOUD_QUOTA_PROJECT=marathon-club

OUTDIR="$HOME/costfix"
STAMP="$(date +%Y%m%d-%H%M)"
RAW="$OUTDIR/trading-$STAMP.jsonl"
MD="$OUTDIR/trading-$STAMP.md"
CLONE="$OUTDIR/clone-$STAMP"
REPORT="docs/firebase-cost-sept19.md"
BRANCH="perf/trading-capture-$STAMP"
REMOTE="github-costcapture:junidmoh-code/marathon-store-app.git"
DURATION="${1:-3900}"
# Which ref to clone the analyser and the report from. The default branch is
# right in production; the override exists so the whole path — capture, clone,
# analyse, commit, push — can be exercised from a feature branch before that
# branch is merged, which is how this script was verified end to end.
REF="${COSTCAPTURE_REF:-}"

if ! mkdir -p "$OUTDIR" || ! chmod 700 "$OUTDIR"; then
  echo "COSTCAPTURE_ALARM: cannot create or secure $OUTDIR — refusing to write captures" >&2
  exit 1
fi
exec >>"$OUTDIR/costcapture.log" 2>&1
echo "── costcapture start $(date) (duration ${DURATION}s) ──"

# The profiler caps itself at 60 minutes whatever --duration says, so ask for
# more and let the cap end it.
# Two separate failures, checked separately. A non-zero exit means the profiler
# itself failed — an auth error, a refused API, a dropped socket — and it can
# leave a PARTIAL file behind, which `-s` would happily accept and the analyser
# would happily report on. An empty file after a clean exit is the different
# case of an hour in which nothing was read. Either way the raw capture is kept
# rather than discarded: a partial hour is still evidence.
if ! firebase database:profile --project marathon-club --duration "$DURATION" --raw -o "$RAW"; then
  echo "COSTCAPTURE_ALARM: profiler exited non-zero; partial capture kept at $RAW"
  exit 1
fi
if [ ! -s "$RAW" ]; then
  echo "COSTCAPTURE_ALARM: capture produced no records ($RAW)"
  exit 1
fi
echo "captured $(wc -l < "$RAW") records"

# Clone fresh and run the CLONED analyser, so the analysis is always produced by
# the version of the script that the report it is appended to describes — and so
# nothing here touches the mini's own working tree, which is what the Shopify
# reconcile loop runs out of and which carries unrelated local edits.
rm -rf "$CLONE"
if ! GIT_SSH_COMMAND="ssh -o BatchMode=yes" git clone --quiet --depth 1 ${REF:+--branch "$REF"} "$REMOTE" "$CLONE"; then
  echo "COSTCAPTURE_ALARM: clone failed; raw capture kept at $RAW"; exit 1
fi

if ! node "$CLONE/scripts/cost/analyse-profile.mjs" "$RAW" --md --top 30 > "$MD"; then
  echo "COSTCAPTURE_ALARM: analyser failed; raw capture kept at $RAW"; exit 1
fi
echo "analysed → $MD"

cd "$CLONE" || exit 1
git checkout -q -b "$BRANCH"
{
  printf '\n---\n\n## Trading-hours capture — %s\n\n' "$(date '+%A %-d %B %Y, %H:%M %Z')"
  printf 'Captured unattended by `com.marathon.costcapture` on the Mac mini,\n'
  printf 'via `scripts/cost/trading-hours-capture.sh`. This is the weekday-trading\n'
  printf 'counterpart to the after-hours floor above: the same 60 minutes of raw\n'
  printf 'profiler output, analysed by `scripts/cost/analyse-profile.mjs`.\n\n'
  printf 'The raw capture stays on the mini at `%s`.\n\n' "$RAW"
  cat "$MD"
} >> "$REPORT"

git add "$REPORT"
if ! git -c user.name="Marathon Mac mini" -c user.email="gunidmoh@gmail.com" \
       commit -q -m "docs: trading-hours RTDB capture $STAMP (unattended)"; then
  echo "COSTCAPTURE_ALARM: nothing to commit"; exit 1
fi

# A deploy key authenticates git, but not the REST API, so this pushes a branch
# rather than opening a pull request. The branch is the delivery.
if GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push -q origin "$BRANCH"; then
  echo "pushed $BRANCH — open a PR from it, or read it on the branch"
else
  echo "COSTCAPTURE_ALARM: push failed; analysed markdown kept at $MD"
  exit 1
fi

echo "── costcapture done $(date) ──"
