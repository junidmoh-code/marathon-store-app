// ─── BEANIE ONE-SIZE COLLAPSE — COMMIT 3: THE MIGRATION (dry-run by default) ──
//
// Collapses every legacy sized beanie (["M"] / ["S"]) to true one-size ["_"]:
//
//   STEP 1  stock: per location, PAIRED adjustment movements move each sized
//           cell's units into "_" — OUT from the sized cell, then IN to "_",
//           same qty, same timestamp, deterministic ids (see
//           scripts/lib/beanieCollapseCore.mjs for the id scheme and the
//           negative-cell mirror). applyMovement semantics refuse an
//           overdraw, so the OUT leg cannot go below zero. Interrupting here
//           is SAFE: stock splits across the sized cell and "_", sizes and
//           barcodes still agree, every unit stays sellable, and a re-run
//           completes the missing legs from the ledger.
//   STEP 2  identity: ONE atomic multi-path update per product — sizes ["_"],
//           barcodes map {"_": keepCode}, every index record's size "_".
//           Split across separate writes in any order and every scan for the
//           product breaks in the window; atomic means no window exists.
//   STEP 3  explicit /stock_targets rows on retired sizes → target 0
//           ("deliberately excluded" in the engine's own vocabulary).
//
// DRY RUN BY DEFAULT — prints the complete per-product plan and writes NOTHING
// except the rollback snapshot. --execute performs the writes. Processes one
// product at a time with a fresh-read verification per product; resumable
// after interruption at any point (all writes are idempotent or ledger-derived).
//
// Scope: /beanie/i name match, not a mergedInto stub — the census rule
// (scripts/beanie-census.mjs). Caps share the subcategory and are NEVER in
// scope. Products already fully collapsed verify as no-ops.
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
//   node scripts/collapse-one-size-beanies.mjs                  # dry run
//   node scripts/collapse-one-size-beanies.mjs --execute        # real writes
//   node scripts/collapse-one-size-beanies.mjs --only=pid1,pid2 # scope filter
//   SNAPSHOT_PATH=/somewhere/rollback.json ... (default: os tmpdir, run-stamped)
//
// Exit 0 = every in-scope product done (or already done) and verified.
// Exit 1 = at least one product gated/failed — re-run after clearing.

import { createRequire } from "module";
import { writeFileSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setServerTimeOffsetMs, serverNowIso } from "../src/utils/serverTime.js";
import {
  applyMovementAdmin, planStep1, planStep2, step2Done, planStep3, verifyProduct,
  orderBlocks, isInScope, REAL_SIZE,
} from "./lib/beanieCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const EXECUTE = process.argv.includes("--execute");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const SNAP = process.env.SNAPSHOT_PATH || join(tmpdir(), `rollback-beanie-collapse-${Date.now()}.json`);

const io = {
  read: (p) => db.ref(p).once("value").then((s) => s.val()),
  update: (u) => db.ref().update(u),
};

// Same credential assertion as the pre-flight probe — fail early and legibly.
function hasPrivilegedCredential(app) {
  const c = app && app.options && app.options.credential;
  return !!c && typeof c.getAccessToken === "function";
}


(async () => {
  console.log(`\n${"═".repeat(78)}\n  BEANIE ONE-SIZE COLLAPSE — mode: ${EXECUTE ? "EXECUTE (REAL WRITES)" : "DRY RUN"}\n${"═".repeat(78)}`);

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
  const nowMs = Date.parse(nowIso);
  console.log(`  server time anchor: offset ${offset}ms → ${nowIso}`);

  const [products, stock, allTargets, barcodesIdx, transfers, orders, refillRequests, openLocks, dcActive, session] =
    await Promise.all([
      io.read("products"), io.read("stock"), io.read("stock_targets"), io.read("barcodes"),
      io.read("transfers"), io.read("orders"), io.read("refill_requests"),
      io.read("refill_engine/open"), io.read("displayChecks_active"), io.read("receiving_session"),
    ]).then((r) => r.map((v) => v || {}));

  // ── scope ──────────────────────────────────────────────────────────────────
  let scope = Object.entries(products)
    .filter(([, p]) => isInScope(p))
    .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
  if (ONLY.length) scope = scope.filter(([pid]) => ONLY.includes(pid));
  const pidSet = new Set(scope.map(([pid]) => pid));
  console.log(`  scope: ${scope.length} beanies${ONLY.length ? ` (--only filter from ${ONLY.length} asked)` : ""}`);

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
  const snapshot = { capturedAt: nowIso, mode: EXECUTE ? "execute" : "dry-run", products: {}, barcodeIndex: {}, stockCells: {}, stockTargets: {} };
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

  // ── execute-only global gate ───────────────────────────────────────────────
  if (EXECUTE && session?.active !== true) {
    console.error(`\nABORT: refill engine is NOT paused (receiving_session.active = ${JSON.stringify(session?.active)}).`);
    console.error("Set /receiving_session/active = true first — the health scan runs every 15 min");
    console.error("regardless of shop hours, so a trading-hours freeze alone does not cover this.");
    process.exit(1);
  }
  if (!EXECUTE) console.log(`  engine paused: ${session?.active === true ? "yes" : "NO (must be true at execute time)"}`);

  // ── per-product ────────────────────────────────────────────────────────────
  const results = [];
  for (const [pid, p] of scope) {
    const name = p.name || pid;
    const indexCodes = { ...(reverseIdx[pid] || {}) };
    for (const code of Object.values(p.barcodes || {}).map(String)) if (!(code in indexCodes)) indexCodes[code] = barcodesIdx[code] ?? null;

    // gates
    const gates = [];
    for (const [code, rec] of Object.entries(indexCodes)) {
      if (!rec) gates.push(`barcode ${code}: no index record`);
      else if (rec.productId !== pid) gates.push(`barcode ${code}: index points at ${rec.productId}`);
    }
    const cellsByLoc = {};
    for (const [loc, byPid] of Object.entries(stock)) if (byPid?.[pid]) cellsByLoc[loc] = byPid[pid];
    const declared = (p.sizes || []).map(String);
    const heldKeys = [];
    for (const [loc, bySize] of Object.entries(cellsByLoc)) {
      for (const [sizeKey, cell] of Object.entries(bySize)) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        if (q !== 0) {
          heldKeys.push(sizeKey);
          if (sizeKey !== "_" && !declared.includes(sizeKey)) gates.push(`holds ${q} in undeclared size ${loc}/${sizeKey}`);
        }
      }
    }
    // A transfer is matched on the whole record (line items nest the product),
    // and any not-yet-received transfer naming a real size still has a receive
    // leg ahead of it that would credit the retired key.
    for (const [tid, t] of Object.entries(transfers)) {
      if (!t || t.status === "received") continue;
      const raw = JSON.stringify(t);
      if (raw.includes(pid) && /"(size|sizeKey)"\s*:\s*"(XS|S|M|L|XL|XXL|XXXL)"/.test(raw)) gates.push(`open transfer ${tid} (${t.status})`);
    }
    for (const [oid, o] of Object.entries(orders)) {
      const why = orderBlocks(o && { id: oid, ...o }, pid, nowMs);
      if (why) gates.push(why);
    }
    for (const [rid, r] of Object.entries(refillRequests)) {
      if (r && r.status === "open" && r.productId === pid && REAL_SIZE.test(String(r.size || ""))) gates.push(`open refill request ${rid} (size ${r.size})`);
    }
    for (const [loc, byPid] of Object.entries(openLocks)) {
      for (const sk of Object.keys(byPid?.[pid] || {})) if (sk !== "_") gates.push(`engine lock ${loc}/${sk}`);
    }
    for (const [loc, byKey] of Object.entries(dcActive)) {
      for (const k of Object.keys(byKey || {})) if (k.startsWith(`${pid}__`) && !k.endsWith("___")) gates.push(`active display check ${loc}/${k}`);
    }
    if (gates.length) {
      results.push({ pid, name, status: "GATED", detail: gates });
      continue;
    }

    // plan
    const step1 = await planStep1(io, pid, declared, cellsByLoc);
    const s2 = planStep2(pid, p, indexCodes, heldKeys);
    if (s2.error) { results.push({ pid, name, status: "GATED", detail: [s2.error] }); continue; }
    const targetRows = {};
    for (const [loc, byPid] of Object.entries(allTargets)) if (byPid?.[pid]) targetRows[loc] = byPid[pid];
    const step3 = planStep3(pid, targetRows, nowIso);
    const s2Needed = !step2Done(p, indexCodes, s2.keepCode);

    if (!EXECUTE) {
      const legLines = step1.flatMap((pl) => pl.legs.map((l) => `${l.id} (${l.movement.from ? "OUT " + l.movement.from : "IN " + l.movement.to} ${l.movement.size} qty ${l.movement.qty}${l.movement.allowNegative ? " allowNegative" : ""})`));
      results.push({ pid, name, status: (step1.length || s2Needed || Object.keys(step3).length) ? "PLANNED" : "ALREADY DONE", detail: [
        ...legLines,
        s2Needed ? `step2 atomic ×${Object.keys(s2.updates).length} paths — "_" slot ← ${s2.keepCode} (${s2.rule})` : "step2: already collapsed",
        ...(Object.keys(step3).length ? [`step3 retire ${Object.keys(step3).length} target rows`] : []),
      ] });
      continue;
    }

    // execute
    const totalsBeforeProduct = {};
    for (const [loc, bySize] of Object.entries(cellsByLoc)) {
      totalsBeforeProduct[loc] = Object.values(bySize).reduce((t, c) => t + (typeof c?.qty === "number" ? c.qty : 0), 0);
    }
    let failed = null;
    for (const pl of step1) {
      for (const leg of pl.legs) {
        const r = await applyMovementAdmin(io, { ...leg.movement, ts: nowIso }, { nowIso });
        if (!r.ok) { failed = `${leg.id}: ${r.reason}${r.available != null ? ` (available ${r.available}, requested ${r.requested})` : ""}`; break; }
      }
      if (failed) break;
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
      : { pid, name, status: "DONE", detail: [`"_" slot ← ${s2.keepCode} (${s2.rule})`, `${step1.length} cell merges, ${Object.keys(step3).length} target rows retired`] });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const byStatus = {};
  for (const r of results) (byStatus[r.status] = byStatus[r.status] || []).push(r);
  console.log("");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(13)} ${r.pid} "${r.name}"`);
    for (const d of r.detail) console.log(`     ${d}`);
  }
  console.log(`\n  SUMMARY: ${Object.entries(byStatus).map(([s, l]) => `${s}=${l.length}`).join("  ")}`);
  // Machine-readable twin of the same run — the operator report and the
  // clear-first worklist are built from this, not from scraping stdout.
  const REPORT = process.env.REPORT_JSON || join(tmpdir(), `beanie-collapse-${EXECUTE ? "execute" : "dryrun"}-${Date.now()}.json`);
  writeFileSync(REPORT, JSON.stringify({ ranAt: nowIso, mode: EXECUTE ? "execute" : "dry-run", scope: scope.length, totalsBefore, results }, null, 2));
  console.log(`  JSON report: ${REPORT}`);

  if (EXECUTE) {
    // final proof: network totals across scope must be unchanged
    const stockAfter = (await io.read("stock")) || {};
    const totalsAfter = {};
    for (const [loc, byPid] of Object.entries(stockAfter)) {
      for (const pid of pidSet) {
        for (const cell of Object.values(byPid?.[pid] || {})) {
          totalsAfter[loc] = (totalsAfter[loc] || 0) + (typeof cell?.qty === "number" ? cell.qty : 0);
        }
      }
    }
    const locs = new Set([...Object.keys(totalsBefore), ...Object.keys(totalsAfter)]);
    let totalsOk = true;
    for (const loc of locs) {
      const b = totalsBefore[loc] || 0, a = totalsAfter[loc] || 0;
      if (b !== a) { totalsOk = false; console.log(`  TOTALS MISMATCH ${loc}: ${b} → ${a}`); }
    }
    console.log(`  network totals ${totalsOk ? "UNCHANGED" : "CHANGED — investigate before anything else"}: ${Object.entries(totalsAfter).sort().map(([l, q]) => `${l}=${q}`).join("  ")}`);
    if (!totalsOk) process.exit(1);
  } else {
    console.log("  DRY RUN — nothing written except the rollback snapshot above.");
  }
  const bad = results.filter((r) => r.status !== "DONE" && r.status !== "ALREADY DONE" && r.status !== "PLANNED");
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
