// ─── RELABEL THE FOOTWEAR GROUP TO "Sneakers" ─────────────────────────────────
//
// ONE FIELD. It writes /config/refillEngine/policyGroups/footwear-all/label and
// nothing else — not `armed`, not `memberCategoryKeys`, not `policy`, and no
// /stock_targets row anywhere. The group key stays `footwear-all` (renaming a
// key is a delete plus a create, and a group that vanishes for even one scan is
// a group that resolves nothing during it).
//
// ── WHY A SCRIPT AND NOT THE SCREEN ──────────────────────────────────────────
// The card edits a group's NUMBERS. The label is the name of a policy the whole
// estate reads, changed once, deliberately, with the before value printed so it
// can be put back by hand in one line.
//
// SAFETY: refuses if the group is armed (a relabel is not the moment to touch
// an armed policy), refuses if the group is missing, and prints the rollback
// command before it writes. Dry by default; --execute writes.
//
// Usage:
//   node scripts/relabel-sneakers-group.mjs                 # dry run
//   node scripts/relabel-sneakers-group.mjs --execute
//   LABEL="Sneakers" GROUP_KEY=footwear-all node scripts/relabel-sneakers-group.mjs --execute

import { createRequire } from "module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const GROUP_KEY = process.env.GROUP_KEY || "footwear-all";
const LABEL = process.env.LABEL || "Sneakers";
const EXECUTE = process.argv.includes("--execute");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const PATH = `config/refillEngine/policyGroups/${GROUP_KEY}`;

(async () => {
  const group = (await db.ref(PATH).once("value")).val();
  if (!group || typeof group !== "object") {
    console.error(`REFUSED: no group at ${PATH}`);
    process.exit(2);
  }
  console.log(`group      : ${GROUP_KEY}`);
  console.log(`label now  : ${JSON.stringify(group.label)}`);
  console.log(`label after: ${JSON.stringify(LABEL)}`);
  console.log(`armed      : ${group.armed}`);
  console.log(`members    : ${(group.memberCategoryKeys || []).join(", ")}`);
  if (group.armed === true) {
    console.error("REFUSED: this group is ARMED. Relabelling an armed policy is not this script's job.");
    process.exit(3);
  }
  if (group.label === LABEL) {
    console.log("Nothing to do — it is already called that.");
    process.exit(0);
  }
  console.log(`\nROLLBACK: LABEL=${JSON.stringify(group.label)} node scripts/relabel-sneakers-group.mjs --execute`);
  if (!EXECUTE) {
    console.log("\nDRY RUN — nothing written. Re-run with --execute.");
    process.exit(0);
  }
  await db.ref(`${PATH}/label`).set(LABEL);
  const after = (await db.ref(PATH).once("value")).val();
  const ok = after.label === LABEL && after.armed === group.armed
    && JSON.stringify(after.memberCategoryKeys) === JSON.stringify(group.memberCategoryKeys)
    && JSON.stringify(after.policy) === JSON.stringify(group.policy);
  console.log(`\nwritten. verified: ${ok ? "yes — label only" : "NO — something else moved, check the node"}`);
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error(e); process.exit(1); });
