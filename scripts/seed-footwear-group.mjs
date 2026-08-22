// ─── SEED THE FOOTWEAR GROUP — DISARMED ───────────────────────────────────────
//
// Writes ONE key: /config/refillEngine/policyGroups/footwear-all, with
// armed:false. Nothing else is touched. No product's categoryKey changes, no
// /stock_targets row is written or deleted, no category policy moves, and the
// footwear kill switch (/config/refillEngine/footwearTargets, absent = OFF) is
// not read, written or reasoned about here.
//
// ── WHY WRITING IT IS SAFE ───────────────────────────────────────────────────
// A DISARMED GROUP IS NOT IN THE ENGINE'S RESOLUTION ORDER AT ALL —
// armedGroupForCategory returns before it ever reads the policy. So this write
// cannot produce an intent by any path, whatever numbers the group holds. That
// is a property, mutation-proved in scripts/mutation-proof-policy-groups.mjs
// (M-DISARMED), not a hope; and scripts/census-policy-groups.mjs measures it
// against the live snapshot as well — writing the group disarmed moved 0
// requests and 0 units across all 7 members on 2026-08-22.
//
// ── AND WHY IT IS NOT ARMED ──────────────────────────────────────────────────
// Modelled against the live snapshot with the locations' own footwear runs,
// arming it would produce 2,176 requests on the next scan against a per-scan
// cap of 75 that is SHARED with every clothing category — 29x. The callable
// refuses to arm it for exactly that reason, with the number in the message.
// Arming footwear is a decision for Junid, taken against that number, and it
// needs the separate footwearTargets switch thrown as well.
//
// ── THE MEMBER LIST IS READ, NOT WRITTEN DOWN ────────────────────────────────
// Every categoryKey in /settings/productTaxonomy whose `top` is "footwear",
// minus soccer-boots. A hardcoded list here would go stale the first time a
// category is added, and the group would silently stop covering it.
//
// It goes through applyCategoryPolicy — the same callable the card uses — so it
// gets the same validation, the same drift check, the same history entry and
// the same post-verify. A script that wrote the node directly would leave no
// audit trail and skip every guard the feature has.
//
//   node scripts/seed-footwear-group.mjs               # dry run
//   node scripts/seed-footwear-group.mjs --execute

import { createRequire } from "module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

const EXECUTE = process.argv.includes("--execute");
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const GROUP_KEY = "footwear-all";
const GROUP_TOP = "footwear";
const GROUP_EXCLUDE = ["soccer-boots"];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

(async () => {
  const [cfgSnap, taxSnap] = await Promise.all([
    db.ref("config/refillEngine").once("value"),
    db.ref("settings/productTaxonomy").once("value"),
  ]);
  const cfg = cfgSnap.val() || {};
  const cats = (taxSnap.val() || {}).cats || {};

  const members = Object.keys(cats).filter((k) => cats[k]?.top === GROUP_TOP && !GROUP_EXCLUDE.includes(k)).sort();
  if (!members.length) { console.error("No footwear categories in the taxonomy — refusing to write an empty group."); process.exit(1); }

  // THE GROUP'S NUMBERS are the locations' own footwear runs, so that if it is
  // ever armed it does what the footwear RULE would have done rather than
  // something invented here. reorderPoint 0 — ask only when a cell hits zero —
  // is the measured launch setting from 2026-07-30 (993 intents at eager,
  // 578 at 0).
  const runByLoc = cfg.footwearRunByLocation || {};
  const policy = { perSize: true };
  for (const loc of Object.keys(cfg.mode || {})) {
    const run = runByLoc[loc];
    if (!run || typeof run !== "object") continue;
    const sizes = {};
    for (const [sizeKey, t] of Object.entries(run)) {
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
      sizes[sizeKey] = { target: t, minQty: Math.max(1, t - 1), reorderPoint: 0 };
    }
    if (Object.keys(sizes).length) policy[loc] = { sizes };
  }
  if (Object.keys(policy).length === 1) { console.error("No footwear run in config — refusing to write a group with no numbers."); process.exit(1); }

  const group = {
    label: `All footwear except ${GROUP_EXCLUDE.join(", ")}`,
    memberCategoryKeys: members,
    armed: false,                     // ← THE POINT. Not a default; a decision.
    policy,
  };

  console.log(`\n  group      : ${GROUP_KEY}`);
  console.log(`  label      : ${group.label}`);
  console.log(`  members(${members.length}) : ${members.join(", ")}`);
  console.log(`  excluded   : ${GROUP_EXCLUDE.join(", ")}`);
  console.log(`  ARMED      : false  ← not in the engine's resolution order at all`);
  console.log(`  policy     : ${JSON.stringify(policy)}`);
  console.log(`  live now   : ${JSON.stringify(cfg.policyGroups?.[GROUP_KEY] ?? null)}`);

  if (!EXECUTE) { console.log(`\n  Dry run. Nothing written. Re-run with --execute.\n`); process.exit(0); }

  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "seed-script",
    data: { action: "setGroup", groupKey: GROUP_KEY, group, expectedBefore: cfg.policyGroups?.[GROUP_KEY] ?? null },
    nowMs: Date.now(),
  });
  console.log(`\n  ${res.noChange ? "No change — it was already exactly this." : "Written."}  historyId ${res.historyId || "—"}`);

  const back = (await db.ref(`config/refillEngine/policyGroups/${GROUP_KEY}`).once("value")).val();
  console.log(`  read back  : armed=${back?.armed}  members=${(back?.memberCategoryKeys || []).length}`);
  if (back?.armed !== false) { console.error("  🛑 the group did not read back DISARMED. Investigate before anything else."); process.exit(1); }
  console.log(`  ✓ disarmed, and therefore inert.\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
