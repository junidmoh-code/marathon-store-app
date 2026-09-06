// ── PRECOMPUTED NEIGHBOURS — the whole matrix, once, offline ─────────────────
// Scores every enriched sneaker against every other and writes the top twelve
// onto each product record as /products/{pid}/alternatives. The app then reads
// a list and computes NOTHING: 1,410 products is ~1M pairs, and doing that in a
// phone at the moment a chip is tapped is a frozen screen in front of a
// customer.
//
//   node scripts/shopify/build-neighbours.mjs                DRY RUN + the spot-check
//   node scripts/shopify/build-neighbours.mjs --spot 20      spot-check N products
//   node scripts/shopify/build-neighbours.mjs --apply        write the lists
//   node scripts/shopify/build-neighbours.mjs --prune        also CLEAR lists that no longer qualify
//
// COSTS NOTHING. No model call — arithmetic over what extract-attributes.mjs
// already wrote.
//
// ── WHO CAN BE A NEIGHBOUR ───────────────────────────────────────────────────
// A product that could actually be sold to the customer standing there. So:
// enriched, not merged away, not deactivated (#445/#532/#566 — a finished line
// must never be offered), carrying a photo, and carrying a price. A suggestion
// that cannot be sold is worse than no suggestion, and the sheet is built to
// show nothing rather than to show something unsellable.
//
// LIVE AVAILABILITY IS NOT CHECKED HERE, deliberately. Stock moves by the
// minute and this list is written once; the app joins each candidate to the
// shared availability resolver at render time and drops whatever cannot be
// given out right now (App.jsx, availabilityCore).
//
// WRITES: /products/{pid}/alternatives only. One child, never the record.
import { createRequire } from "module";
import "./env.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { isDeactivated } from "../../src/utils/deactivation.js";
import { ATTRIBUTES_PATH, usableAttributes } from "../../src/utils/productAttributes.js";
import {
  neighbourProfile, topNeighbours, scorePair, encodeNeighbour, matchReasonText,
  MAX_NEIGHBOURS, NEIGHBOURS_FIELD, SIMILARITY_WEIGHTS,
} from "../../src/utils/productNeighbours.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { isSneakerProduct } from "../lib/sneakerScope.mjs";

const flags = process.argv.slice(2);
const arg = (n) => { const i = flags.indexOf(n); if (i === -1) return null; const v = flags[i + 1]; if (!v || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); } return v; };
const APPLY = flags.includes("--apply");
const PRUNE = flags.includes("--prune");
const SPOT = arg("--spot") ? Number(arg("--spot")) : 20;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const products = await readMapPaged(db, "products", { pageSize: 500 });
const attrs = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });

const rejected = { notSneaker: 0, merged: 0, deactivated: 0, noPhoto: 0, noPrice: 0, unenriched: 0, noSilhouette: 0 };
const profiles = [];
const productOf = {};
for (const [pid, p] of Object.entries(products)) {
  if (!p?.id) continue;
  if (!isSneakerProduct(p)) { rejected.notSneaker += 1; continue; }
  if (p.mergedInto) { rejected.merged += 1; continue; }
  if (isDeactivated(p)) { rejected.deactivated += 1; continue; }
  if (!String(p.photoUrl || "").trim()) { rejected.noPhoto += 1; continue; }
  if (!(Number(p.retailPrice) > 0)) { rejected.noPrice += 1; continue; }
  const a = usableAttributes(attrs[pid]);
  if (!a) { rejected.unenriched += 1; continue; }
  const prof = neighbourProfile(p, a);
  if (!prof) { rejected.noSilhouette += 1; continue; }
  profiles.push(prof);
  productOf[pid] = p;
}
profiles.sort((a, b) => a.pid.localeCompare(b.pid));

console.log(`candidate pool: ${profiles.length} sneaker(s)`);
console.log(`  excluded — not a sneaker: ${rejected.notSneaker} · merged: ${rejected.merged} · ` +
            `deactivated: ${rejected.deactivated} · no photo: ${rejected.noPhoto} · no price: ${rejected.noPrice} · ` +
            `not enriched: ${rejected.unenriched} · silhouette unusable: ${rejected.noSilhouette}`);
console.log(`weights: ${Object.entries(SIMILARITY_WEIGHTS).map(([k, v]) => `${k}=${v}`).join(" ")}`);

// ── The matrix ───────────────────────────────────────────────────────────────
// Bucketed by silhouette group first. The group is a hard wall in scorePair, so
// every cross-group pair scores 0 — computing them anyway is the difference
// between ~1M comparisons and ~700k, for an identical answer.
const byGroup = new Map();
for (const p of profiles) {
  if (!byGroup.has(p.group)) byGroup.set(p.group, []);
  byGroup.get(p.group).push(p);
}
console.log(`groups: ${[...byGroup.entries()].map(([g, v]) => `${g}=${v.length}`).join(" · ")}`);

const startedAt = Date.now();
const lists = new Map();
let pairs = 0;
for (const [, pool] of byGroup) {
  for (const target of pool) {
    pairs += pool.length - 1;
    const top = topNeighbours(target, pool, { limit: MAX_NEIGHBOURS });
    if (top.length) lists.set(target.pid, top);
  }
}
console.log(`scored ${pairs.toLocaleString()} pair(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ` +
            `${lists.size} product(s) got a list · ${profiles.length - lists.size} got none`);

const sizes = [...lists.values()].map((v) => v.length);
const full = sizes.filter((n) => n === MAX_NEIGHBOURS).length;
console.log(`list length: ${full} at the ${MAX_NEIGHBOURS} cap · min ${Math.min(...sizes, 0)} · ` +
            `mean ${(sizes.reduce((a, b) => a + b, 0) / Math.max(sizes.length, 1)).toFixed(1)}`);

// ── THE SPOT-CHECK ───────────────────────────────────────────────────────────
// Printed so the ranking can be eyeballed against the photos, which is the only
// way to find out whether it is any good. Spread across the pool rather than
// taken from the front: the front is one week's delivery.
console.log(`\n${"=".repeat(78)}\nSPOT-CHECK — ${SPOT} products, top 5 each\n${"=".repeat(78)}`);
const byPid = new Map(profiles.map((p) => [p.pid, p]));
const step = Math.max(1, Math.floor(profiles.length / SPOT));
for (let i = 0, shown = 0; i < profiles.length && shown < SPOT; i += step, shown++) {
  const t = profiles[i];
  const list = lists.get(t.pid) || [];
  const p = productOf[t.pid];
  console.log(`\n${t.pid}  ${JSON.stringify(p.name)}  R${p.retailPrice}`);
  console.log(`   ${t.brand} · ${t.silhouette}/${t.group} · ${t.primaryColour}(${t.colourFamily}) · ${t.upperMaterial} · ${t.pattern} · ${t.priceBand}`);
  console.log(`   ${p.photoUrl}`);
  if (!list.length) { console.log("   (no neighbours)"); continue; }
  for (const n of list.slice(0, 5)) {
    const np = productOf[n.pid], nf = byPid.get(n.pid);
    const { terms } = scorePair(t, nf);
    const top3 = Object.entries(terms).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}+${v}`).join(" ");
    console.log(`     ${String(Math.round(n.score)).padStart(3)}  ${n.pid}  ${JSON.stringify(np.name).padEnd(48)} R${String(np.retailPrice).padEnd(5)} ${nf.silhouette}/${nf.primaryColour}/${nf.upperMaterial}`);
    console.log(`          "${matchReasonText(n.code)}"   ${top3}`);
    console.log(`          ${np.photoUrl}`);
  }
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to store the lists.`);
  process.exit(0);
}

// ── The write ────────────────────────────────────────────────────────────────
// ONE CHILD PER PRODUCT, never the record. Batched so a 1,400-product run is
// tens of requests rather than 1,400.
//
// RTDB CANNOT STORE AN EMPTY ARRAY: writing [] deletes the child, and it reads
// back null. That is exactly the behaviour wanted for a product with no
// neighbours — but it must be a DELIBERATE null, not an accidental [], so the
// intent is readable at the call site rather than inferred from a database
// quirk.
const patch = {};
let wrote = 0, cleared = 0;
for (const p of profiles) {
  assertSafeSegment(p.pid, "productId");
  const list = lists.get(p.pid);
  if (list?.length) {
    patch[`${p.pid}/${NEIGHBOURS_FIELD}`] = list.map((n) => encodeNeighbour(n.pid, n.code));
    wrote += 1;
  } else if (PRUNE && products[p.pid]?.[NEIGHBOURS_FIELD] !== undefined) {
    patch[`${p.pid}/${NEIGHBOURS_FIELD}`] = null;   // deliberate delete, not []
    cleared += 1;
  }
}
// A product that LEFT the pool (deactivated, merged, its price removed) still
// carries yesterday's list, and every entry in it may still be perfectly
// sellable — so the list is only cleared under --prune, and cleared for the
// same reason it would be for a product with no neighbours: the record no
// longer earns one.
if (PRUNE) {
  for (const [pid, p] of Object.entries(products)) {
    if (!p?.id || byPid.has(pid) || p[NEIGHBOURS_FIELD] === undefined) continue;
    assertSafeSegment(pid, "productId");
    patch[`${pid}/${NEIGHBOURS_FIELD}`] = null;
    cleared += 1;
  }
}

const keys = Object.keys(patch);
const CHUNK = 400;
for (let i = 0; i < keys.length; i += CHUNK) {
  const slice = {};
  for (const k of keys.slice(i, i + CHUNK)) slice[k] = patch[k];
  await db.ref("products").update(slice);
  console.log(`  … wrote ${Math.min(i + CHUNK, keys.length)}/${keys.length}`);
}
console.log(`\nwrote ${wrote} list(s)${PRUNE ? ` · cleared ${cleared}` : ""}. ` +
            `Bytes added to /products: ~${(wrote * MAX_NEIGHBOURS * 20 / 1024).toFixed(0)} KB.`);
process.exit(0);
