// ─── HEADWEAR — THE EXCLUDED SHELF-MATES, IN FULL (READ-ONLY) ─────────────────
//
// PR #345 put beanies and caps in scope and deliberately left 24 records on the
// "Caps & Hats" shelf out: bucket hats and visors. That decision was made from a
// name list and a size count. Before widening it, this script printed the whole
// evidence base for those records — declared sizes, EVERY stock cell by location
// and quantity, every barcode with the size its /barcodes index record carries,
// explicit target rows, and any open reference — so the widening was argued from
// live data rather than from the earlier summary.
//
// The bucket hats are now IN scope, so what this prints today is what is STILL
// excluded: the 7 visors, plus any bucket hat filed off the Caps & Hats shelf
// (the scope rule declines those on purpose). It is deliberately unchanged
// otherwise — the same report against the same paths is what makes the before
// and after comparable, and it stays the standing answer to "what is left out
// and what is sitting in it".
//
// ── THE ONE QUESTION THIS SCRIPT EXISTS TO ANSWER ────────────────────────────
// A collapse merges every sized cell into one. On a beanie or a cap that is
// free: the size run was never a real fit distinction, so the quantities were
// always one pool wearing several labels. A BUCKET HAT IS NOT AUTOMATICALLY
// THAT. Several brands genuinely ship bucket hats in S/M and L/XL, and those are
// two different physical fits. Merging them makes one quantity out of two things
// a customer cannot swap between — and no later step can tell them apart again,
// because the sized cells are gone.
//
// So any bucket hat holding REAL STOCK (qty > 0) in two or more retired size
// keys at once is reported under its own heading and is a STOP: the owner
// decides that one per product. Holding stock in exactly one size, or none at
// all, carries no such risk — there is nothing to merge, only a cell to rename.
//
// Classification is by NAME, and the script says so where the name cannot carry
// it: a record whose name contains neither a bucket-hat word nor a visor word is
// listed as UNCLASSIFIABLE BY NAME rather than being silently sorted into
// whichever bucket the code happened to reach first.
//
// Writes NOTHING. Reads the same live paths the census reads, through the same
// shared predicate, so the two cannot disagree about who is excluded.
//
// Usage:  node scripts/headwear-excluded-report.mjs
//         EXCLUDED_JSON=/path/report.json node scripts/headwear-excluded-report.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isExcludedHeadwear, isInScope, isRetiredSizeKey, isRetiredSize,
  orderBlocks, transferBlocks, HEADWEAR_SUBCATEGORY,
  isBucketHatNamed, isVisorNamed,
} from "./lib/headwearCollapseCore.mjs";
// The bucket/visor classifiers are IMPORTED, never restated. A local copy here
// would have kept sorting records by the pre-widening wording while the scope
// rule moved on, and this file's whole job is to be comparable with the scope
// rule. The core is the only file under scripts/ holding a headwear name
// pattern, and a test enforces it.

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

const OUT = process.env.EXCLUDED_JSON || join(tmpdir(), `headwear-excluded-${Date.now()}.json`);

(async () => {
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR — EXCLUDED SHELF-MATES, FULL DETAIL (read-only)\n${"═".repeat(78)}`);

  const offset = (await g(".info/serverTimeOffset")) || 0;
  const nowMs = Date.now() + offset;

  const [products, stock, allTargets, transfers, orders, refillRequests, openLocks, dcActive, barcodesIdx] =
    await Promise.all([
      g("products"), g("stock"), g("stock_targets"), g("transfers"), g("orders"),
      g("refill_requests"), g("refill_engine/open"), g("displayChecks_active"), g("barcodes"),
    ]).then((r) => r.map((v) => v || {}));

  const excluded = Object.entries(products).filter(([, p]) => isExcludedHeadwear(p));
  excluded.sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));

  const rows = [];
  for (const [pid, p] of excluded) {
    const sizes = (p.sizes || []).map(String);

    const cells = {};                 // loc → { sizeKey: qty }
    const unitsBySizeKey = {};
    let totalUnits = 0;
    for (const [loc, byPid] of Object.entries(stock)) {
      const bySize = byPid?.[pid];
      if (!bySize) continue;
      for (const [sk, cell] of Object.entries(bySize)) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        (cells[loc] = cells[loc] || {})[sk] = q;
        totalUnits += q;
        if (q !== 0) unitsBySizeKey[sk] = (unitsBySizeKey[sk] || 0) + q;
      }
    }

    // Barcodes, both directions: the product's own map and every /barcodes
    // record pointing back at it (a code the map forgot is exactly the code a
    // collapse would miss).
    const codes = {};
    for (const [slot, code] of Object.entries(p.barcodes || {})) {
      const rec = barcodesIdx[code];
      codes[String(code)] = { slot, indexSize: rec?.size ?? null, indexPid: rec?.productId ?? null, indexed: !!rec };
    }
    for (const [code, rec] of Object.entries(barcodesIdx)) {
      if (rec?.productId === pid && !(code in codes)) {
        codes[code] = { slot: "(index-only)", indexSize: rec.size ?? null, indexPid: rec.productId, indexed: true };
      }
    }

    const targetRows = {};
    for (const [loc, byPid] of Object.entries(allTargets)) if (byPid?.[pid]) targetRows[loc] = byPid[pid];

    // Open references, judged by the SAME gate functions the migration gates on.
    const refs = [];
    for (const [tid, t] of Object.entries(transfers)) {
      const why = transferBlocks(t, pid);
      if (why) refs.push({ kind: "transfer", id: tid, why, blocks: true });
    }
    for (const [oid, o] of Object.entries(orders)) {
      const why = orderBlocks(o && { ...o, id: o.id || oid }, pid, nowMs);
      if (why) refs.push({ kind: "order", id: oid, why, blocks: true });
    }
    for (const [rid, r] of Object.entries(refillRequests)) {
      if (r && r.status === "open" && r.productId === pid && isRetiredSize(r.size)) {
        refs.push({ kind: "refill_request", id: rid, size: r.size, blocks: true });
      }
    }
    for (const [loc, byPid] of Object.entries(openLocks)) {
      for (const sk of Object.keys(byPid?.[pid] || {})) refs.push({ kind: "engine_lock", id: `${loc}/${pid}/${sk}`, size: sk, blocks: isRetiredSizeKey(sk) });
    }
    for (const [loc, byKey] of Object.entries(dcActive)) {
      for (const k of Object.keys(byKey || {})) {
        if (k.startsWith(`${pid}__`)) refs.push({ kind: "display_check", id: `${loc}/${k}`, blocks: !k.endsWith("___") });
      }
    }

    const name = String(p.name || "");
    const isBucket = isBucketHatNamed(p);
    const isVisor = isVisorNamed(p);
    // Sized keys holding REAL stock — the merge risk. A negative is a shortage
    // signal, not two fits sitting on a shelf, so it is reported but does not
    // raise the two-fit stop on its own.
    const positiveSized = Object.entries(unitsBySizeKey).filter(([k, q]) => isRetiredSizeKey(k) && q > 0);

    rows.push({ pid, name, sizes, subcategory: p.subcategory ?? null, productType: p.productType ?? null,
      onShelf: p.subcategory === HEADWEAR_SUBCATEGORY,
      group: isBucket && !isVisor ? "bucket" : isVisor && !isBucket ? "visor" : "unclassifiable",
      cells, unitsBySizeKey, totalUnits, positiveSized, codes, targetRows, openRefs: refs,
      alreadyOneSize: JSON.stringify(sizes) === JSON.stringify(["_"]),
      wouldBeInScopeToday: isInScope(p) });
  }

  const buckets = rows.filter((r) => r.group === "bucket");
  const visors = rows.filter((r) => r.group === "visor");
  const unknown = rows.filter((r) => r.group === "unclassifiable");

  const detail = (r) => {
    const cellStr = Object.entries(r.cells).map(([l, m]) => `${l}{${Object.entries(m).map(([k, q]) => `${k}:${q}`).join(",")}}`).join(" ") || "(no cells)";
    const codeStr = Object.entries(r.codes).map(([c, i]) => `${c}[${i.slot}→${i.indexSize}${i.indexed ? "" : " NO-INDEX-RECORD"}]`).join(" ") || "(none)";
    console.log(`  ${r.pid} ${JSON.stringify(r.sizes).padEnd(30)} "${r.name}"${r.onShelf ? "" : `   [filed under ${JSON.stringify(r.subcategory)}]`}`);
    console.log(`     stock: ${cellStr}   (total ${r.totalUnits})`);
    console.log(`     codes: ${codeStr}`);
    if (Object.keys(r.targetRows).length) console.log(`     targets: ${JSON.stringify(r.targetRows)}`);
    for (const ref of r.openRefs) console.log(`     ${ref.blocks ? "BLOCKS" : "info  "} ${ref.kind} ${ref.id}${ref.why ? ` — ${ref.why}` : ""}`);
  };

  console.log(`\nEXCLUDED BY THE CURRENT PREDICATE: ${rows.length} records`);
  console.log(`  bucket hats ${buckets.length}   visors ${visors.length}   name cannot classify ${unknown.length}`);

  console.log(`\n${"─".repeat(78)}\nBUCKET HATS (${buckets.length})\n${"─".repeat(78)}`);
  for (const r of buckets) detail(r);

  console.log(`\n${"─".repeat(78)}\nEVERYTHING ELSE — VISORS (${visors.length})\n${"─".repeat(78)}`);
  for (const r of visors) detail(r);

  console.log(`\n${"─".repeat(78)}\nNAME ALONE CANNOT CLASSIFY THESE (${unknown.length})\n${"─".repeat(78)}`);
  if (!unknown.length) console.log(`  none — every excluded record's name says either "bucket hat" or "visor", never both and never neither.`);
  for (const r of unknown) detail(r);

  // ── THE STOP CONDITION ─────────────────────────────────────────────────────
  const twoFit = buckets.filter((r) => r.positiveSized.length >= 2);
  console.log(`\n${"═".repeat(78)}\nSTOP CONDITION — bucket hats holding REAL stock in two or more sizes at once`);
  console.log(`${"═".repeat(78)}`);
  console.log(`A collapse here would merge two physically different fits (S/M and L/XL are`);
  console.log(`genuine on some brands) into ONE quantity, irreversibly. Owner decides per product.`);
  if (!twoFit.length) console.log(`\n  NONE. No bucket hat holds positive stock in more than one size key.`);
  for (const r of twoFit) {
    console.log(`\n  ${r.pid} "${r.name}" declares ${JSON.stringify(r.sizes)}`);
    for (const [loc, m] of Object.entries(r.cells)) {
      const live = Object.entries(m).filter(([, q]) => q !== 0);
      if (live.length) console.log(`     ${loc}: ${live.map(([k, q]) => `${k} ${q}`).join(" + ")}`);
    }
    console.log(`     sized units: ${r.positiveSized.map(([k, q]) => `${k}=${q}`).join(", ")}`);
  }

  const bucketSized = buckets.filter((r) => !r.alreadyOneSize);
  console.log(`\nBUCKET HATS THAT STILL DECLARE A SIZE RUN: ${bucketSized.length} of ${buckets.length}`);
  for (const r of bucketSized) console.log(`  ${r.pid} ${JSON.stringify(r.sizes)} "${r.name}" — ${r.totalUnits} unit(s)`);

  const negatives = rows.flatMap((r) => Object.entries(r.cells).flatMap(([loc, m]) =>
    Object.entries(m).filter(([, q]) => q < 0).map(([k, q]) => `${r.pid} "${r.name}" ${loc}/${k} = ${q}`)));
  console.log(`\nNEGATIVE CELLS AMONG THE EXCLUDED: ${negatives.length}`);
  for (const n of negatives) console.log(`  ${n}`);

  const blocking = rows.filter((r) => r.openRefs.some((x) => x.blocks));
  console.log(`\nEXCLUDED RECORDS CARRYING A BLOCKING OPEN REFERENCE: ${blocking.length}`);
  for (const r of blocking) for (const ref of r.openRefs.filter((x) => x.blocks)) {
    console.log(`  ${r.pid} "${r.name}" — ${ref.kind} ${ref.id}${ref.why ? ` — ${ref.why}` : ""}`);
  }

  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date(nowMs).toISOString(),
    counts: { total: rows.length, buckets: buckets.length, visors: visors.length, unclassifiable: unknown.length,
      bucketsStillSized: bucketSized.length, bucketsTwoFit: twoFit.length },
    rows }, null, 2));
  console.log(`\nJSON report: ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
