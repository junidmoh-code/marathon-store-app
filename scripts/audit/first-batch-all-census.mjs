// ─── FIRST BATCH, ALL CATEGORIES — READ-ONLY CENSUS (2026-09-17) ─────────────
// WRITES NOTHING. Answers the investigation questions behind widening the
// first-batch path (PR #607) from plain clothing to every non-sneaker,
// non-slide category:
//   1. which categories the Missing Products tab admits today, and which
//      Central-stranded cards exist per category (units, one-size or sized);
//   2. per card product, whether the ENGINE'S OWN resolver (resolveTarget,
//      imported — never re-implemented) answers a positive target at Hub 2 and
//      at each shop once a cell exists there — i.e. "has a Hub 2 policy and a
//      shop policy";
//   3. how Hub 2 is managed for each category today: unscoped map leg,
//      carriedOnly leg, explicit rows, or the clothing rule;
//   4. what LOCATION HISTORY exists that can be read scoped: explicit rows at
//      the shops, style-code siblings and their shop / Hub 2 cells;
//   5. the live first-batch rows so far, and the kill-switch positions.
// Paged reads only (readMapPaged), never a whole-node read.
//   node scripts/audit/first-batch-all-census.mjs [--dump] [--from-dump F]
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
// This file sits in scripts/audit/, so adminRequire's repo-relative base
// (../functions) misses; try THIS checkout's functions install first.
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const { resolveTarget, encodeSizeKey, categoryPolicyEntry, policyCategoryKey, isClothing } = req(join(ROOT, "functions", "lib", "refill-engine.cjs"));
const { locationPolicyFor } = req(join(ROOT, "functions", "lib", "policy-resolve.cjs"));

const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine"];
const SHOPS = ["marathon-pe", "trophy"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const cells = (row) => Object.entries(row || {}).filter(([, c]) => c && typeof c === "object");
const carries = (stock, loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const sumAt = (stock, loc, pid) => cells(stock?.[loc]?.[pid]).reduce((t, [, c]) => t + Math.max(num(c.qty), 0), 0);
const isPerfume = (p) => !!p && p.categoryKey === "perfumes";
const isDeactivated = (p) => !!(p && p.deactivated);
// The tab's admission predicate, as of PR #608: the complement of the engine's
// footwear group (missingProductsCore.inFootwearGroup — a CJS restatement here
// because that module is ESM; the vitest suite pins the key list to the
// engine's). "admitted (#607)" below is the OLD gate, kept so the census still
// shows what the widening changed.
const FOOTWEAR_GROUP_KEYS = new Set(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes"]);
const inFootwearGroup = (p) => !!p && !isClothing(p) && (p.category === "Footwear" || FOOTWEAR_GROUP_KEYS.has(policyCategoryKey(p) || ""));
const admitsMissingProduct = (p) => !!p && !inFootwearGroup(p);

async function readLive() {
  const admin = req("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const config = (await db.ref("config/refillEngine").once("value")).val() || {};
  const taxonomy = (await db.ref("settings/productTaxonomy").once("value")).val();
  const products = await readMapPaged(db, "products");
  const stock = {};
  for (const l of LOCS) stock[l] = await readMapPaged(db, `stock/${l}`);
  const targets = {};
  for (const l of ["hub2", ...SHOPS]) targets[l] = await readMapPaged(db, `stock_targets/${l}`);
  const refill = await readMapPaged(db, "refill_requests");
  const open = (await db.ref("refill_engine/open").once("value")).val() || {};
  const runs = (await db.ref("refill_engine/runs").orderByKey().limitToLast(1).once("value")).val();
  return { config, taxonomy, products, stock, targets, refill, open, runs, readAt: new Date().toISOString() };
}

(async () => {
  let snap;
  const from = opt("--from-dump");
  if (from) snap = JSON.parse(readFileSync(from, "utf8"));
  else {
    snap = await readLive();
    if (flag("--dump")) {
      mkdirSync(join(ROOT, "var"), { recursive: true });
      const f = join(ROOT, "var", `first-batch-all-snapshot-${snap.readAt.replace(/[:.]/g, "-")}.json`);
      writeFileSync(f, JSON.stringify(snap));
      console.log("snapshot →", f);
    }
  }
  const { config, taxonomy, products, stock, targets, refill, open, runs } = snap;
  const out = [];
  const say = (...a) => { out.push(a.join(" ")); console.log(...a); };

  say("# First batch all categories — census", snap.readAt);
  say("\n## Kill switches / config");
  for (const k of ["enabled", "ruleBasedTargets", "footwearTargets", "maxUnitsPerIntent", "maxIntentsPerRun"]) say(`- ${k}: ${JSON.stringify(config[k])}`);
  say(`- routes: ${JSON.stringify(config.routes)}`);
  say(`- mode: ${JSON.stringify(config.mode)}`);
  say(`- last run: ${JSON.stringify(runs)}`.slice(0, 400));
  say("\n## categoryPolicy legs (live)");
  for (const [key, ent] of Object.entries(config.categoryPolicy || {}).sort()) {
    const legs = Object.entries(ent || {}).filter(([k, v]) => k !== "perSize" && v && typeof v === "object")
      .map(([loc, v]) => `${loc}${v.carriedOnly ? "(carriedOnly)" : ""}${v.sizes ? "(map)" : `=${v.target}`}`);
    say(`- ${key}${ent.perSize ? " perSize" : ""}: ${legs.join(", ")}`);
  }
  say(`- policyGroups: ${JSON.stringify(config.policyGroups)}`.slice(0, 600));

  const cats = taxonomy?.cats || {};
  say(`\n## Taxonomy registry: ${Object.keys(cats).length} categories`);
  const byTop = {};
  for (const c of Object.values(cats)) (byTop[c.top] = byTop[c.top] || []).push(`${c.key}[${c.legacy?.productType ?? "∅"}]`);
  for (const [top, ks] of Object.entries(byTop)) say(`- ${top}: ${ks.sort().join(", ")}`);

  // ── catalogue by effective key ──────────────────────────────────────────
  say("\n## Catalogue by effective category key (all products)");
  const cat = {};
  for (const [pid, p] of Object.entries(products)) {
    if (!p || typeof p !== "object") continue;
    const key = policyCategoryKey({ ...p, id: pid }) || "(no key)";
    const c = (cat[key] = cat[key] || { n: 0, types: {}, clothing: 0, perfume: 0, admitted: 0, deact: 0, oneSize: 0, styleCode: 0, alternatives: 0, atShop: 0, atHub2: 0 });
    c.n++;
    const t = p.productType || "∅"; c.types[t] = (c.types[t] || 0) + 1;
    if (isClothing(p)) c.clothing++;
    if (isPerfume(p)) c.perfume++;
    if (admitsMissingProduct(p)) c.admitted++;
    if (isClothing(p) || isPerfume(p)) c.admitted607 = (c.admitted607 || 0) + 1;
    if (isDeactivated(p)) c.deact++;
    const sizes = (p.sizes || []).map(String);
    if (sizes.length === 1 && sizes[0] === "_") c.oneSize++;
    if (p.styleCodeNormalised) c.styleCode++;
    if (p.alternatives) c.alternatives++;
    if (SHOPS.some((s) => carries(stock, s, pid))) c.atShop++;
    if (carries(stock, "hub2", pid)) c.atHub2++;
  }
  say("| key | n | productType | isClothing | isPerfume | admitted to Missing Products (#608 / #607) | deactivated | one-size | styleCode | alternatives | carried at a shop | carried at Hub 2 |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, c] of Object.entries(cat).sort((a, b) => b[1].n - a[1].n)) {
    say(`| ${k} | ${c.n} | ${Object.entries(c.types).map(([t, n]) => `${t}:${n}`).join(" ")} | ${c.clothing} | ${c.perfume} | ${c.admitted} / ${c.admitted607 || 0} | ${c.deact} | ${c.oneSize} | ${c.styleCode} | ${c.alternatives} | ${c.atShop} | ${c.atHub2} |`);
  }

  // ── the cards: Only in Central ──────────────────────────────────────────
  say("\n## Central-stranded products (the 'Only in Central' cards), by key");
  say("Card = Central units > 0, no Hub 2 node, no shop node, not deactivated. 'admitted' = isClothing || isPerfume (today's tab gate). Policies asked of the REAL resolveTarget with a hypothetical seed at the destination.");
  const ctxFor = (pid, dest) => {
    const p = products[pid];
    const st = {};
    for (const l of LOCS) st[l] = { [pid]: stock[l]?.[pid] || {} };
    const seeded = { ...(st[dest][pid] || {}) };
    for (const s of p.sizes || []) if (seeded[encodeSizeKey(String(s))] == null) seeded[encodeSizeKey(String(s))] = { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live" };
    st[dest] = { [pid]: seeded };
    return { config, products: { [pid]: p }, stock: st, targets: { hub2: { [pid]: targets.hub2?.[pid] }, "marathon-pe": { [pid]: targets["marathon-pe"]?.[pid] }, trophy: { [pid]: targets.trophy?.[pid] } } };
  };
  const policyAt = (pid, dest) => {
    const p = products[pid];
    const ctx = ctxFor(pid, dest);
    const res = {};
    for (const s of (p.sizes || []).map(String)) { const t = resolveTarget(ctx, dest, pid, s); res[s] = t ? { target: t.target, source: t.source } : null; }
    return res;
  };
  const cardsByKey = {};
  const cardRows = [];
  for (const [pid, p] of Object.entries(products)) {
    if (!p || typeof p !== "object") continue;
    if (isDeactivated(p)) continue;
    const ce = sumAt(stock, "central", pid);
    if (!(ce > 0)) continue;
    if (carries(stock, "hub2", pid) || SHOPS.some((s) => carries(stock, s, pid))) continue;
    const key = policyCategoryKey({ ...p, id: pid }) || "(no key)";
    const admitted = admitsMissingProduct(p);
    const admitted607 = isClothing(p) || isPerfume(p);
    const hub2 = policyAt(pid, "hub2"), pe = policyAt(pid, "marathon-pe"), tr = policyAt(pid, "trophy");
    const any = (m) => Object.values(m).some((t) => t && t.target > 0);
    const src = (m) => [...new Set(Object.values(m).filter((t) => t && t.target > 0).map((t) => t.source))].join("/");
    const hubLeg = locationPolicyFor(config, key, "hub2");
    const row = {
      pid, key, name: p.name, admitted, admitted607, oneSize: (p.sizes || []).length === 1 && String(p.sizes[0]) === "_", sizes: (p.sizes || []).length,
      units: ce, hub2Policy: any(hub2), hub2Src: src(hub2), pePolicy: any(pe), peSrc: src(pe), trPolicy: any(tr), trSrc: src(tr),
      explicitHub2: !!targets.hub2?.[pid], explicitPe: !!targets["marathon-pe"]?.[pid], explicitTr: !!targets.trophy?.[pid],
      hub2Leg: hubLeg ? (hubLeg.carriedOnly ? "carriedOnly" : "unscoped") : "none",
      openHub2Lock: !!open?.hub2?.[pid], openShopLock: SHOPS.filter((s) => !!open?.[s]?.[pid]).join("/"),
      styleCode: p.styleCodeNormalised || null,
    };
    cardRows.push(row);
    const c = (cardsByKey[key] = cardsByKey[key] || { n: 0, units: 0, admitted: 0, oneSize: 0, hub2Policy: 0, shopPolicy: 0, bothShops: 0, explicitHub2: 0, explicitShop: 0, unscopedLeg: 0, carriedOnlyLeg: 0, openHub2Lock: 0, noPolicyAnywhere: 0, styleCode: 0, srcs: {} });
    c.n++; c.units += ce; if (admitted) c.admitted++; if (row.oneSize) c.oneSize++;
    if (row.hub2Policy) c.hub2Policy++; if (row.pePolicy || row.trPolicy) c.shopPolicy++; if (row.pePolicy && row.trPolicy) c.bothShops++;
    if (row.explicitHub2) c.explicitHub2++; if (row.explicitPe || row.explicitTr) c.explicitShop++;
    if (row.hub2Leg === "unscoped") c.unscopedLeg++; if (row.hub2Leg === "carriedOnly") c.carriedOnlyLeg++;
    if (row.openHub2Lock) c.openHub2Lock++;
    if (!row.hub2Policy && !row.pePolicy && !row.trPolicy) c.noPolicyAnywhere++;
    if (row.styleCode) c.styleCode++;
    const sk = `${row.hub2Src || "-"}|${row.peSrc || "-"}|${row.trSrc || "-"}`; c.srcs[sk] = (c.srcs[sk] || 0) + 1;
  }
  say("| key | cards | units | admitted | one-size | Hub 2 policy | shop policy (either) | both shops | explicit Hub 2 row | explicit shop row | unscoped hub2 leg | carriedOnly hub2 leg | open engine hub2 lock now | NO policy anywhere | styleCode | sources hub2\\|pe\\|trophy |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, c] of Object.entries(cardsByKey).sort((a, b) => b[1].n - a[1].n)) {
    say(`| ${k} | ${c.n} | ${c.units} | ${c.admitted} | ${c.oneSize} | ${c.hub2Policy} | ${c.shopPolicy} | ${c.bothShops} | ${c.explicitHub2} | ${c.explicitShop} | ${c.unscopedLeg} | ${c.carriedOnlyLeg} | ${c.openHub2Lock} | ${c.noPolicyAnywhere} | ${c.styleCode} | ${Object.entries(c.srcs).map(([s, n]) => `${s}:${n}`).join(" ")} |`);
  }
  say(`\nTotal cards: ${cardRows.length}; admitted (#608 gate): ${cardRows.filter((r) => r.admitted).length}; admitted by the #607 gate: ${cardRows.filter((r) => r.admitted607).length}; with an open engine Hub 2 lock right now: ${cardRows.filter((r) => r.openHub2Lock).length}; with an open shop lock: ${cardRows.filter((r) => r.openShopLock).length}`);
  say("\n### Cards with NO policy at Hub 2 or either shop (the ones the widened path cannot arm without inventing numbers)");
  for (const r of cardRows.filter((x) => !x.hub2Policy && !x.pePolicy && !x.trPolicy).slice(0, 60)) say(`- ${r.pid} ${r.key} "${r.name}" units ${r.units} sizes ${r.sizes}${r.oneSize ? " one-size" : ""}`);
  say("\n### Cards with a Hub 2 policy but NO shop policy at either shop");
  for (const r of cardRows.filter((x) => x.hub2Policy && !x.pePolicy && !x.trPolicy).slice(0, 60)) say(`- ${r.pid} ${r.key} "${r.name}" units ${r.units} hub2 ${r.hub2Src}`);
  say("\n### Cards with a shop policy but NO Hub 2 policy");
  for (const r of cardRows.filter((x) => !x.hub2Policy && (x.pePolicy || x.trPolicy)).slice(0, 60)) say(`- ${r.pid} ${r.key} "${r.name}" units ${r.units} pe ${r.peSrc} trophy ${r.trSrc}`);

  // ── location history that can be read scoped ───────────────────────────
  say("\n## Location history available per card product (scoped sources only)");
  const byCode = {};
  for (const [pid, p] of Object.entries(products)) if (p?.styleCodeNormalised) (byCode[p.styleCodeNormalised] = byCode[p.styleCodeNormalised] || []).push(pid);
  let withSib = 0, sibAtShop = 0, sibAtHub2 = 0, ownRowShop = 0, ownRowHub2 = 0, sibRowShop = 0;
  const sibShopDetail = {};
  for (const r of cardRows) {
    const sibs = r.styleCode ? (byCode[r.styleCode] || []).filter((x) => x !== r.pid) : [];
    if (sibs.length) withSib++;
    const atShop = SHOPS.filter((s) => sibs.some((x) => carries(stock, s, x)));
    if (atShop.length) { sibAtShop++; sibShopDetail[atShop.join("+")] = (sibShopDetail[atShop.join("+")] || 0) + 1; }
    if (sibs.some((x) => carries(stock, "hub2", x))) sibAtHub2++;
    if (r.explicitPe || r.explicitTr) ownRowShop++;
    if (r.explicitHub2) ownRowHub2++;
    if (sibs.some((x) => SHOPS.some((s) => !!targets[s]?.[x]))) sibRowShop++;
  }
  say(`- cards with a style code: ${cardRows.filter((r) => r.styleCode).length}; with ≥1 style-code sibling: ${withSib}; sibling carried at a shop: ${sibAtShop} ${JSON.stringify(sibShopDetail)}; sibling carried at Hub 2: ${sibAtHub2}; sibling with an explicit shop row: ${sibRowShop}`);
  say(`- cards with their OWN explicit row at a shop: ${ownRowShop}; at Hub 2: ${ownRowHub2}`);
  // How do carried products split between the shops today, per key (the prior the history rides on)?
  say("\n### Where each category currently sits (products carried, any qty) — the category's own placement prior");
  const place = {};
  for (const [pid, p] of Object.entries(products)) {
    if (!p || typeof p !== "object") continue;
    const key = policyCategoryKey({ ...p, id: pid }) || "(no key)";
    const c = (place[key] = place[key] || { pe: 0, tr: 0, both: 0, hub2: 0, peUnits: 0, trUnits: 0 });
    const pe = carries(stock, "marathon-pe", pid), tr = carries(stock, "trophy", pid);
    if (pe) c.pe++; if (tr) c.tr++; if (pe && tr) c.both++; if (carries(stock, "hub2", pid)) c.hub2++;
    c.peUnits += sumAt(stock, "marathon-pe", pid); c.trUnits += sumAt(stock, "trophy", pid);
  }
  say("| key | at Marathon PE | at Trophy | at both | at Hub 2 | PE units | Trophy units |");
  say("|---|---|---|---|---|---|---|");
  for (const [k, c] of Object.entries(place).sort((a, b) => (b[1].pe + b[1].tr) - (a[1].pe + a[1].tr))) if (c.pe + c.tr + c.hub2) say(`| ${k} | ${c.pe} | ${c.tr} | ${c.both} | ${c.hub2} | ${c.peUnits} | ${c.trUnits} |`);

  // ── refill requests: first-batch rows, and shop-level history ──────────
  say("\n## /refill_requests");
  const rows = Object.entries(refill);
  const fb = rows.filter(([, r]) => r?.createdFrom?.firstBatch === true);
  say(`- rows: ${rows.length}; first-batch tagged: ${fb.length} ${JSON.stringify(fb.map(([id, r]) => ({ id, loc: r.requestingLocation, pid: r.productId, size: r.size, qty: r.qty, status: r.status, leg: r.firstBatch?.hub2Leg ? Object.keys(r.firstBatch.hub2Leg)[0] : null })))}`);
  const openByLoc = {};
  for (const [, r] of rows) if (r?.status === "open") openByLoc[r.requestingLocation] = (openByLoc[r.requestingLocation] || 0) + 1;
  say(`- open by location: ${JSON.stringify(openByLoc)}`);
  const shopFulfilled = {};
  for (const [, r] of rows) if (SHOPS.includes(r?.requestingLocation) && r.status === "fulfilled") shopFulfilled[r.requestingLocation] = (shopFulfilled[r.requestingLocation] || 0) + 1;
  say(`- fulfilled shop rows (a 'sent before' record, unindexed by product): ${JSON.stringify(shopFulfilled)}`);

  mkdirSync(join(ROOT, "var"), { recursive: true });
  const f = join(ROOT, "var", `first-batch-all-census-${snap.readAt.replace(/[:.]/g, "-")}.md`);
  writeFileSync(f, out.join("\n"));
  console.log("\nreport →", f);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e?.stack || e); process.exit(1); });
