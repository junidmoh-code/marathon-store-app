// ─── CAPS & BEANIES — WHY IS SOLVE GREY? (READ-ONLY CENSUS, Junid 20 Nov 2026) ─
//
// Junid's report: in Missing Products some normal caps and beanies show Solve,
// others are greyed "No refill policy covers this one-size product yet" — same
// kind of product, different result. This census answers it from LIVE data, per
// product, with the REAL code on both sides:
//
//   • the engine: functions/lib/refill-engine.cjs resolveTarget, called at Hub 2
//     and Marathon PE for "_" and every declared size, reporting the branch
//     (explicit / category_policy / default / subcategory_default / none);
//   • the Solve mirror: src/components/stock/solvePlan.js resolvedRun +
//     qualifyingSizes over the same inputs NetworkTransfer hands it, then the
//     exact sentence actionReasons.solveReason returns.
//
// It writes NOTHING. Products are read in pages (scripts/lib/rtdbPaged.mjs —
// never one whole-node read); stock and /stock_targets are read per product,
// by key, at every location the shallow listing names.
//
// Scope printed: the named products in Junid's report, then every product on
// the Caps & Hats shelf, every product keyed caps-beanies or fitted-caps, and
// every product whose NAME says beanie/cap/bucket hat/visor wherever it is
// filed — grouped by cause.
//
// Usage:  node --import ./scripts/lib/appModuleLoader.mjs scripts/audit/caps-beanies-solve-census.mjs
//         CENSUS_JSON=/path/out.json …   (machine-readable copy)
import { createRequire } from "module";
import { writeFileSync } from "fs";
import { shallowKeys, readMapPaged } from "../lib/rtdbPaged.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const engine = require("./lib/refill-engine.cjs");
const { normalizeNetwork: normalizeNetworkCjs } = require("./lib/network-registry.cjs");
const { resolvedRun, qualifyingSizes, seedLocations, ruleTargetsEnabledFor } = await import("../../src/components/stock/solvePlan.js");
const { engineConfigView } = await import("../../src/components/stock/policyTemplate.js");
const { solveReason } = await import("../../src/components/stock/actionReasons.js");
const { computeMissingProducts, isClothing } = await import("../../src/components/stock/missingProductsCore.js");
const { solveHubFor, storeIds } = await import("../../src/components/stock/sectionRouting.js");
const { normalizeNetwork } = await import("../../src/utils/networkRegistry.js");
const { setCurrentNetworkFromRaw } = await import("../../src/utils/networkStore.js");
const { decodedCellKey } = await import("../../src/utils/sizeKey.js");

const app = admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = async (p) => (await db.ref(p).once("value")).val();

// Junid's named examples (20 Nov 2026), matched case-insensitively on the name.
export const NAMED_GREYED = ["Lacoste beanie black small logo", "Lacoste beanie grey", "Lacoste beanie green small lago", "Nike cap white"];
export const NAMED_SOLVABLE = ["Karl Lagerfeld beanie black 3", "Nike beanie white", "Nike beanie (brown)", "Timberland beanie brown", "Lacoste beanie white 3"];

const HEADWEAR_NAME = /\bbeanies?\b|\bcaps?\b|\bbucket\s*hats?\b|\bvisors?\b|\bsnapback\b|\btrucker\b|\bhats?\b/i;
const isCandidate = (p) => !!p && !p.mergedInto && (
  p.subcategory === "Caps & Hats" || p.categoryKey === "caps-beanies" || p.categoryKey === "fitted-caps" || HEADWEAR_NAME.test(String(p.name || "")));

const [config, rawNetwork, products, stockLocs, targetLocs] = await Promise.all([
  g("config/refillEngine"), g("network"),
  readMapPaged(db, "products", { pageSize: 500 }),
  shallowKeys(app, "stock"), shallowKeys(app, "stock_targets"),
]);
setCurrentNetworkFromRaw(rawNetwork);
const network = normalizeNetwork(rawNetwork);
const networkCjs = normalizeNetworkCjs(rawNetwork);

const cand = Object.entries(products).filter(([, p]) => isCandidate(p)).map(([pid, p]) => [pid, { ...p, id: p.id || pid }]);
const stock = {};
const targets = {};
await Promise.all(cand.flatMap(([pid]) => [
  ...stockLocs.map(async (loc) => { const v = await g(`stock/${loc}/${pid}`); if (v) (stock[loc] = stock[loc] || {})[pid] = v; }),
  ...targetLocs.map(async (loc) => { const v = await g(`stock_targets/${loc}/${pid}`); if (v) (targets[loc] = targets[loc] || {})[pid] = v; }),
]));
const prodMap = Object.fromEntries(cand);
// The browser holds every /stock cell DECODED (useStockCells); the engine reads
// the raw keys. Letters and "_" are identical either way.
const allStockDecoded = {};
for (const [loc, byPid] of Object.entries(stock)) for (const [pid, cells] of Object.entries(byPid)) {
  allStockDecoded[loc] = allStockDecoded[loc] || {};
  allStockDecoded[loc][pid] = Object.fromEntries(Object.entries(cells || {}).map(([k, c]) => [decodedCellKey(k), c]));
}

const ENGINE_LOCS = ["hub2", "marathon-pe"];
function engineAt(dest, pid, size) {
  const r = engine.resolveTarget({ targets, config, products: prodMap, stock, network: networkCjs }, dest, pid, size);
  return r ? `${r.source}:${r.target}` : "none";
}

// The mirror, exactly as NetworkTransfer composes it (runFor / qualifyingSizes /
// solveReason), over this product's own inputs.
const pcfg = engineConfigView(config, network);
const cards = computeMissingProducts({ allStock: allStockDecoded, products: cand.map(([, p]) => p), network, centralFed: config });
const cardOf = new Map(cards.map((c) => [c.pid, c]));
function mirror(pid) {
  const p = prodMap[pid];
  const sizes = (p.sizes || []).map(String).filter((s) => s.trim() !== "");
  const ruleEligible = isClothing(p);
  const qtyAt = (loc, sz) => Math.max(Number(allStockDecoded?.[loc]?.[pid]?.[decodedCellKey(sz)]?.qty) || 0, 0);
  const run = resolvedRun({
    std: ruleEligible ? (pcfg?.defaultRunByStore || {}) : {}, subRun: ruleEligible ? pcfg?.subcategoryRunByLocation : undefined,
    subcategory: p.subcategory, sizes, targets, pid, ruleBasedTargets: pcfg?.ruleBasedTargets,
    categoryPolicy: pcfg?.categoryPolicy, categoryKey: p.categoryKey,
    unitsAnywhere: (sz) => Object.keys(allStockDecoded).reduce((t, loc) => t + qtyAt(loc, sz), 0),
  });
  const card = cardOf.get(pid) || { pid, source: "central", units: 1 };
  const stores = storeIds(network, { section: 2 }).filter((s) => s !== "trophy" || true);
  const q = Object.fromEntries(stores.map((st) => {
    const hub = solveHubFor(network, st, p, pid);
    return [st, hub ? qualifyingSizes(sizes, card.source, st, run, hub) : []];
  }));
  const policyAtAnyStore = Object.values(q).some((a) => a.length > 0);
  const armed = stores.some((st) => seedLocations(card.source, st, solveHubFor(network, st, p, pid)).every((l) => ruleTargetsEnabledFor(pcfg?.ruleBasedTargets, l)));
  const reason = solveReason({
    canAct: true, configLoaded: true, configError: false, targetsLoaded: true, targetsError: false,
    hasSourceStock: true, policyAtAnyStore, ruleOnAnywhere: ruleEligible ? armed : true,
    oneSize: sizes.length > 0 && sizes.every((s) => s === "_"),
  });
  return { onCard: cardOf.has(pid), source: card.source, run: { hub2: run.hub2, "marathon-pe": run["marathon-pe"] }, qualifying: q, reason };
}

const rows = cand.map(([pid, p]) => {
  const sizes = (p.sizes || []).map(String);
  const sz = [...new Set(["_", ...sizes])];
  const eng = Object.fromEntries(ENGINE_LOCS.map((l) => [l, Object.fromEntries(sz.map((s) => [s, engineAt(l, pid, s)]))]));
  const explicit = Object.fromEntries(Object.entries(targets).filter(([, byPid]) => byPid[pid]).map(([loc, byPid]) => [loc, byPid[pid]]));
  const units = Object.fromEntries(Object.entries(stock).filter(([, b]) => b[pid]).map(([loc, b]) => [loc, Object.fromEntries(Object.entries(b[pid]).map(([k, c]) => [k, Number(c?.qty) || 0]))]));
  const m = mirror(pid);
  const engineSolvable = ENGINE_LOCS.some((l) => Object.values(eng[l]).some((v) => /:([1-9]\d*)$/.test(v)));
  const mirrorSolvable = m.reason === null;
  const name = String(p.name || "");
  const kind = /beanie/i.test(name) ? "beanie" : /bucket\s*hat/i.test(name) ? "bucket-hat" : /\bvisors?\b/i.test(name) ? "visor"
    : p.categoryKey === "fitted-caps" ? "fitted-cap" : /\bcaps?\b/i.test(name) ? "cap" : p.subcategory === "Caps & Hats" ? "cap(shelf only)" : "other-name-match";
  let cause = null;
  const ck = p.categoryKey;
  if (!mirrorSolvable) {
    const zeroRow = Object.values(explicit).some((rowBySize) => Object.values(rowBySize || {}).some((r) => r && r.target === 0));
    if (zeroRow) cause = "explicit target:0 row";
    else if (engineSolvable) cause = "Solve mirror diverges from engine";
    else if (ck !== "caps-beanies" && kind !== "fitted-cap" && kind !== "visor") cause = ck == null || ck === "" ? "missing categoryKey" : `wrong categoryKey (${JSON.stringify(ck)})`;
    else if (ck === "caps-beanies" && !sizes.includes("_")) cause = "still sized (no \"_\")";
    else cause = "other";
  }
  return { pid, name, kind, subcategory: p.subcategory ?? null, category: p.category ?? null, categoryKey: ck ?? null, sizes,
    createdAt: p.createdAt ?? null, createdVia: p.createdVia ?? p.source ?? null, deactivated: !!p.deactivated, units, explicit, engine: eng,
    mirror: m, engineSolvable, mirrorSolvable, cause };
});

const byName = (n) => rows.filter((r) => r.name.toLowerCase().trim() === n.toLowerCase());
const show = (r) => {
  console.log(`\n${r.name}  [${r.pid}]  kind=${r.kind}`);
  console.log(`   categoryKey=${JSON.stringify(r.categoryKey)}  subcategory=${JSON.stringify(r.subcategory)}  sizes=${JSON.stringify(r.sizes)}  createdAt=${r.createdAt}`);
  console.log(`   units=${JSON.stringify(r.units)}  explicitRows=${JSON.stringify(r.explicit)}`);
  console.log(`   engine hub2=${JSON.stringify(r.engine.hub2)}  marathon-pe=${JSON.stringify(r.engine["marathon-pe"])}`);
  console.log(`   mirror onCard=${r.mirror.onCard} source=${r.mirror.source} run=${JSON.stringify(r.mirror.run)} qualifying=${JSON.stringify(r.mirror.qualifying)}`);
  console.log(`   Solve reason: ${r.mirror.reason === null ? "null (AVAILABLE)" : JSON.stringify(r.mirror.reason)}   cause=${r.cause}`);
};
console.log("═".repeat(78)); console.log("  NAMED GREYED"); console.log("═".repeat(78));
for (const n of NAMED_GREYED) { const h = byName(n); if (!h.length) console.log(`\n${n}: NOT FOUND`); h.forEach(show); }
console.log("\n" + "═".repeat(78)); console.log("  NAMED SOLVABLE"); console.log("═".repeat(78));
for (const n of NAMED_SOLVABLE) { const h = byName(n); if (!h.length) console.log(`\n${n}: NOT FOUND`); h.forEach(show); }

console.log("\n" + "═".repeat(78)); console.log(`  CENSUS — ${rows.length} headwear candidates`); console.log("═".repeat(78));
const tally = (f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log("by kind:", tally((r) => r.kind));
console.log("by kind × categoryKey:", tally((r) => `${r.kind} | ${JSON.stringify(r.categoryKey)}`));
console.log("by kind × sizes:", tally((r) => `${r.kind} | ${r.sizes.every((s) => s === "_") && r.sizes.length ? "one-size" : JSON.stringify(r.sizes)}`));
const greyed = rows.filter((r) => r.mirror.onCard && !r.mirrorSolvable);
console.log(`\nOn a Missing Products card: ${rows.filter((r) => r.mirror.onCard).length}; greyed: ${greyed.length}`);
const groups = {};
for (const r of greyed) (groups[r.cause] = groups[r.cause] || []).push(r);
for (const [c, list] of Object.entries(groups)) {
  console.log(`\n── greyed: ${c} (${list.length})`);
  for (const r of list) console.log(`   ${r.kind.padEnd(16)} ${r.name}  [${r.pid}] key=${JSON.stringify(r.categoryKey)} sizes=${JSON.stringify(r.sizes)} → ${r.mirror.reason}`);
}
const div = rows.filter((r) => r.engineSolvable !== r.mirrorSolvable && r.mirror.onCard);
console.log(`\nengine-vs-mirror disagreements (on a card): ${div.length}`);
for (const r of div) console.log(`   ${r.name} [${r.pid}] engine=${r.engineSolvable} mirror=${r.mirrorSolvable}`);
console.log("\nEvery normal cap/beanie/bucket hat NOT keyed caps-beanies (on a card or not):");
for (const r of rows.filter((r) => ["beanie", "cap", "cap(shelf only)", "bucket-hat"].includes(r.kind) && r.categoryKey !== "caps-beanies"))
  console.log(`   ${r.kind.padEnd(16)} ${r.name} [${r.pid}] key=${JSON.stringify(r.categoryKey)} sub=${JSON.stringify(r.subcategory)} sizes=${JSON.stringify(r.sizes)} created=${r.createdAt}`);
console.log("\nEvery caps-beanies product still declaring a letter size:");
for (const r of rows.filter((r) => r.categoryKey === "caps-beanies" && !(r.sizes.length && r.sizes.every((s) => s === "_"))))
  console.log(`   ${r.kind.padEnd(16)} ${r.name} [${r.pid}] sizes=${JSON.stringify(r.sizes)} units=${JSON.stringify(r.units)}`);
if (process.env.CENSUS_JSON) writeFileSync(process.env.CENSUS_JSON, JSON.stringify(rows, null, 1));
process.exit(0);
