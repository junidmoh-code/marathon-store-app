// ─── REFILL ENGINE CORE (pure) ────────────────────────────────────────────────
// The deterministic heart of the automated clothing-refill system. Every 15
// minutes the refillHealthScan Cloud Function snapshots the RTDB and calls
// computeRefillPlan() below; the function then APPLIES the plan (creates refill
// intents / R### orders, closes finished locks, writes exceptions). All policy
// lives HERE, pure and node-tested — the function is just I/O.
//
// DESIGN RULES (see plan "AI-Driven Inventory Refill"):
//  • The engine NEVER writes /stock. It creates intents; humans move stock via
//    the existing CR fulfilment (fulfillCRBatch) and Transfer flows.
//  • Scan-only, stateless: every run recomputes deficits from scratch, so a
//    crashed run, a lost intent, or a human mistake heals on the next pass (L3).
//  • Routing is CONFIG (config.routes), never code — flexible topology.
//  • qty < 0 (oversell signals) counts as 0 available and never inflates a
//    deficit; it feeds the confidence score instead.
//  • Idempotency: ONE open intent per (dest, product, size), tracked in
//    /refill_engine/open. R-numbers are daily-recycled and are never identity.
//
// Terminology:
//  • dest      — a location being kept at target (marathon-pe, trophy, hub2)
//  • source    — where its refills come from (config.routes[dest])
//  • intent    — "move qty of (product,size) source→dest", surfaced as a
//                /refill_requests record (+ an R### order for store legs)

// RTDB keys can't contain . # $ / [ ] — mirror of src/utils/sizeKey.js.
function encodeSizeKey(size) {
  const s = String(size == null ? "" : size).trim();
  if (!s) return "_";
  return s.replace(/[.#$/\[\]\s]/g, "_");
}

// Device-local SA date key, matching App.jsx getTodayKey() EXACTLY (including
// the 0-based month!). The refill counter's daily reset compares this string —
// the server must produce the same value the shop tablets (UTC+2) produce, or
// a scan near midnight would fight the tablets over the counter's day.
function saTodayKey(nowMs) {
  const d = new Date(nowMs + 2 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const cellQty = (stock, loc, pid, size) =>
  num(stock?.[loc]?.[pid]?.[encodeSizeKey(size)]?.qty);
const avail = (q) => Math.max(q, 0);

// Is this product clothing? Prefer the explicit flag; legacy size heuristic.
function isClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// ── target resolution ─────────────────────────────────────────────────────────
// explicit /stock_targets cell → default run (only for shops, only for sizes in
// the product's catalog, only if the product sold at that shop recently) → null
// (unmanaged — the engine leaves the cell alone).
function resolveTarget({ config, targets, products, recentSaleSet }, dest, pid, size) {
  const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];
  if (explicit && typeof explicit.target === "number") {
    return { target: num(explicit.target), minQty: num(explicit.minQty), source: "explicit" };
  }
  const run = config?.defaultRunByStore?.[dest];
  if (!run || run[size] == null) return null;
  const p = products?.[pid];
  if (!isClothing(p)) return null;
  if (!(p.sizes || []).map(String).includes(String(size))) return null;
  if (!recentSaleSet.has(`${dest}|${pid}`)) return null;
  return { target: num(run[size]), minQty: Math.ceil(num(run[size]) / 2), source: "default_run" };
}

// ── the plan ──────────────────────────────────────────────────────────────────
function computeRefillPlan(snapshot) {
  const {
    nowMs, config, targets = {}, stock = {}, products = {},
    openIndex = {}, refillRequests = {}, orders = {}, movements = [],
  } = snapshot;

  const errors = [];
  const routes = config?.routes || {};
  // Dests ordered so downstream (stores) compute before their source when the
  // source is itself a dest (hub2) — pass-through demand must land first.
  const dests = Object.keys(routes).sort((a, b) => {
    if (routes[a] === b) return -1;
    if (routes[b] === a) return 1;
    return a.localeCompare(b);
  });

  // Recent-sale gate for the default run: `${loc}|${pid}` that sold within
  // defaultRunRecentSaleDays. Uses the windowed movements the caller fetched.
  const recentDays = num(config?.defaultRunRecentSaleDays) || 14;
  const recentCutoff = nowMs - recentDays * 864e5;
  const recentSaleSet = new Set();
  for (const m of movements) {
    if (m?.type === "sold" && m.from && m.productId && Date.parse(m.ts || "") >= recentCutoff) {
      recentSaleSet.add(`${m.from}|${m.productId}`);
    }
  }
  const ctx = { config, targets, products, recentSaleSet };

  // ── inbound & reservations from EXISTING open intents ──────────────────────
  // inbound[dest|pid|size] = qty already on its way. Manual (human-placed) Shop
  // Refill order lines count as inbound too, so the engine never duplicates a
  // request a shop just placed — engine-created orders carry autoRefill:true and
  // are already represented by their open lock, so they're excluded here.
  const inbound = new Map();
  const bump = (map, key, q) => map.set(key, (map.get(key) || 0) + q);
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        bump(inbound, `${dest}|${pid}|${sizeKey}`, num(entry.qty) || 1);
      }
    }
  }
  for (const o of Object.values(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.autoRefill) continue;
    if (o.clothingRefillStatus != null || o.status !== "incoming") continue;
    if (!o.destShop || !o.productId || o.size == null) continue;
    bump(inbound, `${o.destShop}|${o.productId}|${encodeSizeKey(o.size)}`, num(o.qty) || 1);
  }

  // ── reconcile: close locks whose intent finished; flag stale ones (L6) ─────
  const closes = [];
  const stuckRefills = [];
  const staleMs = (num(config?.staleIntentHours) || 48) * 3600e3;
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        const rr = entry.refillId ? refillRequests[entry.refillId] : null;
        const order = entry.orderId ? orders[entry.orderId] : null;
        // The order node is only "ours" if it still matches — R-numbers recycle
        // daily, so a same-key node created later is a DIFFERENT order.
        const orderIsOurs = order && order.productId === pid &&
          encodeSizeKey(order.size) === sizeKey && order.createdAt === entry.orderCreatedAt;
        if (rr && rr.status && rr.status !== "open") {
          closes.push({ dest, pid, sizeKey, refillId: entry.refillId, reason: rr.status });
        } else if (orderIsOurs && order.clothingRefillStatus != null) {
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId,
            reason: order.clothingRefillStatus === "available" ? "fulfilled" : "cancelled",
            rrStatus: order.clothingRefillStatus === "available" ? "fulfilled" : "cancelled",
          });
        } else if (nowMs - Date.parse(entry.createdAt || 0) > staleMs) {
          stuckRefills.push({ dest, pid, sizeKey, refillId: entry.refillId || null, ageHours: Math.round((nowMs - Date.parse(entry.createdAt || 0)) / 3600e3) });
        }
      }
    }
  }
  // Manual refill lines stuck too long are equally worth surfacing.
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.autoRefill) continue;
    if (o.clothingRefillStatus != null || o.status !== "incoming") continue;
    if (nowMs - Date.parse(o.createdAt || 0) > staleMs) {
      stuckRefills.push({ dest: o.destShop || null, pid: o.productId || null, sizeKey: encodeSizeKey(o.size), orderId: id, manual: true, ageHours: Math.round((nowMs - Date.parse(o.createdAt || 0)) / 3600e3) });
    }
  }
  const closedSet = new Set(closes.map((c) => `${c.dest}|${c.pid}|${c.sizeKey}`));

  // ── managed universe per dest: explicit-target pids ∪ recently-sold pids ────
  const managedPids = (dest) => {
    const set = new Set(Object.keys(targets?.[dest] || {}));
    if (config?.defaultRunByStore?.[dest]) {
      for (const key of recentSaleSet) {
        const [loc, pid] = key.split("|");
        if (loc === dest) set.add(pid);
      }
    }
    return set;
  };
  const sizesFor = (dest, pid) => {
    const set = new Set(Object.keys(targets?.[dest]?.[pid] || {}).map((k) => k)); // encoded keys
    const run = config?.defaultRunByStore?.[dest] || {};
    for (const s of products?.[pid]?.sizes || []) {
      if (run[String(s)] != null) set.add(encodeSizeKey(s));
    }
    return set;
  };
  // Encoded key → raw size (clothing letters are identity; keep a map anyway).
  const rawSize = (pid, sizeKey) => {
    for (const s of products?.[pid]?.sizes || []) if (encodeSizeKey(s) === sizeKey) return String(s);
    return sizeKey === "_" ? "" : sizeKey;
  };

  // ── deficits (L1/L2/L4) — propose, don't suppress ───────────────────────────
  // Owner philosophy (2026-07-12 v3): the warehouse is the validation layer.
  // A deficit ALWAYS becomes a request (system availability is advisory — real
  // shelves beat database cells); staff fulfil or reject per size. The only
  // suppressors are: an intent already open for the cell, and a recent
  // warehouse REJECTION of the same cell (cooldown, so a "no" isn't re-asked
  // every 15 minutes). Zero-stock-anywhere still surfaces as a missing-size
  // reorder candidate IN ADDITION to the request.
  const intents = [];
  const belowTarget = [];
  const missingSizes = [];
  let managedCells = 0;   // cells with a resolvable target > 0 (Health-score denominator)
  const maxUnits = num(config?.maxUnitsPerIntent) || 20;

  // Rejection cooldown: (dest|pid|sizeKey) → most recent rejection timestamp.
  const cooldownMs = (num(config?.rejectCooldownHours) || 24) * 3600e3;
  const rejectedAt = new Map();
  for (const o of Object.values(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.clothingRefillStatus !== "rejected") continue;
    if (!o.destShop || !o.productId || o.size == null) continue;
    const ts = Date.parse(o.clothingOutOfStockAt || o.updatedAt || 0) || 0;
    const k = `${o.destShop}|${o.productId}|${encodeSizeKey(o.size)}`;
    if (ts > (rejectedAt.get(k) || 0)) rejectedAt.set(k, ts);
  }
  for (const [id, rr] of Object.entries(refillRequests)) {
    if (!rr || rr.status !== "cancelled" || !rr.requestingLocation || !rr.productId) continue;
    const ts = Date.parse(rr.resolvedAt || 0) || 0;
    const k = `${rr.requestingLocation}|${rr.productId}|${encodeSizeKey(rr.size)}`;
    if (ts > (rejectedAt.get(k) || 0)) rejectedAt.set(k, ts);
  }

  const networkQty = (pid, size) =>
    Object.keys(stock).reduce((t, loc) => t + avail(cellQty(stock, loc, pid, size)), 0);

  for (const dest of dests) {
    const mode = config?.mode?.[dest] || "off";
    const src = routes[dest];
    for (const pid of managedPids(dest)) {
      if (!isClothing(products?.[pid]) && !targets?.[dest]?.[pid]) continue;
      for (const sizeKey of sizesFor(dest, pid)) {
        const size = rawSize(pid, sizeKey);
        const t = resolveTarget(ctx, dest, pid, size);
        if (!t || t.target <= 0) continue;
        managedCells++;
        const q = cellQty(stock, dest, pid, size);
        const have = avail(q);
        const inb = inbound.get(`${dest}|${pid}|${sizeKey}`) || 0;
        const deficit = t.target - have - inb;
        if (deficit <= 0) continue;

        belowTarget.push({ loc: dest, pid, size, have: q, target: t.target, inbound: inb, deficit });

        // Genuinely nothing anywhere in the network → reorder candidate (the
        // request below still goes out — the shelf may disagree with the DB).
        if (networkQty(pid, size) - have <= 0) {
          missingSizes.push({ loc: dest, pid, size, wanted: deficit, note: "zero stock upstream — reorder candidate" });
        }

        // Suppress ONLY for: an intent already on its way, or a fresh rejection.
        if (inb > 0) continue;
        if (nowMs - (rejectedAt.get(`${dest}|${pid}|${sizeKey}`) || 0) < cooldownMs) continue;

        intents.push({
          dest, source: src, productId: pid, size, sizeKey,
          qty: Math.min(deficit, maxUnits),
          priority: have < t.minQty ? "high" : "normal", mode,
        });
      }
    }
  }

  // ── circuit breaker — FAIR across destinations ──────────────────────────────
  // A global top-N starves the smaller locations (Marathon PE's backlog alone
  // can fill the cap, so Trophy and hub2 never surface). Round-robin across
  // destinations instead: each dest's list is priority-sorted, then slots are
  // dealt one per dest until the cap is reached.
  const maxIntents = num(config?.maxIntentsPerRun) || 200;
  let plannedIntents = intents;
  if (intents.length > maxIntents) {
    errors.push(`circuit breaker: ${intents.length} intents computed, capped to ${maxIntents} (fair per destination, high-priority first)`);
    const byDest = new Map();
    for (const i of intents) {
      if (!byDest.has(i.dest)) byDest.set(i.dest, []);
      byDest.get(i.dest).push(i);
    }
    for (const list of byDest.values()) list.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
    plannedIntents = [];
    const queues = [...byDest.values()];
    for (let round = 0; plannedIntents.length < maxIntents; round++) {
      let dealt = false;
      for (const q of queues) {
        if (round < q.length && plannedIntents.length < maxIntents) { plannedIntents.push(q[round]); dealt = true; }
      }
      if (!dealt) break;
    }
  }

  // ── inventory intelligence (plan §Inventory Intelligence — CLOTHING ONLY) ───
  const onlyInCentral = [];
  const onlyInHub2 = [];
  const excess = [];        // network-wide: hub2 (any surplus) + stores (significant surplus)
  const negativeCells = [];
  const sumLoc = (loc, pid) => Object.values(stock?.[loc]?.[pid] || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
  // Stores legitimately sell down their overage, so only SIGNIFICANT store
  // excess is flagged; hub2 is a strict buffer — any unit above target counts.
  const storeExcessMin = num(config?.storeExcessMinUnits) || 2;
  const allPids = new Set([
    ...Object.keys(stock?.central || {}), ...Object.keys(stock?.hub2 || {}),
    ...Object.keys(stock?.["marathon-pe"] || {}), ...Object.keys(stock?.trophy || {}),
  ]);
  for (const pid of allPids) {
    if (!isClothing(products?.[pid])) continue;
    const ce = sumLoc("central", pid), h2 = sumLoc("hub2", pid);
    const pe = sumLoc("marathon-pe", pid), tr = sumLoc("trophy", pid);
    if (ce > 0 && h2 === 0 && pe === 0 && tr === 0) onlyInCentral.push({ pid, units: ce });
    if (h2 > 0 && pe === 0 && tr === 0) onlyInHub2.push({ pid, units: h2 });
    for (const loc of dests) {
      for (const [sizeKey, cell] of Object.entries(stock?.[loc]?.[pid] || {})) {
        const t = targets?.[loc]?.[pid]?.[sizeKey];
        // Hub 2 is STRICTLY a refill buffer: a product/size with NO approved
        // target has no business sitting there — its whole quantity is excess
        // (target 0). Stores keep the target requirement (they hold what they
        // hold; only targeted cells are judged).
        const target = (t && typeof t.target === "number") ? t.target
          : (loc === "hub2" ? 0 : null);
        if (target == null) continue;
        const ex = num(cell?.qty) - target;
        const minEx = loc === "hub2" ? 1 : storeExcessMin;
        if (ex >= minEx) excess.push({ loc, pid, sizeKey, have: num(cell.qty), target, excess: ex });
      }
    }
  }
  for (const loc of new Set([...dests, ...Object.values(routes)])) {
    for (const [pid, bySize] of Object.entries(stock?.[loc] || {})) {
      if (!isClothing(products?.[pid])) continue;   // sneakers never appear in Health
      for (const [sizeKey, cell] of Object.entries(bySize || {})) {
        if (num(cell?.qty) < 0) negativeCells.push({ loc, pid, sizeKey, qty: num(cell.qty) });
      }
    }
  }
  // ── policy warnings: inconsistencies to review BEFORE trusting refills ─────
  // (owner request after the first shadow scan — surface bad targets instead of
  // silently generating requests from them)
  const policyWarnings = [];
  const anyStockOfSize = (pid, sizeKey) =>
    Object.keys(stock).some((loc) => num(stock?.[loc]?.[pid]?.[sizeKey]?.qty) > 0);
  for (const [loc, byPid] of Object.entries(targets)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      const p = products?.[pid];
      if (!p) { policyWarnings.push({ kind: "unknown_product", loc, pid, note: "target on a product that no longer exists" }); continue; }
      if (!isClothing(p)) { policyWarnings.push({ kind: "not_clothing", loc, pid, note: "target on a non-clothing product" }); continue; }
      const catalog = new Set((p.sizes || []).map((s) => encodeSizeKey(s)));
      for (const sizeKey of Object.keys(bySize || {})) {
        const t = bySize[sizeKey];
        if (!t || num(t.target) <= 0) continue;
        if (!catalog.has(sizeKey) && !anyStockOfSize(pid, sizeKey)) {
          policyWarnings.push({ kind: "size_not_carried", loc, pid, sizeKey, note: "target on a size this product doesn't carry and no stock exists anywhere" });
        }
      }
      // (v3: the "inactive product" warning was dropped — it flagged work the
      // warehouse is perfectly able to judge itself; warnings are reserved for
      // genuine data problems a human must fix.)
    }
  }

  // Failed refills (visible 48h): any Shop Refill line rejected recently.
  const failedRefills = [];
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.customerName !== "Shop Refill") continue;
    if (o.clothingRefillStatus === "rejected" && nowMs - Date.parse(o.clothingOutOfStockAt || o.updatedAt || 0) < 48 * 3600e3) {
      failedRefills.push({ orderId: id, pid: o.productId || null, size: o.size, dest: o.destShop || null });
    }
  }

  const cap = (arr, n = 300) => ({ count: arr.length, items: arr.slice(0, n) });
  return {
    intents: plannedIntents,
    closes,
    errors,
    stats: { managedCells },
    exceptions: {
      policyWarnings: cap(policyWarnings),
      belowTarget: cap(belowTarget),
      missingSizes: cap(missingSizes),
      stuckRefills: cap(stuckRefills),
      failedRefills: cap(failedRefills),
      onlyInCentral: cap(onlyInCentral),
      onlyInHub2: cap(onlyInHub2),
      excess: cap(excess),
      negativeCells: cap(negativeCells),
    },
  };
}

// ── confidence scoring (plan §Inventory Confidence Score) ─────────────────────
// Per (location, product): start at 100, subtract for accuracy risk signals.
// Only entries below the threshold are returned (the "Needs Review" list).
function computeConfidence({ nowMs, stock = {}, movements = [], openIndex = {}, products = {}, threshold = 85 }) {
  const byLocPid = new Map();
  const ensure = (loc, pid) => {
    const k = `${loc}|${pid}`;
    if (!byLocPid.has(k)) byLocPid.set(k, { negative: 0, adjustments: 0, uncounted: 0, lastMoveMs: 0, stuck: 0 });
    return byLocPid.get(k);
  };
  const clothingOnly = Object.keys(products).length > 0;
  const skip = (pid) => clothingOnly && !isClothing(products[pid]);
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      if (skip(pid)) continue;
      for (const cell of Object.values(bySize || {})) {
        if (num(cell?.qty) < 0) ensure(loc, pid).negative++;
        const upd = Date.parse(cell?.updatedAt || 0) || 0;
        const f = ensure(loc, pid);
        if (upd > f.lastMoveMs) f.lastMoveMs = upd;
      }
    }
  }
  const d30 = nowMs - 30 * 864e5;
  for (const m of movements) {
    if (!m || skip(m.productId)) continue;
    const ts = Date.parse(m.ts || 0) || 0;
    if (m.type === "adjustment" && ts >= d30) {
      if (m.from) ensure(m.from, m.productId).adjustments++;
      if (m.to) ensure(m.to, m.productId).adjustments++;
    }
    if (m.reason === "clothing_cr_uncounted" && ts >= d30 && m.to) ensure(m.to, m.productId).uncounted++;
  }
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const pid of Object.keys(byPid || {})) if (!skip(pid)) ensure(dest, pid); // presence only
  }
  const out = {};
  for (const [k, f] of byLocPid) {
    const [loc, pid] = k.split("|");
    let score = 100;
    if (f.negative > 0) score -= 30;
    score -= Math.min(f.adjustments * 5, 25);
    if (f.lastMoveMs && nowMs - f.lastMoveMs > 45 * 864e5) score -= 15;
    score -= Math.min(f.uncounted * 10, 20);
    score = Math.max(0, score);
    if (score < threshold) {
      ((out[loc] ||= {})[pid] = { score, factors: { negativeCells: f.negative, adjustments30d: f.adjustments, uncountedSends30d: f.uncounted, staleDays: f.lastMoveMs ? Math.round((nowMs - f.lastMoveMs) / 864e5) : null } });
    }
  }
  return out;
}

module.exports = { computeRefillPlan, computeConfidence, resolveTarget, encodeSizeKey, saTodayKey, isClothing };
