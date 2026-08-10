// ─── HEADWEAR ONE-SIZE COLLAPSE — THE MIGRATION (dry-run by default) ─────────
//
// Collapses every legacy sized BEANIE and CAP to true one-size ["_"]:
//
//   STEP 1  stock: per location, PAIRED adjustment movements move each sized
//           cell's units into "_" — OUT from the sized cell, then IN to "_",
//           same qty, same timestamp, deterministic ids (see
//           scripts/lib/headwearCollapseCore.mjs for the id scheme and the
//           negative-cell mirror). One pair PER SIZE PER LOCATION, which is
//           what makes the cap case correct: 47 caps hold two or more sizes at
//           one location and their quantities genuinely sum (M 2 + L 3 + XL 1
//           → a single "_" cell of 6). applyMovement semantics refuse an
//           overdraw, so the OUT leg cannot go below zero. Interrupting here
//           is SAFE: stock splits across the sized cell and "_", sizes and
//           barcodes still agree, every unit stays sellable, and a re-run
//           completes the missing legs from the ledger.
//   STEP 2  identity: ONE atomic multi-path update per product — sizes ["_"],
//           barcodes map {"_": keepCode}, every index record's size "_".
//           Split across separate writes in any order and every scan for the
//           product breaks in the window; atomic means no window exists.
//           87 caps carry more than one barcode, so which code takes the "_"
//           slot is a real decision — see the keep-code rule in the core. The
//           codes that do not take it are NOT deleted and keep resolving to the
//           product through /barcodes; only their slot in the product's own map
//           goes, and a one-size product has only one slot.
//   STEP 3  explicit /stock_targets rows on retired sizes → target 0
//           ("deliberately excluded" in the engine's own vocabulary).
//           IT NEVER CREATES A ROW. Arming the refill policy is a separate,
//           owner-approved act (scripts/model-headwear-onesize-policy.mjs).
//
// DRY RUN BY DEFAULT — prints the complete per-product plan and writes NOTHING
// except the rollback snapshot. --execute performs the writes. Processes one
// product at a time with a fresh-read verification per product; resumable
// after interruption at any point (all writes are idempotent or ledger-derived).
//
// Scope: beanies (by name) and caps (by the Caps & Hats shelf, minus visors and
// bucket hats), never a mergedInto stub — the ONE exported predicate in
// scripts/lib/headwearCollapseCore.mjs, shared with the census and the probe so
// they cannot drift. Products already fully collapsed verify as no-ops.
//
// PER-PRODUCT GATES (a gated product is SKIPPED and reported, the run
// continues — nothing about product A blocks product B):
//   • an open order / transfer / refill request / engine lock / active Display
//     Check referencing the product with a real size — must clear first
//   • stock held in a size outside the declared list
//   • a broken barcode index (missing record / wrong productId)
// EXECUTE-ONLY GLOBAL GATE: /receiving_session/active === true (the refill
// engine stands down completely while it is true — a trading-hours freeze
// alone does NOT cover the 15-min health scan). Asserted, never set here:
// pausing the engine stays a conscious operator act.
//
// Usage:
//   node scripts/collapse-one-size-headwear.mjs                  # dry run
//   node scripts/collapse-one-size-headwear.mjs --execute        # real writes
//   node scripts/collapse-one-size-headwear.mjs --only=pid1,pid2 # scope filter
//   node scripts/collapse-one-size-headwear.mjs --kind=cap       # beanies only / caps only
//   SNAPSHOT_PATH=/somewhere/rollback.json ... (default: os tmpdir, run-stamped)
//
// Exit 0 = every in-scope product done (or already done) and verified.
// Exit 1 = at least one product gated/failed — re-run after clearing.

import { createRequire } from "module";
import { writeFileSync, readFileSync, statSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { setServerTimeOffsetMs, serverNowIso } from "../src/utils/serverTime.js";
import {
  applyMovementAdmin, planStep1, planStep2, step2Done, planStep3, verifyProduct,
  assertDrained, orderBlocks, transferBlocks, movementRecency, isInScope, headwearKind,
  isRetiredSize, isRetiredSizeKey,
} from "./lib/headwearCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const EXECUTE = process.argv.includes("--execute");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
// Beanies and caps are one migration but two very different risk profiles — the
// beanie half is 134 products that mostly need identity only, the cap half has
// the real arithmetic. --kind lets the operator run them as separate passes on
// separate days without hand-listing 167 product ids into --only.
const KIND = (process.argv.find((a) => a.startsWith("--kind=")) || "").slice(7).trim();
if (KIND && KIND !== "beanie" && KIND !== "cap") {
  console.error(`--kind must be "beanie" or "cap" (got ${JSON.stringify(KIND)})`);
  process.exit(1);
}
const SNAP = process.env.SNAPSHOT_PATH || join(tmpdir(), `rollback-headwear-collapse-${Date.now()}.json`);

const io = {
  read: (p) => db.ref(p).once("value").then((s) => s.val()),
  update: (u) => db.ref().update(u),
};

// A product that moved this recently is in active use at a till — skip it.
const RECENT_ACTIVITY_MS = Number(process.env.RECENT_ACTIVITY_MINUTES || 15) * 60 * 1000;

// Set once the execute-run lock is taken; called on every exit path.
let releaseLock = null;

// Same credential assertion as the pre-flight probe — fail early and legibly.
function hasPrivilegedCredential(app) {
  const c = app && app.options && app.options.credential;
  return !!c && typeof c.getAccessToken === "function";
}


(async () => {
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR ONE-SIZE COLLAPSE — mode: ${EXECUTE ? "EXECUTE (REAL WRITES)" : "DRY RUN"}\n${"═".repeat(78)}`);

  if (!hasPrivilegedCredential(admin.app())) {
    console.error("ABORT: not a privileged Admin SDK credential — Step 2 (rewriting existing");
    console.error("/barcodes/{code}/size records) is create-only under client auth and would fail.");
    process.exit(1);
  }
  console.log(`  credential: ${admin.app().options.credential.constructor.name} (privileged)`);

  // The repo's server-time anchor: push RTDB's measured offset into the same
  // module the app itself stamps timestamps with. Device clock stays irrelevant.
  const offset = (await io.read(".info/serverTimeOffset")) || 0;
  setServerTimeOffsetMs(offset);
  const nowIso = serverNowIso();
  const nowMs0 = Date.parse(nowIso);
  console.log(`  server time anchor: offset ${offset}ms → ${nowIso}`);

  const [products, stock, allTargets, barcodesIdx, transfers, orders, refillRequests, openLocks, dcActive, session, movements] =
    await Promise.all([
      io.read("products"), io.read("stock"), io.read("stock_targets"), io.read("barcodes"),
      io.read("transfers"), io.read("orders"), io.read("refill_requests"),
      io.read("refill_engine/open"), io.read("displayChecks_active"), io.read("receiving_session"),
      io.read("stock_movements"),
    ]).then((r) => r.map((v) => v || {}));

  // productId → most recent movement instant (and a count of unreadable stamps)
  // for the recent-activity gate — see movementRecency for why the unreadable
  // case must block rather than read as quiet.
  const { lastMs: lastMovementMs0, unreadable: unreadableStamp0 } = movementRecency(movements, { nowMs: nowMs0 });

  // ── scope ──────────────────────────────────────────────────────────────────
  let scope = Object.entries(products)
    .filter(([, p]) => isInScope(p))
    .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
  if (KIND) scope = scope.filter(([, p]) => headwearKind(p) === KIND);
  if (ONLY.length) scope = scope.filter(([pid]) => ONLY.includes(pid));
  const pidSet = new Set(scope.map(([pid]) => pid));
  const kindCount = { beanie: 0, cap: 0 };
  for (const [, p] of scope) kindCount[headwearKind(p)]++;
  console.log(`  scope: ${scope.length} headwear products (${kindCount.beanie} beanies, ${kindCount.cap} caps)`
    + `${KIND ? ` — --kind=${KIND}` : ""}${ONLY.length ? ` — --only filter from ${ONLY.length} asked` : ""}`);

  // reverse index: code → record, per pid (catches codes the product map forgot)
  const reverseIdx = {};
  for (const [code, rec] of Object.entries(barcodesIdx)) {
    if (rec && pidSet.has(rec.productId)) (reverseIdx[rec.productId] = reverseIdx[rec.productId] || {})[code] = rec;
  }

  // network totals BEFORE, across scope — the number the end of the run must reproduce
  const totalsBefore = {};
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const pid of pidSet) {
      for (const cell of Object.values(byPid?.[pid] || {})) {
        totalsBefore[loc] = (totalsBefore[loc] || 0) + (typeof cell?.qty === "number" ? cell.qty : 0);
      }
    }
  }
  console.log(`  units before: ${Object.entries(totalsBefore).sort().map(([l, q]) => `${l}=${q}`).join("  ")}  total=${Object.values(totalsBefore).reduce((a, b) => a + b, 0)}`);

  // ── rollback snapshot ON DISK before ANY write (balaclava standard) ────────
  // RUN ID + the ids this run actually writes. The rollback must be able to
  // tell THIS run's movements from those of any other run of the same script:
  // a prefix match on "onesize_" cannot, and a stale snapshot would then roll
  // back over a later, genuinely-completed migration without a warning (the
  // multi-pass workflow over gated products produces exactly that situation).
  // The snapshot file is rewritten at the end of the run with the applied ids.
  // (Sonnet review of the rollback, PR #343.)
  const RUN_ID = `${nowIso}__${process.pid}`;
  const appliedMovementIds = [];
  const snapshot = { capturedAt: nowIso, runId: RUN_ID, mode: EXECUTE ? "execute" : "dry-run",
    appliedMovementIds, products: {}, barcodeIndex: {}, stockCells: {}, stockTargets: {} };
  for (const [pid, p] of scope) {
    snapshot.products[pid] = { sizes: p.sizes ?? null, barcodes: p.barcodes ?? null };
    for (const code of new Set([...Object.values(p.barcodes || {}).map(String), ...Object.keys(reverseIdx[pid] || {})])) {
      snapshot.barcodeIndex[code] = barcodesIdx[code] ?? null;
    }
    for (const [loc, byPid] of Object.entries(stock)) if (byPid?.[pid]) (snapshot.stockCells[loc] = snapshot.stockCells[loc] || {})[pid] = byPid[pid];
    for (const [loc, byPid] of Object.entries(allTargets)) if (byPid?.[pid]) (snapshot.stockTargets[loc] = snapshot.stockTargets[loc] || {})[pid] = byPid[pid];
  }
  writeFileSync(SNAP, JSON.stringify(snapshot, null, 2));
  try {
    const back = JSON.parse(readFileSync(SNAP, "utf8"));
    if (!back.products || Object.keys(back.products).length !== scope.length) throw new Error("snapshot incomplete");
    console.log(`  rollback snapshot: ${SNAP} (${statSync(SNAP).size} bytes, ${Object.keys(back.products).length} products)`);
  } catch (e) {
    console.error(`ABORT: rollback snapshot unreadable — ${e.message}. Nothing has been written.`);
    process.exit(1);
  }

  // ── EXECUTE-ONLY: THE ENGINE MUST BE PAUSED ───────────────────────────────
  // Checked BEFORE the run lock is taken. Taking the lock first meant that the
  // most likely operator mistake — running while the engine is still live —
  // aborted with the lock held, and every subsequent run then aborted on a
  // stale lock until it was cleared by hand. A gate that punishes the expected
  // mistake with a second, unrelated failure is a worse gate. (Kimi review of
  // the lock delta, PR #343.)
  if (EXECUTE && session?.active !== true) {
    console.error(`\nABORT: refill engine is NOT paused (receiving_session.active = ${JSON.stringify(session?.active)}).`);
    console.error("Set /receiving_session/active = true first — the health scan runs every 15 min");
    console.error("regardless of shop hours, so a trading-hours freeze alone does not cover this.");
    console.error("(No run lock was taken, so nothing needs clearing before you retry.)");
    process.exit(1);
  }
  if (!EXECUTE) console.log(`  engine paused: ${session?.active === true ? "yes" : "NO (must be true at execute time)"}`);

  // ── EXECUTE-ONLY: ONE RUN AT A TIME ───────────────────────────────────────
  // Two overlapping --execute processes are the one way this migration can
  // double-apply a positive leg: both read the ledger, neither sees the other's
  // movement yet, and the IN leg into "_" has no negative floor to refuse the
  // second write — 6 units could land 12, with the single ledger record
  // overwritten so nothing records that it happened twice. The in-loop
  // idempotency re-check narrows it; this closes it, because there is never a
  // second process. (Sonnet re-review, PR #343.)
  //
  // The lock lives in RTDB, not on disk: two runs on different machines still
  // hit the same database. A stale lock (a crashed run) is reported with its
  // age and can be cleared deliberately — never auto-stolen, because "the other
  // run looks old" is exactly the reasoning that produces a double-apply.
  // ACQUIRED BY TRANSACTION, not read-then-write. A read followed by a write is
  // the very TOCTOU this lock exists to close: two processes could both read it
  // as free and both write it, last-writer-wins, and both proceed. RTDB's
  // single-path transaction is a real compare-and-set and is exactly the right
  // primitive here — Step 2 needs a multi-path update and so cannot use one,
  // but a lock is one path. (Kimi review of the lock delta, PR #343.)
  const LOCK = "_migrations/headwearOneSizeCollapse/runLock";
  let lockHeld = false;
  if (EXECUTE) {
    const mine = { startedAt: nowIso, pid: process.pid, host: hostname(), releasedAt: null };
    const { committed, snapshot } = await db.ref(LOCK).transaction((cur) => {
      if (cur && cur.releasedAt == null) return;         // abort: someone holds it
      return mine;
    });
    if (!committed) {
      const held = snapshot.val() || {};
      const started = Date.parse(held.startedAt);
      const age = Number.isFinite(started) ? `${Math.round((nowMs0 - started) / 60000)} min ago` : "at an unreadable time";
      console.error(`\nABORT: another --execute run holds the lock (pid ${held.pid} on ${held.host}, started ${held.startedAt}, ${age}).`);
      console.error("Two concurrent runs can double-apply a positive movement leg. If that run");
      console.error(`crashed, clear the lock deliberately once you are sure it is dead:\n  firebase database:remove /${LOCK} --project marathon-club`);
      process.exit(1);
    }
    lockHeld = true;
    const release = async () => {
      if (!lockHeld) return;
      lockHeld = false;
      try { await io.update({ [`${LOCK}/releasedAt`]: new Date().toISOString() }); } catch { /* best effort */ }
    };
    process.on("exit", () => { if (lockHeld) console.error(`\n⚠ run lock still held — clear it: firebase database:remove /${LOCK} --project marathon-club`); });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await release(); process.exit(130); });
    releaseLock = release;
  }

  // ── BOUNDED-STALENESS GATE DATA ────────────────────────────────────────────
  // The referential trees (orders, transfers, refill requests, engine locks,
  // Display Checks) were read once before the loop. A run over ~90 products is
  // not instantaneous, so an order or request opened after that read but before
  // its product's turn was invisible to the gate — the same staleness class the
  // fresh per-product cell read closed for /stock. (Sonnet review, PR #343.)
  //
  // Re-reading all of them per product would mean ~134 × (2.4k orders + 12k
  // requests) of reads for a one-off script; refreshing when the snapshot is
  // older than a bounded age gets the same guarantee at a sane cost. The
  // exposure drops from "the whole run" to at most GATE_MAX_AGE_MS, and the
  // recent-activity gate covers the tail.
  const GATE_MAX_AGE_MS = Number(process.env.GATE_MAX_AGE_SECONDS || 60) * 1000;
  //
  // THE LEDGER IS REFRESHED WITH THEM, and the clock with it. The recent-
  // activity gate asks "is this product being sold RIGHT NOW", and it was the
  // only input still answering from the startup snapshot against a frozen
  // `nowMs`. Over a run measured in tens of minutes that turns a sliding
  // 15-minute window into a fixed slice of the run's first 15 minutes: a
  // product sold at minute 30 read as quiet when its turn came at minute 90.
  // The gate designed to stop a race with a till was the stalest thing in the
  // loop. (Both independent reviews, PR #345.)
  let gateData = { transfers, orders, refillRequests, openLocks, dcActive,
    lastMovementMs: lastMovementMs0, unreadableStamp: unreadableStamp0, nowMs: nowMs0 };
  let gateReadAt = Date.now();
  let gateRefreshes = 0;
  const freshGates = async () => {
    if (Date.now() - gateReadAt < GATE_MAX_AGE_MS) return gateData;
    const [t, o, rr, ol, dc, mv] = await Promise.all([
      io.read("transfers"), io.read("orders"), io.read("refill_requests"),
      io.read("refill_engine/open"), io.read("displayChecks_active"),
      io.read("stock_movements"),
    ]).then((r) => r.map((v) => v || {}));
    const nowMsFresh = Date.now() + offset;
    const { lastMs, unreadable } = movementRecency(mv, { nowMs: nowMsFresh });
    gateData = { transfers: t, orders: o, refillRequests: rr, openLocks: ol, dcActive: dc,
      lastMovementMs: lastMs, unreadableStamp: unreadable, nowMs: nowMsFresh };
    gateReadAt = Date.now();
    gateRefreshes++;
    return gateData;
  };

  // Run-wide "before" baseline, accumulated from the per-product FRESH reads
  // (not the startup snapshot) — the denominator of the final network proof.
  const baselineFresh = {};
  const baselinePids = new Set();

  // ── per-product ────────────────────────────────────────────────────────────
  const results = [];
  for (const [pid, pStart] of scope) {
    const gates_ = await freshGates();
    const { transfers: transfersNow, orders: ordersNow, refillRequests: refillRequestsNow,
      openLocks: openLocksNow, dcActive: dcActiveNow,
      lastMovementMs, unreadableStamp, nowMs } = gates_;
    // ── EVERYTHING THIS PRODUCT'S DECISIONS REST ON IS RE-READ HERE ─────────
    // The startup snapshot is minutes old by the 60th product and over an hour
    // old by the last, and Step 2 FORCE-WRITES barcodes/{code}/size for every
    // code the snapshot listed. Two consequences, both found by review of #345:
    //
    //   • a code reassigned to another product mid-run (a re-tag, a merge)
    //     still passes the ownership gate on the stale record, and Step 2 then
    //     stamps size "_" onto a record that now belongs to SOMEONE ELSE —
    //     corrupting a product this run was never asked to touch. verifyProduct
    //     would eventually notice, but only as a cryptic line under THIS
    //     product's failure, naming neither the victim nor the damage.
    //   • the undeclared-size gate and the keep-code ranking were computed from
    //     stale cells while the plan itself used fresh ones, so a cell that
    //     appeared in an undeclared size after startup was drained without ever
    //     being gated, and the code that won the "_" slot could differ from the
    //     one the dry run printed.
    //
    // So the product record, its cells and its index records are all re-read
    // immediately before its own gates and plan. This is the same bounded-
    // staleness reasoning freshGates applies to the referential trees; it was
    // simply never extended to the data being WRITTEN.
    const p = (await io.read(`products/${pid}`)) || pStart;
    const name = p.name || pid;
    const freshCells = {};
    for (const loc of Object.keys(stock)) {
      const bySize = await io.read(`stock/${loc}/${pid}`);
      if (bySize) freshCells[loc] = bySize;
    }
    const indexCodes = {};
    for (const code of new Set([
      ...Object.keys(reverseIdx[pid] || {}),
      ...Object.values(p.barcodes || {}).map(String),
    ])) {
      indexCodes[code] = await io.read(`barcodes/${code}`);
    }

    // gates
    const gates = [];
    if (!isInScope(p)) gates.push(`no longer in headwear scope (renamed, re-filed or merged since the run started): ${JSON.stringify(p.name)} / ${JSON.stringify(p.subcategory)}`);
    for (const [code, rec] of Object.entries(indexCodes)) {
      if (!rec) gates.push(`barcode ${code}: no index record`);
      else if (rec.productId !== pid) gates.push(`barcode ${code}: index now points at ${rec.productId} — reassigned since this run started; writing it would corrupt that product`);
    }
    const cellsByLoc = freshCells;
    const declared = (p.sizes || []).map(String);
    // Units per SIZE KEY, summed across every location — the input to the
    // keep-code rule. It was a LIST of keys when every beanie held one size and
    // the rule only needed "which size has stock"; caps hold several at once and
    // the rule now asks "which size has the MOST", so the quantities have to
    // survive the trip. A list would have made the choice depend on iteration
    // order across locations.
    const heldUnits = {};
    for (const [loc, bySize] of Object.entries(cellsByLoc)) {
      for (const [sizeKey, cell] of Object.entries(bySize)) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        if (q !== 0) {
          heldUnits[sizeKey] = (heldUnits[sizeKey] || 0) + q;
          if (isRetiredSizeKey(sizeKey) && !declared.includes(sizeKey)) gates.push(`holds ${q} in undeclared size ${loc}/${sizeKey}`);
        }
      }
    }
    // Any not-yet-received transfer carrying this product in a real size still
    // has a receive leg ahead of it that would credit the retired key.
    for (const [tid, t] of Object.entries(transfersNow)) {
      const why = transferBlocks(t, pid);
      if (why) gates.push(`${why} [${tid}]`);
    }
    for (const [oid, o] of Object.entries(ordersNow)) {
      // id LAST: a record carrying its own id must not shadow the node key it
      // is actually stored under. (Kimi review, PR #343.)
      const why = orderBlocks(o && { ...o, id: o.id || oid }, pid, nowMs);
      if (why) gates.push(why);
    }
    // RECENT ACTIVITY. The engine is paused at execute time, but the tills are
    // not — and a sale landing mid-product is the one concurrency case the
    // version re-check narrows without eliminating. If this product moved in
    // the last window, it is in active use right now: skip it and say so
    // rather than race it. (Kimi review, PR #343.)
    const lastMove = lastMovementMs.get(pid);
    if (lastMove && nowMs - lastMove < RECENT_ACTIVITY_MS) {
      gates.push(`moved ${Math.round((nowMs - lastMove) / 60000)} min ago (${new Date(lastMove).toISOString()}) — active at a till; re-run when it is quiet`);
    }
    const unreadable = unreadableStamp.get(pid);
    if (unreadable?.length) {
      gates.push(`${unreadable.length} recent ledger movement(s) have an unreadable timestamp (${unreadable.slice(0, 3).join(", ")}${unreadable.length > 3 ? ", …" : ""}) — cannot prove this product is quiet, so it is not migrated`);
    }
    for (const [rid, r] of Object.entries(refillRequestsNow)) {
      if (r && r.status === "open" && r.productId === pid && isRetiredSize(r.size)) gates.push(`open refill request ${rid} (size ${r.size})`);
    }
    for (const [loc, byPid] of Object.entries(openLocksNow)) {
      for (const sk of Object.keys(byPid?.[pid] || {})) if (sk !== "_") gates.push(`engine lock ${loc}/${sk}`);
    }
    for (const [loc, byKey] of Object.entries(dcActiveNow)) {
      for (const k of Object.keys(byKey || {})) if (k.startsWith(`${pid}__`) && !k.endsWith("___")) gates.push(`active display check ${loc}/${k}`);
    }
    if (gates.length) {
      results.push({ pid, name, status: "GATED", detail: gates });
      continue;
    }

    // PLAN FROM A FRESH READ, NOT THE STARTUP SNAPSHOT. The whole-tree read at
    // the top is minutes old by the time the 60th product is processed; planning
    // a movement quantity from it means moving a number that was true then. A
    // stale OUT that is too large is refused as an overdraw (safe but a failed
    // product); one that is too small leaves units behind in a size the product
    // is about to stop declaring. Re-read this product's cells immediately
    // before planning, and derive the before-totals from the same fresh read so
    // the verification compares like with like. (Kimi review, PR #343.)
    const step1 = await planStep1(io, pid, declared, freshCells);
    const s2 = planStep2(pid, p, indexCodes, heldUnits);
    if (s2.error) { results.push({ pid, name, status: "GATED", detail: [s2.error] }); continue; }
    const targetRows = {};
    for (const [loc, byPid] of Object.entries(allTargets)) if (byPid?.[pid]) targetRows[loc] = byPid[pid];
    const step3 = planStep3(pid, targetRows, nowIso);
    const s2Needed = !step2Done(p, indexCodes, s2.keepCode);

    if (!EXECUTE) {
      // A planned leg whose movement id ALREADY exists will no-op — it moves
      // nothing. On a first run that never happens; on a resume it means stock
      // arrived in a size whose pair has already been spent, and the execute
      // path will refuse to collapse this product. Say so in the plan rather
      // than printing it like an ordinary pair. (Sonnet review, PR #343.)
      // planStep1 no longer emits a leg whose id is already spent — such stock
      // comes back as a `stranded` plan with no legs instead, because planning
      // it would either no-op (losing it) or half-apply (minting). Both are
      // printed: the legs that will run, and the stock that will not move.
      const legLines = [];
      for (const pl of step1) {
        if (pl.kind === "stranded") { legLines.push(`⚠ STRANDED — ${pl.note}`); continue; }
        for (const l of pl.legs) {
          legLines.push(`${l.id} (${l.movement.from ? "OUT " + l.movement.from : "IN " + l.movement.to} ${l.movement.size} qty ${l.movement.qty}${l.movement.allowNegative ? " allowNegative" : ""})${pl.kind.startsWith("resume") ? "  ↩ RESUME — completing a pair an earlier run left half-applied, at the LEDGER's quantity" : ""}`);
        }
      }
      results.push({ pid, name, status: (step1.length || s2Needed || Object.keys(step3).length) ? "PLANNED" : "ALREADY DONE", detail: [
        ...legLines,
        s2Needed ? `step2 atomic ×${Object.keys(s2.updates).length} paths — "_" slot ← ${s2.keepCode} (${s2.rule})` : "step2: already collapsed",
        ...(s2.droppedCodes.length ? [`${s2.droppedCodes.length} other code(s) keep resolving to this product at size "_" but lose their map slot: ${s2.droppedCodes.join(", ")}`] : []),
        ...(Object.keys(step3).length ? [`step3 retire ${Object.keys(step3).length} target rows`] : []),
      ] });
      continue;
    }

    // execute — before-totals from the SAME fresh read the plan was built from,
    // and accumulated into the run-wide baseline so the final network proof
    // compares fresh against fresh. The startup snapshot is minutes old by the
    // last product, and the tills are not paused by receiving_session, so
    // measuring against it would report a legitimate sale as a migration loss
    // (and could hide a real one). (CodeRabbit, PR #343.)
    const totalsBeforeProduct = {};
    for (const [loc, bySize] of Object.entries(freshCells)) {
      const sum = Object.values(bySize).reduce((t, c) => t + (typeof c?.qty === "number" ? c.qty : 0), 0);
      totalsBeforeProduct[loc] = sum;
      baselineFresh[loc] = (baselineFresh[loc] || 0) + sum;
      baselinePids.add(pid);
    }
    let failed = null;
    const strandedPlans = step1.filter((pl) => pl.kind === "stranded");
    for (const pl of step1) {
      for (const leg of pl.legs) {
        const r = await applyMovementAdmin(io, { ...leg.movement, ts: nowIso }, { nowIso });
        if (!r.ok) { failed = `${leg.id}: ${r.reason}${r.available != null ? ` (available ${r.available}, requested ${r.requested})` : ""}`; break; }
        // Only ids THIS run actually applied — an idempotent no-op means the id
        // belongs to an earlier run and must NOT be excluded from that run's
        // rollback activity check.
        if (!r.idempotent) appliedMovementIds.push(r.movementId);
      }
      if (failed) break;
    }
    // STEP 2'S PRECONDITION, ON FRESH READS. Step 1 reporting success is not
    // proof the cells are empty — an already-landed movement id no-ops without
    // moving anything, so stock that arrived in a still-declared size between
    // runs would be stranded the instant identity collapses. Ask the database.
    // (Sonnet review, PR #343 — reproduced end to end.)
    // A stranded cell cannot be moved by this run and MUST NOT be collapsed
    // over. assertDrained would catch it a moment later anyway; naming it here
    // gives the operator the instruction instead of just the symptom.
    if (!failed && strandedPlans.length) {
      failed = strandedPlans.map((pl) => pl.note).join("  |  ");
    }
    if (!failed) {
      const residue = await assertDrained(io, pid);
      if (residue.length) {
        failed = `step1 did not drain: ${residue.join(", ")} — stock arrived in a size about to be retired; identity NOT collapsed. Move it to "_" (or clear it) and re-run.`;
      }
    }
    if (!failed && s2Needed) {
      try { await io.update(s2.updates); } catch (e) { failed = `step2: ${e.message}`; }
    }
    if (!failed && Object.keys(step3).length) {
      try { await io.update(step3); } catch (e) { failed = `step3: ${e.message}`; }
    }
    if (failed) { results.push({ pid, name, status: "FAILED", detail: [failed] }); continue; }

    const problems = await verifyProduct(io, pid, s2.keepCode, s2.codes, totalsBeforeProduct);
    results.push(problems.length
      ? { pid, name, status: "VERIFY-FAILED", detail: problems }
      : { pid, name, status: "DONE", detail: [
        `"_" slot ← ${s2.keepCode} (${s2.rule})${s2.droppedCodes.length ? `; ${s2.droppedCodes.length} other code(s) still resolve here: ${s2.droppedCodes.join(", ")}` : ""}`,
        `${step1.length} cell merges, ${Object.keys(step3).length} target rows retired`] });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const byStatus = {};
  for (const r of results) (byStatus[r.status] = byStatus[r.status] || []).push(r);
  console.log("");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(13)} ${r.pid} "${r.name}"`);
    for (const d of r.detail) console.log(`     ${d}`);
  }
  if (gateRefreshes) console.log(`  gate data refreshed ${gateRefreshes}× during the run (max age ${GATE_MAX_AGE_MS / 1000}s)`);
  console.log(`\n  SUMMARY: ${Object.entries(byStatus).map(([s, l]) => `${s}=${l.length}`).join("  ")}`);
  // Machine-readable twin of the same run — the operator report and the
  // clear-first worklist are built from this, not from scraping stdout.
  const REPORT = process.env.REPORT_JSON || join(tmpdir(), `headwear-collapse-${EXECUTE ? "execute" : "dryrun"}-${Date.now()}.json`);
  writeFileSync(REPORT, JSON.stringify({ ranAt: nowIso, mode: EXECUTE ? "execute" : "dry-run", scope: scope.length, totalsBefore, baselineFresh, results }, null, 2));
  console.log(`  JSON report: ${REPORT}`);

  if (EXECUTE) {
    // Final proof: network totals must be unchanged for the products this run
    // actually touched, measured against the fresh per-product baselines.
    const stockAfter = (await io.read("stock")) || {};
    const totalsAfter = {};
    for (const [loc, byPid] of Object.entries(stockAfter)) {
      for (const pid of baselinePids) {
        for (const cell of Object.values(byPid?.[pid] || {})) {
          totalsAfter[loc] = (totalsAfter[loc] || 0) + (typeof cell?.qty === "number" ? cell.qty : 0);
        }
      }
    }
    const locs = new Set([...Object.keys(baselineFresh), ...Object.keys(totalsAfter)]);
    let totalsOk = true;
    for (const loc of locs) {
      const b = baselineFresh[loc] || 0, a = totalsAfter[loc] || 0;
      if (b !== a) { totalsOk = false; console.log(`  TOTALS MISMATCH ${loc}: ${b} → ${a}`); }
    }
    console.log(`  network totals for the ${baselinePids.size} products this run touched ${totalsOk ? "UNCHANGED" : "CHANGED — investigate before anything else"}: ${Object.entries(totalsAfter).sort().map(([l, q]) => `${l}=${q}`).join("  ")}`);
    console.log(`  (measured against the fresh per-product baselines, not the startup snapshot)`);
    if (!totalsOk) { await releaseLock?.(); process.exit(1); }
  } else {
    console.log("  DRY RUN — nothing written except the rollback snapshot above.");
  }
  if (EXECUTE) {
    // Rewrite the snapshot so it carries the ids this run applied. Written last
    // because the list is only complete now; the ORIGINAL pre-write capture is
    // untouched — only this field is added to it.
    writeFileSync(SNAP, JSON.stringify({ ...snapshot, appliedMovementIds, completedAt: new Date().toISOString() }, null, 2));
    console.log(`  snapshot updated with ${appliedMovementIds.length} applied movement id(s): ${SNAP}`);
  }
  await releaseLock?.();
  const bad = results.filter((r) => r.status !== "DONE" && r.status !== "ALREADY DONE" && r.status !== "PLANNED");
  process.exit(bad.length ? 1 : 0);
})().catch(async (e) => { console.error(e); await releaseLock?.(); process.exit(1); });
