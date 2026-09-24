// ─── APPLY THE ONE FOOTWEAR POLICY — THE GUARDED RUNNER ───────────────────────
//
// Writes Junid's standing footwear run (scripts/lib/footwearStanding.mjs) as ONE
// policy — the footwear-all group, armed, eight members, identical at Hub 1 and
// Hub 2 — and removes the per-category footwear entries that would shadow it.
//
// EVERY WRITE GOES THROUGH THE CALLABLE'S OWN CODE PATH:
// functions/lib/category-policy-write.cjs applyCategoryPolicy, the function the
// deployed setCategoryPolicy runs once its owner check has passed. Same
// validation, same seating gate, same cap model, same drift checks, same
// history entry written BEFORE the mutation, same post-verify. Each step is
// therefore an entry in the Engine Policy card's history with one-tap Revert.
// Nothing here writes a policy node itself.
//
// ── THE ORDER IS LOAD-BEARING ────────────────────────────────────────────────
//   1. setGroup footwear-all  → armed, 8 members, standing legs
//   2. categoryPolicy/<key> → null, for each footwear key that has one
// Arming the group FIRST means no footwear category is ever unarmed between
// steps: while an own entry exists it wins (own beats group), and the moment
// it is removed the group already speaks. The other order would drop Sneakers
// and Slides to "no policy" for a scan and withdraw their open lines.
//
// ── STOPS ────────────────────────────────────────────────────────────────────
//   • the dry run models more requests than the group cap allows (the
//     callable's own refusal — nothing is written)
//   • the modelled armed (product, hub) set is not a subset of the carried
//     (cell) set — a policy sets HOW MANY, never WHERE
//   • after the writes, footwearPolicyDrift is not empty
//
// Dry run by default. --execute writes. A rollback snapshot of every node it
// touches goes to var/ BEFORE the first write.
//
// Usage:
//   node scripts/apply-footwear-one-policy.mjs            # dry run
//   node scripts/apply-footwear-one-policy.mjs --execute

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { standingGroup, FOOTWEAR_KEYS, FOOTWEAR_GROUP_KEY, STANDING_HUBS } from "./lib/footwearStanding.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "functions", "package.json"));
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");
const { footwearPolicyDrift } = require("../functions/lib/policy-resolve.cjs");
const { resolveTarget, policyCategoryKey } = require("../functions/lib/refill-engine.cjs");

const EXECUTE = process.argv.includes("--execute");
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const RUNNER = "footwear-one-policy-runner";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val());
const carries = (stock, loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;

(async () => {
  console.log("═".repeat(90));
  console.log(`  ONE FOOTWEAR POLICY${EXECUTE ? "" : "        DRY RUN — nothing will be written"}`);
  console.log("═".repeat(90));
  const offset = (await small(".info/serverTimeOffset")) || 0;
  const now = () => Date.now() + offset;
  const call = (data) => applyCategoryPolicy({ db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER, data, nowMs: now() });

  // ── LIVE READ + ROLLBACK SNAPSHOT ─────────────────────────────────────────
  const liveGroup = await small(`config/refillEngine/policyGroups/${FOOTWEAR_GROUP_KEY}`);
  const liveOwn = {};
  for (const k of FOOTWEAR_KEYS) { const v = await small(`config/refillEngine/categoryPolicy/${k}`); if (v != null) liveOwn[k] = v; }
  const rollback = join(ROOT, "var", `footwear-one-policy-rollback-${STAMP}.json`);
  mkdirSync(dirname(rollback), { recursive: true });
  writeFileSync(rollback, JSON.stringify({ at: new Date().toISOString(), group: liveGroup, ownEntries: liveOwn }, null, 2));
  console.log(`\n  rollback snapshot → ${rollback}`);
  console.log(`  live group: armed=${liveGroup?.armed} members=${(liveGroup?.memberCategoryKeys || []).join(",")}`);
  console.log(`  own footwear entries to remove: ${Object.keys(liveOwn).join(", ") || "none"}`);

  // ── STEP 1, DRY: the group, through the callable's own model ──────────────
  const group = standingGroup();
  const dry = await call({ action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group, expectedBefore: liveGroup ?? null, dryRun: true });
  console.log(`\n  group dry run: modelled ${dry.armModel?.totalRequests} requests / ${dry.armModel?.totalUnits} units against cap ${dry.armModel?.cap} (own entries still in force for: ${Object.keys(liveOwn).join(", ") || "none"})`);
  for (const m of dry.armModel?.perMember || []) console.log(`    ${m.key.padEnd(15)} ${String(m.requests).padStart(4)} req  source ${m.policySource || "none"}`);

  // ── THE WHERE CHECK: the after-state arms nothing without a cell ──────────
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const locations = Object.keys((await small("locations")) || {});
  const stock = {};
  for (const loc of [...new Set([...locations, "in_transit"])]) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  const targets = {};
  for (const hub of STANDING_HUBS) targets[hub] = await readMapPaged(db, `stock_targets/${hub}`, { pageSize: 500 });
  const cfgLive = await small("config/refillEngine");
  const cfgAfter = { ...cfgLive, policyGroups: { ...(cfgLive.policyGroups || {}), [FOOTWEAR_GROUP_KEY]: dry.after },
    categoryPolicy: Object.fromEntries(Object.entries(cfgLive.categoryPolicy || {}).filter(([k]) => !FOOTWEAR_KEYS.includes(k))) };
  const armedPairs = (cfg) => {
    const out = new Set();
    const ctx = { targets, config: cfg, products, stock };
    for (const [pid, p] of Object.entries(products)) {
      if (!FOOTWEAR_KEYS.includes(policyCategoryKey(p))) continue;
      for (const hub of STANDING_HUBS) {
        // Policy arming only — an explicit row is a person's decision and is
        // not what this run changes.
        if ((p.sizes || []).some((s) => { const t = resolveTarget(ctx, hub, pid, String(s)); return t && t.target > 0 && t.source === "category_policy"; })) out.add(`${pid}|${hub}`);
      }
    }
    return out;
  };
  const before = armedPairs(cfgLive), after = armedPairs(cfgAfter);
  const uncarried = [...after].filter((k) => { const [pid, hub] = k.split("|"); return !carries(stock, hub, pid); });
  const grown = [...after].filter((k) => !before.has(k));
  console.log(`\n  policy-armed (product, hub): before ${before.size} → after ${after.size}; newly armed ${grown.length}, all holding a cell: ${grown.every((k) => { const [pid, hub] = k.split("|"); return carries(stock, hub, pid); })}`);
  if (uncarried.length) {
    console.error(`\n  STOP: ${uncarried.length} armed pairs hold no stock cell — the policy would decide WHERE. Nothing written.`);
    console.error(uncarried.slice(0, 20).join("\n"));
    process.exit(4);
  }
  const slidesSplit = (set) => [...set].filter((k) => policyCategoryKey(products[k.split("|")[0]]) === "slides").sort().join(",");
  const slidesSame = slidesSplit(before) === slidesSplit(after);
  console.log(`  slides split identical: ${slidesSame}`);
  if (!slidesSame) { console.error("\n  STOP: the Slides Hub 1 / Hub 2 split would change. Nothing written."); process.exit(4); }

  if (!EXECUTE) { console.log("\n  DRY RUN — pass --execute to write.\n"); process.exit(0); }

  // ── STEP 1: arm the one policy ────────────────────────────────────────────
  const g = await call({ action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group, expectedBefore: liveGroup ?? null });
  console.log(`\n  ✓ group written  history ${g.historyId || "(no change)"}`);
  // ── STEP 2: remove every own footwear entry ───────────────────────────────
  for (const [k, v] of Object.entries(liveOwn)) {
    const r = await call({ categoryKey: k, policy: null, expectedBefore: v });
    console.log(`  ✓ ${k} own entry removed  history ${r.historyId}`);
  }
  // ── VERIFY ────────────────────────────────────────────────────────────────
  const drift = footwearPolicyDrift(await small("config/refillEngine"));
  console.log(`\n  drift after: ${drift.length ? JSON.stringify(drift) : "none"}`);
  process.exit(drift.length ? 5 : 0);
})().catch((e) => { console.error(e?.message || e, e?.details ? JSON.stringify(e.details).slice(0, 800) : ""); process.exit(1); });
