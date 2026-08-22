// ─── RELABEL THE FOOTWEAR GROUP TO "SNEAKERS" ─────────────────────────────────
//
// One live write, through the same callable path the screen uses
// (applyCategoryPolicy → setGroup), so it is validated, drift-checked, history-
// stamped and read back exactly like a save from the card would be. The label
// is the ONLY field that changes:
//
//   memberCategoryKeys  untouched — the 7 members stay (soccer boots stay out)
//   armed               untouched — FALSE, and this script refuses to proceed
//                       if the live group is not disarmed, and refuses to
//                       finish if it does not read back disarmed
//   policy              untouched
//
// Dry run by default. Nothing is written without --execute.
//
// Usage:
//   node scripts/relabel-sneakers-group.mjs             # shows the live group and the change
//   node scripts/relabel-sneakers-group.mjs --execute

import { createRequire } from "module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

const GROUP_KEY = "footwear-all";
const NEW_LABEL = "Sneakers";
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const EXECUTE = process.argv.includes("--execute");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

(async () => {
  const live = (await db.ref(`config/refillEngine/policyGroups/${GROUP_KEY}`).once("value")).val();
  if (!live || typeof live !== "object") { console.error(`No live group at policyGroups/${GROUP_KEY} — nothing to relabel.`); process.exit(1); }
  console.log(`\n  group    : ${GROUP_KEY}`);
  console.log(`  label    : "${live.label}"  →  "${NEW_LABEL}"`);
  console.log(`  members  : ${(live.memberCategoryKeys || []).length}  ${(live.memberCategoryKeys || []).join(", ")}`);
  console.log(`  armed    : ${live.armed}  (must be false, stays false)`);
  if (live.armed !== false) { console.error("  🛑 the live group is not DISARMED. This script does not touch an armed group."); process.exit(1); }
  if (live.label === NEW_LABEL) { console.log("\n  Already labelled Sneakers. Nothing to do.\n"); process.exit(0); }
  if (!EXECUTE) { console.log(`\n  Dry run. Nothing written. Re-run with --execute.\n`); process.exit(0); }

  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "relabel-script",
    data: { action: "setGroup", groupKey: GROUP_KEY, group: { ...live, label: NEW_LABEL }, expectedBefore: live },
    nowMs: Date.now(),
  });
  console.log(`\n  ${res.noChange ? "No change." : "Written."}  historyId ${res.historyId || "—"}`);
  const back = (await db.ref(`config/refillEngine/policyGroups/${GROUP_KEY}`).once("value")).val();
  console.log(`  read back: label="${back?.label}" armed=${back?.armed} members=${(back?.memberCategoryKeys || []).length}`);
  if (back?.armed !== false) { console.error("  🛑 the group did not read back DISARMED. Investigate before anything else."); process.exit(1); }
  if (back?.label !== NEW_LABEL) { console.error("  🛑 the label did not read back. Investigate."); process.exit(1); }
  console.log(`  ✓ relabelled, still disarmed.\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
