// ─── APPLY AN ENGINE CATEGORY POLICY — THE GUARDED RUNNER ────────────────────
//
// Runs the CALLABLE'S OWN CODE PATH (functions/lib/category-policy-write.cjs
// applyCategoryPolicy) against the live database with the Admin SDK, which is
// exactly what the deployed setCategoryPolicy does once its auth check has
// passed. So the write goes through the same validation, the same drift checks,
// the same rollback snapshot, the same audit entry and the same post-verify —
// not a second implementation that merely resembles them.
//
// It exists because the owner-run arming step has to happen before the function
// is deployed, and because a bulk live write in this repo carries an on-disk
// rollback file whatever else it carries. The card is how this is done from
// then on.
//
// ── THE GUARD, IN ORDER ──────────────────────────────────────────────────────
//   live re-read  →  drift check against --expect  →  rollback snapshot to disk
//   →  model it  →  write  →  post-verify by reading it back
//
// DRY RUN BY DEFAULT. --execute is required, and is refused if the on-disk
// rollback file cannot be written first: a live write whose rollback is not
// already on disk is not a guarded write.
//
// Usage:
//   node scripts/apply-engine-policy.mjs                       # dry run
//   node scripts/apply-engine-policy.mjs --execute
//   CATEGORY=perfumes POLICY_JSON=/path/to/entry.json node scripts/apply-engine-policy.mjs

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const EXECUTE = process.argv.includes("--execute");
const CATEGORY = process.env.CATEGORY || "caps-beanies";

// The change this build was commissioned for. Targets are UNCHANGED at 5 and
// 10 — only the trigger moves, from "ask when the shelf is empty" to "ask when
// it drops to 2".
const DEFAULT_POLICY = {
  hub2: { target: 10, minQty: 5, reorderPoint: 2 },
  "marathon-pe": { target: 5, minQty: 3, reorderPoint: 2 },
};
const POLICY = process.env.POLICY_JSON
  ? JSON.parse(require("fs").readFileSync(process.env.POLICY_JSON, "utf8"))
  : DEFAULT_POLICY;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// Key order is not stable across RTDB reads, so EVERY equality in this file is
// on a canonical form — the drift check AND the post-verify. Using a raw
// JSON.stringify for the post-verify reported a false failure on a write that
// had in fact landed exactly right, because RTDB returns keys alphabetically
// and the intended object was built in field order. A verification that cries
// wolf is as bad as one that never fires: the next person believes neither.
const canon = (v) => (v === null || v === undefined ? "null"
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const ROLLBACK = join(ROOT, "var", `engine-policy-rollback-${CATEGORY}-${stamp}.json`);

(async () => {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  ENGINE POLICY — ${CATEGORY}${EXECUTE ? "" : "   (DRY RUN — nothing will be written)"}`);
  console.log(`${"═".repeat(78)}`);

  // ── 1. LIVE RE-READ ───────────────────────────────────────────────────────
  const live = (await db.ref(`config/refillEngine/categoryPolicy/${CATEGORY}`).once("value")).val();
  console.log(`\n  LIVE NOW: ${JSON.stringify(live)}`);
  console.log(`  PROPOSED: ${JSON.stringify(POLICY)}`);

  // ── 2. DRIFT CHECK against what this run was written for ──────────────────
  // The expectation is stated as data, not assumed: if live is not the shape
  // this change was modelled against, stop and let a human look.
  const EXPECT = process.env.EXPECT_JSON
    ? JSON.parse(require("fs").readFileSync(process.env.EXPECT_JSON, "utf8"))
    : (CATEGORY === "caps-beanies"
        ? { hub2: { target: 10, minQty: 5, reorderPoint: 0 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } }
        : null);
  if (EXPECT) {
    if (canon(live) !== canon(EXPECT)) {
      console.error(`\n  ✗ DRIFT — live does not match what this change was modelled against.`);
      console.error(`    expected: ${canon(EXPECT)}`);
      console.error(`    live:     ${canon(live)}`);
      console.error(`    Nothing was written. Re-run the model before deciding.`);
      process.exit(3);
    }
    console.log(`  ✓ live matches what the model was run against — no drift.`);
  }

  // ── 3. ROLLBACK SNAPSHOT TO DISK, BEFORE ANYTHING ─────────────────────────
  // The callable writes its own snapshot into RTDB. This is the second copy, on
  // disk, because the first one lives in the database this write is changing.
  mkdirSync(dirname(ROLLBACK), { recursive: true });
  writeFileSync(ROLLBACK, JSON.stringify({
    capturedAt: new Date().toISOString(),
    path: `config/refillEngine/categoryPolicy/${CATEGORY}`,
    categoryKey: CATEGORY,
    before: live,
    proposedAfter: POLICY,
    restoreWith: `CATEGORY=${CATEGORY} POLICY_JSON=<the "before" object from this file> node scripts/apply-engine-policy.mjs --execute`,
  }, null, 2));
  console.log(`  ✓ rollback snapshot → ${ROLLBACK}`);

  // ── 4. MODEL IT (dryRun through the callable's own code) ──────────────────
  const dry = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "runner",
    data: { categoryKey: CATEGORY, policy: POLICY, dryRun: true }, nowMs: Date.now(),
  });
  console.log(`\n  CHANGES:`);
  for (const c of dry.changes) console.log(`    ${(c.loc || "(category)").padEnd(14)} ${String(c.field).padEnd(14)} ${String(c.from ?? "absent").padStart(7)}  ->  ${c.to ?? "absent"}`);
  const m = dry.preview.after, b = dry.preview.before;
  console.log(`\n  DAY ONE (ceiling — the scan can only ask for less):`);
  console.log(`    requests  ${b.totalRequests} -> ${m.totalRequests}   against the ${m.cap}-per-scan cap`);
  console.log(`    units     ${b.totalUnits} -> ${m.totalUnits}   against Central's ${m.centralOnHand}`);
  console.log(`    products still on their own explicit rows: ${m.overriddenProducts}`);
  for (const l of m.legs) {
    console.log(`    ${l.loc.padEnd(14)} keep ${String(l.target).padStart(3)}  min ${String(l.minQty).padStart(3)}  askAt ${String(l.reorderPoint ?? "absent").padStart(6)}  →  ${l.wouldRequest} requests, ${l.unitsWanted} units  (${l.silent} silent, ${l.parked} parked)`);
  }

  const blockers = [];
  if (m.exceedsCap) blockers.push(`over the ${m.cap}-intent cap (${m.totalRequests})`);
  if (m.exceedsCentral) blockers.push(`wants ${m.totalUnits} units, Central holds ${m.centralOnHand}`);
  if (m.overriddenProducts > 20) blockers.push(`${m.overriddenProducts} products overridden by explicit rows`);
  if (blockers.length) {
    console.error(`\n  ✗ STOP — ${blockers.join("; ")}.`);
    console.error(`    Nothing was written. This needs a decision, not a run.`);
    process.exit(4);
  }
  console.log(`\n  ✓ within the cap, within Central's stock, and fewer than 20 products overridden.`);

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.`);
    console.log(`${"═".repeat(78)}\n`);
    process.exit(0);
  }

  // ── 5. THE WRITE, through the callable's own path ─────────────────────────
  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "runner",
    data: { categoryKey: CATEGORY, policy: POLICY, expectedBefore: live },
    nowMs: Date.now(),
  });
  console.log(`\n  ✓ WRITTEN. audit entry: /engine_policy_history/${res.historyId}`);

  // ── 6. POST-VERIFY, from a fresh read ─────────────────────────────────────
  const after = (await db.ref(`config/refillEngine/categoryPolicy/${CATEGORY}`).once("value")).val();
  console.log(`  LIVE AFTER: ${JSON.stringify(after)}`);
  const ok = canon(after) === canon(res.after);
  const audit = (await db.ref(`engine_policy_history/${res.historyId}`).once("value")).val();
  // Defensive on purpose: this line runs AFTER the live write. new Date(undefined)
  // .toISOString() throws a RangeError, the outer catch would print FAILED and
  // exit 1 — announcing a failure for a write that had already succeeded, and
  // swallowing the post-verify line that says so.
  const auditAt = Number.isFinite(audit?.at) ? new Date(audit.at).toISOString() : "unknown";
  console.log(`  audit: status=${audit?.status ?? "missing"} by=${audit?.by ?? "unknown"} at=${auditAt}`);
  console.log(ok ? `  ✓ POST-VERIFY PASSED — live reads back exactly what was intended.`
                 : `  ✗ POST-VERIFY FAILED — live does not match. Roll back with ${ROLLBACK}.`);
  console.log(`${"═".repeat(78)}\n`);
  process.exit(ok ? 0 : 5);
})().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
