#!/bin/bash
# One-time (and whenever the SimplyBLU password changes): save the SimplyBLU
# sign-in on the Mac mini so the 18:00 pull can sign in by itself. The portal
# ends every session after about an hour, so each pull signs in again with
# email + password (the portal's login has no PIN step; linking a store does).
#
#   ssh -t marathonclub@100.64.186.78 'bash ~/marathon-store-app/tools/sb-portal-recon/save-login.sh'
#
# Typed by Junid, never echoed, never logged. Kept in the login Keychain
# (service "marathon-simplyblu") when it is unlocked, else in
# ~/.marathon/sb-portal/credentials (chmod 600, outside the repo).
set -euo pipefail
DIR="$HOME/.marathon/sb-portal"; mkdir -p "$DIR"; chmod 700 "$DIR"
read -r -p "SimplyBLU email: " EMAIL
[ -n "$EMAIL" ] || { echo "✗ the email is needed"; exit 1; }
# The Keychain prompts for the password itself (-w last): it never appears in
# a command line or a shell variable (CodeRabbit, #838).
echo "The Keychain asks for the SimplyBLU password twice (not shown):"
if security add-generic-password -U -s marathon-simplyblu -a "$EMAIL" -T /usr/bin/security -w 2>/dev/null; then
  rm -f "$DIR/credentials"
  echo "✓ saved in the login Keychain"
else
  # Locked over SSH: a chmod-600 file outside the repo. It takes precedence
  # over any older Keychain item (run.mjs reads the file first).
  umask 077
  { printf 'SIMPLYBLU_EMAIL=%s\nSIMPLYBLU_PASSWORD=' "$EMAIL"; IFS= read -r -s -p "The Keychain is locked over SSH — type the password once more for the file (not shown): " && printf '%s\n' "$REPLY"; } > "$DIR/credentials"
  echo
  chmod 600 "$DIR/credentials"
  grep -q '^SIMPLYBLU_PASSWORD=.\+' "$DIR/credentials" || { rm -f "$DIR/credentials"; echo "✗ no password typed"; exit 1; }
  echo "✓ saved in $DIR/credentials"
fi
# A sign-in that failed before no longer blocks the next pull.
/opt/homebrew/bin/node -e 'const f=process.argv[1];const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};s.loginAt=Date.now();fs.writeFileSync(f,JSON.stringify(s,null,2),{mode:0o600})' "$DIR/state.json"
echo "The next pull (18:00) signs in with it. To test now: node ~/marathon-store-app/tools/sb-portal-recon/run.mjs --dry-run"
