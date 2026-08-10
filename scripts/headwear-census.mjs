// ─── HEADWEAR ONE-SIZE COLLAPSE — COMMIT 1: LIVE CENSUS (READ-ONLY) ───────────
//
// Beanies and caps have no size. They are quantities. The catalogue disagrees
// with itself: legacy records created before the free-size product flow carry
// letter runs (and, on fitted caps, centimetre runs) while newer records are
// correctly one-size ["_"]. This census reads LIVE data and reports, for every
// in-scope product:
//
//   • declared sizes
//   • every stock cell by location and quantity (raw size keys, incl. negatives)
//   • every barcode and the size its /barcodes index record carries
//   • any explicit /stock_targets row, at ANY location (whole-tree sweep)
//   • any open order, transfer, refill request, engine lock or active Display
//     Check referencing the product
//
// It writes NOTHING. The before-totals per location printed here are the numbers
// the post-migration verification must reproduce exactly.
//
// ── WHY THE CAP NUMBERS GET THEIR OWN SECTIONS ───────────────────────────────
// The beanie census could report three aggregates and be done, because every
// beanie held one size and carried one barcode. Caps break both assumptions, so
// the three questions that were trivial then are reported separately now:
//   • how many caps hold stock in TWO OR MORE sizes, and what combines into what
//   • how many carry MORE THAN ONE barcode
//   • whether any cap holds stock in a size it does not declare
// Read those three before the per-product detail; they are where the risk is.
//
// ── SCOPE RULE ───────────────────────────────────────────────────────────────
// The ONE exported predicate (scripts/lib/headwearCollapseCore.mjs), shared with
// the probe and the migration so they cannot drift. Beanies by name, caps by the
// Caps & Hats shelf minus visors and bucket hats. This census prints the full
// membership of that shelf split three ways — admitted beanies, admitted caps,
// and excluded — so "what does the predicate now admit" is answered by a list,
// not by a claim.
//
// Whole-tree sweeps everywhere (/stock, /stock_targets, locks, checks,
// transfers, orders): the balaclava collapse (scripts/collapse-one-size-
// balaclava.mjs, PR #284) learned four separate times that a hardcoded location
// list silently orphans data — the data says where it lives, not this file.
//
// Usage:   node scripts/headwear-census.mjs
//          CENSUS_JSON=/path/report.json node scripts/headwear-census.mjs
// Exit 0 = census clean (no blockers). Exit 1 = blockers found (still reports).

import { createRequire } from "module";
import { writeFileSync } from "fs";
import {
  isInScope, isUnexpectedSubcategory, isExcludedHeadwear, isCapByShelfOnly,
  headwearKind, isRetiredSizeKey, orderBlocks, transferBlocks, isRetiredSize,
  HEADWEAR_SUBCATEGORY, planStep2,
} from "./lib/headwearCollapseCore.mjs";
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

const OUT = process.env.CENSUS_JSON || join(tmpdir(), `headwear-census-${Date.now()}.json`);

(async () => {
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR CENSUS — read-only, live data\n${"═".repeat(78)}`);

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  const [products, stock, allTargets, transfers, orders, refillRequests, openLocks, dcActive, barcodesIdx] =
    await Promise.all([
      g("products"), g("stock"), g("stock_targets"), g("transfers"), g("orders"),
      g("refill_requests"), g("refill_engine/open"), g("displayChecks_active"), g("barcodes"),
    ]).then((r) => r.map((v) => v || {}));

  // ── scope ──────────────────────────────────────────────────────────────────
  const inScope = [];        // [pid, product, kind]
  const excluded = [];       // on the shelf, deliberately not a beanie or a cap
  const mergedStubs = [];    // redirect stubs — no stock identity of their own
  for (const [pid, p] of Object.entries(products)) {
    const onShelf = p?.subcategory === HEADWEAR_SUBCATEGORY;
    const kind = headwearKind(p);
    if (kind) { inScope.push([pid, p, kind]); continue; }
    if (isExcludedHeadwear(p)) { excluded.push([pid, p]); continue; }
    // A merged stub that WOULD have been in scope but for the redirect.
    if (p?.mergedInto && (onShelf || /beanie/i.test(p?.name || ""))) {
      mergedStubs.push({ pid, mergedInto: p.mergedInto, name: p.name });
    }
  }
  inScope.sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
  const beanies = inScope.filter(([, , k]) => k === "beanie");
  const caps = inScope.filter(([, , k]) => k === "cap");

  // Reverse barcode index: every /barcodes record pointing at an in-scope pid,
  // whether or not the product's own barcodes map still lists it. A code the map
  // forgot is exactly the code Step 2 would miss.
  const inScopeIds = new Set(inScope.map(([pid]) => pid));
  const reverseIdx = {};
  for (const [code, rec] of Object.entries(barcodesIdx)) {
    if (rec && inScopeIds.has(rec.productId)) (reverseIdx[rec.productId] = reverseIdx[rec.productId] || {})[code] = rec;
  }

  // BLOCKERS gate a product's migration and must be cleared by a human before
  // the run. NOTICES are conditions this migration is designed to handle and
  // reports anyway. Conflating them was misleading: a negative cell is not a
  // blocker — the mirrored pair exists precisely for it, and the CLI does not
  // gate on one — but reporting it under "BLOCKERS" made the census exit
  // non-zero for a state that needs no action at all.
  const blockers = [];
  const notices = [];
  const flag = (kind, detail) => blockers.push({ kind, detail });
  const note = (kind, detail) => notices.push({ kind, detail });

  const locTotals = { beanie: {}, cap: {}, all: {} };
  const bySplit = {};
  const multiSizeHolders = [];
  const multiBarcode = [];
  const report = [];

  for (const [pid, p, kind] of inScope) {
    const sizes = (p.sizes || []).map(String);
    const splitKey = JSON.stringify(sizes);
    (bySplit[splitKey] = bySplit[splitKey] || []).push(pid);

    // ── stock cells — whole /stock tree ─────────────────────────────────────
    const cells = {};                 // loc → { sizeKey: qty }
    const unitsBySizeKey = {};        // sizeKey → units summed across locations
    const heldKeys = new Set();
    let totalUnits = 0;
    for (const [loc, byPid] of Object.entries(stock)) {
      const bySize = byPid?.[pid];
      if (!bySize) continue;
      for (const [sk, cell] of Object.entries(bySize)) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        (cells[loc] = cells[loc] || {})[sk] = q;
        locTotals[kind][loc] = (locTotals[kind][loc] || 0) + q;
        locTotals.all[loc] = (locTotals.all[loc] || 0) + q;
        totalUnits += q;
        if (q !== 0) { heldKeys.add(sk); unitsBySizeKey[sk] = (unitsBySizeKey[sk] || 0) + q; }
        if (q < 0) note("negative-cell", `${pid} "${p.name}" ${loc}/${sk} = ${q} — migrates via the MIRRORED pair (a normal OUT would overdraw)`);
        // Stock held in a size the product does not declare ("_" tolerated: the
        // collapse target cell may already exist). A STOP-AND-REPORT condition.
        if (q !== 0 && isRetiredSizeKey(sk) && !sizes.includes(sk)) {
          flag("undeclared-size-stock", `${pid} "${p.name}" holds ${q} in ${loc}/${sk} but declares ${splitKey}`);
        }
      }
    }
    // Two or more SIZE KEYS holding stock at once — the case where the merge
    // actually combines quantities rather than just renaming a cell.
    // `.length`, NOT `.size` — this is an Array. As `.size` it was always
    // undefined, so `undefined >= 2` was false and the ONLY holders detected
    // were those with two live cells at the SAME location. A product whose
    // sizes are split ACROSS locations (M at hub2, L at marathon-pe) was
    // silently absent from the very list that exists to find it.
    const sizedHeld = [...heldKeys].filter(isRetiredSizeKey);
    const perLoc = {};
    for (const [loc, m] of Object.entries(cells)) {
      const live = Object.entries(m).filter(([, q]) => q !== 0);
      if (live.length >= 2) perLoc[loc] = Object.fromEntries(live);
    }
    if (sizedHeld.length >= 2 || Object.keys(perLoc).length) {
      multiSizeHolders.push({ pid, name: p.name, kind, unitsBySizeKey, perLocation: perLoc, totalUnits });
    }

    // ── barcodes: map ∪ reverse-index — both directions must agree ───────────
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

    // WHICH CODE WOULD KEEP THE "_" SLOT — from the SAME planStep2 the migration
    // runs, never a restatement of the rule. Reporting the answer here is the
    // whole point of Commit 2: the decision is visible before anything moves.
    // indexCodes assembled EXACTLY as the CLI assembles it (reverse index ∪ the
    // product's own map), so the code reported here is the code the migration
    // will actually keep — not a near-miss built from a different input.
    let keep = null;
    if (Object.keys(codes).length) {
      const indexCodes = { ...(reverseIdx[pid] || {}) };
      for (const code of Object.values(map).map(String)) if (!(code in indexCodes)) indexCodes[code] = barcodesIdx[code] ?? null;
      const s2 = planStep2(pid, p, indexCodes, unitsBySizeKey);
      if (!s2.error) keep = { keepCode: s2.keepCode, rule: s2.rule, dropped: s2.droppedCodes };
    }
    if (Object.keys(codes).length > 1) multiBarcode.push({ pid, name: p.name, kind, codes: Object.keys(codes), keep });

    // ── explicit target rows, any location ──────────────────────────────────
    const targetRows = {};
    for (const [loc, byPid] of Object.entries(allTargets)) {
      if (byPid?.[pid]) targetRows[loc] = byPid[pid];
    }

    // ── open references ─────────────────────────────────────────────────────
    // These use the SAME gate functions the migration gates on (orderBlocks /
    // transferBlocks), not a JSON regex. The old regex scan enumerated letter
    // sizes and therefore could never fire on a fitted cap in size 57 or 4XL —
    // the fail-open direction on the one check that stops a live order being
    // collapsed out from under a customer.
    const refs = [];
    for (const [tid, t] of Object.entries(transfers)) {
      const why = transferBlocks(t, pid);
      if (why) { refs.push({ kind: "transfer", id: tid, status: t?.status ?? null, why }); flag("open-ref-real-size", `${pid} "${p.name}" transfer ${tid} — ${why}`); }
    }
    for (const [oid, o] of Object.entries(orders)) {
      const why = orderBlocks(o && { ...o, id: o.id || oid }, pid, nowMs);
      if (why) { refs.push({ kind: "order", id: oid, status: o?.status ?? null, why }); flag("open-ref-real-size", `${pid} "${p.name}" order ${oid} — ${why}`); }
    }
    for (const [rid, r] of Object.entries(refillRequests)) {
      if (r && r.status === "open" && r.productId === pid && isRetiredSize(r.size)) {
        refs.push({ kind: "refill_request", id: rid, size: r.size, dest: r.dest ?? r.shop ?? null });
        flag("open-ref-real-size", `${pid} "${p.name}" open refill request ${rid} (size ${r.size})`);
      }
    }
    for (const [loc, byPid] of Object.entries(openLocks)) {
      for (const sk of Object.keys(byPid?.[pid] || {})) {
        refs.push({ kind: "engine_lock", id: `${loc}/${pid}/${sk}`, size: sk });
        if (isRetiredSizeKey(sk)) flag("open-ref-real-size", `${pid} "${p.name}" engine lock ${loc}/${sk}`);
      }
    }
    for (const [loc, byKey] of Object.entries(dcActive)) {
      for (const k of Object.keys(byKey || {})) {
        if (!k.startsWith(`${pid}__`)) continue;
        refs.push({ kind: "display_check", id: `${loc}/${k}` });
        // The check key is `${pid}__${sizeKey}__…`; a one-size check ends "___".
        if (!k.endsWith("___")) flag("open-ref-real-size", `${pid} "${p.name}" active display check ${loc}/${k}`);
      }
    }

    report.push({ pid, name: p.name, kind, productType: p.productType ?? null, subcategory: p.subcategory ?? null,
      sizes, cells, unitsBySizeKey, totalUnits, barcodes: codes, keep, targetRows, openRefs: refs });
  }

  // ── print ──────────────────────────────────────────────────────────────────
  const shelf = Object.values(products).filter((p) => p?.subcategory === HEADWEAR_SUBCATEGORY).length;
  console.log(`\nSCOPE — what the shared predicate now admits`);
  console.log(`  "${HEADWEAR_SUBCATEGORY}" shelf holds ${shelf} records. Admitted: ${inScope.length} (${beanies.length} beanies, ${caps.length} caps).`);
  console.log(`  Excluded from the shelf (neither a beanie nor a cap): ${excluded.length}`);
  for (const [pid, p] of excluded) console.log(`     ${pid} ${JSON.stringify((p.sizes || []).map(String)).padEnd(8)} ${p.name}`);
  console.log(`  Merged redirect stubs skipped: ${mergedStubs.length}`);
  for (const m of mergedStubs) console.log(`     ${m.pid} → ${m.mergedInto}  "${m.name}"`);

  const shelfOnly = inScope.filter(([, p]) => isCapByShelfOnly(p));
  console.log(`\n  ADMITTED AS A CAP BY THE SHELF ALONE (the name carries no "cap"): ${shelfOnly.length}`);
  console.log(`  These are the records whose scope decision rests entirely on the subcategory`);
  console.log(`  field. Read them before executing — if one of these is not a cap, say so.`);
  for (const [pid, p] of shelfOnly) console.log(`     ${pid} ${JSON.stringify((p.sizes || []).map(String)).padEnd(28)} ${p.name}`);

  const offSub = report.filter((r) => isUnexpectedSubcategory(products[r.pid]));
  for (const r of offSub) flag("unexpected-subcategory", `${r.pid} "${r.name}" is name-matched as a beanie but filed under ${JSON.stringify(r.subcategory)} — confirm it belongs in scope`);
  if (offSub.length) console.log(`\nBEANIE-NAMED OUTSIDE ${HEADWEAR_SUBCATEGORY} (in scope, flagged):\n${offSub.map((r) => `  ${r.pid} "${r.name}" sub=${r.subcategory}`).join("\n")}`);

  console.log(`\nDECLARED-SIZES SPLIT (live):`);
  for (const [k, v] of Object.entries(bySplit).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(4)}  ${k}`);
  }

  console.log(`\nUNITS BEFORE, PER LOCATION — the numbers the migration must reproduce exactly:`);
  const allLocs = [...new Set([...Object.keys(locTotals.beanie), ...Object.keys(locTotals.cap)])].sort();
  console.log(`  ${"location".padEnd(16)} ${"beanies".padStart(9)} ${"caps".padStart(7)} ${"total".padStart(8)}`);
  let gB = 0, gC = 0;
  for (const loc of allLocs) {
    const b = locTotals.beanie[loc] || 0, c = locTotals.cap[loc] || 0;
    gB += b; gC += c;
    console.log(`  ${loc.padEnd(16)} ${String(b).padStart(9)} ${String(c).padStart(7)} ${String(b + c).padStart(8)}`);
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${String(gB).padStart(9)} ${String(gC).padStart(7)} ${String(gB + gC).padStart(8)}`);

  console.log(`\nMULTI-SIZE HOLDERS — stock in 2+ size keys, where the merge actually COMBINES`);
  console.log(`quantities rather than renaming a cell: ${multiSizeHolders.length} (${multiSizeHolders.filter((m) => m.kind === "cap").length} caps, ${multiSizeHolders.filter((m) => m.kind === "beanie").length} beanies)`);
  for (const m of multiSizeHolders) {
    const combines = Object.entries(m.unitsBySizeKey).filter(([k]) => isRetiredSizeKey(k));
    console.log(`  ${m.pid} "${m.name}"`);
    for (const [loc, cells] of Object.entries(m.perLocation)) {
      const sum = Object.values(cells).reduce((a, b) => a + b, 0);
      console.log(`     ${loc}: ${Object.entries(cells).map(([k, q]) => `${k} ${q}`).join(" + ")}  →  "_" ${sum}`);
    }
    if (!Object.keys(m.perLocation).length) console.log(`     (sizes split ACROSS locations: ${combines.map(([k, q]) => `${k} ${q}`).join(", ")} — each location merges on its own)`);
  }

  console.log(`\nMULTI-BARCODE PRODUCTS — more than one code, so one must take the "_" slot:`);
  console.log(`  ${multiBarcode.length} products (${multiBarcode.filter((m) => m.kind === "cap").length} caps, ${multiBarcode.filter((m) => m.kind === "beanie").length} beanies)`);
  console.log(`  Every listed code keeps resolving to its product at size "_" — only the map slot changes.`);
  for (const m of multiBarcode) {
    console.log(`  ${m.pid} "${m.name}"  codes ${m.codes.join(", ")}`);
    console.log(`     KEEPS ${m.keep?.keepCode} — ${m.keep?.rule}${m.keep?.dropped?.length ? `; still resolving: ${m.keep.dropped.join(", ")}` : ""}`);
  }

  const withTargets = report.filter((r) => Object.keys(r.targetRows).length);
  console.log(`\nEXPLICIT /stock_targets ROWS: ${withTargets.length} products`);
  for (const r of withTargets) console.log(`  ${r.pid} "${r.name}" ${JSON.stringify(r.targetRows)}`);

  const withRefs = report.filter((r) => r.openRefs.length);
  console.log(`\nOPEN REFERENCES (these must clear before their product can migrate): ${withRefs.length} products`);
  for (const r of withRefs) for (const ref of r.openRefs) console.log(`  ${r.pid} "${r.name}" — ${ref.kind} ${ref.id}${ref.why ? ` — ${ref.why}` : ""}${ref.size ? ` size=${ref.size}` : ""}`);

  console.log(`\nPER-PRODUCT DETAIL`);
  for (const r of report) {
    const cellStr = Object.entries(r.cells).map(([l, m]) => `${l}{${Object.entries(m).map(([k, q]) => `${k}:${q}`).join(",")}}`).join(" ") || "(no cells)";
    const codeStr = Object.entries(r.barcodes).map(([c, i]) => `${c}[${i.slot}→${i.indexSize}]`).join(" ") || "(none)";
    console.log(`  ${r.pid} ${r.kind.padEnd(6)} ${JSON.stringify(r.sizes).padEnd(30)} "${r.name}"\n     stock: ${cellStr}\n     codes: ${codeStr}`);
  }

  console.log(`\nNOTICES — handled by the migration, reported for the record: ${notices.length}`);
  for (const n of notices) console.log(`  [${n.kind}] ${n.detail}`);

  console.log(`\nBLOCKERS — a product carrying one of these is SKIPPED until it clears: ${blockers.length}`);
  const byKind = {};
  for (const b of blockers) (byKind[b.kind] = byKind[b.kind] || []).push(b.detail);
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`  [${k}] ${list.length}`);
    for (const d of list) console.log(`     ${d}`);
  }

  writeFileSync(OUT, JSON.stringify({ capturedAt: nowIso, notices,
    scope: { total: inScope.length, beanies: beanies.length, caps: caps.length, shelf, excluded: excluded.length },
    excluded: excluded.map(([pid, p]) => ({ pid, name: p.name, sizes: p.sizes || [] })),
    capsByShelfOnly: shelfOnly.map(([pid, p]) => ({ pid, name: p.name })),
    split: Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k, v.length])),
    locTotals, multiSizeHolders, multiBarcode, mergedStubs, blockers, report }, null, 2));
  console.log(`\nJSON report: ${OUT}`);
  process.exit(blockers.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
