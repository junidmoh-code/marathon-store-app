// ── "REVIVE THE PUBLISHER" — THE MAC MINI'S HALF ─────────────────────────────
// The publisher stalled for 625 minutes on 31 Aug 2026 and the only cure was
// somebody opening an ssh session and running launchctl kickstart. Owner:
// "I need one quick button to revive without having to open a session."
//
// A browser cannot reach the Mac mini — no public address, no inbound port,
// and opening one for this would be a security hole to save a click. So the
// button does not talk to the mini. It writes a REQUEST to RTDB, which both
// sides can already reach, and the mini asks for it.
//
// This script is that asking. It prints REVIVE when there is a request newer
// than the last one handled, and prints nothing otherwise; the watchdog shell
// script does the kickstart. Splitting it that way keeps the credential-using
// part small enough to read in one go.
//
// ── WHY A HIGH-WATER MARK AND NOT A DELETE ───────────────────────────────────
// The obvious design is: browser writes a flag, mini deletes it. That needs
// the mini to WRITE to RTDB, and it makes the request disappear the moment it
// is picked up — so a request that arrives while the publisher is mid-run is
// consumed and silently does nothing.
//
// Instead the request is a TIMESTAMP the browser sets, and the mini keeps its
// own local high-water mark of the last one it acted on. The mini never
// writes. A request is handled exactly once, the history stays visible in
// RTDB, and a second press genuinely means "again" because it is a later
// timestamp.
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const MARK = join(homedir(), "marathon-social", "logs", "revive.mark");
// A request older than this is stale — the machine was probably off when it
// was made, and reviving now for a press from yesterday is noise, not help.
const MAX_AGE_MS = 30 * 60 * 1000;

admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});

const requestedAt = Number(
  (await admin.database().ref("social_health/revive/requestedAt").get()).val() || 0
);
if (!Number.isFinite(requestedAt) || requestedAt <= 0) process.exit(0);

let handled = 0;
try { handled = Number(readFileSync(MARK, "utf8").trim()) || 0; } catch { /* first run */ }

if (requestedAt <= handled) process.exit(0);
if (Date.now() - requestedAt > MAX_AGE_MS) {
  // Move the mark past it so a stale press cannot fire later.
  writeFileSync(MARK, String(requestedAt));
  process.exit(0);
}

writeFileSync(MARK, String(requestedAt));
console.log("REVIVE");
process.exit(0);
