#!/bin/bash
# ── INSTALL THE SOCIAL PUBLISHER ON THE MAC MINI ─────────────────────────────
# One command, idempotent, safe to re-run:
#
#   curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/scripts/social/install-on-mac-mini.sh | bash
#
# or, if you already have a checkout somewhere:
#
#   bash scripts/social/install-on-mac-mini.sh
#
# ── IT NEVER TOUCHES ~/marathon-store-app ────────────────────────────────────
# That checkout is the Shopify reconciler's, and it runs from there against the
# LIVE SHOP every two minutes. A `git checkout` or a `git pull` in it mid-run
# would swap the code out from under a process that is pushing products to
# Shopify. So this installs into its OWN clone at ~/marathon-social and the
# reconciler's directory is never opened, read or written by anything here.
#
# ── WHAT IT INSTALLS ─────────────────────────────────────────────────────────
#   ~/marathon-social                                  a separate clone of main
#   ~/Library/LaunchAgents/com.marathon.socialpublish.plist
#   ~/marathon-social/logs/social-publish.log          rotated, readable
#
# The schedule is Mon/Wed/Sat 18:00 SAST — the same three slots the queue shows
# and the generator assigns, pinned equal by test.
#
# ── IT CANNOT POST ANYTHING BY BEING INSTALLED ───────────────────────────────
# RunAtLoad is false, and the publisher refuses anything that is not approved
# and due. Installing this at 3pm on a Tuesday sends nothing.
set -euo pipefail

REPO_URL="https://github.com/junidmoh-code/marathon-store-app.git"
CLONE="$HOME/marathon-social"
RECONCILER="$HOME/marathon-store-app"
PLIST_NAME="com.marathon.socialpublish.plist"
PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LABEL="com.marathon.socialpublish"
SA_JSON="$HOME/.config/marathon/shopify-reconciler-sa.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "1/7  Checking where we are"
if [ "$(whoami)" != "marathonclub" ]; then
  bad "this is meant to run as 'marathonclub' on the Mac mini; you are '$(whoami)'."
  bad "refusing, rather than installing a schedule on the wrong machine."
  exit 2
fi
ok "user marathonclub on $(hostname)"

# The one thing that must never be disturbed.
if [ -d "$RECONCILER" ]; then
  ok "reconciler checkout found at $RECONCILER — this script will not touch it"
fi
if [ "$CLONE" = "$RECONCILER" ]; then
  bad "the social clone path equals the reconciler's. Refusing."
  exit 2
fi

say "2/7  Getting the code into its own clone"
if [ -d "$CLONE/.git" ]; then
  git -C "$CLONE" fetch --quiet origin
  git -C "$CLONE" checkout --quiet main
  git -C "$CLONE" reset --hard --quiet origin/main
  ok "updated $CLONE to origin/main"
else
  git clone --quiet --branch main "$REPO_URL" "$CLONE"
  ok "cloned to $CLONE"
fi
echo "     at commit: $(git -C "$CLONE" rev-parse --short HEAD)"

say "3/7  Installing dependencies"
# ONLY functions/ — that is where firebase-admin and google-auth-library live,
# and they are the only dependencies the publisher's import graph reaches.
# The root install pulls vite and puppeteer, which this machine has no use for.
( cd "$CLONE/functions" && npm install --omit=dev --no-audit --no-fund --silent )
ok "functions dependencies installed"

say "4/7  Checking credentials"
if [ ! -f "$SA_JSON" ]; then
  bad "no service-account JSON at $SA_JSON"
  bad "that is the file the reconciler's launchd agent points at. Without it the"
  bad "publisher cannot read RTDB or Secret Manager. Fix that first."
  exit 2
fi
ok "service-account JSON present at $SA_JSON"
# The ACCOUNT is printed; the key never is.
#
# A file that exists but cannot be parsed — a truncated download, a wrong file
# at the right path — is treated as an ERROR, not as "unreadable, carry on".
# Accepting it would register a schedule that authenticates against nothing and
# fails every Saturday at 18:00, having reported itself INSTALLED.
# The type check is inside Python on purpose: `print(None)` emits the four
# characters "None", which is not empty, so a JSON carrying
# "client_email": null would have sailed past a shell -z test and installed a
# schedule whose identity is the literal string None.
SA_EMAIL=$(/usr/bin/python3 -c "
import json, sys
v = json.load(open('$SA_JSON')).get('client_email')
sys.stdout.write(v.strip() if isinstance(v, str) and v.strip() else '')
" 2>/dev/null || true)
if [ -z "$SA_EMAIL" ]; then
  bad "$SA_JSON is not a readable service-account key (no client_email)."
  bad "REFUSING to install a schedule that cannot authenticate."
  exit 2
fi
echo "     running as: $SA_EMAIL"
echo "     (this account needs roles/secretmanager.secretAccessor — granted from the laptop)"

say "5/7  Writing the launchd agent"
mkdir -p "$HOME/Library/LaunchAgents" "$CLONE/logs"
# The committed plist is written for a checkout at ~/marathon-store-app. Rewrite
# every path to this clone so the two jobs can never share a directory.
sed -e "s#/Users/marathonclub/marathon-store-app#$CLONE#g" \
    "$CLONE/scripts/social/$PLIST_NAME" > "$PLIST"
if /usr/bin/plutil -lint "$PLIST" >/dev/null 2>&1; then
  ok "plist is valid: $PLIST"
else
  bad "the rewritten plist is not valid — launchd would refuse it."
  bad "This usually means \$CLONE contains a character sed or XML dislikes."
  bad "CLONE=$CLONE"
  exit 2
fi
if grep -q "$CLONE/scripts/social/publish-runner.mjs" "$PLIST"; then
  ok "points at $CLONE (not the reconciler)"
else
  bad "path rewrite failed — the plist does not point at this clone."
  exit 2
fi
# This check must STOP the install, not narrate. `bad` only prints — leaving it
# as the failure branch meant an unsafe plist got a red line and was then
# bootstrapped anyway, which is the one outcome the check exists to prevent:
# RunAtLoad true fires a publish the instant the agent loads.
# The grep is whitespace-tolerant because the plist is hand-formatted and a
# reflow would otherwise silently turn this guard off.
if grep -qE "<key>RunAtLoad</key>[[:space:]]*<false/>" "$PLIST"; then
  ok "RunAtLoad is false — loading this posts nothing"
else
  bad "RunAtLoad is not false in $PLIST — loading it could post immediately."
  bad "REFUSING to install. Fix the plist first."
  exit 2
fi

say "6/7  Loading it"
# bootout first so a re-run replaces cleanly rather than erroring.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"
ok "loaded into gui/$UID"

say "7/7  Verifying"
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  ok "launchd knows the job"
  launchctl print "gui/$UID/$LABEL" | grep -E "state|program|run interval|next fire|path =" | head -8 | sed 's/^/     /'
else
  bad "launchd does NOT have the job — installation failed"
  exit 2
fi

echo
say "A read-only smoke test (posts nothing)"
cd "$CLONE"
# The exit status is CHECKED, not discarded. `|| true` hid a genuinely broken
# install behind a cheerful "INSTALLED" banner.
#
# But a NON-ZERO here is not automatically fatal: "Meta is not connected yet" is
# the expected state until the token is minted, and refusing to install the
# schedule because of it would be wrong. So the status is reported plainly and
# the operator is told which it is.
set +e
GOOGLE_APPLICATION_CREDENTIALS="$SA_JSON" node scripts/social/publish.mjs --status 2>&1 | sed 's/^/     /'
SMOKE=${PIPESTATUS[0]}
set -e
if [ "$SMOKE" -eq 0 ]; then
  ok "the publisher runs and can read the queue"
else
  bad "the publisher exited $SMOKE — read the output above."
  bad "If it says the Meta credentials are missing, that is EXPECTED until you"
  bad "run meta-token.mjs; the schedule is installed and will simply skip."
  bad "Anything else (RTDB refused, node crashed) needs fixing before Saturday."
fi

cat <<EOF

═══════════════════════════════════════════════════════════════════════════
 INSTALLED.

 Schedule:  Mon / Wed / Sat, 18:00 SAST
 Clone:     $CLONE   (the reconciler's checkout was not touched)
 Log:       $CLONE/logs/social-publish.log

 REBOOT-SAFE: the plist lives in ~/Library/LaunchAgents, which launchd loads
 on login. The mini logs in automatically, so the job returns after a reboot
 without anyone doing anything. A fire missed while the machine was asleep or
 off runs as soon as it wakes — an approved post goes out late, never skipped.

 CHECK IT ANY TIME:
   launchctl print gui/\$UID/$LABEL | head -20
   tail -f $CLONE/logs/social-publish.log
   cd $CLONE && node scripts/social/publish.mjs --status

 UPDATE IT LATER (after a new deploy):
   bash $CLONE/scripts/social/install-on-mac-mini.sh

 STOP IT:
   launchctl bootout gui/\$UID/$LABEL
═══════════════════════════════════════════════════════════════════════════
EOF
