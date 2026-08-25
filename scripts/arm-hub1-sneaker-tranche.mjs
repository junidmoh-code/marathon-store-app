// ─── ARM THE NEXT HUB 1 SNEAKER TRANCHE ──────────────────────────────────────
//
// The Hub 1 per-size sneaker policy (2026-08-25) is armed in SIZE TRANCHES,
// one per day, because the measured first-scan demand for all ten sizes at
// once is 538 request lines / 857 units — an order of magnitude over a normal
// release window's 12-45 lines / 24-82 units. Per-size line counts from the
// dry run (scripts/model-hub1-sneaker-policy.mjs, 2026-08-25):
//
//   3:19  4:17  5:19  5.5:25 │ 6:69 │ 7:82 │ 8:80 │ 9:82 │ 10:83 │ 11:62
//
// so each tranche below lands ≈62-83 lines ≈ 31-42 per window — inside the
// historical band. The release-window gate itself needs nothing built: a
// request is released iff createdAt <= the most recent release instant
// (src/components/stock/releaseWindows.js), so everything a scan raises after
// 06:00 holds until 14:00 by itself. No earlyRelease is ever written.
//
// Each run arms exactly ONE more tranche (idempotent per day by construction —
// re-running the same day re-writes the same policy, which the drift check
// turns into a no-op refusal). When all ten sizes are armed it exits 0 doing
// nothing, and prints the launchctl line that removes the schedule.
//
// The write goes through applyCategoryPolicy — the deployed callable's own
// code path: same validation, drift check, history entry, post-verify. The
// entry it writes is what the Engine Policy card renders and can edit/revert.
//
// DRY RUN BY DEFAULT; --execute writes. A rollback file lands on disk first.
//
// Usage:  node scripts/arm-hub1-sneaker-tranche.mjs [--execute]
import { createRequire } from "module";
import { writeFileSync } from "fs";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

import { HUB1_RUN as RUN, runRow as row, TRANCHES } from "./lib/hub1SneakerRun.mjs";

const EXECUTE = process.argv.includes("--execute");
const ADMIN_EMAIL = "gunidmoh@gmail.com";   // the project's super-admin constant (PermissionsContext)

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

(async () => {
  // (The carriedOnly deploy sentinel is GONE with the scope gate, 2026-08-25
  // scope change: the policy arms every sneaker by design, and an unscoped
  // entry means the same thing to every engine version — there is no deploy
  // ordering left to guard.)
  const live = (await db.ref("config/refillEngine/categoryPolicy/sneakers").once("value")).val();

  // Refuse anything that is not OUR shape: a sneakers policy someone else
  // wrote must never be silently overwritten by a scheduler.
  if (live !== null) {
    const hub1 = live?.hub1;
    // A stale carriedOnly:true from the scope-gate window is tolerated on the
    // LIVE entry (the engine ignores it); the entry this script WRITES never
    // carries it, so the first tranche write scrubs it.
    const ok = live?.perSize === true && hub1
      && hub1.sizes && Object.keys(hub1).every((k) => k === "sizes" || k === "carriedOnly")
      && Object.keys(live).every((k) => k === "perSize" || k === "hub1")
      && Object.keys(hub1.sizes).every((k) => RUN[k] !== undefined);
    if (!ok) {
      console.error("REFUSED: live sneakers policy is not the Hub 1 tranche shape — arm by hand via the card.");
      console.error(JSON.stringify(live, null, 2));
      process.exit(2);
    }
  }

  const armed = new Set(live ? Object.keys(live.hub1.sizes) : []);
  const next = TRANCHES.find((t) => t.some((k) => !armed.has(k)));
  if (!next) {
    console.log("All ten sizes are armed — nothing to do. Remove the schedule:");
    console.log("  launchctl bootout gui/501/com.marathon.hub1sneakertranche && rm ~/Library/LaunchAgents/com.marathon.hub1sneakertranche.plist");
    process.exit(0);
  }

  const sizes = {};
  for (const k of [...armed, ...next]) sizes[k] = row(k);
  const policy = { perSize: true, hub1: { sizes } };   // unscoped — every sneaker, owner order 2026-08-25
  console.log(`tranche to arm: sizes ${next.join(", ")} (already armed: ${[...armed].join(", ") || "none"})`);
  console.log(JSON.stringify(policy, null, 2));

  const rollback = `${process.env.HOME}/hub1-sneaker-tranche-rollback-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(rollback, JSON.stringify({ at: new Date().toISOString(), before: live }, null, 2));
  console.log(`rollback (previous entry) written: ${rollback}`);

  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "hub1-tranche-runner",
    data: { categoryKey: "sneakers", policy, expectedBefore: live, dryRun: !EXECUTE },
    nowMs: Date.now(),
  });
  console.log(EXECUTE ? "WRITTEN:" : "DRY RUN (pass --execute to write):");
  console.log(JSON.stringify({ ok: res?.ok, dryRun: res?.dryRun, changes: res?.changes,
    modelled: res?.preview?.after ? { requests: res.preview.after.totalRequests, units: res.preview.after.totalUnits } : null }, null, 2));
  process.exit(res?.ok ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
