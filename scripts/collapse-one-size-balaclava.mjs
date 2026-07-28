// ─── ONE-SIZE COLLAPSE — Nike Pro Hyperwarm Balaclava Black ──────────────────
//
// ⚠️  THE APPLY PATH IS UNWIRED BY DESIGN. ⚠️
//
// This build can ONLY dry-run. It reads live data, runs every pre-flight
// assertion, prints the complete write plan and captures a rollback snapshot —
// and then stops. Passing --apply reaches a deliberate dead end; it does NOT
// write. Wiring the apply path is a separate, conscious edit to be made close to
// a scheduled run, reviewed, and not left sitting on disk between runs.
//
// The one exception, and it is intentional: the pre-flight WRITE-BACK PROBE
// writes each barcode index record's EXISTING size value back verbatim. That is
// a real write with zero content change, and it is the assertion the whole
// operation depends on — see PERMISSIONS below. It re-reads to confirm the value
// is unchanged and fails loudly if it is not.
//
// ── WHAT THIS DOES (runbook steps 0d → 3) ────────────────────────────────────
// A product that is physically one-size but was created before the app offered a
// free-size option carries a multi-size run. Its stock sits in ONE size cell, its
// barcodes are minted per size, and collapsing `sizes` to ["_"] naively would
// orphan the stock AND make every physical label unscannable. This migrates it
// properly:
//
//   Step 1  move all units from the holding size cell → the "_" cell, per
//           location, as PAIRED adjustments (out-then-in), so the ledger never
//           shows the stock existing twice.
//   Step 2  ONE atomic multi-path update: products/{pid}/sizes → ["_"], the
//           barcodes map → a single "_" slot, and EVERY barcode index record's
//           `size` → "_".
//   Step 3  target rows: the new one-size policy, plus target 0 ("excluded") on
//           the now-dead size rows.
//
// ── WHY STEP 2 MUST BE ONE ATOMIC UPDATE ─────────────────────────────────────
// Both orderings break scanning if done as two writes:
//   • sizes first    → realSizes() is [], index still says "L" → sizeOk =
//                      ("L" == null) → every code fails size_unavailable.
//   • barcodes first → index says "_" → size = null, but realSizes() is still
//                      ["L"] → ["L"].includes(null) → every code fails.
// Only landing them together avoids a window where the product cannot be sold.
// (POS: marathon-pos-app src/scanner/resolveScan.js + src/products/oneSize.js.)
//
// ── PERMISSIONS ──────────────────────────────────────────────────────────────
// The live rule at /barcodes/$code is CREATE-ONLY:
//     ".write": "... && !data.exists()"
// It cascades to writes at barcodes/{code}/size, because `data` in that rule's
// context is the $code record, which exists. So Step 2 is IMPOSSIBLE under client
// auth and, since multi-path updates are all-or-nothing, would fail entirely
// rather than partially land.
//
// This script therefore runs on the ADMIN SDK (Application Default Credentials),
// which bypasses rules. NO RULES CHANGE IS NEEDED OR WANTED — the create-only
// rule stops a till or an admin browser from silently repointing a barcode, and
// relaxing it for a one-off migration would weaken a live protection forever.
// The write-back probe proves the credential can do it BEFORE any stock moves.
//
// ── OPERATOR STEPS THIS SCRIPT DOES NOT PERFORM ──────────────────────────────
// 0a pause the engine   — set /receiving_session/active = true (refill-scan.cjs
//                         stands the engine down completely while it is true;
//                         refillHealthScan runs every 15 min regardless of shop
//                         hours, so a trading-hours freeze alone does NOT cover
//                         this). ASSERTED here, not set — pausing stays a
//                         conscious act.
// 0b drain in-flight    — resolve/cancel any open refill order for the product.
// 0c clear Display Check— the ACTIVE check is keyed {pid}__{size}; after the
//                         collapse new sales key {pid}___ and the old one can
//                         never be matched or completed again.
// 4  verify             — SCAN EVERY PHYSICAL LABEL at the till. The read-side
//                         checks are necessary but not sufficient; the scan is
//                         the only thing that proves the index repair worked.
// 5  resume             — /receiving_session/active = false.
//
// ── NEXT TARGET ──────────────────────────────────────────────────────────────
// p1780602531099 "Nike Pro Therma-FIT Hyperwarm Hood Grey Camo" — 201 units all
// in "M" on a six-size run. Same shape: change PID / NAME / FROM_SIZE / KEEP_CODE
// and re-derive the policy. Run the balaclava first; it is smaller and its result
// validates the procedure.
//
// Usage:  node scripts/collapse-one-size-balaclava.mjs
//         SNAPSHOT_PATH=/somewhere/rollback.json node scripts/collapse-one-size-balaclava.mjs
//
// The rollback snapshot is written OUTSIDE the repo by default (os.tmpdir()) and
// is regenerated on every run — it is a point-in-time artifact, never committed.

import { createRequire } from "module";
import { writeFileSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
// Pass Application Default Credentials EXPLICITLY. app.options.credential only
// reflects options actually handed to initializeApp, so relying on implicit ADC
// left the pre-flight assertion below reading a field that was never populated —
// it passed by coincidence, not because anything had been verified.
// (CodeRabbit, PR #284.)
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── target product + policy ──────────────────────────────────────────────────
const PID   = "p1780602630945";
const NAME  = "Nike Pro Hyperwarm Balaclava Black";
const FROM_SIZE = "L";                 // the size cell holding all the stock
const KEEP_CODE = "00008511";          // the L code owns the "_" slot: every physical label in the field is L,
                                       // so reprints reproduce the code already on the stock
// ONE AUTHORITATIVE SCOPE. Every location whose stock or locks are read must be
// in here, and every one of them is walked by the Step 1 movement plan and the
// pre-flight lock check. The first version read marathon-pe into `stock` but
// left it OUT of LOCS, so its units were excluded from the total and from the
// movement plan — nonzero stock there would have been silently orphaned the
// moment `sizes` became ["_"]. Its L cell happens to be 0 today; that is luck,
// not a guarantee, and the assertion below now makes the guarantee explicit.
// (CodeRabbit, PR #284.)
const LOCS  = ["central", "hub2", "marathon-pe", "marathon-pine"];
const POLICY = { "marathon-pe": { target: 25, reorderPoint: 5 }, hub2: { target: 20, reorderPoint: 5 } };
// EXCLUDE_SIZES is DERIVED from the captured target rows at run time, never
// hardcoded — the same lesson as LOCS: the data is the source of truth, not a
// list in this file. A hardcoded S/M/L would silently leave any other legacy
// size key (XL, 4XL, a typo'd key) alive in /stock_targets, pointing at a size
// the product no longer declares. Assigned in main() once targetsNow is read.
// (CodeRabbit, PR #284.)
let EXCLUDE_SIZES = [];
const EXPECTED_TOTAL = 188;            // asserted — a changed quantity must fail, not silently migrate

const APPLY = process.argv.includes("--apply");
const SNAP  = process.env.SNAPSHOT_PATH || join(tmpdir(), `rollback-${PID}-${Date.now()}.json`);
const NOW = new Date().toISOString();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

// A privileged (Admin SDK) credential is one that can mint its own access
// tokens — that is precisely what lets it bypass the /barcodes create-only rule.
// Exported shape kept trivial so it can be exercised against a stub app: a
// client-auth or credential-less app has no such object and this returns false.
// The WRITE-BACK PROBE further down remains the empirical proof; this assertion
// exists to fail EARLY and legibly when the script is run under the wrong auth.
export function hasPrivilegedCredential(app) {
  const c = app && app.options && app.options.credential;
  return !!c && typeof c.getAccessToken === "function";
}

const asserts = [];
const chk = (name, ok, detail) => { asserts.push({ name, ok, detail }); return ok; };

(async () => {
  console.log(`\n${"═".repeat(78)}\n  ONE-SIZE COLLAPSE — ${NAME}\n  mode: ${APPLY ? "APPLY REQUESTED (apply path is UNWIRED — will not write)" : "DRY RUN"}\n${"═".repeat(78)}`);

  const product = await g(`products/${PID}`);
  if (!product) { console.error(`ABORT: products/${PID} not found`); process.exit(1); }
  const codes = { ...(product.barcodes || {}) };
  const stock = {};
  for (const loc of LOCS) stock[loc] = (await g(`stock/${loc}/${PID}`)) || {};

  // ── rollback snapshot (captured BEFORE any assertion writes) ───────────────
  const idx = {};
  for (const code of Object.values(codes)) idx[code] = await g(`barcodes/${code}`);
  // WHOLE-TREE sweep, not Object.keys(POLICY). Target rows can exist at any
  // location with a targets tree — today that is hub2, marathon-pe AND trophy,
  // and trophy is in neither POLICY nor LOCS. A legacy S/M/L row there would be
  // invisible to EXCLUDE_SIZES, unflagged by the mirror, and left un-cleaned by
  // Step 3 — the third instance of the orphan class this file already fixed for
  // /stock and for Display Checks. Sweep the tree and let the data say where the
  // rows are. (CodeRabbit, PR #284.)
  const allTargets = (await g("stock_targets")) || {};
  const targetsNow = {};
  for (const loc of Object.keys(allTargets)) {
    const rows = allTargets[loc]?.[PID];
    if (rows) targetsNow[loc] = rows;
  }
  for (const loc of Object.keys(POLICY)) if (!(loc in targetsNow)) targetsNow[loc] = null;
  // Every non-"_" size key that actually exists under either policy location.
  EXCLUDE_SIZES = [...new Set(Object.values(targetsNow)
    .flatMap((bySize) => Object.keys(bySize || {}))
    .filter((k) => k !== "_"))].sort();

  const snapshot = {
    capturedAt: NOW, productId: PID, name: NAME,
    product: { sizes: product.sizes ?? null, barcodes: product.barcodes ?? null },
    barcodeIndex: idx, stockCells: stock, stockTargets: targetsNow,
  };

  // ── SNAPSHOT TO DISK *BEFORE* ANY WRITE ────────────────────────────────────
  // The pre-flight write-back probe below performs REAL .set() calls. The first
  // version kept the snapshot in memory until the end, so a probe failure, a
  // crash, or an unwritable SNAPSHOT_PATH left NO rollback artifact even though
  // writes had already happened. Nothing may be written anywhere until the
  // rollback record exists on disk AND has been read back. (CodeRabbit, PR #284.)
  writeFileSync(SNAP, JSON.stringify(snapshot, null, 2));
  let snapOk = false, snapDetail = "";
  try {
    const back = JSON.parse(readFileSync(SNAP, "utf8"));
    snapOk = back.productId === PID && !!back.barcodeIndex && !!back.stockCells;
    snapDetail = `${SNAP} (${statSync(SNAP).size} bytes, ${Object.keys(back.barcodeIndex || {}).length} index records)`;
  } catch (e) { snapDetail = `UNREADABLE: ${e.message}`; }
  if (!snapOk) {
    console.error(`\nABORT: rollback snapshot not on disk / not readable — ${snapDetail}`);
    console.error("No write of any kind has occurred. Fix SNAPSHOT_PATH and re-run.");
    process.exit(1);
  }

  // ── PRE-FLIGHT (step 0d) ───────────────────────────────────────────────────
  console.log("\n── PRE-FLIGHT ─────────────────────────────────────────────────────────────");
  chk("rollback snapshot on disk and read back BEFORE any write", snapOk, snapDetail);
  const credOk = hasPrivilegedCredential(admin.app());
  const cred = admin.app().options.credential;
  chk("credential is a privileged Admin SDK credential (rules bypassed)", credOk,
      credOk ? `${cred.constructor.name} (getAccessToken present)` : "NO privileged credential — running under client auth?");

  const session = await g("receiving_session");
  chk("0a engine paused (receiving_session.active === true)", session?.active === true,
      `receiving_session.active = ${JSON.stringify(session?.active)}`);

  // Locks are keyed by DESTINATION/product/size, so every location in scope must
  // be checked — not just the two the policy happens to target. A lock anywhere
  // means a pick may be in flight against a cell this migration is about to move.
  // LOCATION-AGNOSTIC, like every other tree in this file. LOCS is the wrong
  // scope here for the same reason it was wrong for Display Checks: locks are
  // keyed by refill DESTINATION, and trophy is a destination that appears in
  // neither POLICY nor LOCS. This assertion is the guard against migrating stock
  // out from under an in-flight pick — a lock it cannot see defeats its whole
  // purpose. Sweep the node and let the data say where the locks are.
  // (CodeRabbit, PR #284 — fourth and last tree to get this treatment.)
  const openLocks = (await g("refill_engine/open")) || {};
  const lockHits = [];
  for (const [loc, byPid] of Object.entries(openLocks)) {
    for (const sk of Object.keys(byPid?.[PID] || {})) lockHits.push(`${loc}/${sk}`);
  }
  chk(`0b no open refill locks at ANY location (${Object.keys(openLocks).length} scanned)`, lockHits.length === 0,
      lockHits.length ? lockHits.join(", ") : `none across ${Object.keys(openLocks).join(", ") || "(no locks anywhere)"}`);

  // TWO defects fixed here (CodeRabbit, PR #284 — the second was raised on the
  // FIRST review and went unaddressed through three rounds):
  //
  // 1. SEPARATOR. `startsWith(PID)` matches any product whose id merely begins
  //    with this one's, so an unrelated product could abort the migration. The
  //    documented key shape is {pid}__{sizeKey}; match the separator.
  //
  // 2. SCOPE. This read a single hardcoded location while every other pre-flight
  //    check was widened — the same single-location assumption the LOCS fix
  //    exists to kill. And LOCS is the WRONG scope to widen to: display checks
  //    live at TRIGGER STORES, not stock locations. Live counts today are
  //    marathon-pe 412 and trophy 288 — trophy is not in LOCS, so scanning LOCS
  //    would still have missed it. Walk whatever locations the node actually
  //    has: location-agnostic cannot miss one.
  const dcAll = (await g("displayChecks_active")) || {};
  const dcHits = [];
  for (const [loc, byKey] of Object.entries(dcAll)) {
    for (const k of Object.keys(byKey || {})) if (k.startsWith(`${PID}__`)) dcHits.push(`${loc}/${k}`);
  }
  chk(`0c no ACTIVE size-keyed Display Check at ANY location (${Object.keys(dcAll).length} scanned)`,
      dcHits.length === 0, dcHits.length ? dcHits.join(", ") : `none across ${Object.keys(dcAll).join(", ") || "(no active checks)"}`);

  chk("product still declares the expected size", JSON.stringify(product.sizes) === JSON.stringify([FROM_SIZE]),
      `sizes = ${JSON.stringify(product.sizes)}`);
  chk("all six barcode slots present", Object.keys(codes).length === 6, Object.keys(codes).sort().join(","));
  // Not "one of the codes" — it must be the code minted for the SIZE THAT HOLDS
  // THE STOCK, because every physical label in the field carries that one. Put a
  // different code in the "_" slot and reprints stop matching the stock.
  chk(`KEEP_CODE is the ${FROM_SIZE}-size barcode`, codes[FROM_SIZE] === KEEP_CODE,
      `codes.${FROM_SIZE}=${codes[FROM_SIZE]} vs KEEP_CODE=${KEEP_CODE}`);

  const idxOk = Object.values(codes).every((code) => idx[code] && idx[code].productId === PID);
  chk("every index record exists and points at this product", idxOk,
      Object.entries(codes).map(([s, c]) => `${s}:${c}→${idx[c]?.size ?? "(none)"}`).join("  "));

  // THE decisive probe — see header. Identical value in, re-read out.
  let probeOk = true; const probeDetail = [];
  for (const code of Object.values(codes)) {
    const before = idx[code]?.size;
    try {
      await db.ref(`barcodes/${code}/size`).set(before);
      const after = await g(`barcodes/${code}/size`);
      if (after !== before) { probeOk = false; probeDetail.push(`${code} CHANGED(${before}→${after})`); }
      else probeDetail.push(`${code}:ok`);
    } catch (e) { probeOk = false; probeDetail.push(`${code} DENIED(${e.code || e.message})`); }
  }
  chk("barcode index is WRITABLE (write-back probe, all codes)", probeOk, probeDetail.join(" "));

  const total = LOCS.reduce((t, l) => t + Math.max(stock[l]?.[FROM_SIZE]?.qty || 0, 0), 0);
  chk(`network total in size ${FROM_SIZE} = ${EXPECTED_TOTAL}`, total === EXPECTED_TOTAL,
      `${total} units across ${LOCS.join(", ")}`);

  // ORPHAN GUARD. The migration only moves cells the Step 1 plan walks, and the
  // plan only walks LOCS. Sweep the WHOLE /stock tree for this product+size and
  // fail loudly if any location holding units is outside that scope — otherwise
  // those units keep sitting in a size the product no longer declares, invisible
  // to the app and to the engine. This is the assertion that turns "we happened
  // to list the right locations" into a guarantee. (CodeRabbit, PR #284.)
  const allStock = (await g("stock")) || {};
  const holdersOutsideScope = Object.entries(allStock)
    .filter(([loc, byPid]) => !LOCS.includes(loc) && Math.max(byPid?.[PID]?.[FROM_SIZE]?.qty || 0, 0) > 0)
    .map(([loc, byPid]) => `${loc}:${byPid[PID][FROM_SIZE].qty}`);
  chk(`every location holding ${FROM_SIZE} units is inside the movement plan`, holdersOutsideScope.length === 0,
      holdersOutsideScope.length ? `ORPHANS WOULD BE LEFT AT ${holdersOutsideScope.join(", ")}` : `scope covers ${LOCS.join(", ")}`);

  // The plan-completeness mirror. It compares the plan (built from the per-location
  // `stock` reads) against the INDEPENDENT whole-tree read above — never against
  // `total`, which comes from the same object the plan does and would make this
  // tautological: `planned` is by construction the nonzero subset of LOCS, so
  // plannedTotal === total always. Only a second, independent read can fail.
  // (CodeRabbit, PR #284 — the same defect it caught in the exclusion mirror.)
  const planned = LOCS.filter((l) => Math.max(stock[l]?.[FROM_SIZE]?.qty || 0, 0) > 0);
  const plannedTotal = planned.reduce((t, l) => t + stock[l][FROM_SIZE].qty, 0);
  const freshNetworkTotal = Object.values(allStock)
    .reduce((t, byPid) => t + Math.max(byPid?.[PID]?.[FROM_SIZE]?.qty || 0, 0), 0);
  chk("Step 1 plan moves every unit the database currently holds", plannedTotal === freshNetworkTotal,
      `plan ${plannedTotal} vs live ${freshNetworkTotal} units, from ${planned.join(", ") || "(none)"}`);

  // Mirror of the orphan guard, and it must MIRROR IT PROPERLY: go back to the
  // database and ask. Deriving liveKeys from the same in-memory `targetsNow` that
  // produced EXCLUDE_SIZES made this tautological — identical transform, same
  // object, nothing re-read in between, so `unhandled` could never be non-empty.
  // It gave false assurance and could not catch a row added at a policy location
  // between snapshot capture and this check, nor a bug in the shared derivation.
  // The orphan guard above is the standard: it re-reads /stock in full.
  // (CodeRabbit, PR #284.)
  const allTargetsFresh = (await g("stock_targets")) || {};
  const targetsFresh = {};
  for (const loc of Object.keys(allTargetsFresh)) {
    const rows = allTargetsFresh[loc]?.[PID];
    if (rows) targetsFresh[loc] = rows;
  }
  const liveKeys = [...new Set(Object.values(targetsFresh).flatMap((b) => Object.keys(b || {})).filter((k) => k !== "_"))].sort();
  const unhandled = liveKeys.filter((k) => !EXCLUDE_SIZES.includes(k));
  chk("every non-\"_\" target key is covered by the exclusions", unhandled.length === 0,
      liveKeys.length ? `covering ${EXCLUDE_SIZES.join(",")}${unhandled.length ? ` — UNHANDLED: ${unhandled.join(",")}` : ""}` : "no legacy size rows exist");

  // Step 3 only WRITES at POLICY locations, so a legacy row anywhere else would
  // survive the migration pointing at a size the product no longer declares.
  // Same shape as the /stock orphan guard: sweep, then fail loudly.
  const targetOrphans = Object.entries(targetsFresh)
    .filter(([loc, rows]) => !Object.keys(POLICY).includes(loc) && Object.keys(rows || {}).some((k) => k !== "_"))
    .map(([loc, rows]) => `${loc}[${Object.keys(rows).filter((k) => k !== "_").join(",")}]`);
  chk("no target rows outside the locations Step 3 cleans", targetOrphans.length === 0,
      targetOrphans.length ? `UNCLEANED AT ${targetOrphans.join(" ")}` : `rows exist only at ${Object.keys(targetsFresh).join(", ") || "(none)"}`);

  const transfers = (await g("transfers")) || {};
  const tHits = Object.entries(transfers).filter(([, x]) => x && x.status !== "received" && JSON.stringify(x).includes(PID));
  chk("no OPEN transfer references this product", tHits.length === 0, tHits.map(([i]) => i).join(",") || "none");

  for (const a of asserts) console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.name.padEnd(52)} ${a.detail}`);
  const blocked = asserts.filter((a) => !a.ok);

  // ── WRITE PLAN ─────────────────────────────────────────────────────────────
  console.log(`\n── STEP 1 · migrate ${FROM_SIZE} → "_" (paired adjustments) ────────────────`);
  const step1 = [];
  for (const loc of LOCS) {
    const n = Math.max(stock[loc]?.[FROM_SIZE]?.qty || 0, 0);
    if (!n) { console.log(`  ${loc}: 0 units — skipped`); continue; }
    const haveUs = Math.max(stock[loc]?._?.qty || 0, 0);
    const base = { productId: PID, actor: "system:one-size-collapse", actorRole: "admin", ts: NOW, appliedAt: NOW };
    step1.push(
      { id: `onesize_${PID}_${loc}_out_${FROM_SIZE}`, mv: { ...base, type: "adjustment", size: FROM_SIZE, qty: n,
          from: loc, before: { [loc]: n }, after: { [loc]: 0 },
          reason: `Collapse to one-size: move size ${FROM_SIZE} → _` } },
      { id: `onesize_${PID}_${loc}_in_us`, mv: { ...base, type: "adjustment", size: "_", qty: n,
          to: loc, before: { [loc]: haveUs }, after: { [loc]: haveUs + n },
          reason: `Collapse to one-size: receive from size ${FROM_SIZE}` } },
    );
    console.log(`  ${loc.padEnd(14)} ${FROM_SIZE}: ${n} → 0   |   _: ${haveUs} → ${haveUs + n}`);
  }
  console.log(`  → ${step1.length} movements (${step1.length / 2} paired), ${total} units`);
  console.log("  ids (deterministic — a re-run is a no-op via applyMovement idempotency):");
  step1.forEach((m) => console.log(`     ${m.id}`));

  console.log("\n── STEP 2 · ONE atomic update (sizes + barcode index) ─────────────────────");
  const step2 = { [`products/${PID}/sizes`]: ["_"], [`products/${PID}/barcodes`]: { _: KEEP_CODE } };
  for (const code of Object.values(codes)) step2[`barcodes/${code}/size`] = "_";
  for (const [p, v] of Object.entries(step2)) console.log(`  ${p.padEnd(46)} = ${JSON.stringify(v)}`);
  console.log(`  → ${Object.keys(step2).length} paths, all-or-nothing`);

  console.log("\n── STEP 3 · target rows ───────────────────────────────────────────────────");
  const stamp = { source: "onesize_collapse_policy_v1", batchId: `collapse-${PID}`, approvedBy: "owner", approvedAt: NOW };
  const step3 = {};
  for (const [loc, pol] of Object.entries(POLICY)) {
    step3[`stock_targets/${loc}/${PID}/_`] = { target: pol.target, minQty: Math.ceil(pol.target / 2), reorderPoint: pol.reorderPoint, ...stamp };
    for (const s of EXCLUDE_SIZES) step3[`stock_targets/${loc}/${PID}/${s}`] = { target: 0, minQty: 0, ...stamp, source: "excluded" };
  }
  for (const [p, v] of Object.entries(step3)) console.log(`  ${p.padEnd(46)} = ${JSON.stringify(v)}`);

  // ── snapshot (already on disk — written before the pre-flight probe) ───────
  console.log(`\n── ROLLBACK SNAPSHOT ──────────────────────────────────────────────────────`);
  console.log(`  written BEFORE any write, verified readable: ${SNAP}`);
  console.log(`  captures: sizes, barcodes map, ${Object.keys(idx).length} index records, ${Object.keys(stock).length} stock cell groups, target rows`);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`  TOTAL WRITES PLANNED: ${step1.length} movements + ${step1.length} cell-updates + ${Object.keys(step2).length} paths + ${Object.keys(step3).length} target rows`);
  if (blocked.length) {
    console.log(`  ${blocked.length} PRE-FLIGHT ASSERTION(S) FAILED — would ABORT before any write:`);
    blocked.forEach((b) => console.log(`     - ${b.name} — ${b.detail}`));
  } else {
    console.log("  all pre-flight assertions pass");
  }
  if (APPLY) {
    console.log("\n  APPLY PATH IS UNWIRED BY DESIGN — nothing was written.");
    console.log("  Wire it deliberately before a scheduled run (see the header), then re-run");
    console.log("  this dry run first and confirm the plan is identical.");
  } else {
    // NOT "nothing written": the rollback snapshot was written to disk, and the
    // write-back probe performed six real (no-op, identical-value) writes to the
    // barcode index. Saying otherwise would be the kind of comfortable-but-false
    // claim this whole script exists to avoid. (CodeRabbit, PR #284.)
    console.log("  DRY RUN — no MIGRATION write performed.");
    console.log(`     what WAS written: the rollback snapshot (${SNAP}),`);
    console.log("     and the write-back probe re-wrote each barcode index size to its EXISTING");
    console.log("     value (verified unchanged). No stock, target, product or index CHANGE.");
  }
  process.exit(blocked.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
