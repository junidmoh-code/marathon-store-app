// ─── REVERSE THE 2026-09-08 SLIDES ARMING ─────────────────────────────────────
//
// DRY RUN BY DEFAULT. Pass --execute to write.
//
// WHAT IT UNDOES, AND IN WHICH ORDER — the order is the whole safety argument.
//
//   1. UN-ARM THE MAP FIRST. /config/refillEngine/categoryPolicy/slides is what
//      manufactures the demand; the scan runs every 15 minutes. Cancelling the
//      requests before switching the source off would have the next scan raise
//      them again, and the reversal would race a robot it cannot win.
//      Un-arming goes through applyCategoryPolicy with `policy: null` — the
//      documented off switch — so it gets the drift check, the rollback
//      snapshot in /engine_policy_history, and the post-verify. It DELETES the
//      map entry. It does NOT write `target: 0` rows anywhere: a target-0 row
//      is a permanent per-product seating switch-off and would outlive any
//      re-arm, which is the opposite of what is wanted.
//
//   2. THEN WITHDRAW THE LINES, through the engine's own withdrawal shape
//      (refill-engine.cjs `needGone` → refill-scan.cjs's close loop):
//        • a null-tolerant transaction on /refill_requests/{id} that writes
//          status "cancelled", resolvedAt and cancelReason "no_longer_needed",
//          and ONLY while the live row still reads "open" — a line somebody
//          picked or rejected in the meantime is left exactly as they left it;
//        • then the lock at /refill_engine/open/{dest}/{pid}/{sizeKey} removed.
//      cancelReason is present ON PURPOSE. Its ABSENCE is the stored shape of a
//      HUMAN rejection, which the engine reads as "the shelf was empty" and
//      answers with a cooldown and a confirmed-out strike. This was not a
//      rejection — nobody looked at a shelf — so a reasoned withdrawal is the
//      honest record and it teaches the engine nothing false. It classifies as
//      "No longer needed" in Refill History. No /refill_engine/rejectStreak
//      node is touched.
//      Clearing the lock and the open status is also what clears the derived
//      state: Missing Sneakers, awaiting-transfer and the health counts all
//      read the open set and the lock table, and none of them stores a copy.
//
//   NO /orders CLEANUP IS OWED. hub1 and hub2 are not store legs
//   (refill-scan.cjs UNIVERSE_BY_SHOP is marathon-pe / trophy / marathon-pine),
//   so these intents never created an order node. Verified against the live
//   locks, which carry no orderId.
//
// ── WHAT IT REFUSES TO TOUCH ─────────────────────────────────────────────────
//
//   • THE 13 EXPLICIT /stock_targets ROWS AT HUB2. Hand-made through the
//     product-override path on 2026-09-06 and 2026-09-08T11:52, all on products
//     hub2 already seats, all predating the 12:02 arming, none a target-0
//     switch-off. Explicit rows are the source of truth for the products that
//     carry them and are edited in place, never deleted. This script has no
//     code path that writes to /stock_targets at all.
//   • ANY LINE BACKED BY ONE OF THOSE ROWS. An explicit row outranks the map
//     (resolveTarget:468), so its request exists with or without the arming.
//     Live, that is exactly one line — the Givenchy size 9 at hub2, raised two
//     minutes BEFORE the arming.
//   • ANYTHING OUTSIDE SLIDES. Hub 1's armed sneakers and the whole clothing
//     arming are not read, not modelled and not written.
//
// ── IDEMPOTENT ───────────────────────────────────────────────────────────────
// Re-running after a partial run is safe and is the intended recovery. The
// policy un-arm no-ops when the entry is already gone; each line is decided
// from LIVE state, and the transaction bails on anything no longer open.
//
// Usage:
//   node scripts/reverse-slides-arming.mjs              # dry run
//   node scripts/reverse-slides-arming.mjs --execute

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTE = process.argv.includes("--execute");
const CATEGORY = "slides";
const HUBS = ["hub1", "hub2"];
const ADMIN_EMAIL = "gunidmoh@gmail.com";

// The arming this run reverses. Stated as data so the scope is auditable and so
// a line older than the incident can never be swept up by a bug in the filter.
const ARMING_HISTORY_ID = "-P1-t_VYDbVyCVI0m-ce";
const ARMING_AT = "2026-09-08T12:00:00.000Z";   // the arming landed at 12:02:48Z

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const ROLLBACK = join(ROOT, "var", `slides-arming-reversal-${STAMP}.json`);

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val());
const pad = (s, n) => String(s).padEnd(n);

(async () => {
  console.log("═".repeat(96));
  console.log(`  REVERSE THE SLIDES ARMING${EXECUTE ? "" : "        DRY RUN — nothing will be written"}`);
  console.log("═".repeat(96));

  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const pids = new Set(Object.keys(products).filter((p) => products[p]?.categoryKey === CATEGORY));

  // Explicit rows first — they decide which lines are out of scope, so they are
  // read BEFORE anything is chosen, not consulted afterwards.
  const explicitCells = new Set();
  for (const loc of HUBS) {
    const t = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
    for (const pid of Object.keys(t)) {
      if (!pids.has(pid)) continue;
      for (const [sizeKey, row] of Object.entries(t[pid] || {})) {
        if (row && typeof row === "object") explicitCells.add(`${loc}|${pid}|${sizeKey}`);
      }
    }
  }
  console.log(`\n  explicit /stock_targets rows on slides at the hubs: ${explicitCells.size}  (untouched, and their lines are out of scope)`);

  const beforePolicy = await small(`config/refillEngine/categoryPolicy/${CATEGORY}`);
  console.log(`  categoryPolicy.${CATEGORY} live now: ${beforePolicy ? Object.keys(beforePolicy).filter((k) => k !== "perSize").join(", ") : "(absent — already un-armed)"}`);

  // ── CHOOSE THE LINES, FROM LIVE ────────────────────────────────────────────
  const targetsLines = [];
  const skipped = [];
  for (const loc of HUBS) {
    const openIdx = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
    for (const [pid, bySize] of Object.entries(openIdx)) {
      if (!pids.has(pid)) continue;
      for (const [sizeKey, e] of Object.entries(bySize || {})) {
        if (!e || typeof e !== "object" || !e.refillId) continue;
        const rr = await small(`refill_requests/${e.refillId}`);
        const row = { loc, pid, sizeKey, refillId: e.refillId, orderId: e.orderId || null,
          name: products[pid]?.name || pid, size: rr?.size ?? null, qty: rr?.qty ?? e.qty ?? null,
          createdAt: rr?.createdAt || e.createdAt || null, status: rr?.status || null,
          sentQty: rr?.sentQty ?? 0 };
        if (explicitCells.has(`${loc}|${pid}|${sizeKey}`)) { skipped.push({ ...row, why: "explicit row backs it" }); continue; }
        if (!rr || rr.status !== "open") { skipped.push({ ...row, why: `not open (${rr?.status || "request missing"})` }); continue; }
        if ((row.createdAt || "") < ARMING_AT) { skipped.push({ ...row, why: "predates the arming" }); continue; }
        targetsLines.push(row);
      }
    }
  }

  const units = targetsLines.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  const partSent = targetsLines.filter((r) => (r.sentQty || 0) > 0);
  console.log(`\n  lines to withdraw: ${targetsLines.length}  (${units} units)`);
  console.log(`    hub1 ${targetsLines.filter((r) => r.loc === "hub1").length}   hub2 ${targetsLines.filter((r) => r.loc === "hub2").length}`);
  console.log(`  lines left alone : ${skipped.length}`);
  for (const s of skipped) console.log(`    ${pad(s.loc, 6)} ${pad(s.name, 36)} ${pad(s.size, 5)} — ${s.why}`);
  if (partSent.length) {
    console.log(`\n  ⚠ ALREADY PART-PICKED OUT OF CENTRAL — the remainder is withdrawn, the units already sent are a WAREHOUSE matter:`);
    for (const r of partSent) console.log(`    ${pad(r.loc, 6)} ${pad(r.name, 36)} ${pad(r.size, 5)} sent ${r.sentQty}, remainder ${r.qty}  (${r.refillId})`);
  }

  mkdirSync(dirname(ROLLBACK), { recursive: true });
  writeFileSync(ROLLBACK, JSON.stringify({
    capturedAt: new Date().toISOString(), executed: EXECUTE,
    armingHistoryId: ARMING_HISTORY_ID, armingAt: ARMING_AT,
    policyBefore: beforePolicy ?? null,
    restorePolicyWith: `CATEGORY=slides POLICY_JSON='<policyBefore>' node scripts/apply-engine-policy.mjs --execute`,
    linesToWithdraw: targetsLines, linesLeftAlone: skipped,
  }, null, 2));
  console.log(`\n  rollback snapshot → ${ROLLBACK}`);

  if (!EXECUTE) { console.log(`\n  DRY RUN — pass --execute to write.\n`); process.exit(0); }

  // ── 1. UN-ARM ──────────────────────────────────────────────────────────────
  if (beforePolicy) {
    const offset = (await small(".info/serverTimeOffset")) || 0;
    const res = await applyCategoryPolicy({
      db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "slides-reversal-runner",
      data: { categoryKey: CATEGORY, policy: null, expectedBefore: beforePolicy },
      nowMs: Date.now() + offset,
    });
    console.log(`\n  ✓ categoryPolicy.${CATEGORY} un-armed  (history ${res.historyId})`);
  } else {
    console.log(`\n  · categoryPolicy.${CATEGORY} was already absent — nothing to un-arm`);
  }
  const afterPolicy = await small(`config/refillEngine/categoryPolicy/${CATEGORY}`);
  if (afterPolicy) { console.error(`  ✗ the entry is still live: ${JSON.stringify(afterPolicy)}`); process.exit(3); }

  // ── 2. WITHDRAW ────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  let cancelled = 0, bailed = 0, lockFails = 0;
  for (const r of targetsLines) {
    let committed = false;
    try {
      const res = await db.ref(`refill_requests/${r.refillId}`).transaction((cur) => {
        if (cur === null) return null;                       // cold-cache probe — see refill-scan.cjs
        if (cur.status && cur.status !== "open") return;      // resolved meanwhile — leave it
        return { ...cur, status: "cancelled", resolvedAt: nowIso, cancelReason: "no_longer_needed" };
      });
      committed = !!(res && res.committed && res.snapshot.val()?.status === "cancelled");
    } catch (e) { console.error(`    ✗ ${r.refillId}: ${e?.message || e}`); }
    if (!committed) { bailed++; continue; }
    cancelled++;
    // The lock goes only AFTER the request is safely cancelled: a lock removed
    // over a still-open request re-proposes on the next scan.
    try { await db.ref(`refill_engine/open/${r.loc}/${r.pid}/${r.sizeKey}`).set(null); }
    catch (e) { lockFails++; console.error(`    ✗ lock ${r.loc}/${r.pid}/${r.sizeKey}: ${e?.message || e}`); }
  }
  console.log(`\n  ✓ withdrawn ${cancelled}   left as-is ${bailed}   lock removals failed ${lockFails}`);

  // ── 3. RE-VERIFY, FROM LIVE ────────────────────────────────────────────────
  let stillOpen = 0, stillLocked = 0, rowsLeft = 0;
  for (const loc of HUBS) {
    const idx = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
    for (const [pid, bySize] of Object.entries(idx)) {
      if (!pids.has(pid)) continue;
      for (const [sizeKey, e] of Object.entries(bySize || {})) {
        if (explicitCells.has(`${loc}|${pid}|${sizeKey}`)) continue;
        stillLocked++;
        const rr = e?.refillId ? await small(`refill_requests/${e.refillId}`) : null;
        if (rr?.status === "open") stillOpen++;
      }
    }
    const t = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
    for (const pid of Object.keys(t)) if (pids.has(pid)) rowsLeft += Object.keys(t[pid] || {}).length;
  }
  console.log(`\n  ── RE-VERIFY ──────────────────────────────────────────────────────────`);
  console.log(`    categoryPolicy.${CATEGORY}                        : absent ✓`);
  console.log(`    open slides lines from the arming, either hub  : ${stillOpen} ${stillOpen === 0 ? "✓" : "✗"}`);
  console.log(`    locks left from the arming                     : ${stillLocked} ${stillLocked === 0 ? "✓" : "✗"}`);
  console.log(`    /stock_targets rows on slides (all pre-existing): ${rowsLeft}  — untouched by design`);
  console.log("");
  process.exit(stillOpen === 0 && stillLocked === 0 ? 0 : 4);
})().catch((e) => { console.error(e); process.exit(1); });
