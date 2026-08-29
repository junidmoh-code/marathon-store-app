#!/bin/bash
# ─── INSTALL THE CARD RECON MAILBOX POLLER ON THE MAC MINI ───────────────────
# Run ON the mini, from the checkout, after it has been updated:
#
#   ssh marathonclub@100.64.186.78 'cd ~/marathon-store-app && git fetch origin && git reset --hard origin/main'
#   ssh marathonclub@100.64.186.78 'bash ~/marathon-store-app/scripts/cardrecon/install-card-recon-poller.sh'
#
# THE GIT UPDATE IS NOT IN THIS SCRIPT, ON PURPOSE. The social installer resets
# the clone that CONTAINS itself, and bash reads a script by BYTE OFFSET — it
# carries on in the new file at the old position and executes a splice of two
# versions. That cost three bugs to find (#476-#478). This script never touches
# git, so it cannot rewrite itself mid-run and always does what it says.
#
# The body is still wrapped in braces so bash parses the whole file before
# running any of it. NOTHING MAY FOLLOW THE CLOSING BRACE.
{
set -euo pipefail

REPO="${REPO:-$HOME/marathon-store-app}"
LABEL="com.marathon.cardreconpoll"
PLIST_SRC="$REPO/scripts/cardrecon/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

say() { printf '  %s\n' "$*"; }

echo "── Card recon mailbox poller ──"

# 1 · The checkout, and that it carries this feature.
[ -d "$REPO/.git" ] || { echo "✗ no checkout at $REPO"; exit 1; }
[ -f "$REPO/scripts/cardrecon/email-poller.mjs" ] || { echo "✗ $REPO is behind — it has no scripts/cardrecon/email-poller.mjs. Update it first (see the header)."; exit 1; }
say "checkout: $REPO ($(cd "$REPO" && git log --oneline -1))"

# 2 · node, by ABSOLUTE PATH. A non-interactive ssh shell gets
#     PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `which node` finds nothing; and
#     launchd resolves ProgramArguments[0] itself without consulting PATH, so a
#     wrong path here is a job that reports itself loaded and never starts.
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { NODE="$candidate"; break; }
done
[ -n "$NODE" ] || { echo "✗ no node binary found. Install it, or fix the path."; exit 1; }
say "node: $NODE ($("$NODE" --version))"

# 3 · Credentials must be PRESENT before a schedule is armed. The values are
#     never read, printed or echoed here — only whether the keys exist.
[ -f "$REPO/.env" ] || { echo "✗ no $REPO/.env — the poller reads CARD_RECON_IMAP_USER and CARD_RECON_IMAP_PASSWORD from it. Create it first; it is gitignored."; exit 1; }
# QUOTES ARE STRIPPED BEFORE THE VALUE IS JUDGED, exactly as the poller's own
# loadEnv() strips them. Without that, CARD_RECON_IMAP_PASSWORD="" reads as
# present (the quote is a non-space character), the schedule is armed, and the
# failure only appears in a log five minutes later. (CodeRabbit, PR #510.)
for key in CARD_RECON_IMAP_USER CARD_RECON_IMAP_PASSWORD; do
  raw="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$REPO/.env" | tail -1)"
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  [ -n "${raw//[[:space:]]/}" ] || { echo "✗ $key is missing or empty in $REPO/.env"; exit 1; }
  say "$key: present"
done
SA="/Users/marathonclub/.config/marathon/shopify-reconciler-sa.json"
[ -f "$SA" ] || { echo "✗ no service-account key at $SA — the poller needs it to mint its identity and write /card_batch_intake."; exit 1; }
say "service account: present"

# 4 · The poller's own dependencies (imapflow, mailparser). Deliberately NOT in
#     functions/package.json: those are installed into every Cloud Function
#     deploy. npm's shebang is `#!/usr/bin/env node`, so node's DIRECTORY goes
#     on PATH — handing npm an absolute node is not enough (#478).
export PATH="$(dirname "$NODE"):$PATH"
say "installing imapflow + mailparser…"
( cd "$REPO/scripts/cardrecon" && npm install --omit=dev --no-audit --no-fund >/dev/null )
[ -d "$REPO/scripts/cardrecon/node_modules/imapflow" ] || { echo "✗ imapflow did not install"; exit 1; }
[ -d "$REPO/functions/node_modules/firebase-admin" ] || { echo "✗ functions/node_modules/firebase-admin is missing — run npm install in $REPO/functions"; exit 1; }
say "dependencies: ready"

# 5 · THE IDENTITY, BEFORE THE SCHEDULE. RunAtLoad fires this the moment the
#     agent is bootstrapped, so installing without the two permission flags
#     means every message in the mailbox is answered with "This identity may not
#     capture emailed slips" — a loud failure, but a pointless one, and the mail
#     is marked read on the way past. Checked here, and it fails CLOSED with the
#     one command that fixes it. (CodeRabbit, PR #510.)
POLLER_UID="$(sed -n 's/^[[:space:]]*CARD_RECON_POLLER_UID[[:space:]]*=[[:space:]]*//p' "$REPO/.env" | tail -1)"
POLLER_UID="${POLLER_UID:-card-recon-email-poller}"
say "checking the poller identity ($POLLER_UID)…"
GOOGLE_APPLICATION_CREDENTIALS="$SA" "$NODE" -e '
const admin = require(process.argv[1] + "/functions/node_modules/firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const uid = process.argv[2];
(async () => {
  const missing = [];
  for (const flag of ["card_recon", "card_recon_intake"]) {
    const v = (await admin.database().ref(`users/${uid}/permFlags/${flag}`).get()).val();
    if (v !== true) missing.push(flag);
  }
  await admin.app().delete();
  if (missing.length) { console.error(`missing permFlags: ${missing.join(", ")}`); process.exit(2); }
})();
' "$REPO" "$POLLER_UID" || {
  echo "✗ the poller identity is not granted. Run this first, from a machine with owner credentials:"
  echo "    node scripts/cardrecon/grant-poller-identity.mjs --uid $POLLER_UID --execute"
  exit 1
}
say "identity: card_recon + card_recon_intake granted"

# 6 · The agent. The plist is rewritten with the node this machine actually has
#     and the checkout it actually uses, so the file and the machine cannot
#     drift apart.
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"
sed -e "s|/opt/homebrew/bin/node|$NODE|g" \
    -e "s|/Users/marathonclub/marathon-store-app|$REPO|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
launchctl enable "gui/$UID_NUM/$LABEL"
say "agent: loaded (every 5 minutes, and at login/boot)"

echo
echo "Installed. It is running now (RunAtLoad). To watch it:"
echo "  tail -f $REPO/logs/card-recon-poll.log"
echo "  launchctl print gui/$UID_NUM/$LABEL | head -20"
echo "One run by hand, changing nothing:"
echo "  cd $REPO && GOOGLE_APPLICATION_CREDENTIALS=$SA $NODE scripts/cardrecon/email-poller.mjs --dry-run"
}
