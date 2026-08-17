// ─── COMMIT 1 — PROVENANCE STUDY (READ-ONLY) ─────────────────────────────────
//
// Does the ledger's own recorded shape separate STOCKING-class movements from
// customer-collection routing cleanly enough to build a predicate on? This script
// answers that with the whole ledger, not a sample, and it is designed to be able
// to say NO.
//
// It reports:
//   1. every distinct (type | reason) pair with counts, its link shape, and the
//      class this classification assigns it — the full 69-row audit
//   2. the separation test: how many records are decided by a recorded field, how
//      many would need the free-text reason read, and where the two disagree
//   3. the whole (store, pid) universe re-classified under the new predicate, with
//      the blast radius in BOTH directions:
//        • pairs that flip TRUE → FALSE  (demand that stops — the fix working)
//        • pairs that stay TRUE          (true positives — legitimate demand kept)
//        • pairs that flip and are TRADING TODAY (would be starved — the risk)
//   4. what happens to the 55 latent pairs and the 44 open lines
//
// Reads the cached ledger if given one (LEDGER_DIR), otherwise pulls live. The
// cache exists because /stock_movements is 56k records and Outgoing Bandwidth is
// the SKU behind the $409 month — a study should not re-pull it on every edit.
//
// Every join on pid. Writes nothing.
//
// Usage:
//   node scripts/provenance-study.mjs
//   LEDGER_DIR=/path/to/cache STUDY_MD=~/provenance-study.md node scripts/provenance-study.mjs

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import {
  classifyMovement, foldProvenance, carriesByProvenance,
  STOCKING, COLLECTION, SALE, UNSTOCK, NEUTRAL, NON_STOCKING_LOCATIONS,
} from "./lib/movementProvenance.mjs";

const DIR = process.env.LEDGER_DIR || null;
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

async function load() {
  if (DIR && existsSync(`${DIR}/movements.json`)) {
    const j = (f) => JSON.parse(readFileSync(`${DIR}/${f}.json`, "utf8"));
    return { movements: j("movements"), products: j("products"), stock: j("stock"), targets: j("stock_targets"), config: j("config"), refillRequests: j("refill_requests"), orders: j("orders"), source: `cache ${DIR}` };
  }
  const require = createRequire(new URL("../functions/package.json", import.meta.url));
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const paged = async (path, pageSize = 3000) => {
    const acc = {}; let lastKey = null;
    for (;;) {
      let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
      if (lastKey) q = q.startAt(lastKey);
      const snap = await q.once("value");
      const keys = []; snap.forEach((c) => { keys.push(c.key); });   // braces load-bearing
      let added = 0;
      for (const k of keys) { if (k === lastKey) continue; acc[k] = snap.child(k).val(); added += 1; }
      if (added === 0) break;
      lastKey = keys[keys.length - 1];
      if (added < pageSize) break;
    }
    return acc;
  };
  const [movements, products, refillRequests, orders] = await Promise.all([
    paged("/stock_movements"), paged("/products"), paged("/refill_requests"), paged("/orders"),
  ]);
  const one = async (p) => (await db.ref(p).once("value")).val() || {};
  return { movements, products, refillRequests, orders, stock: await one("/stock"), targets: await one("/stock_targets"), config: await one("/config/refillEngine"), source: "live RTDB" };
}

const { movements, products, stock, targets, config, refillRequests, orders, source } = await load();
const mvList = Object.entries(movements).filter(([, m]) => m);

// refill-engine.cjs:200-202 — the predicate being replaced.
const storeCarriesOld = (loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const heldUnits = (loc, pid) => Object.values(stock?.[loc]?.[pid] || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);
const catOf = (pid) => products?.[pid]?.categoryKey || products?.[pid]?.productType || "(uncategorised)";

say(`# Provenance study — does the ledger separate stocking from collection?`);
say();
say(`Read-only. Source: ${source}. ${mvList.length} ledger records. Every join on **pid**.`);
say();

// ── 1. the full (type | reason) audit ────────────────────────────────────────
say(`## 1. Every distinct \`(type | reason)\` pair, with the class assigned`);
say();
say(`\`reason\` appears here as a LABEL. The class is decided by \`type\` and the SHAPE of \`link\` —`);
say(`see \`scripts/lib/movementProvenance.mjs\` for why free text cannot be the key.`);
say();
const pairs = new Map();
for (const [id, m] of mvList) {
  const key = `${m.type} | ${m.reason == null ? "(null)" : m.reason}`;
  const lk = Object.entries(m.link || {}).filter(([, v]) => v != null).map(([a]) => a).sort().join("+") || "(empty)";
  const c = classifyMovement(m);
  const e = pairs.get(key) || { n: 0, qty: 0, links: new Map(), classes: new Map(), whys: new Set(), tos: new Set(), froms: new Set(), prefixes: new Set() };
  e.n += 1; e.qty += Number(m.qty) || 0;
  e.links.set(lk, (e.links.get(lk) || 0) + 1);
  e.classes.set(c.cls, (e.classes.get(c.cls) || 0) + 1);
  e.whys.add(c.why);
  if (m.to) e.tos.add(m.to);
  if (m.from) e.froms.add(m.from);
  if (e.prefixes.size < 4) e.prefixes.add(/^-[A-Za-z0-9_-]{19}$/.test(id) ? "(pushid)" : String(id).split(/[_:]/)[0]);
  pairs.set(key, e);
}
say(`${pairs.size} distinct pairs.`);
say();
say(`| n | units | type \\| reason | link shapes | id prefix | class(es) assigned |`);
say(`|---|---|---|---|---|---|`);
for (const [k, e] of [...pairs.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const label = k.length > 90 ? k.slice(0, 87) + "…" : k;
  const cls = [...e.classes.entries()].map(([c, n]) => `${c}×${n}`).join(", ");
  say(`| ${e.n} | ${e.qty} | \`${label.replace(/\|/g, "\\|")}\` | ${[...e.links.keys()].map((x) => `\`${x}\``).join(" ")} | ${[...e.prefixes].join(",")} | **${cls}** |`);
}
say();

// ── 2. THE SEPARATION TEST ───────────────────────────────────────────────────
say(`## 2. The separation test`);
say();
const tally = { [STOCKING]: 0, [COLLECTION]: 0, [SALE]: 0, [UNSTOCK]: 0, [NEUTRAL]: 0 };
const whyTally = new Map();
for (const [, m] of mvList) {
  const c = classifyMovement(m);
  tally[c.cls] += 1;
  whyTally.set(c.why, (whyTally.get(c.why) || 0) + 1);
}
say(`| class | records |`);
say(`|---|---|`);
for (const [c, n] of Object.entries(tally)) say(`| ${c} | ${n} |`);
say();
say(`**What decided each record** — the field, not the prose:`);
say();
say(`| deciding field | records |`);
say(`|---|---|`);
for (const [w, n] of [...whyTally.entries()].sort((a, b) => b[1] - a[1])) say(`| \`${w}\` | ${n} |`);
say();

// 2a. does any (type|reason) pair split across classes? A pair that splits means
// the reason string is NOT the discriminator — which is the point — but a pair that
// splits INCONSISTENTLY within one link shape would mean the shape isn't either.
const splitPairs = [...pairs.entries()].filter(([, e]) => e.classes.size > 1);
say(`### 2a. Pairs whose records do not all land in one class`);
say();
if (!splitPairs.length) say(`_none — every (type\\|reason) pair maps to a single class_`);
else {
  say(`${splitPairs.length} pair(s) split. A split is EXPECTED — \`reason\` is not the key. The test that matters`);
  say(`is whether the class is a pure function of the RECORDED SHAPE, which is the link key set together`);
  say(`with whether \`to\` names a real shop (\`in_transit\`/\`base\`/\`studio\` are not shelves). Both halves are`);
  say(`recorded fields; neither reads prose.`);
  say();
  say(`| type \\| reason | classes | (link shape, to-is-a-shop) groups | pure function of the recorded shape? |`);
  say(`|---|---|---|---|`);
  for (const [k, e] of splitPairs) {
    const byShape = new Map();
    for (const [, m] of mvList) {
      const key = `${m.type} | ${m.reason == null ? "(null)" : m.reason}`;
      if (key !== k) continue;
      const lk = Object.entries(m.link || {}).filter(([, v]) => v != null).map(([a]) => a).sort().join("+") || "(empty)";
      const toShop = !!(m.to && !NON_STOCKING_LOCATIONS.has(m.to));
      const gk = `${lk}/to-shop=${toShop}`;
      const set = byShape.get(gk) || new Set();
      set.add(classifyMovement(m).cls);
      byShape.set(gk, set);
    }
    const pure = [...byShape.values()].every((s) => s.size === 1);
    const label = k.length > 60 ? k.slice(0, 57) + "…" : k;
    say(`| \`${label.replace(/\|/g, "\\|")}\` | ${[...e.classes.keys()].join(", ")} | ${[...byShape.keys()].map((x) => `\`${x}\``).join(" ")} | ${pure ? "**YES**" : "**NO — AMBIGUOUS**"} |`);
  }
}
say();

// 2b. the collection class, verified end to end — no exceptions permitted
say(`### 2b. The collection class, verified against every record that claims it`);
say();
const collection = mvList.filter(([, m]) => classifyMovement(m).cls === COLLECTION);
const notDisp = collection.filter(([id]) => !String(id).startsWith("disp_"));
const dispNotCollection = mvList.filter(([id, m]) => String(id).startsWith("disp_") && classifyMovement(m).cls !== COLLECTION);
say(`- records classified COLLECTION: **${collection.length}**`);
say(`- of those, NOT carrying the \`disp_\` movement-id prefix: **${notDisp.length}**${notDisp.length ? ` — ${notDisp.slice(0, 5).map(([i]) => `\`${i}\``).join(", ")}` : ""}`);
say(`- records with the \`disp_\` prefix NOT classified COLLECTION: **${dispNotCollection.length}**${dispNotCollection.length ? ` — ${dispNotCollection.slice(0, 5).map(([i, m]) => `\`${i}\` (${m.type}/${m.reason})`).join(", ")}` : ""}`);
say();
say(`Two independent signals — the structural \`link\` shape and the \`disp_\` id convention — agree on`);
say(`${collection.length - notDisp.length - dispNotCollection.length} of ${collection.length} records. Full agreement means the class is not resting on a naming habit.`);
say();

// ── 3. THE UNIVERSE, RECLASSIFIED ────────────────────────────────────────────
const prov = foldProvenance(mvList.map(([, m]) => m));
say(`## 3. The (store, pid) universe under the new predicate`);
say();
const routes = config?.routes || {};
const dests = Object.keys(routes);
say(`Refill destinations (\`/config/refillEngine/routes\`): ${dests.map((d) => `\`${d}\``).join(", ")}`);
say();

// Universe = every pair the OLD predicate answers true for, at a refill destination.
const universe = [];
for (const dest of dests) {
  for (const pid of Object.keys(stock?.[dest] || {})) {
    if (!storeCarriesOld(dest, pid)) continue;
    const e = prov.get(`${dest}|${pid}`);
    universe.push({
      dest, pid, cat: catOf(pid),
      old: true, now: carriesByProvenance(e),
      held: heldUnits(dest, pid),
      sold: e?.sold || 0,
      stocked: e?.stockedUnits || 0,
      unstocked: e?.unstockedUnits || 0,
      collected: e?.collectedUnits || 0,
    });
  }
}
const keeps = universe.filter((u) => u.now);
const flips = universe.filter((u) => !u.now);
say(`| | pairs |`);
say(`|---|---|`);
say(`| \`storeCarries()\` answers TRUE today (at a refill destination) | **${universe.length}** |`);
say(`| …still TRUE under the new predicate (**true positives — demand kept**) | **${keeps.length}** |`);
say(`| …flip to FALSE (**demand that stops**) | **${flips.length}** |`);
say();

say(`### 3a. Flips by destination and category`);
say();
const fg = new Map();
for (const u of flips) {
  const k = `${u.dest}|${u.cat}`;
  const e = fg.get(k) || { n: 0, held: 0, collectedOnly: 0 };
  e.n += 1; e.held += u.held;
  if (u.collected > 0 && u.stocked === 0) e.collectedOnly += 1;
  fg.set(k, e);
}
say(`| destination | category | pairs flipping | units still on hand | of which collection-only provenance |`);
say(`|---|---|---|---|---|`);
for (const [k, e] of [...fg.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const [d, c] = k.split("|");
  say(`| \`${d}\` | \`${c}\` | ${e.n} | ${e.held} | ${e.collectedOnly} |`);
}
say();

// ── 3b. THE RISK DIRECTION — would the fix starve anything? ──────────────────
say(`### 3b. The risk direction — pairs that flip to FALSE while still trading`);
say();
say(`A flip is only safe if the shop is not actually selling the line. These are the pairs where it is:`);
say();
const starve = flips.filter((u) => u.held > 0 || u.sold > 0);
if (!starve.length) say(`**None.** Every pair that flips holds zero units and has never recorded a sale at that shop.`);
else {
  say(`| dest | pid | name (display only) | category | units held | sales recorded | stocked | unstocked | collected |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  for (const u of starve.sort((a, b) => b.held - a.held).slice(0, 60)) {
    say(`| \`${u.dest}\` | \`${u.pid}\` | ${JSON.stringify(products[u.pid]?.name ?? null)} | \`${u.cat}\` | ${u.held} | ${u.sold} | ${u.stocked} | ${u.unstocked} | ${u.collected} |`);
  }
  if (starve.length > 60) say(`| … | | | | | | | | _${starve.length - 60} more_ |`);
}
say();
say(`**${starve.length} pair(s) would be starved by the new predicate.** ${starve.length ? "Each needs either an `introduce: true` opt-in or a real stocking movement before the predicate can ship." : "Nothing needs an opt-in on day one."}`);
say();

// 3c. pairs held-but-never-stocked: the ones that only an adjustment ever filled
say(`### 3c. Where treating \`adjustment\`/\`return\` as neutral actually bites`);
say();
const adjOnly = universe.filter((u) => u.held > 0 && u.sold === 0 && u.stocked === 0);
say(`Pairs holding real units at a shop with NO sale and NO stocking-class movement — i.e. the units`);
say(`arrived by a correction or a return only: **${adjOnly.length}**`);
say();
if (adjOnly.length) {
  say(`| dest | pid | name | category | units held | collected |`);
  say(`|---|---|---|---|---|---|`);
  for (const u of adjOnly.sort((a, b) => b.held - a.held).slice(0, 40)) {
    say(`| \`${u.dest}\` | \`${u.pid}\` | ${JSON.stringify(products[u.pid]?.name ?? null)} | \`${u.cat}\` | ${u.held} | ${u.collected} |`);
  }
  if (adjOnly.length > 40) say(`| … | | | | | _${adjOnly.length - 40} more_ |`);
}
say();

// ── 3d. THE LEDGER IS NOT COMPLETE — setCellState writes outside it ──────────
say(`### 3d. ⚠ The ledger is not a complete record of stocking intent`);
say();
say(`\`setCellState()\` (src/components/stock/applyMovement.js) is documented as *"the one legitimate cell`);
say(`write that isn't a movement"* — it seeds \`{qty:0, v:0, mv:"seed", lastType:"count"}\` when a counted-zero`);
say(`size is brought under tracking. **Those cells leave no ledger record at all**, so a purely`);
say(`ledger-derived index cannot see them.`);
say();
const seedPairs = new Set(), seedNoProv = [];
let seedCells = 0;
for (const loc of Object.keys(stock)) {
  for (const pid of Object.keys(stock[loc] || {})) {
    let anySeed = false;
    for (const sk of Object.keys(stock[loc][pid] || {})) {
      if (stock[loc][pid][sk]?.mv === "seed") { seedCells += 1; anySeed = true; }
    }
    if (!anySeed) continue;
    seedPairs.add(`${loc}|${pid}`);
    if (!carriesByProvenance(prov.get(`${loc}|${pid}`))) seedNoProv.push({ loc, pid, cat: catOf(pid), held: heldUnits(loc, pid) });
  }
}
say(`| | count |`);
say(`|---|---|`);
say(`| cells carrying \`mv: "seed"\` | ${seedCells} |`);
say(`| (loc, pid) pairs containing at least one seed cell | ${seedPairs.size} |`);
say(`| …of those with **no ledger evidence whatsoever** — the new predicate refuses them | **${seedNoProv.length}** |`);
say();
say(`A seed is a DELIBERATE human act: "start tracking this line here." That is the same intent as the`);
say(`\`introduce: true\` opt-in. But it is also exactly the 2026-07-29 failure — zero cells seeded at Trophy`);
say(`raised 15 CR requests for jerseys Trophy had never stocked. **Both readings are defensible and they`);
say(`disagree on ${seedNoProv.length} pairs**, so this is a policy choice, not a technical one.`);
say();
say(`**Default taken here: a seed establishes NOTHING.** It is the conservative direction, it matches the`);
say(`predicate exactly as written, and the pairs that need it are recoverable one at a time via`);
say(`\`introduce: true\` rather than all at once by a rule. The full worklist:`);
say();
say(`| location | pid | name (display only) | category | units held |`);
say(`|---|---|---|---|---|`);
for (const s of seedNoProv.sort((a, b) => a.loc.localeCompare(b.loc) || String(a.cat).localeCompare(String(b.cat)))) {
  say(`| \`${s.loc}\` | \`${s.pid}\` | ${JSON.stringify(products[s.pid]?.name ?? null)} | \`${s.cat}\` | ${s.held} |`);
}
say();

// ── 4. the open lines ────────────────────────────────────────────────────────
say(`## 4. Effect on today's open demand`);
say();
const OPEN_ORDER_STATUS = new Set(["incoming", "open", "pending", "ready", "requested", undefined, null, ""]);
const isRefillOrder = (id, o) => o.autoRefill === true || /^R\d/.test(String(id)) || String(o.customerName || "") === "Shop Refill";
const lines = [];
for (const [id, r] of Object.entries(refillRequests)) {
  if (!r || r.status !== "open" || !r.productId || !r.requestingLocation) continue;
  lines.push({ kind: "refill_request", id, pid: r.productId, dest: r.requestingLocation, size: r.size, qty: Number(r.qty) || 0, engine: r.createdFrom?.engine === true });
}
for (const [id, o] of Object.entries(orders)) {
  if (!o || !o.productId || !o.destShop || !OPEN_ORDER_STATUS.has(o.status)) continue;
  if (!isRefillOrder(id, o)) continue;
  lines.push({ kind: "refill_order", id, pid: o.productId, dest: o.destShop, size: o.size, qty: Number(o.qty) || 1, engine: o.autoRefill === true });
}
for (const l of lines) {
  const e = prov.get(`${l.dest}|${l.pid}`);
  l.now = carriesByProvenance(e);
  l.old = storeCarriesOld(l.dest, l.pid);
  l.cat = catOf(l.pid);
}
const withdraw = lines.filter((l) => l.old && !l.now);
say(`| | lines | units |`);
say(`|---|---|---|`);
say(`| open REFILL lines total | ${lines.length} | ${lines.reduce((s, l) => s + l.qty, 0)} |`);
say(`| armed by the OLD predicate, refused by the NEW one → **withdraw** | **${withdraw.length}** | **${withdraw.reduce((s, l) => s + l.qty, 0)}** |`);
say(`| …of those, ENGINE-raised (engine retracts them itself) | ${withdraw.filter((l) => l.engine).length} | ${withdraw.filter((l) => l.engine).reduce((s, l) => s + l.qty, 0)} |`);
say(`| …of those, HUMAN-raised (**owner's call, not the engine's**) | ${withdraw.filter((l) => !l.engine).length} | ${withdraw.filter((l) => !l.engine).reduce((s, l) => s + l.qty, 0)} |`);
say();
// Reconciling this against the 2026-08-17 sweep's "44 lines / 63 units". The two
// populations are NOT the same set and the difference is the point: the sweep asked
// "does this destination trade the line", which flags human-placed requests at
// shops with no cell at all. Those were never armed BY THE GATE, so the predicate
// change cannot withdraw them — only a human can. Stated rather than glossed:
const neverArmed = lines.filter((l) => !l.old && !l.now);
say(`Reconciliation with the earlier sweep's 44 lines / 63 units — they are different sets, deliberately:`);
say();
say(`| set | lines | units |`);
say(`|---|---|---|`);
say(`| armed by the gate today AND refused by the new predicate → the engine withdraws these | ${withdraw.length} | ${withdraw.reduce((s, l) => s + l.qty, 0)} |`);
say(`| open at a shop with NO cell at all → the gate never armed them, so the predicate change is a no-op | ${neverArmed.length} | ${neverArmed.reduce((s, l) => s + l.qty, 0)} |`);
say(`| …of those, HUMAN-raised (**only you can withdraw these**) | ${neverArmed.filter((l) => !l.engine).length} | ${neverArmed.filter((l) => !l.engine).reduce((s, l) => s + l.qty, 0)} |`);
say();
const wg = new Map();
for (const l of withdraw) {
  const k = `${l.dest}|${l.cat}`;
  const e = wg.get(k) || { lines: 0, qty: 0, pids: new Set() };
  e.lines += 1; e.qty += l.qty; e.pids.add(l.pid); wg.set(k, e);
}
say(`| destination | category | lines | units | pids |`);
say(`|---|---|---|---|---|`);
for (const [k, e] of [...wg.entries()].sort((a, b) => b[1].qty - a[1].qty)) {
  const [d, c] = k.split("|");
  say(`| \`${d}\` | \`${c}\` | ${e.lines} | ${e.qty} | ${e.pids.size} |`);
}
say();
say(`### 4a. Human-raised lines — flagged, never auto-withdrawn`);
say();
const human = withdraw.filter((l) => !l.engine);
if (!human.length) say(`_none_`);
else {
  say(`| dest | pid | name | category | size | qty | line |`);
  say(`|---|---|---|---|---|---|---|`);
  for (const l of human) say(`| \`${l.dest}\` | \`${l.pid}\` | ${JSON.stringify(products[l.pid]?.name ?? null)} | \`${l.cat}\` | ${l.size} | ${l.qty} | ${l.kind} \`${l.id}\` |`);
}
say();

// ── 5. the incident case, as a named regression fixture ──────────────────────
say(`## 5. The incident case`);
say();
for (const pid of ["p1786452575638", "p1786453234097"]) {
  const e = prov.get(`marathon-pe|${pid}`);
  say(`- \`${pid}\` @ \`marathon-pe\` — sold ${e?.sold ?? 0}, stocked ${e?.stockedUnits ?? 0}, unstocked ${e?.unstockedUnits ?? 0}, collected ${e?.collectedUnits ?? 0} → old \`${storeCarriesOld("marathon-pe", pid)}\`, **new \`${carriesByProvenance(e)}\`**`);
  const t = prov.get(`trophy|${pid}`);
  say(`  - the shop that actually trades it, \`trophy\` — sold ${t?.sold ?? 0}, stocked ${t?.stockedUnits ?? 0} → **new \`${carriesByProvenance(t)}\`**`);
}
say();

// ── 6. verdict ───────────────────────────────────────────────────────────────
const ambiguous = splitPairs.filter(([k]) => {
  const byShape = new Map();
  for (const [, m] of mvList) {
    const key = `${m.type} | ${m.reason == null ? "(null)" : m.reason}`;
    if (key !== k) continue;
    const lk = Object.entries(m.link || {}).filter(([, v]) => v != null).map(([a]) => a).sort().join("+") || "(empty)";
    const gk = `${lk}/to-shop=${!!(m.to && !NON_STOCKING_LOCATIONS.has(m.to))}`;
    const s = byShape.get(gk) || new Set(); s.add(classifyMovement(m).cls); byShape.set(gk, s);
  }
  return [...byShape.values()].some((s) => s.size > 1);
});
say(`## Verdict`);
say();
say(`| test | result |`);
say(`|---|---|`);
say(`| distinct \`(type \\| reason)\` pairs | ${pairs.size} |`);
say(`| pairs whose class is ambiguous within one link shape | **${ambiguous.length}** |`);
say(`| records needing the free-text \`reason\` read to classify | **${[...whyTally.entries()].filter(([w]) => w.includes("code constant")).reduce((s, [, n]) => s + n, 0)}** (all four are code constants, not prose) |`);
say(`| COLLECTION records where link shape and \`disp_\` convention disagree | **${notDisp.length + dispNotCollection.length}** |`);
say(`| pairs starved by the new predicate (hold units or have sold) | **${starve.length}** |`);
say(`| pairs refused because their only evidence is a ledger-invisible \`seed\` cell | **${seedNoProv.length}** |`);
say();
say(ambiguous.length === 0 && notDisp.length + dispNotCollection.length === 0
  ? `**The movement types separate cleanly on recorded fields.** No prose is read; the four undo reasons matched are code constants declared in App.jsx and utils/clothingSold.js.`
  : `**THEY DO NOT SEPARATE CLEANLY — ${ambiguous.length} ambiguous pair(s), ${notDisp.length + dispNotCollection.length} disagreement(s). STOP.**`);
say();

if (process.env.STUDY_MD) {
  const p = process.env.STUDY_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(0);
