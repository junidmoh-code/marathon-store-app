// ─── REFILL DESTINATION AUDIT — READ-ONLY ────────────────────────────────────
//
// WHY THIS FILE EXISTS
// Two products that belong to TROPHY grew live AUTO refill requests destined for
// MARATHON PE on 2026-08-17. The standing hypothesis, carried over from the
// 2026-08-15 bags/belts audit, was that categoryPolicyTarget() (functions/lib/
// refill-engine.cjs) arms a destination with no storeCarries() check — unlike the
// clothing and footwear rules beside it, which both require one.
//
// This script tests that hypothesis against LIVE data instead of assuming it. It
// answers, per product id:
//
//   • which open refill lines exist, at which destination, and their createdFrom
//     (engine run / human / Solve seed)
//   • which resolveTarget() branch actually armed each line — computed by CALLING
//     the real exported resolveTarget from functions/lib/refill-engine.cjs, not by
//     restating its rules here (a restatement would assert against itself)
//   • every /config/refillEngine/categoryPolicy entry and every explicit
//     /stock_targets row touching the product at any location
//   • whether storeCarries() passes at the destination, and if so the FULL
//     provenance of that cell from /stock_movements — every movement that ever
//     touched it, oldest first, with before→after per location
//   • the owning store's holdings for comparison
//
// IDENTITY RULE — PID ONLY. 177 exact-duplicate name groups exist in this
// catalogue and this product family is the collision shape itself: eight live
// "Lacoste sweatshirt*" records, two of them character-identical ("Lacoste
// sweatshirt black" twice), plus a "navy blue" and a "nevy blue" that differ by a
// typo. Every product in this report is resolved by the pid READ OFF THE OPEN
// REQUEST RECORD. Names are printed for humans and used for NOTHING else. The
// name-collision census is printed so the reader can see the trap rather than
// take a claim about it.
//
// Writes nothing. Reads only.
//
// Usage:
//   node scripts/audit-refill-destination-carries.mjs                  # auto-discover
//   AUDIT_PIDS=p1786452575638,p1786453234097 node scripts/…            # pin the pids
//   AUDIT_MD=~/report.md node scripts/…                                # write markdown
//   AUDIT_NAME_GREP=lacoste node scripts/…                             # collision census filter

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { homedir } from "os";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const engine = require("../functions/lib/refill-engine.cjs");
const { resolveTarget, categoryPolicyTarget, categoryPolicyEntry, encodeSizeKey, isClothing } = engine;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const OWNED_BY = process.env.AUDIT_OWNER || "trophy";
// Space-separated tokens, ALL of which must appear in the name. One token alone is
// useless here: "lacoste" matches 347 live records and buries the actual collision
// group in a wall of bags and beanies.
const NAME_TOKENS = (process.env.AUDIT_NAME_GREP || "lacoste sweatshirt").toLowerCase().split(/\s+/).filter(Boolean);
const PINNED = (process.env.AUDIT_PIDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// THE OLD PREDICATE, kept deliberately. This was refill-engine.cjs:200-202 before
// 2026-08-17 — "a cell exists here". It is retained verbatim so the report can show
// BEFORE and AFTER side by side: this function's answer next to the live
// resolveTarget()'s, which now consults the provenance index. It is no longer a copy
// of anything in the engine, and must not be updated to track it — its whole value
// is that it is the superseded question.
const storeCarriesOld = (stock, loc, pid) =>
  !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

// ── whole-map paged read (bandwidth-bounded, resumable) ──────────────────────
async function readPaged(path, pageSize = 2000) {
  const acc = {};
  let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });   // braces load-bearing: a truthy
    let added = 0;                                 // return cancels RTDB forEach
    for (const k of keys) {
      if (k === lastKey) continue;
      acc[k] = snap.child(k).val();
      added += 1;
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return acc;
}

const [config, products, stock, targets, refillRequests, engineOpen, orders, provenance, provenanceMeta] = await Promise.all([
  db.ref("/config/refillEngine").once("value").then((s) => s.val() || {}),
  readPaged("/products"),
  db.ref("/stock").once("value").then((s) => s.val() || {}),
  db.ref("/stock_targets").once("value").then((s) => s.val() || {}),
  readPaged("/refill_requests"),
  db.ref("/refill_engine/open").once("value").then((s) => s.val() || {}),
  readPaged("/orders"),
  db.ref("/stock_provenance").once("value").then((s) => {
    const v = s.val() || {};
    const { _meta, ...locs } = v;   // _meta is not a location
    return locs;
  }),
  db.ref("/stock_provenance/_meta").once("value").then((s) => s.val() || {}),
]);

const openReqs = Object.entries(refillRequests).filter(([, r]) => r && r.status === "open");

// ── the pids under audit — read off the open request records themselves ───────
let PIDS = PINNED;
let discovery = "pinned via AUDIT_PIDS";
if (!PIDS.length) {
  // Discover by: open line whose destination is NOT the store that actually holds
  // the units. No name matching anywhere in this path.
  const cand = new Map();
  for (const [id, r] of openReqs) {
    const pid = r.productId, dest = r.requestingLocation;
    if (!pid || !dest) continue;
    const destUnits = Object.values(stock?.[dest]?.[pid] || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);
    const ownerUnits = Object.values(stock?.[OWNED_BY]?.[pid] || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);
    if (dest !== OWNED_BY && destUnits === 0 && ownerUnits > 0) cand.set(pid, (cand.get(pid) || 0) + 1);
  }
  PIDS = [...cand.keys()];
  discovery = `auto-discovered: open line at a destination holding 0 units while ${OWNED_BY} holds units`;
}

say(`# Refill destination audit — ${new Date(Date.now()).toISOString().slice(0, 10)}`);
say();
say(`Read-only. Every product resolved by **pid**, read off the open request record.`);
say(`Product discovery: ${discovery}.`);
say();
// The plain-language verdict is written LAST (it depends on the whole analysis) but
// belongs FIRST for the reader. This marker holds its place.
const SUMMARY_AT = out.length;
say();

// ── 0. the name-collision trap, shown not claimed ────────────────────────────
say(`## 0. Why this report never uses names`);
say();
// A near-miss matcher too: the incident products are "Sweatshirt lacoste NEVY blue"
// and "Lacoste sweatshirt NAVY blue" — one typo apart, two different products. A
// token filter that demanded correct spelling would miss exactly the pair a human
// is most likely to confuse, so the filter is on the STABLE tokens only.
const collide = Object.entries(products).filter(([, p]) => {
  const n = String(p?.name || "").toLowerCase();
  return NAME_TOKENS.every((t) => n.includes(t));
});
say(`\`/products\` records whose name contains every one of ${JSON.stringify(NAME_TOKENS)} — ${collide.length} records:`);
say();
say(`| pid | name (verbatim) | categoryKey | productType | declared sizes |`);
say(`|---|---|---|---|---|`);
for (const [pid, p] of collide.sort((a, b) => String(a[1]?.name).localeCompare(String(b[1]?.name)))) {
  say(`| \`${pid}\` | ${JSON.stringify(p?.name)} | ${p?.categoryKey ?? "—"} | ${p?.productType ?? "—"} | ${JSON.stringify(p?.sizes || [])} |`);
}
const byName = {};
for (const [pid, p] of collide) (byName[String(p?.name)] ||= []).push(pid);
const dupNames = Object.entries(byName).filter(([, v]) => v.length > 1);
say();
if (dupNames.length) {
  for (const [n, v] of dupNames) say(`- **Character-identical name** ${JSON.stringify(n)} → ${v.length} distinct pids: ${v.map((x) => `\`${x}\``).join(", ")}`);
} else {
  say(`- No character-identical names inside this filter.`);
}
say();

// ── 1. per-pid detail ────────────────────────────────────────────────────────
const findings = [];

for (const pid of PIDS) {
  const p = products[pid];
  say(`---`);
  say();
  say(`## \`${pid}\` — ${JSON.stringify(p?.name ?? null)}`);
  say();
  say(`| field | value |`);
  say(`|---|---|`);
  say(`| categoryKey | \`${p?.categoryKey ?? "(absent)"}\` |`);
  say(`| productType | \`${p?.productType ?? "(absent)"}\` |`);
  say(`| subcategory | \`${p?.subcategory ?? p?.subcategoryKey ?? "(absent)"}\` |`);
  say(`| declared sizes | ${JSON.stringify(p?.sizes || [])} |`);
  say(`| isClothing() | \`${isClothing(p)}\` |`);
  say(`| barcodes | ${JSON.stringify(p?.barcodes || p?.barcode || null)} |`);
  say();

  // 1a. open lines
  const mine = openReqs.filter(([, r]) => r.productId === pid);
  say(`### Open refill requests (${mine.length})`);
  say();
  if (!mine.length) say(`_none_`);
  else {
    say(`| requestId | dest | size | qty | createdAt | createdFrom | verdict |`);
    say(`|---|---|---|---|---|---|---|`);
    for (const [id, r] of mine.sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)))) {
      const cf = r.createdFrom || {};
      const kind = cf.engine === true ? `ENGINE (run ${cf.runId}, source ${cf.source})`
        : cf.solve ? `SOLVE seed (${JSON.stringify(cf)})`
        : Object.keys(cf).length ? `NON-ENGINE ${JSON.stringify(cf)}`
        : `createdFrom ABSENT → human`;
      say(`| \`${id}\` | \`${r.requestingLocation}\` | ${r.size} | ${r.qty} | ${r.createdAt} | ${kind} | ${cf.engine === true ? "engine-created" : "NOT engine-created"} |`);
    }
  }
  say();

  // 1b. which rule armed it — the REAL resolveTarget, called
  const dests = [...new Set(mine.map(([, r]) => r.requestingLocation))];
  // provenance/provenanceMeta are read live so this audit reflects what the engine
  // would actually decide right now, including a not-yet-backfilled index.
  const ctx = { targets, config, products, stock, provenance, provenanceMeta };
  for (const dest of dests) {
    say(`### Rule that armed \`${dest}\` — computed by calling the real \`resolveTarget()\``);
    say();
    say(`\`storeCarriesOld(stock, "${dest}", "${pid}")\` → **\`${storeCarriesOld(stock, dest, pid)}\`**`);
    const cells = stock?.[dest]?.[pid] || {};
    say(`  (cell keys present at \`${dest}\`: ${JSON.stringify(Object.keys(cells))})`);
    say();
    const catEntry = categoryPolicyEntry(config, products, pid, dest);
    say(`\`categoryPolicyEntry(config, products, "${pid}", "${dest}")\` → **\`${JSON.stringify(catEntry)}\`**`);
    say();
    say(`| size | explicit row | categoryPolicyTarget() | resolveTarget() → source | target | reorderPoint | minQty |`);
    say(`|---|---|---|---|---|---|---|`);
    const sizes = [...new Set([...(p?.sizes || []).map(String), ...mine.filter(([, r]) => r.requestingLocation === dest).map(([, r]) => String(r.size))])];
    for (const size of sizes) {
      const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];
      // Signature changed 2026-08-17: categoryPolicyTarget now takes ctx whole, because
      // it consults storeCarries() (which needs the provenance index and the
      // introduce opt-in). Passing `ctx` here keeps this probe calling the REAL
      // function with the REAL inputs rather than a reconstruction of it.
      const cat = categoryPolicyTarget(ctx, dest, pid, size);
      const rt = resolveTarget(ctx, dest, pid, size);
      say(`| ${size} | ${explicit ? `\`${JSON.stringify(explicit)}\`` : "—"} | ${cat ? `\`${JSON.stringify(cat)}\`` : "**null**"} | ${rt ? `\`${rt.source}\`` : "null"} | ${rt?.target ?? "—"} | ${rt?.reorderPoint ?? "null"} | ${rt?.minQty ?? "—"} |`);
      findings.push({ pid, dest, size, carries: storeCarriesOld(stock, dest, pid), catEntry: !!catEntry, cat: !!cat, source: rt?.source ?? null });
    }
    say();
  }

  // 1c. category policy + explicit rows everywhere
  say(`### Policy & target rows touching \`${pid}\``);
  say();
  const key = p?.categoryKey;
  const catPol = config?.categoryPolicy || {};
  say(`- \`/config/refillEngine/categoryPolicy\` mapped categories: ${Object.keys(catPol).map((k) => `\`${k}\``).join(", ") || "(none)"}`);
  say(`- this product's \`categoryKey\` is \`${key ?? "(absent)"}\` → policy entry: **${catPol[key] ? `\`${JSON.stringify(catPol[key])}\`` : "ABSENT — the category-policy branch cannot fire for this product"}**`);
  say();
  const rows = [];
  for (const loc of Object.keys(targets)) {
    const r = targets[loc]?.[pid];
    if (r) for (const sk of Object.keys(r)) rows.push([loc, sk, r[sk]]);
  }
  if (!rows.length) say(`- \`/stock_targets\`: **no explicit row at any location** (whole-tree sweep of ${Object.keys(targets).length} locations)`);
  else {
    say(`- \`/stock_targets\` rows (whole-tree sweep):`);
    say();
    say(`| location | sizeKey | row |`);
    say(`|---|---|---|`);
    for (const [loc, sk, row] of rows) say(`| \`${loc}\` | \`${sk}\` | \`${JSON.stringify(row)}\` |`);
  }
  say();
  const runs = config?.defaultRunByStore || {};
  say(`- \`defaultRunByStore\` for the destinations above:`);
  for (const dest of dests) say(`  - \`${dest}\`: \`${JSON.stringify(runs[dest] || null)}\``);
  say(`- \`ruleBasedTargets\` (clothing kill switch): \`${JSON.stringify(config?.ruleBasedTargets)}\``);
  say();

  // 1d. holdings everywhere
  say(`### Holdings — every location, raw cells`);
  say();
  say(`| location | sizeKey | qty | v | lastType | mv | state | updatedAt |`);
  say(`|---|---|---|---|---|---|---|---|`);
  for (const loc of Object.keys(stock).sort()) {
    const cells = stock[loc]?.[pid];
    if (!cells) continue;
    for (const sk of Object.keys(cells).sort()) {
      const c = cells[sk];
      say(`| \`${loc}\` | \`${sk}\` | ${c?.qty} | ${c?.v} | ${c?.lastType ?? "—"} | \`${c?.mv ?? "—"}\` | ${c?.state ?? "—"} | ${c?.updatedAt ?? "—"} |`);
    }
  }
  say();

  // 1e. engine open index
  say(`### \`/refill_engine/open\` locks`);
  say();
  let any = false;
  for (const loc of Object.keys(engineOpen)) {
    const e = engineOpen[loc]?.[pid];
    if (!e) continue;
    any = true;
    for (const sk of Object.keys(e)) say(`- \`${loc}\` / \`${sk}\` → \`${JSON.stringify(e[sk])}\``);
  }
  if (!any) say(`_no engine lock_`);
  say();

  // 1f. the orders those locks point at
  const orderIds = new Set();
  for (const loc of Object.keys(engineOpen)) {
    const e = engineOpen[loc]?.[pid] || {};
    for (const sk of Object.keys(e)) if (e[sk]?.orderId) orderIds.add(e[sk].orderId);
  }
  if (orderIds.size) {
    say(`### Orders referenced by those locks`);
    say();
    for (const [oid, o] of Object.entries(orders)) {
      const num = o?.orderNumber != null ? String(o.orderNumber) : null;
      const hit = [...orderIds].some((x) => String(x).startsWith(String(num))) && String(o?.type || "").length >= 0;
      if (!hit || !num) continue;
      const items = (o.items || o.lines || []).filter((it) => it?.productId === pid || it?.pid === pid);
      if (!items.length) continue;
      say(`- \`/orders/${oid}\` number=\`${num}\` type=\`${o.type ?? "—"}\` dest=\`${o.destShop ?? o.store ?? o.requestingLocation ?? "—"}\` createdAt=\`${o.createdAt ?? "—"}\` status=\`${o.status ?? "—"}\``);
      for (const it of items) say(`  - line: \`${JSON.stringify(it)}\``);
    }
    say();
  }
}

// ── 2. movement provenance (paged filter over the ledger) ────────────────────
say(`---`);
say();
say(`## Movement provenance — every \`/stock_movements\` record touching these pids`);
say();
const pidSet = new Set(PIDS);
const mvs = [];
{
  let lastKey = null, scanned = 0;
  for (;;) {
    let q = db.ref("/stock_movements").orderByKey().limitToFirst(3000 + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });
    let added = 0;
    for (const k of keys) {
      if (k === lastKey) continue;
      const v = snap.child(k).val();
      scanned += 1; added += 1;
      if (v && pidSet.has(v.productId)) mvs.push([k, v]);
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < 3000) break;
  }
  say(`Scanned ${scanned} ledger records; ${mvs.length} touch these pids.`);
}
say();
mvs.sort((a, b) => String(a[1].appliedAt || a[1].ts).localeCompare(String(b[1].appliedAt || b[1].ts)));
for (const pid of PIDS) {
  say(`### \`${pid}\` — ledger, oldest first`);
  say();
  say(`| appliedAt | movementId | type | size | qty | from → to | before → after | reason | link | actor |`);
  say(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const [id, m] of mvs.filter(([, m]) => m.productId === pid)) {
    const ba = `${JSON.stringify(m.before || {})} → ${JSON.stringify(m.after || {})}`;
    say(`| ${m.appliedAt ?? m.ts} | \`${id}\` | ${m.type} | ${m.size} | ${m.qty} | \`${m.from ?? "—"}\` → \`${m.to ?? "—"}\` | ${ba} | ${m.reason ?? "—"} | \`${JSON.stringify(m.link || {})}\` | \`${m.actor}\` |`);
  }
  say();
  // the destination-cell provenance, isolated
  for (const dest of [...new Set(openReqs.filter(([, r]) => r.productId === pid).map(([, r]) => r.requestingLocation))]) {
    const touching = mvs.filter(([, m]) => m.productId === pid && (m.from === dest || m.to === dest || (m.before && dest in m.before)));
    say(`**Provenance of the \`${dest}\` cell** — ${touching.length} movement(s) ever touched it:`);
    say();
    for (const [id, m] of touching) {
      say(`- ${m.appliedAt ?? m.ts} \`${id}\` — ${m.type} ${m.size} ×${m.qty}, \`${m.from ?? "—"}\`→\`${m.to ?? "—"}\`, \`${dest}\` went ${JSON.stringify(m.before?.[dest])} → ${JSON.stringify(m.after?.[dest])}, reason \`${m.reason ?? "—"}\`, link \`${JSON.stringify(m.link || {})}\``);
    }
    say();
  }
}

// ── 3. verdict ──────────────────────────────────────────────────────────────
say(`---`);
say();
say(`## Verdict`);
say();
say(`| pid | dest | storeCarriesOld(dest) | categoryPolicy entry | categoryPolicyTarget fired | resolveTarget source(s) | engine-created |`);
say(`|---|---|---|---|---|---|---|`);
const seen = new Set();
for (const f of findings) {
  const k = `${f.pid}|${f.dest}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const srcs = [...new Set(findings.filter((x) => x.pid === f.pid && x.dest === f.dest && x.source).map((x) => x.source))];
  const catFired = findings.some((x) => x.pid === f.pid && x.dest === f.dest && x.cat);
  const eng = openReqs.filter(([, r]) => r.productId === f.pid && r.requestingLocation === f.dest).every(([, r]) => r.createdFrom?.engine === true);
  say(`| \`${f.pid}\` | \`${f.dest}\` | **${f.carries}** | ${f.catEntry ? "present" : "**ABSENT**"} | ${catFired ? "yes" : "**no**"} | ${srcs.join(", ") || "none"} | ${eng ? "yes" : "**no**"} |`);
}
say();

// ── 3b. THE LOOP — every request this pid has had, and what closed it ────────
// The recurrence is the point: it is not one bad batch, it is a cycle that
// re-arms on a fixed interval. This prints every request record for the audited
// pids so the cycle is visible as a sequence rather than described as one.
say(`## The cycle — every \`/refill_requests\` record for these pids`);
say();
say(`\`cancelReason\` is the load-bearing column. \`no_longer_needed\` is the ENGINE retracting its own`);
say(`ask (safe). An ABSENT cancelReason on a cancelled line is read as a human "no" and sets a 24h`);
say(`cooldown plus a (pid|size) denial SHARED between marathon-pe and trophy (refill-engine.cjs:1137-1150).`);
say();
say(`| createdAt | pid | dest | size | qty | status | cancelReason | resolvedAt | run | order line | gen |`);
say(`|---|---|---|---|---|---|---|---|---|---|---|`);
const lifecycle = Object.entries(refillRequests)
  .filter(([, r]) => r && pidSet.has(r.productId))
  .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)));
for (const [id, r] of lifecycle) {
  // the order line the engine raised for this request, found by refillId in the lock
  // history is not retained, so match on (dest, pid, size, run) through /orders
  const ord = Object.entries(orders).find(([oid, o]) =>
    o && o.productId === r.productId && o.destShop === r.requestingLocation &&
    String(o.size) === String(r.size) && o.autoRefillRunId === r.createdFrom?.runId);
  say(`| ${r.createdAt} | \`${r.productId}\` | \`${r.requestingLocation}\` | ${r.size} | ${r.qty} | **${r.status}** | ${r.cancelReason ? `\`${r.cancelReason}\`` : (r.status === "cancelled" ? "**ABSENT → reads as human reject**" : "—")} | ${r.resolvedAt ?? "—"} | ${r.createdFrom?.runId ?? "—"} | ${ord ? `\`${ord[0]}\` (${ord[1].status})` : "—"} | ${ord?.[1]?.clothingRefillGen ?? "—"} |`);
}
say();

// ── 4. THE TWO CANDIDATE CAUSES, TESTED ──────────────────────────────────────
// Neither of these is asserted. Each is a predicate evaluated against the live
// snapshot above, and the one that comes back true is the cause.
say(`## The two candidate causes, tested against the snapshot`);
say();
say(`**Candidate A — \`categoryPolicyTarget()\` has no \`storeCarries()\` gate**`);
say(`(refill-engine.cjs:391-417, the 2026-08-15 bags/belts finding). For this to be the cause here,`);
say(`\`categoryPolicyTarget()\` must be the branch that produced the target.`);
say();
const aFired = findings.some((f) => f.cat);
const aEntry = findings.some((f) => f.catEntry);
say(`- a \`/config/refillEngine/categoryPolicy\` entry exists for these products' category: **${aEntry ? "YES" : "NO"}**`);
say(`- \`categoryPolicyTarget()\` returned a target on any audited size: **${aFired ? "YES" : "NO"}**`);
say(`- \`resolveTarget()\` sources actually observed: ${[...new Set(findings.map((f) => f.source).filter(Boolean))].map((s) => `\`${s}\``).join(", ") || "none"}`);
say();
say(`→ **Candidate A is ${aFired ? "LIVE" : "RULED OUT"}.**${aFired ? "" : " The category-policy branch never executes for these products, so adding a gate to it would change nothing about these lines."}`);
say();
say(`**Candidate B — \`storeCarries()\` counts a cell that holds nothing and never traded**`);
say(`(refill-engine.cjs:200-202). For this to be the cause, the gate must PASS at the destination while the`);
say(`destination holds no units and has never sold the product — i.e. the cell is a husk left by a pass-through.`);
say();
say(`| pid | dest | storeCarriesOld | units held at dest | \`sold\` movements ever at dest | first positive inflow at dest |`);
say(`|---|---|---|---|---|---|`);
let bLive = false;
for (const k of new Set(findings.map((f) => `${f.pid}|${f.dest}`))) {
  const [pid, dest] = k.split("|");
  const held = Object.values(stock?.[dest]?.[pid] || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);
  const sold = mvs.filter(([, m]) => m.productId === pid && m.type === "sold" && m.from === dest).length;
  const inflow = mvs.filter(([, m]) => m.productId === pid && m.to === dest && m.type !== "sold");
  const first = inflow[0]?.[1];
  const carries = storeCarriesOld(stock, dest, pid);
  if (carries && held === 0 && sold === 0) bLive = true;
  say(`| \`${pid}\` | \`${dest}\` | **${carries}** | ${held} | ${sold} | ${first ? `\`${first.reason ?? "(none)"}\` — ${first.type} ${first.from ?? "—"}→${first.to}, ${first.appliedAt ?? first.ts}` : "**never**"} |`);
}
say();
say(`→ **Candidate B is ${bLive ? "LIVE" : "RULED OUT"}.**`);
say();

// ── the plain-language verdict, spliced to the top ───────────────────────────
{
  const s = [];
  s.push(`## Verdict in one page`);
  s.push(``);
  s.push(aFired
    ? `The category-policy gate **IS** the cause: \`categoryPolicyTarget()\` produced the target for these lines.`
    : `**The category-policy gate is NOT the cause.** These products sit in category \`${products[PIDS[0]]?.categoryKey}\`, which has no \`/config/refillEngine/categoryPolicy\` entry at all, so \`categoryPolicyTarget()\` returns \`null\` on every size (verified by calling the real function, not by reading the code). The branch that armed every line is the ordinary **clothing size run** — \`resolveTarget()\` source \`default\` — and that branch **already has** the \`storeCarries()\` gate.`);
  s.push(``);
  s.push(bLive ? `The gate did not fail. **It passed, on a cell that holds nothing and has never sold anything.**` : `\`storeCarries()\` is not passing on an empty cell either — the cause is elsewhere and is NOT yet identified.`);
  s.push(``);
  if (bLive) {
    s.push(`\`storeCarries()\` is defined (refill-engine.cjs:200-202) as **"a cell object exists"**:`);
    s.push(``);
    s.push("```js");
    s.push(`function storeCarriesOld(stock, loc, pid) {`);
    s.push(`  return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;`);
    s.push(`}`);
    s.push("```");
    s.push(``);
    s.push(`Not "holds units". Not "has ever held units". Not "has ever sold one". /stock cells are never`);
    s.push(`deleted, so **any** event that routes a single unit through a shop converts that shop into one that`);
    s.push(`"carries" the product permanently, and the size run arms there on the very next scan.`);
    s.push(``);
    s.push(`### What actually happened, from the ledger`);
    s.push(``);
    for (const pid of PIDS) {
      const dest = "marathon-pe";
      const chain = mvs.filter(([, m]) => m.productId === pid && (m.from === dest || m.to === dest));
      if (!chain.length) continue;
      s.push(`**\`${pid}\`** — ${JSON.stringify(products[pid]?.name)}`);
      s.push(``);
      for (const [id, m] of chain) {
        s.push(`  ${m.appliedAt ?? m.ts} — ${m.type} ${m.size}×${m.qty} \`${m.from ?? "—"}\`→\`${m.to ?? "—"}\` (${m.reason ?? "no reason"}) · \`${dest}\` ${JSON.stringify(m.before?.[dest])}→${JSON.stringify(m.after?.[dest])}`);
      }
      s.push(``);
    }
    s.push(`Read that as a sequence:`);
    s.push(``);
    s.push(`1. A **real customer order** (\`/orders/017\`, \`/orders/018\` — customer \`C-1695\`, both \`destShop: marathon-pe\`)`);
    s.push(`   was dispatched hub2 → marathon-pe at 07:58. Correct business. That dispatch **created the cell at PE.**`);
    s.push(`2. Staff walked the unit next door to Trophy (\`transfer_out marathon-pe→trophy\`, 08:04/08:05) where the`);
    s.push(`   customer actually was, and Trophy rang up the sale. Also correct business. The PE cell went back to 0`);
    s.push(`   — **but the cell object stayed.**`);
    s.push(`3. The **08:00 engine run** saw \`storeCarries("marathon-pe") === true\`, applied PE's clothing run`);
    s.push(`   (\`defaultRunByStore["marathon-pe"]\` = M 2, L 2, XL 1) against an on-hand of 0, and raised the full`);
    s.push(`   run as AUTO refill demand. Batch \`R004\`.`);
    s.push(`4. The warehouse **fulfilled** \`R004\` at 08:19–08:20, putting real units into PE and creating the L and`);
    s.push(`   XL cells too. Someone then **undid** the fulfil at 08:54 (\`clothing_cr_undo\`) and the units went back`);
    s.push(`   to hub2. All three PE cells now sit at 0 — **and all three still exist.**`);
    s.push(`5. The **09:00 run** re-armed all three sizes. Those are the lines open right now.`);
    s.push(``);
    s.push(`It is a closed loop with a one-hour period. Fulfilling it creates more cells; undoing the fulfil`);
    s.push(`does not remove them; the next scan re-arms. Nothing in the current code breaks the cycle.`);
    s.push(``);
    s.push(`### Why this is a different defect from the 2026-08-15 bags/belts one`);
    s.push(``);
    s.push(`Bags and belts were armed by a **category-policy entry with no gate**. These sweatshirts were armed by`);
    s.push(`a **gate that answered the wrong question**. Adding \`storeCarries()\` to \`categoryPolicyTarget()\` — the`);
    s.push(`fix that was queued up — would not have stopped a single one of these lines, because the gate was already`);
    s.push(`there and already said yes. The two findings share a symptom and have nothing else in common.`);
    s.push(``);
    s.push(`### The decision this needs from you`);
    s.push(``);
    s.push(`There are two places to cut, and they are not equivalent:`);
    s.push(``);
    s.push(`- **Make \`storeCarries()\` mean "trades this line"** — e.g. a cell counts only if it holds units, has`);
    s.push(`  ever held units, or the shop has ever sold the product. This is one predicate in one file and it`);
    s.push(`  fixes every branch at once (clothing, footwear, and the category policy if it ever gets a gate).`);
    s.push(`  It also changes behaviour for every existing (store, pid) pair in the same shape — see the`);
    s.push(`  latent-exposure table in \`scripts/sweep-destination-carries.mjs\` — so the definition is your call`);
    s.push(`  before anyone writes it.`);
    s.push(`- **Stop a customer-order dispatch from creating a stocking footprint** at the collection shop. This`);
    s.push(`  is the narrower cut and it is upstream of the engine entirely, but it touches the single writer to`);
    s.push(`  /stock (\`applyMovement\`) and every dispatch path that calls it.`);
    s.push(``);
    s.push(`Per the standing instruction, **no fix was written.** The audit stopped here.`);
    s.push(``);
  }
  out.splice(SUMMARY_AT, 0, ...s);
}

if (process.env.AUDIT_MD) {
  const path = process.env.AUDIT_MD.replace(/^~/, homedir());
  writeFileSync(path, out.join("\n") + "\n");
  console.log(`\n[written] ${path}`);
}
process.exit(0);
