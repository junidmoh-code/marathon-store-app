// ─── BEANIE ONE-SIZE COLLAPSE — COMMIT 1: LIVE CENSUS (READ-ONLY) ─────────────
//
// A beanie has no size, but the catalogue disagrees with itself: legacy records
// created before the free-size product flow carry ["M"] or ["S"] size runs while
// newer records are correctly one-size ["_"]. This census reads LIVE data and
// reports, for every in-scope beanie:
//
//   • declared sizes
//   • every stock cell by location and quantity (raw size keys, incl. negatives)
//   • every barcode and the size its /barcodes index record carries
//   • any explicit /stock_targets row, at ANY location (whole-tree sweep)
//   • any open order, transfer, refill request, engine lock or active Display
//     Check referencing the product
//
// It writes NOTHING. It exists so the migration operates on reported facts, not
// assumptions — the before-totals per location printed here are the numbers the
// post-migration verification must reproduce exactly.
//
// ── SCOPE RULE ───────────────────────────────────────────────────────────────
// In scope:  /beanie/i.test(product.name) AND the record is not a mergedInto
//            redirect stub. Beanies and caps share subcategory "Caps & Hats",
//            so subcategory CANNOT separate them — the name is the only field
//            that does. Caps are OUT OF SCOPE (45 genuinely hold stock across
//            two or more sizes; one-size rows would orphan them) and this
//            census counts them only to prove the scope rule excludes them.
// Flagged:   any name-matched record whose subcategory is NOT "Caps & Hats"
//            (reported, still in scope — the name is decisive).
//
// Whole-tree sweeps everywhere (/stock, /stock_targets, locks, checks,
// transfers, orders): the balaclava collapse (scripts/collapse-one-size-
// balaclava.mjs, PR #284) learned four separate times that a hardcoded location
// list silently orphans data — the data says where it lives, not this file.
//
// Usage:   node scripts/beanie-census.mjs
//          CENSUS_JSON=/path/report.json node scripts/beanie-census.mjs
// Exit 0 = census clean (no blockers). Exit 1 = blockers found (still reports).

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

const OUT = process.env.CENSUS_JSON || join(tmpdir(), `beanie-census-${Date.now()}.json`);

// Order statuses that mean "still live" — anything else is terminal history.
// (App.jsx STATUS: incoming → ready → collected; out_of_stock/coming_tomorrow
// are live holds. /orders is ephemeral & daily-scoped, so live is small.)
const LIVE_ORDER_STATUSES = new Set(["incoming", "ready", "coming_tomorrow", "on_hold"]);

(async () => {
  console.log(`\n${"═".repeat(78)}\n  BEANIE CENSUS — read-only, live data\n${"═".repeat(78)}`);

  const [products, stock, allTargets, transfers, orders, refillRequests, openLocks, dcActive, barcodesIdx] =
    await Promise.all([
      g("products"), g("stock"), g("stock_targets"), g("transfers"), g("orders"),
      g("refill_requests"), g("refill_engine/open"), g("displayChecks_active"), g("barcodes"),
    ]).then((r) => r.map((v) => v || {}));

  // ── scope ──────────────────────────────────────────────────────────────────
  const beanies = [];        // in-scope
  const mergedStubs = [];    // name-matched but mergedInto → redirect, no stock identity
  let capsCount = 0, capsMultiSize = 0;
  for (const [pid, p] of Object.entries(products)) {
    const isBeanieName = /beanie/i.test(p?.name || "");
    const isCapsHats = p?.subcategory === "Caps & Hats";
    if (!isBeanieName && !isCapsHats) continue;
    if (isBeanieName) {
      if (p.mergedInto) { mergedStubs.push({ pid, mergedInto: p.mergedInto, name: p.name }); continue; }
      beanies.push([pid, p]);
    } else {
      capsCount++;
      if ((p?.sizes || []).length > 1) capsMultiSize++;
    }
  }
  beanies.sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));

  // Reverse barcode index: every /barcodes record pointing at an in-scope pid,
  // whether or not the product's own barcodes map still lists it. A code the map
  // forgot is exactly the code Step 2 would miss.
  const inScopeIds = new Set(beanies.map(([pid]) => pid));
  const reverseIdx = {};
  for (const [code, rec] of Object.entries(barcodesIdx)) {
    if (rec && inScopeIds.has(rec.productId)) (reverseIdx[rec.productId] = reverseIdx[rec.productId] || {})[code] = rec;
  }

  const blockers = [];
  const flag = (kind, detail) => blockers.push({ kind, detail });

  const locTotals = {};                 // location → total beanie units (raw, incl. negative)
  const bySplit = { '["_"]': [], '["M"]': [], '["S"]': [], other: [] };
  const multiSizeHolders = [];
  const report = [];

  for (const [pid, p] of beanies) {
    const sizes = p.sizes || [];
    const splitKey = JSON.stringify(sizes);
    (bySplit[splitKey] || bySplit.other).push(pid);
    if (bySplit.other.includes(pid)) flag("unexpected-size-run", `${pid} "${p.name}" declares ${splitKey}`);

    // stock cells — whole /stock tree
    const cells = {};   // loc → { sizeKey: qty }
    const sizedHeld = new Set();
    for (const [loc, byPid] of Object.entries(stock)) {
      const bySize = byPid?.[pid];
      if (!bySize) continue;
      for (const [sk, cell] of Object.entries(bySize)) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        (cells[loc] = cells[loc] || {})[sk] = q;
        locTotals[loc] = (locTotals[loc] || 0) + q;
        if (q !== 0) sizedHeld.add(sk);
        if (q < 0) flag("negative-cell", `${pid} "${p.name}" ${loc}/${sk} = ${q} — paired OUT cannot move negative stock`);
        // stock held in a size the product does not declare ("_" tolerated: the
        // collapse target cell may already exist)
        if (q !== 0 && sk !== "_" && !sizes.includes(sk)) {
          flag("undeclared-size-stock", `${pid} "${p.name}" holds ${q} in ${loc}/${sk} but declares ${splitKey}`);
        }
      }
    }
    if (sizedHeld.size >= 2) {
      multiSizeHolders.push({ pid, name: p.name, held: Object.fromEntries(
        Object.entries(cells).map(([l, m]) => [l, Object.fromEntries(Object.entries(m).filter(([, q]) => q !== 0))]).filter(([, m]) => Object.keys(m).length),
      ) });
    }

    // barcodes: map ∪ reverse-index — both directions must agree
    const map = { ...(p.barcodes || {}) };
    const codes = {};
    for (const [slot, code] of Object.entries(map)) {
      const rec = barcodesIdx[code];
      codes[code] = { slot, indexSize: rec?.size ?? null, indexPid: rec?.productId ?? null };
      if (!rec) flag("missing-index-record", `${pid} "${p.name}" barcodes.${slot}=${code} has NO /barcodes record`);
      else if (rec.productId !== pid) flag("index-points-elsewhere", `${pid} "${p.name}" code ${code} index says productId=${rec.productId}`);
    }
    for (const [code, rec] of Object.entries(reverseIdx[pid] || {})) {
      if (!(code in codes)) {
        codes[code] = { slot: "(index-only)", indexSize: rec.size ?? null, indexPid: rec.productId };
        flag("index-only-code", `${pid} "${p.name}" /barcodes/${code} (size ${rec.size}) points here but the product's barcodes map does not list it`);
      }
    }
    if (Object.keys(codes).length === 0) flag("no-barcodes", `${pid} "${p.name}" has no barcode at all`);

    // explicit target rows, any location
    const targetRows = {};
    for (const [loc, byPid] of Object.entries(allTargets)) {
      if (byPid?.[pid]) targetRows[loc] = byPid[pid];
    }

    // open references
    // For orders/transfers the size sits inside line items, so keep the raw
    // JSON of every matched entity: the blocker test below looks for a real
    // size in THAT JSON, not in this summary row. (A multi-product order can
    // false-positive — census errs toward reporting; the per-product dry run
    // re-checks before anything moves.)
    const refs = [];
    for (const [tid, t] of Object.entries(transfers)) {
      const raw = t && t.status !== "received" ? JSON.stringify(t) : "";
      if (raw.includes(pid)) refs.push({ kind: "transfer", id: tid, status: t.status, raw });
    }
    for (const [oid, o] of Object.entries(orders)) {
      const raw = o && LIVE_ORDER_STATUSES.has(o.status) ? JSON.stringify(o) : "";
      if (raw.includes(pid)) refs.push({ kind: "order", id: oid, status: o.status, raw });
    }
    for (const [rid, r] of Object.entries(refillRequests)) {
      if (r && r.status === "open" && JSON.stringify(r).includes(pid)) refs.push({ kind: "refill_request", id: rid, size: r.size ?? null, dest: r.dest ?? r.shop ?? null, raw: JSON.stringify(r) });
    }
    for (const [loc, byPid] of Object.entries(openLocks)) {
      for (const sk of Object.keys(byPid?.[pid] || {})) refs.push({ kind: "engine_lock", id: `${loc}/${pid}/${sk}` });
    }
    for (const [loc, byKey] of Object.entries(dcActive)) {
      for (const k of Object.keys(byKey || {})) if (k.startsWith(`${pid}__`)) refs.push({ kind: "display_check", id: `${loc}/${k}` });
    }
    // An open reference against a REAL size blocks that product's migration.
    for (const r of refs) {
      const hay = r.raw || r.id || "";
      const sized = /"(size|sizeKey)"\s*:\s*"(XS|S|M|L|XL|XXL|XXXL)"/.test(hay) || /__(XS|S|M|L|XL|XXL|XXXL)$|\/(XS|S|M|L|XL|XXL|XXXL)$/.test(r.id || "");
      if (sized) flag("open-ref-real-size", `${pid} "${p.name}" ${r.kind} ${r.id}`);
      delete r.raw;   // summary row only — the flag has been taken
    }

    report.push({ pid, name: p.name, productType: p.productType ?? null, subcategory: p.subcategory ?? null,
      sizes, cells, barcodes: codes, targetRows, openRefs: refs });
  }

  // ── print ──────────────────────────────────────────────────────────────────
  console.log(`\nSCOPE — name-matched beanies: ${beanies.length} in scope, ${mergedStubs.length} merged stubs (skipped)`);
  console.log(`CAPS (Caps & Hats, non-beanie): ${capsCount} products — OUT OF SCOPE (${capsMultiSize} declare 2+ sizes)`);
  console.log(`\nDECLARED-SIZES SPLIT (live, vs the briefed 32/78/10):`);
  for (const [k, v] of Object.entries(bySplit)) if (v.length) console.log(`  ${k.padEnd(8)} ${v.length}`);
  // FLAGGED MEANS FLAGGED. These were printed as "flagged" but never passed
  // through flag(), so a name-matched beanie filed under an unexpected
  // subcategory could not affect the exit status and a scripted run would treat
  // the census as clean. (CodeRabbit, PR #343.)
  const offSub = report.filter((r) => r.subcategory !== "Caps & Hats");
  for (const r of offSub) flag("unexpected-subcategory", `${r.pid} "${r.name}" is name-matched as a beanie but filed under ${JSON.stringify(r.subcategory)} — confirm it belongs in scope`);
  if (offSub.length) console.log(`\nNAME-MATCHED OUTSIDE Caps & Hats (in scope, flagged):\n${offSub.map((r) => `  ${r.pid} "${r.name}" sub=${r.subcategory}`).join("\n")}`);

  console.log(`\nUNITS BEFORE, PER LOCATION (raw sums across all in-scope beanies):`);
  let grand = 0;
  for (const [loc, t] of Object.entries(locTotals).sort()) { console.log(`  ${loc.padEnd(14)} ${t}`); grand += t; }
  console.log(`  ${"TOTAL".padEnd(14)} ${grand}`);

  console.log(`\nMULTI-SIZE HOLDERS (stock in 2+ size keys at once — the merge actually combines these): ${multiSizeHolders.length}`);
  for (const m of multiSizeHolders) console.log(`  ${m.pid} "${m.name}" ${JSON.stringify(m.held)}`);

  const withTargets = report.filter((r) => Object.keys(r.targetRows).length);
  console.log(`\nEXPLICIT /stock_targets ROWS: ${withTargets.length} products`);
  for (const r of withTargets) console.log(`  ${r.pid} "${r.name}" ${JSON.stringify(r.targetRows)}`);

  const withRefs = report.filter((r) => r.openRefs.length);
  console.log(`\nOPEN REFERENCES: ${withRefs.length} products`);
  for (const r of withRefs) for (const ref of r.openRefs) console.log(`  ${r.pid} "${r.name}" — ${ref.kind} ${ref.id}${ref.status ? ` (${ref.status})` : ""}${ref.size ? ` size=${ref.size}` : ""}`);

  console.log(`\nPER-PRODUCT DETAIL`);
  for (const r of report) {
    const cellStr = Object.entries(r.cells).map(([l, m]) => `${l}{${Object.entries(m).map(([k, q]) => `${k}:${q}`).join(",")}}`).join(" ") || "(no cells)";
    const codeStr = Object.entries(r.barcodes).map(([c, i]) => `${c}[${i.slot}→${i.indexSize}]`).join(" ") || "(none)";
    console.log(`  ${r.pid} ${JSON.stringify(r.sizes).padEnd(7)} "${r.name}"\n     stock: ${cellStr}\n     codes: ${codeStr}`);
  }

  console.log(`\nBLOCKERS: ${blockers.length}`);
  for (const b of blockers) console.log(`  [${b.kind}] ${b.detail}`);

  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), scope: beanies.length,
    split: Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k, v.length])),
    locTotals, grand, multiSizeHolders, mergedStubs, capsCount, blockers, report }, null, 2));
  console.log(`\nJSON report: ${OUT}`);
  process.exit(blockers.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
