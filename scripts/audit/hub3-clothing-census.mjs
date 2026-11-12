// ─── HUB 3 CLOTHING CENSUS (Junid, 12 Nov 2026) — READ-ONLY ──────────────────
// Maps the state the 12 Nov division change starts from. Reads a snapshot made
// by scripts/audit/concrete-division-dump.mjs (paged, scoped reads) and writes
// NOTHING to the database. Prints a markdown report.
//
//   node scripts/audit/hub3-clothing-census.mjs <dump.json> [out.md]
//
// FOOTWEAR is decided by the engine's own division test (concrete-division.cjs
// isDivisionFootwear: category "Footwear", or one of the eight footwear category
// keys). The catalogue rule (footwearLine.js productIsFootwear: the key when a
// product has one, else category "Footwear") is checked beside it and every
// product the two disagree on is listed, so nothing moves on a classifier split
// without being named.
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const dv = require("../../functions/lib/concrete-division.cjs");

const CATALOGUE_FOOTWEAR_KEYS = ["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes"];
function catalogueIsFootwear(p) {
  if (!p) return false;
  const key = typeof p.categoryKey === "string" ? p.categoryKey.trim() : "";
  if (key) return CATALOGUE_FOOTWEAR_KEYS.includes(key);
  return p.category === "Footwear";
}

export function hub3ClothingCensus(dump) {
  const products = dump.products || {};
  const hub3 = dump.stock?.hub3 || {};
  const seats = dump.seats || {};
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const qtyOf = (c) => (isObj(c) && typeof c.qty === "number" ? c.qty : null);
  const name = (pid) => products[pid]?.name || "(no product record)";
  const catOf = (pid) => { const p = products[pid]; return p ? (p.categoryKey || p.category || "uncategorised") : "no product record"; };

  const cells = { positive: [], zero: [], negative: [], noQty: [] };
  const disagree = [];
  const byCat = {};
  for (const [pid, row] of Object.entries(hub3)) {
    if (pid === "_meta" || !isObj(row) && !Array.isArray(row)) continue;
    const p = products[pid];
    if (dv.isDivisionFootwear(p)) { if (!catalogueIsFootwear(p)) disagree.push({ pid, name: name(pid), engine: "footwear", catalogue: "not footwear", category: p?.category, categoryKey: p?.categoryKey || null }); continue; }
    if (catalogueIsFootwear(p)) disagree.push({ pid, name: name(pid), engine: "not footwear", catalogue: "footwear", category: p?.category, categoryKey: p?.categoryKey || null });
    for (const [sizeKey, c] of Object.entries(row)) {
      if (c == null) continue;
      const q = qtyOf(c);
      const owner = seats.hub3?.[pid]?.owner || null;
      const rec = { pid, sizeKey, qty: q, name: name(pid), category: catOf(pid), owner, trusted: !!c.trusted };
      if (q === null) cells.noQty.push(rec); else if (q > 0) cells.positive.push(rec); else if (q < 0) cells.negative.push(rec); else cells.zero.push(rec);
      const b = (byCat[catOf(pid)] ||= { products: new Set(), positiveUnits: 0, cells: 0 });
      b.products.add(pid); b.cells++; if (q > 0) b.positiveUnits += q;
    }
  }
  const sum = (l) => l.reduce((t, r) => t + (r.qty || 0), 0);
  const pidsOf = (l) => new Set(l.map((r) => r.pid));

  // Hub 3 non-footwear seats, by owning shop.
  const hub3Seats = Object.entries(seats.hub3 || {}).filter(([pid]) => !dv.isDivisionFootwear(products[pid]));
  const seatsByOwner = {};
  for (const [, s] of hub3Seats) { const k = s?.owner || "no owner"; seatsByOwner[k] = (seatsByOwner[k] || 0) + 1; }
  const viaCount = {};
  for (const [, s] of hub3Seats) { const k = s?.via || "?"; viaCount[k] = (viaCount[k] || 0) + 1; }

  // Open requests (the dump holds the newest 6,000 by key, plus the lock table).
  const reqs = dump.recentRequests || {};
  const open = Object.entries(reqs).filter(([, r]) => r && r.status === "open" && !r.shadow);
  const srcOf = (r) => r.createdFrom?.source || r.source || null;
  const hub3NonFw = open.filter(([, r]) => r.requestingLocation === "hub3" && !dv.isDivisionFootwear(products[r.productId]));
  const shopFromHub3 = open.filter(([, r]) => dv.DIVISION_SHOPS.includes(r.requestingLocation) && srcOf(r) === "hub3" && !dv.isDivisionFootwear(products[r.productId]));
  const lockRefs = [];
  for (const [dest, byPid] of Object.entries(dump.open || {})) {
    for (const [pid, bySize] of Object.entries(byPid || {})) for (const [sk, e] of Object.entries(bySize || {})) {
      if (!e?.refillId || dv.isDivisionFootwear(products[pid])) continue;
      if (dest === "hub3" || (dv.DIVISION_SHOPS.includes(dest) && e.source === "hub3")) lockRefs.push({ dest, pid, sizeKey: sk, refillId: e.refillId, inDump: !!reqs[e.refillId] });
    }
  }

  // Concrete / Pine products on the Hub 3-owned path today (the engine as live:
  // a shop asks Hub 3 for a size Hub 3 serves, or the other shop owns it).
  const config = dump.config || {};
  const division = dv.divisionContext({ config, rawStock: dump.stock, seats, openIndex: dump.open, heldLines: dump.held, refillRequests: reqs, nowMs: Date.parse(dump.readAt) });
  const onHub3Path = { concrete: new Set(), "marathon-pine": new Set() };
  const ownedByOther = { concrete: new Set(), "marathon-pine": new Set() };
  if (division && typeof dv.hub3ServesSize === "function") {
    for (const shop of dv.DIVISION_SHOPS) {
      for (const pid of Object.keys(seats[shop] || {})) {
        const p = products[pid];
        if (!p || dv.isDivisionFootwear(p) || dv.divisionNeverKeeps(shop, p)) continue;
        if (!division.hub3Present.has(pid)) continue;
        const owner = seats.hub3?.[pid]?.owner;
        if (owner && owner !== shop) { ownedByOther[shop].add(pid); continue; }
        if (dv.divisionSizes(p).some((s) => dv.hub3ServesSize(division, pid, s))) onHub3Path[shop].add(pid);
      }
    }
  }

  // Explicit /stock_targets rows at Hub 3 for non-footwear.
  const explicitHub3 = [];
  for (const [pid, bySize] of Object.entries(dump.targets?.hub3 || {})) {
    if (dv.isDivisionFootwear(products[pid])) continue;
    for (const [sk, row] of Object.entries(bySize || {})) if (row && typeof row.target === "number") explicitHub3.push({ pid, sizeKey: sk, target: row.target });
  }
  // Held boxes into Hub 3 for non-footwear.
  const heldHub3 = Object.entries(dump.held?.hub3 || {}).filter(([, l]) => l && l.productId && !dv.isDivisionFootwear(products[l.productId]));

  const perfumes = cells.positive.filter((r) => dv.divisionNeverKeeps("concrete", products[r.pid]));
  return {
    readAt: dump.readAt,
    positive: { cells: cells.positive.length, products: pidsOf(cells.positive).size, units: sum(cells.positive) },
    zero: { cells: cells.zero.length, products: pidsOf(cells.zero).size },
    negative: { cells: cells.negative.length, products: pidsOf(cells.negative).size, units: sum(cells.negative), list: cells.negative },
    noQty: cells.noQty,
    byOwner: Object.fromEntries(["concrete", "marathon-pine", null].map((o) => {
      const l = cells.positive.filter((r) => r.owner === o);
      return [o || "no owner", { products: pidsOf(l).size, units: sum(l) }];
    })),
    byCategory: Object.fromEntries(Object.entries(byCat).sort((a, b) => b[1].positiveUnits - a[1].positiveUnits).map(([k, v]) => [k, { products: v.products.size, cells: v.cells, positiveUnits: v.positiveUnits }])),
    perfumes: { cells: perfumes.length, products: pidsOf(perfumes).size, units: sum(perfumes), list: [...pidsOf(perfumes)].map((pid) => ({ pid, name: name(pid) })) },
    noProductRecord: [...pidsOf([...cells.positive, ...cells.zero, ...cells.negative])].filter((pid) => !products[pid]),
    classifierDisagreements: disagree,
    hub3Seats: { total: hub3Seats.length, byOwner: seatsByOwner, byVia: viaCount },
    openRequests: {
      newestKeysRead: Object.keys(reqs).length,
      hub3NonFootwear: hub3NonFw.length, hub3NonFootwearUnits: hub3NonFw.reduce((t, [, r]) => t + (Number(r.qty) || 0), 0),
      shopFromHub3NonFootwear: shopFromHub3.length,
      shopFromHub3ByShop: shopFromHub3.reduce((o, [, r]) => ({ ...o, [r.requestingLocation]: (o[r.requestingLocation] || 0) + 1 }), {}),
      locksNamingRequests: lockRefs.length, locksOutsideDump: lockRefs.filter((l) => !l.inDump).length,
    },
    onHub3Path: { concrete: onHub3Path.concrete.size, "marathon-pine": onHub3Path["marathon-pine"].size },
    ownedByOtherShop: { concrete: ownedByOther.concrete.size, "marathon-pine": ownedByOther["marathon-pine"].size },
    explicitHub3Rows: { rows: explicitHub3.length, armed: explicitHub3.filter((r) => r.target > 0).length },
    heldIntoHub3NonFootwear: heldHub3.length,
  };
}

export function censusMarkdown(c) {
  const L = [];
  L.push(`# Hub 3 clothing census — snapshot ${c.readAt}`, "");
  L.push("Footwear = the engine's division test (`isDivisionFootwear`). Everything else at Hub 3 is in scope.", "");
  L.push("## Hub 3 non-footwear cells", "");
  L.push(`| | cells | products | units |`, `|---|---:|---:|---:|`);
  L.push(`| above zero (move to Concrete) | ${c.positive.cells} | ${c.positive.products} | ${c.positive.units} |`);
  L.push(`| at zero | ${c.zero.cells} | ${c.zero.products} | 0 |`);
  L.push(`| below zero | ${c.negative.cells} | ${c.negative.products} | ${c.negative.units} |`);
  L.push(`| no numeric qty | ${c.noQty.length} | | |`, "");
  L.push("Units above zero by Hub 3 owning shop:", "");
  for (const [k, v] of Object.entries(c.byOwner)) L.push(`- ${k}: ${v.products} products, ${v.units} units`);
  L.push("", "By category:", "", "| category | products | cells | units > 0 |", "|---|---:|---:|---:|");
  for (const [k, v] of Object.entries(c.byCategory)) L.push(`| ${k} | ${v.products} | ${v.cells} | ${v.positiveUnits} |`);
  L.push("", `Perfumes above zero (move, no keep, no seat): ${c.perfumes.products} products, ${c.perfumes.units} units.`);
  L.push(`Cells whose product record is gone: ${c.noProductRecord.length}${c.noProductRecord.length ? ` (${c.noProductRecord.join(", ")})` : ""}.`);
  L.push(`Classifier disagreements (engine vs catalogue): ${c.classifierDisagreements.length}.`);
  for (const d of c.classifierDisagreements) L.push(`- ${d.pid} ${d.name}: engine ${d.engine}, catalogue ${d.catalogue} (category ${d.category}, key ${d.categoryKey})`);
  if (c.negative.list.length) {
    L.push("", "Negative cells:", "");
    for (const r of c.negative.list) L.push(`- ${r.pid} ${r.sizeKey} = ${r.qty} — ${r.name}`);
  }
  L.push("", "## Hub 3 non-footwear seats", "");
  L.push(`${c.hub3Seats.total} seats. By owner: ${Object.entries(c.hub3Seats.byOwner).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}. By how seated: ${Object.entries(c.hub3Seats.byVia).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`);
  L.push("", "## Open requests", "");
  L.push(`- Hub 3 non-footwear: ${c.openRequests.hub3NonFootwear} (${c.openRequests.hub3NonFootwearUnits} units)`);
  L.push(`- Concrete/Pine non-footwear sourced from Hub 3: ${c.openRequests.shopFromHub3NonFootwear} (${Object.entries(c.openRequests.shopFromHub3ByShop).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  L.push(`- Engine locks naming such requests: ${c.openRequests.locksNamingRequests} (${c.openRequests.locksOutsideDump} outside the ${c.openRequests.newestKeysRead} newest requests read)`);
  L.push("", "## Concrete / Pine on the Hub 3-owned path today", "");
  L.push(`- asking Hub 3 for at least one size: Concrete ${c.onHub3Path.concrete}, Pine ${c.onHub3Path["marathon-pine"]}`);
  L.push(`- owned at Hub 3 by the other shop (no keep at all): Concrete ${c.ownedByOtherShop.concrete}, Pine ${c.ownedByOtherShop["marathon-pine"]}`);
  L.push(`- explicit /stock_targets rows at Hub 3 for non-footwear: ${c.explicitHub3Rows.rows} (${c.explicitHub3Rows.armed} above 0)`);
  L.push(`- held boxes into Hub 3, non-footwear: ${c.heldIntoHub3NonFootwear}`);
  return L.join("\n") + "\n";
}

if (process.argv[1] && process.argv[1].endsWith("hub3-clothing-census.mjs")) {
  const dump = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const md = censusMarkdown(hub3ClothingCensus(dump));
  if (process.argv[3]) writeFileSync(process.argv[3], md);
  process.stdout.write(md);
}
