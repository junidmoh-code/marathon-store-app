// ─── PINE FOLLOWS TROPHY — GO LIVE (Junid, 22 Nov 2026) ──────────────────────
// Switches the link on (or off) through applyCategoryPolicy, the function the
// Engine Policy card calls, so the change has a history entry and the card's
// Revert undoes it in one tap:
//     config/refillEngine/policyFollow/marathon-pine = "trophy"
// Nothing else is written: no target row, no stock, no request. Dry run by
// default. Run the first-scan dry run first and read its numbers:
//   node scripts/audit/concrete-division-dump.mjs <snapshot.json>
//   node scripts/audit/pine-follows-trophy-dry-run.mjs <snapshot.json>
//   node scripts/apply-pine-follows-trophy.mjs            (dry run)
//   node scripts/apply-pine-follows-trophy.mjs --apply    switch it on
//   node scripts/apply-pine-follows-trophy.mjs --apply --off   switch it off
import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";
const req = adminRequire(import.meta.url);
const require = createRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

const APPLY = process.argv.includes("--apply");
const OFF = process.argv.includes("--off");
const LOCATION = "marathon-pine", LEADER = "trophy";
const db = admin.database();
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const RUNNER = "script:apply-pine-follows-trophy";

const live = (await db.ref(`config/refillEngine/policyFollow/${LOCATION}`).once("value")).val();
const want = OFF ? null : LEADER;
console.log("policyFollow/marathon-pine:", JSON.stringify(live), "->", JSON.stringify(want));
const r = await applyCategoryPolicy({ db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER,
  data: { action: "setPolicyFollow", location: LOCATION, follows: want, expectedBefore: live ?? null, dryRun: !APPLY }, nowMs: Date.now() });
console.log(r.dryRun ? "DRY RUN — nothing written" : r.noChange ? "NO CHANGE — already so" : "APPLIED", JSON.stringify({ before: r.before, after: r.after }), r.historyId || "");
if (!r.dryRun && !r.noChange) console.log("read back:", JSON.stringify((await db.ref(`config/refillEngine/policyFollow/${LOCATION}`).once("value")).val()));
process.exit(0);
