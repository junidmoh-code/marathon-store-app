// ─── ARM HUB 2's SNEAKER CATEGORY POLICY ─────────────────────────────────────
//
// Phase 2 of docs/EXCESS-SNEAKERS.md. Phase 1 (read-only) found the entire
// Hub 1 vs Hub 2 sneaker-arming gap comes down to ONE missing key:
// `config/refillEngine/categoryPolicy/sneakers` has a `hub1` key and no
// `hub2` key. `categoryPolicyTarget()` resolves `null` (unarmed) for every
// hub2 size as a result, and the group fallback
// (`config/refillEngine/policyGroups/footwear-all`) can never be consulted
// once the category owns its own key — own-entry-blocks-group is
// unconditional, not per-location (`policy-resolve.cjs:97`).
//
// This script adds ONLY the `hub2` key, structurally identical to the live
// `hub1` key (`carriedOnly: true`, a per-size map of
// `{target, minQty, reorderPoint}`), populated with the numbers the owner
// already entered for Hub 2 on screen — sitting inert at
// `config/refillEngine/policyGroups/footwear-all.policy.hub2.sizes` because
// the group is unreachable for `sneakers`. It does NOT touch `hub1`, does
// NOT touch `/stock_targets`, does NOT arm any shop, and does NOT touch
// database.rules.json.
//
// The write goes through `applyCategoryPolicy` — the deployed Engine Policy
// card's own code path (functions/lib/category-policy-write.cjs): same
// validation, drift check (before AND immediately before the mutation),
// history entry (written before the mutation, holding the full `before`),
// and post-write verification. This is Admin SDK access straight to the
// database, so RTDB rules (stockRole-admin gate on /config/refillEngine) do
// not apply to this call at all — the ONLY gate is
// `assertEnginePolicyCaller`, satisfied here with the owner's email exactly
// like scripts/arm-hub1-sneaker-tranche.mjs does.
//
// DRY RUN BY DEFAULT; --execute writes. A rollback file (the full `before`
// object) lands on disk before anything is written.
//
// Usage:  node scripts/arm-hub2-sneaker-policy.mjs [--execute]
import { createRequire } from "module";
import { writeFileSync } from "fs";
const require = createRequire("file:///Users/junidmohammed/Documents/marathon-store-app/functions/package.json");
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require(new URL("../functions/lib/category-policy-write.cjs", import.meta.url).pathname);

const EXECUTE = process.argv.includes("--execute");
const ADMIN_EMAIL = "gunidmoh@gmail.com"; // same super-admin constant used by arm-hub1-sneaker-tranche.mjs

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// The 12 sizes named in the hub2 leg of the footwear-all group — this is the
// FULL set the owner already entered on screen for Hub 2 (3-13 plus 5.5).
const GROUP_HUB2_SIZE_KEYS = ["3", "4", "5", "5_5", "6", "7", "8", "9", "10", "11", "12", "13"];
// Sizes hub1's OWN live category policy covers today, for the gap check in
// step 3 (hub1 has 3-11 + 5.5, no 12/13).
const HUB1_SIZE_KEYS = ["3", "4", "5", "5_5", "6", "7", "8", "9", "10", "11"];

(async () => {
  const live = (await db.ref("config/refillEngine/categoryPolicy/sneakers").once("value")).val();
  const group = (await db.ref("config/refillEngine/policyGroups/footwear-all").once("value")).val();

  if (live?.hub2 !== undefined) {
    console.error("REFUSED: config/refillEngine/categoryPolicy/sneakers already has a hub2 key:");
    console.error(JSON.stringify(live.hub2, null, 2));
    console.error("This script only ever CREATES the hub2 key — arm changes by hand via the Engine Policy card.");
    process.exit(2);
  }
  if (!live?.hub1?.sizes) {
    console.error("REFUSED: live sneakers policy has no hub1.sizes — not the shape this script expects.");
    console.error(JSON.stringify(live, null, 2));
    process.exit(2);
  }
  const groupHub2Sizes = group?.policy?.hub2?.sizes;
  if (!groupHub2Sizes) {
    console.error("REFUSED: policyGroups/footwear-all.policy.hub2.sizes is absent — nowhere to pull Hub 2's numbers from.");
    process.exit(2);
  }

  // Gap check: does the group's hub2 leg cover every size hub1 has armed?
  const missing = HUB1_SIZE_KEYS.filter((k) => groupHub2Sizes[k] === undefined);
  if (missing.length) {
    console.log(`NOTE: hub1 arms size(s) [${missing.join(", ")}] that the group's hub2 leg does not cover — leaving those absent for hub2 (genuine gap, not invented).`);
  }

  const hub2Sizes = {};
  for (const k of GROUP_HUB2_SIZE_KEYS) {
    const row = groupHub2Sizes[k];
    if (!row) continue;
    const { target, minQty, reorderPoint } = row;
    hub2Sizes[k] = { target, minQty, reorderPoint };
  }

  const policy = {
    perSize: true,
    hub1: live.hub1, // byte-identical, untouched
    hub2: { carriedOnly: true, sizes: hub2Sizes },
  };

  console.log("Constructed policy.hub2:");
  console.log(JSON.stringify(policy.hub2, null, 2));

  const rollback = `${process.env.HOME}/hub2-sneaker-policy-rollback-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(rollback, JSON.stringify({ at: new Date().toISOString(), before: live }, null, 2));
  console.log(`rollback (previous entry) written: ${rollback}`);

  const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
  const nowMs = Date.now() + offset;

  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "hub2-sneaker-arm-runner",
    data: { categoryKey: "sneakers", policy, expectedBefore: live, dryRun: !EXECUTE },
    nowMs,
  });
  console.log(EXECUTE ? "WRITTEN:" : "DRY RUN (pass --execute to write):");
  console.log(JSON.stringify({
    ok: res?.ok, dryRun: res?.dryRun, changes: res?.changes, historyId: res?.historyId,
    modelled: res?.preview?.after ? { requests: res.preview.after.totalRequests, units: res.preview.after.totalUnits } : null,
  }, null, 2));

  // Post-write sanity: re-read live, confirm exactly {perSize, hub1, hub2}.
  const after = (await db.ref("config/refillEngine/categoryPolicy/sneakers").once("value")).val();
  console.log("Live categoryPolicy/sneakers keys after this run:", Object.keys(after || {}).sort());

  process.exit(res?.ok ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
