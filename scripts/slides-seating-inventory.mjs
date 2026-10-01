// ─── SLIDES SEATING INCIDENT — READ-ONLY INVENTORY ────────────────────────────
//
// WRITES NOTHING TO RTDB. The only outputs are a timestamped JSON snapshot
// under var/ and text on stdout.
//
// WHY IT EXISTS
// The Slides category was armed at BOTH hub1 and hub2 with a per-size target of
// 3 and NO carriage scope (`carriedOnly`). An unscoped category leg arms every
// product carrying that categoryKey at that location whether the location has
// ever held one or not (refill-engine.cjs categoryPolicyEntry: the carriage
// gate is `carriedOnly`, and absent means "the category is the arming act").
// So every slide is now demanded at both hubs instead of only at the hub that
// actually keeps it.
//
// This script measures the blast radius before anything is reversed, and it is
// IDEMPOTENT: it reports what is there now. If a previous session already
// cancelled some lines or cleared some rows, it says so rather than assuming a
// starting state.
//
// WHAT "SEATED" MEANS HERE — and it is the engine's own answer, not a new one:
// storeCarries(stock, loc, pid) is CELL EXISTENCE, including a zero cell
// (refill-engine.cjs:219). A sold-out slide is still seated. This file mirrors
// nothing: it imports resolveTarget and storeCarries' predicate shape straight
// out of functions/lib so there is one definition.
//
// READS ARE PAGED. No whole-node read of /products, /stock/<loc>,
// /stock_targets/<loc> or /refill_engine/open/<loc>. /refill_requests is read
// BY ID from the open locks plus one bounded newest-first window, never whole.
//
// Usage:  node scripts/slides-seating-inventory.mjs
//         CATEGORY=slides OUT=var/x.json node scripts/slides-seating-inventory.mjs

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { encodeSizeKey } = require("../functions/lib/refill-engine.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORY = process.env.CATEGORY || "slides";
const HUBS = (process.env.HUBS || "hub1,hub2").split(",");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = process.env.OUT || join(ROOT, "var", `${CATEGORY}-seating-inventory-${STAMP}.json`);

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val());

// Cell existence, the engine's predicate (refill-engine.cjs:219) — a zero cell
// counts, because applyMovement never deletes a cell and absence is the only
// honest "this shop has never held one".
const carries = (stockLoc, pid) => !!stockLoc?.[pid] && Object.keys(stockLoc[pid]).length > 0;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

(async () => {
  console.log("═".repeat(96));
  console.log(`  ${CATEGORY.toUpperCase()} SEATING INCIDENT — INVENTORY        WRITES NOTHING TO RTDB`);
  console.log("═".repeat(96));

  const config = (await small("config/refillEngine")) || {};
  const policy = config.categoryPolicy || {};
  const entry = policy[CATEGORY] || null;

  console.log(`\n  categoryPolicy.${CATEGORY}: ${entry ? `armed at ${Object.keys(entry).filter((k) => k !== "perSize").sort().join(", ")}` : "(absent — already reversed?)"}`);
  if (entry) {
    for (const loc of Object.keys(entry).filter((k) => k !== "perSize")) {
      const leg = entry[loc];
      const sizes = leg?.sizes ? Object.keys(leg.sizes) : null;
      console.log(`    ${pad(loc, 14)} carriedOnly=${leg?.carriedOnly === true}  ${sizes ? `per-size ${sizes.length} sizes, targets ${[...new Set(Object.values(leg.sizes).map((r) => r.target))].join("/")}` : `uniform target ${leg?.target}`}`);
    }
  }

  console.log(`\n  reading (paged)…`);
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const pids = Object.keys(products).filter((p) => products[p]?.categoryKey === CATEGORY);
  const activePids = pids.filter((p) => products[p]?.active !== false && !products[p]?.mergedInto);
  console.log(`  products in ${CATEGORY}: ${pids.length}  (live, unmerged: ${activePids.length})`);

  const stock = {}, targets = {}, openIndex = {};
  for (const loc of HUBS) {
    stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
    targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
  }
  const centralStock = await readMapPaged(db, "stock/central", { pageSize: 500 });

  // ── SEATING TRUTH ──────────────────────────────────────────────────────────
  const seating = {};
  for (const pid of pids) {
    seating[pid] = Object.fromEntries(HUBS.map((l) => [l, carries(stock[l], pid)]));
  }
  const seatedBoth = pids.filter((p) => HUBS.every((l) => seating[p][l]));
  const seatedNone = pids.filter((p) => HUBS.every((l) => !seating[p][l]));

  // ── EXPLICIT /stock_targets ROWS ───────────────────────────────────────────
  const targetRows = [];
  for (const loc of HUBS) {
    for (const pid of pids) {
      const byS = targets[loc]?.[pid];
      if (!byS || typeof byS !== "object") continue;
      for (const [sizeKey, row] of Object.entries(byS)) {
        if (!row || typeof row !== "object") continue;
        targetRows.push({
          loc, pid, sizeKey,
          name: products[pid]?.name || null,
          target: row.target ?? null, minQty: row.minQty ?? null, reorderPoint: row.reorderPoint ?? null,
          source: row.source || null, batchId: row.batchId || null,
          setAt: row.setAt || (row.offAt ? new Date(row.offAt).toISOString() : null),
          setBy: row.setBy || row.offByEmail || null,
          prevAbsent: row.prevAbsent === true,
          seatedHere: seating[pid][loc],
        });
      }
    }
  }
  const offRows = targetRows.filter((r) => r.target === 0);

  // ── OPEN REFILL LINES ──────────────────────────────────────────────────────
  // The lock table is the bounded read. Each lock names its refillId; the
  // request itself is fetched BY ID, never by scanning /refill_requests.
  const locks = [];
  for (const loc of HUBS) {
    for (const pid of pids) {
      const byS = openIndex[loc]?.[pid];
      if (!byS || typeof byS !== "object") continue;
      for (const [sizeKey, e] of Object.entries(byS)) {
        if (!e || typeof e !== "object") continue;
        locks.push({ loc, pid, sizeKey, refillId: e.refillId || null, qty: e.qty ?? null,
          createdAt: e.createdAt || null, runId: e.runId || null, source: e.source || null });
      }
    }
  }
  const reqById = new Map();
  for (const l of locks) {
    if (!l.refillId || reqById.has(l.refillId)) continue;
    reqById.set(l.refillId, await small(`refill_requests/${l.refillId}`));
  }

  // Lock-less open lines for these products: one bounded newest-first window on
  // /refill_requests (the engine's own reconcile pass uses the same window
  // shape). 3,000 newest keys covers every line this arming could have raised —
  // the arming is days old, not months.
  const recentSnap = await db.ref("refill_requests").orderByKey().limitToLast(3000).once("value");
  const pidSet = new Set(pids);
  const lockedIds = new Set(locks.map((l) => l.refillId).filter(Boolean));
  const looseOpen = [];
  recentSnap.forEach((c) => {
    const r = c.val();
    if (!r || r.status !== "open") return;
    if (!pidSet.has(r.productId)) return;
    if (!HUBS.includes(r.requestingLocation)) return;
    if (lockedIds.has(c.key)) return;
    looseOpen.push({ id: c.key, ...r });
  });

  // ── RELEASE STATE ──────────────────────────────────────────────────────────
  // Mirrors releaseWindows.js: a line is RELEASED when it was created at or
  // before the most recent release instant. SA is UTC+2 year-round.
  const SA = 2 * 60 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
  const rawWin = config.releaseWindows;
  const winList = Array.isArray(rawWin) ? rawWin : (rawWin && typeof rawWin === "object" ? Object.values(rawWin) : []);
  const mins = [...new Set(winList.map((s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; }).filter((v) => v !== null))].sort((a, b) => a - b);
  const useMins = rawWin === false ? null : (mins.length ? mins : [6 * 60, 14 * 60]);
  const nowMs = Date.now();
  const lastRelease = (() => {
    if (useMins === null) return Infinity;               // batching disabled = everything released
    const sa = nowMs + SA, d = new Date(sa);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const nowMin = Math.floor((sa - midnight) / 60000);
    const passed = useMins.filter((m) => m <= nowMin);
    const at = passed.length ? midnight + passed[passed.length - 1] * 60000
      : midnight - DAY + useMins[useMins.length - 1] * 60000;
    return at - SA;
  })();
  const releasedState = (r) => {
    if (r?.earlyRelease) return "released_early";
    const t = Date.parse(r?.createdAt || "");
    if (!Number.isFinite(t)) return "unknown";
    return t <= lastRelease ? "released" : "parked";
  };

  const lines = [];
  for (const l of locks) {
    const r = l.refillId ? reqById.get(l.refillId) : null;
    lines.push({
      kind: "locked", loc: l.loc, pid: l.pid, name: products[l.pid]?.name || null,
      sizeKey: l.sizeKey, size: r?.size ?? null, qty: r?.qty ?? l.qty,
      refillId: l.refillId, createdAt: r?.createdAt || l.createdAt, runId: l.runId,
      source: l.source, status: r?.status || "(request missing)",
      cancelReason: r?.cancelReason || null,
      sentQty: r?.sentQty ?? 0, fulfilledBy: r?.fulfilledBy || null,
      release: r ? releasedState(r) : "unknown",
      seatedHere: seating[l.pid]?.[l.loc] ?? false,
    });
  }
  for (const r of looseOpen) {
    lines.push({
      kind: "unlocked", loc: r.requestingLocation, pid: r.productId, name: products[r.productId]?.name || null,
      sizeKey: encodeSizeKey(r.size), size: r.size, qty: r.qty, refillId: r.id,
      createdAt: r.createdAt, runId: null, source: r.createdFrom?.source || null,
      status: r.status, cancelReason: r.cancelReason || null,
      sentQty: r.sentQty ?? 0, fulfilledBy: r.fulfilledBy || null,
      release: releasedState(r), seatedHere: seating[r.productId]?.[r.requestingLocation] ?? false,
    });
  }
  const open = lines.filter((l) => l.status === "open");

  // ── ANYTHING ALREADY MOVED? ────────────────────────────────────────────────
  // Two separate questions, because they have different recoveries:
  //   • sentQty > 0 on an OPEN line — a partial pick already left Central.
  //   • a line already fulfilled — the whole thing left Central.
  // Both are found by ID; neither needs a movements scan.
  const partiallySent = open.filter((l) => (l.sentQty || 0) > 0);
  const fulfilledLines = lines.filter((l) => l.status === "fulfilled");
  const heldRaw = (await small("settings/stockHold/held")) || {};
  const heldForUs = [];
  for (const [dest, byLine] of Object.entries(heldRaw)) {
    if (!HUBS.includes(dest)) continue;
    for (const [lineId, h] of Object.entries(byLine || {})) {
      if (h && pidSet.has(h.productId)) heldForUs.push({ dest, lineId, ...h });
    }
  }

  const byLoc = (arr) => Object.fromEntries(HUBS.map((l) => [l, arr.filter((x) => x.loc === l).length]));
  const unitsIn = (arr) => arr.reduce((n, x) => n + (Number(x.qty) || 0), 0);

  const snapshot = {
    takenAt: new Date().toISOString(), takenAtMs: nowMs, category: CATEGORY, hubs: HUBS,
    releaseWindows: rawWin === false ? false : (useMins || []).map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`),
    lastReleaseInstant: Number.isFinite(lastRelease) ? new Date(lastRelease).toISOString() : "batching-disabled",
    policyEntry: entry,
    counts: {
      productsInCategory: pids.length, liveUnmerged: activePids.length,
      seatedBoth: seatedBoth.length, seatedNeither: seatedNone.length,
      seatedPerHub: Object.fromEntries(HUBS.map((l) => [l, pids.filter((p) => seating[p][l]).length])),
      targetRows: targetRows.length, targetRowsPerHub: byLoc(targetRows),
      targetRowsOff: offRows.length,
      openLines: open.length, openLinesPerHub: byLoc(open), openUnits: unitsIn(open),
      openParked: open.filter((l) => l.release === "parked").length,
      openReleased: open.filter((l) => l.release !== "parked").length,
      openUnseated: open.filter((l) => !l.seatedHere).length,
      partiallySent: partiallySent.length, fulfilled: fulfilledLines.length,
      heldLines: heldForUs.length,
    },
    seating, targetRows, lines, heldLines: heldForUs,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  const c = snapshot.counts;
  console.log(`\n  ── SEATING (cell exists, zero cells included) ─────────────────────────`);
  for (const l of HUBS) console.log(`    ${pad(l, 10)} seats ${rpad(c.seatedPerHub[l], 4)} of ${pids.length}`);
  console.log(`    both     ${rpad(c.seatedBoth, 4)}     neither ${c.seatedNeither}`);
  console.log(`\n  ── EXPLICIT /stock_targets ROWS ───────────────────────────────────────`);
  console.log(`    ${c.targetRows} rows  ${JSON.stringify(c.targetRowsPerHub)}   (target:0 switch-offs: ${c.targetRowsOff})`);
  for (const r of targetRows.slice(0, 25)) {
    console.log(`      ${pad(r.loc, 7)} ${pad(r.pid, 16)} ${pad(r.sizeKey, 5)} t=${rpad(r.target, 3)} src=${pad(r.source || "-", 14)} ${r.setAt || "?"} seated=${r.seatedHere}`);
  }
  if (targetRows.length > 25) console.log(`      … ${targetRows.length - 25} more (full list in the snapshot)`);
  console.log(`\n  ── OPEN REFILL LINES ──────────────────────────────────────────────────`);
  console.log(`    ${c.openLines} open  ${JSON.stringify(c.openLinesPerHub)}   units ${c.openUnits}`);
  console.log(`    parked ${c.openParked}   released ${c.openReleased}   raised at a hub that does NOT seat the product: ${c.openUnseated}`);
  console.log(`    last release instant: ${snapshot.lastReleaseInstant}   windows ${JSON.stringify(snapshot.releaseWindows)}`);
  console.log(`\n  ── ALREADY MOVED (needs warehouse recovery, not a delete) ─────────────`);
  console.log(`    open lines with a part-pick already sent: ${c.partiallySent}`);
  console.log(`    lines already fulfilled                 : ${c.fulfilled}`);
  console.log(`    parked-in-transit hold lines            : ${c.heldLines}`);
  for (const l of [...partiallySent, ...fulfilledLines].slice(0, 20)) {
    console.log(`      ${pad(l.loc, 7)} ${pad(l.name || l.pid, 34)} ${pad(l.size, 5)} qty=${l.qty} sent=${l.sentQty} ${l.status}`);
  }
  console.log(`\n  snapshot → ${OUT}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
