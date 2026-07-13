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

// Deterministic fingerprint of a product's stock across the whole network —
// the "ignore until inventory changes" decision stores this; ANY movement
// (receive, sale, transfer, adjustment) changes it and resurfaces the card.
// MUST stay in lockstep with the copy in src/components/stock/NoTargetQueue.jsx.
function stockFingerprint(stock, pid) {
  const parts = [];
  for (const loc of Object.keys(stock || {}).sort()) {
    const bySize = stock[loc]?.[pid];
    if (!bySize) continue;
    for (const sizeKey of Object.keys(bySize).sort()) {
      const q = num(bySize[sizeKey]?.qty);
      if (q !== 0) parts.push(`${loc}:${sizeKey}:${q}`);
    }
  }
  return parts.join("|") || "empty";
}
const cellQty = (stock, loc, pid, size) =>
  num(stock?.[loc]?.[pid]?.[encodeSizeKey(size)]?.qty);
const avail = (q) => Math.max(q, 0);

// Is this product clothing? Prefer the explicit flag; legacy size heuristic.
function isClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// ── target resolution — EXPLICIT TARGETS ONLY (owner decision 2026-07-12 v5) ──
// The engine makes NO policy assumptions: a cell is managed if and only if a
// human-approved target exists for it. Three states, never conflated:
//   target > 0  → maintain it (refills below, excess above)
//   target = 0  → deliberately excluded from this location (all stock = excess)
//   no target   → NOT managed; surfaced as "No Target Configured" for humans
// (The old default-run + recent-sale auto-activation was removed — it was the
// engine deciding policy. New products get targets when a human approves them.)
function resolveTarget({ targets }, dest, pid, size) {
  const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];
  if (explicit && typeof explicit.target === "number") {
    return { target: num(explicit.target), minQty: num(explicit.minQty), source: "explicit" };
  }
  return null;
}

// ── the plan ──────────────────────────────────────────────────────────────────
function computeRefillPlan(snapshot) {
  const {
    nowMs, config, targets = {}, stock = {}, products = {},
    openIndex = {}, refillRequests = {}, orders = {}, movements = [],
    targetDecisions = {},   // /stock_targets_decisions — "keep as is" acks from the No Target queue
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

  const ctx = { targets };

  // ── inbound & reservations from EXISTING open intents ──────────────────────
  // inbound[dest|pid|size] = qty already on its way. Manual (human-placed) Shop
  // Refill order lines count as inbound too, so the engine never duplicates a
  // request a shop just placed — engine-created orders carry autoRefill:true and
  // are already represented by their open lock, so they're excluded here.
  const inbound = new Map();
  // v9: units at a SOURCE already promised to open requests — a second
  // destination must never get a card for the same physical unit.
  const sourceReserved = new Map();
  const bump = (map, key, q) => map.set(key, (map.get(key) || 0) + q);
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        bump(inbound, `${dest}|${pid}|${sizeKey}`, num(entry.qty) || 1);
        const s = entry.source || routes[dest];
        if (s) bump(sourceReserved, `${s}|${pid}|${sizeKey}`, num(entry.qty) || 1);
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
  const resizes = [];   // owner approval 2026-07-13: open requests track reality, not history
  const stuckRefills = [];
  // Orders with PHYSICAL fulfilment evidence in the ledger (a movement linked
  // to them) — their status write may still be in flight, so the PLAN skips
  // withdrawing them. NOTE: this is plan-level advisory only — the actual
  // safety boundary is the conditional transaction in refill-scan.cjs that
  // re-reads the order live at write time. Never relax that guard because
  // this set exists (it is built from the same stale snapshot).
  const physicallyTouched = new Set();
  for (const m of movements) if (m?.link?.orderId) physicallyTouched.add(m.link.orderId);
  const staleMs = (num(config?.staleIntentHours) || 48) * 3600e3;
  // Total on-hand for a (pid,size) across every location the scan can see.
  const networkQtyOf = (pid, size) =>
    Object.keys(stock).reduce((t, loc) => t + avail(cellQty(stock, loc, pid, size)), 0);
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        // ORPHANED PENDING LOCK self-heal: a scan that died between claiming a
        // lock and creating its request (function timeout, crash) leaves
        // pending:true with no refillId — phantom inbound that would suppress
        // the cell forever while merely being reported stale. Any pending lock
        // older than an hour can't belong to a live run (run-lock steal is
        // 10 min) → remove it; the released inbound lets the deficit re-propose
        // in this very plan. Younger pending locks stay untouched (in-flight).
        if (entry.pending && !entry.refillId) {
          if (nowMs - Date.parse(entry.createdAt || 0) > 3600e3) {
            closes.push({ dest, pid, sizeKey, refillId: null, reason: "orphaned_pending" });
          }
          continue;
        }
        const rr = entry.refillId ? refillRequests[entry.refillId] : null;
        const order = entry.orderId ? orders[entry.orderId] : null;
        // The order node is only "ours" if it still matches — R-numbers recycle
        // daily, so a same-key node created later is a DIFFERENT order.
        const orderIsOurs = order && order.productId === pid &&
          encodeSizeKey(order.size) === sizeKey && order.createdAt === entry.orderCreatedAt;
        const size = order?.size ?? rr?.size ?? (sizeKey === "_" ? "" : sizeKey);
        const destHave = avail(cellQty(stock, dest, pid, size));
        const unresolvedOurs = (orderIsOurs && order.clothingRefillStatus == null) || (!entry.orderId && rr && rr.status === "open");
        // SELF-REVERSAL (owner rule 2026-07-13): stock can arrive by paths the
        // engine didn't plan — a manual Central→shop transfer, a direct stock
        // add, a bulk customer return. If the destination no longer NEEDS this
        // request (target met counting all OTHER inbound), the engine withdraws
        // its own ask — order deleted, request cancelled — instead of letting
        // the warehouse deliver a surplus.
        const t = unresolvedOurs ? resolveTarget(ctx, dest, pid, size) : null;
        const otherInbound = Math.max((inbound.get(`${dest}|${pid}|${sizeKey}`) || 0) - (num(entry.qty) || 1), 0);
        const needGone = unresolvedOurs && (!t || t.target <= 0 || t.target - destHave - otherInbound <= 0);
        // Certainly-unfillable PURGE (owner rule 2026-07-13): zero stock
        // anywhere upstream → withdrawn; staff never see unpickable requests.
        const unfillable = unresolvedOurs && networkQtyOf(pid, size) - destHave <= 0;
        // ACTIONABLE-ONLY withdraw (owner v9, 2026-07-13): an open engine
        // request whose SOURCE can no longer fulfil it (sold out / never had
        // it) leaves the working queue — staff must never scroll past work
        // they can't do. Self-withdrawal, so NO cooldown: the moment the
        // source restocks, the deficit re-proposes automatically (cascade).
        // IN-FLIGHT GUARD: a fulfil attempt that has locked its split
        // (clothingPlanGen) or already partially sent (clothingRefillGen > 0)
        // must never have its card deleted under the picker's hands — the
        // warehouse finishes what it started; the scan only tidies untouched
        // requests.
        // clothingPlanGen = a fulfil attempt locked its split; ledger link = a
        // pick physically happened (status write may lag). Either one parks
        // the withdraw. (clothingRefillGen deliberately NOT used — it only
        // counts UNDOs, not in-progress picks.)
        const inFlight = (orderIsOurs && order.clothingPlanGen != null) ||
          (entry.orderId && physicallyTouched.has(entry.orderId));
        const sourceLoc = entry.source || routes[dest];
        const sourceEmpty = unresolvedOurs && !needGone && !unfillable && !inFlight &&
          sourceLoc && avail(cellQty(stock, sourceLoc, pid, size)) <= 0;
        if (needGone || unfillable || sourceEmpty) {
          const why = needGone ? "no_longer_needed" : unfillable ? "unfillable" : "awaiting_upstream";
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId,
            reason: why, cancelReason: why,
            rrStatus: "cancelled",
            removeOrderId: orderIsOurs ? entry.orderId : null,
          });
        } else if (rr && rr.status && rr.status !== "open") {
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
        // AUTO-RESIZE (owner approval 2026-07-13): every surviving open request
        // is continuously trued to expected = min(current deficit, source stock
        // net of OTHER reservations, maxUnitsPerIntent). Same request identity,
        // history preserved, never a replacement — a quantity is data, not
        // demand. Skipped while a pick is in flight (retries next scan). An
        // expected of 0 never lands here: the withdraw branches above own the
        // zero cases; the one residue (source stocked but fully reserved by a
        // sibling request) deliberately keeps its quantity until the sibling
        // resolves — deterministic, no claim-stealing between open requests.
        if (unresolvedOurs && !inFlight && !needGone && !unfillable && !sourceEmpty) {
          const srcLoc2 = entry.source || routes[dest];
          const srcHave2 = srcLoc2 ? avail(cellQty(stock, srcLoc2, pid, size)) : 0;
          const ownQty = num(entry.qty) || 1;
          const reservedByOthers = Math.max((sourceReserved.get(`${srcLoc2}|${pid}|${sizeKey}`) || 0) - ownQty, 0);
          const expected = Math.min(
            Math.max((t?.target || 0) - destHave - otherInbound, 0),
            Math.max(srcHave2 - reservedByOthers, 0),
            num(config?.maxUnitsPerIntent) || 20,
          );
          if (expected > 0 && expected !== ownQty) {
            resizes.push({ dest, pid, sizeKey, refillId: entry.refillId || null, orderId: orderIsOurs ? entry.orderId : null, from: ownQty, to: expected });
          }
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
  // A lock being closed THIS scan no longer holds real inbound units — release
  // them so the deficit is honest in the SAME pass (a rejected ask whose stock
  // just arrived re-plans now, not 15 minutes later). Releasing fulfilled
  // closes is equally safe: their units are already inside destHave.
  for (const c of closes) {
    const entry = openIndex[c.dest]?.[c.pid]?.[c.sizeKey];
    if (!entry) continue;
    const k = `${c.dest}|${c.pid}|${c.sizeKey}`;
    const left = (inbound.get(k) || 0) - (num(entry.qty) || 1);
    if (left > 0) inbound.set(k, left); else inbound.delete(k);
  }

  // ── managed universe per dest: EXPLICIT targets only (v5, no policy layer) ──
  const managedPids = (dest) => new Set(Object.keys(targets?.[dest] || {}));
  const sizesFor = (dest, pid) => new Set(Object.keys(targets?.[dest]?.[pid] || {}));
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
  const waitingForStock = [];   // demand parked behind a rejection — never silently dropped
  const awaitingUpstream = [];  // v9: source empty but the chain is flowing — auto-creates when it lands
  const awaitingSupplier = [];  // v9: whole upstream chain empty — supplier reorder / excess return
  let managedCells = 0;   // cells with a resolvable target > 0 (Health-score denominator)
  const maxUnits = num(config?.maxUnitsPerIntent) || 20;

  // Rejection cooldown: (dest|pid|sizeKey) → { ts, by } — the most recent human
  // rejection AND the location that physically said no (recorded on the record
  // itself: order.placedAtHub / rr.source; falls back to the CURRENT route for
  // legacy data). The arrival lift must watch the location that denied, not
  // whatever the route happens to be today — topology is config and can change.
  const cooldownMs = (num(config?.rejectCooldownHours) || 24) * 3600e3;
  const rejectedAt = new Map();
  const setDenial = (map, key, ts, by) => {
    const cur = map.get(key);
    if (!cur || ts > cur.ts) map.set(key, { ts, by: by || null });
  };
  // Confirmed-out learning (owner rule 2026-07-13): a human "not available" at
  // BOTH supply levels beats the counted cells. Track the latest denial per
  // (pid|sizeKey) at each level — SHOP level (a Shop Refill line rejected by
  // the hub2 warehouse, or a cancelled store-destined request) and CENTRAL
  // level (a cancelled hub2 request — Central's Hub 2 Refill queue said no).
  const rejShopLevel = new Map();
  const rejCentralLevel = new Map();
  for (const o of Object.values(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.clothingRefillStatus !== "rejected") continue;
    if (!o.destShop || !o.productId || o.size == null) continue;
    const ts = Date.parse(o.clothingOutOfStockAt || o.updatedAt || 0) || 0;
    const by = o.placedAtHub || o.hub || routes[o.destShop] || null;
    const k = `${o.destShop}|${o.productId}|${encodeSizeKey(o.size)}`;
    setDenial(rejectedAt, k, ts, by);
    const lk = `${o.productId}|${encodeSizeKey(o.size)}`;
    setDenial(rejShopLevel, lk, ts, by);
  }
  for (const [id, rr] of Object.entries(refillRequests)) {
    if (!rr || rr.status !== "cancelled" || !rr.requestingLocation || !rr.productId) continue;
    // Engine self-withdrawals (unfillable / no_longer_needed) are NOT human
    // rejections — they must never impose a cooldown. If the shop dips below
    // target again five minutes later, the engine may re-ask immediately.
    if (rr.cancelReason) continue;
    const ts = Date.parse(rr.resolvedAt || 0) || 0;
    const by = rr.source || rr.createdFrom?.source || routes[rr.requestingLocation] || null;
    const k = `${rr.requestingLocation}|${rr.productId}|${encodeSizeKey(rr.size)}`;
    setDenial(rejectedAt, k, ts, by);
    const lk = `${rr.productId}|${encodeSizeKey(rr.size)}`;
    const levelMap = rr.requestingLocation === "hub2" ? rejCentralLevel : rejShopLevel;
    setDenial(levelMap, lk, ts, by);
  }

  // ── ARRIVAL LIFT (owner rule 2026-07-13: requests are LIVE demand) ──────────
  // A human "not available" is trusted only until stock demonstrably ARRIVES at
  // the location that said no. Any inbound ledger movement — supplier receive,
  // return, positive adjustment, either transfer leg — newer than the denial is
  // fresh physical evidence that beats the stale "no": the demand re-asks on
  // the very next scan instead of resting out the cooldown / confirmed-out
  // window. arrivedAt: (loc|pid|sizeKey) → latest inbound movement ts there.
  // (Movement types whose `to` gains stock mirror applyMovement's cellDeltas;
  // transfers carry a REAL from+to — no in_transit hop — so both legs count.)
  // Only cells with an active denial can need lift evidence, so the map covers
  // exactly those (pid|size) pairs — not every movement in the 45-day window.
  // Where the ledger recorded the resulting balance, it must be POSITIVE: an
  // arrival that leaves the cell at ≤0 (the Negative Inventory "Fix → 0"
  // adjustment, a receive into a deep oversell hole) created no pickable stock
  // and lifts nothing.
  const INBOUND_TYPES = new Set(["received", "opening", "return", "adjustment", "transfer_in", "transfer_out"]);
  const deniedPairs = new Set([...rejShopLevel.keys(), ...rejCentralLevel.keys()]);
  for (const k of rejectedAt.keys()) deniedPairs.add(k.slice(k.indexOf("|") + 1));
  const arrivedAt = new Map();
  for (const m of movements) {
    if (!m || !m.to || !m.productId || m.size == null) continue;
    if (!INBOUND_TYPES.has(m.type) || num(m.qty) <= 0) continue;
    const sizeKey = encodeSizeKey(m.size);
    if (!deniedPairs.has(`${m.productId}|${sizeKey}`)) continue;
    const afterTo = m.after?.[m.to];
    if (typeof afterTo === "number" && afterTo <= 0) continue;
    const ts = Date.parse(m.ts || 0) || 0;
    const k = `${m.to}|${m.productId}|${sizeKey}`;
    if (ts > (arrivedAt.get(k) || 0)) arrivedAt.set(k, ts);
  }
  const arrivedAfter = (loc, pid, sizeKey, ts) =>
    (arrivedAt.get(`${loc}|${pid}|${sizeKey}`) || 0) > ts;
  // Both levels denied within the window (default 14 days) → the size is OUT
  // no matter what the cells claim: no requests to ANY destination, straight
  // to the Missing Sizes reorder list. When the window lapses, the normal
  // cooldown cycle resumes — one re-ask; two fresh denials re-confirm it out.
  const confirmedOutMs = (num(config?.confirmedOutDays) || 14) * 86400e3;
  // Route-derived fallbacks for LEGACY denial records that carry no source of
  // their own: Central (hub2's source) denies hub2 asks; the stores' sources
  // deny store asks. Denials recorded with a `by` use that exact location.
  const centralLevelLoc = routes["hub2"] || "central";
  const shopLevelLocs = [...new Set(dests.filter((d) => d !== "hub2").map((d) => routes[d]).filter(Boolean))];
  const confirmedOut = (pid, sizeKey) => {
    const lk = `${pid}|${sizeKey}`;
    const c = rejCentralLevel.get(lk);
    const s = rejShopLevel.get(lk);
    if (!c || !s || nowMs - c.ts >= confirmedOutMs || nowMs - s.ts >= confirmedOutMs) return false;
    // Stock arrived at the denying location AFTER it said no → no longer
    // confirmed out: one re-ask resumes (two fresh denials re-confirm it out).
    if (arrivedAfter(c.by || centralLevelLoc, pid, sizeKey, c.ts)) return false;
    if (s.by ? arrivedAfter(s.by, pid, sizeKey, s.ts)
             : shopLevelLocs.some((l) => arrivedAfter(l, pid, sizeKey, s.ts))) return false;
    return true;
  };

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

        // Denied by humans at BOTH supply levels → confirmed out. The counted
        // cells may still show stock, but Central and the hub both physically
        // looked and said no — the shelves beat the database. Reorder list,
        // no request, regardless of destination.
        if (confirmedOut(pid, sizeKey)) {
          missingSizes.push({ loc: dest, pid, size, wanted: deficit, note: "denied at both Hub 2 and Central — confirmed out, reorder candidate" });
          continue;
        }

        // Certainly unfillable — ZERO stock anywhere else in the network — is
        // never a request (owner rule 2026-07-13: "if you're 100% sure it
        // exists nowhere, don't even start it — 1000s of unavailable requests
        // are a lot"). It goes straight to the Missing Sizes reorder list and
        // returns to the queue the moment inventory for it appears anywhere.
        if (networkQty(pid, size) - have <= 0) {
          missingSizes.push({ loc: dest, pid, size, wanted: deficit, note: "zero stock upstream — reorder candidate" });
          continue;
        }

        // Suppress for: an intent already on its way, or a fresh rejection —
        // UNLESS stock has arrived at the source since the rejection (arrival
        // lift above: the "no" is stale, the demand reopens automatically).
        // A cell still resting on its cooldown is surfaced as WAITING FOR
        // STOCK so parked demand is always visible, never silently dropped.
        if (inb > 0) continue;
        const rej = rejectedAt.get(`${dest}|${pid}|${sizeKey}`);
        const rejTs = rej?.ts || 0;
        const denier = rej?.by || src;   // watch the location that SAID no, not today's route
        if (nowMs - rejTs < cooldownMs && !arrivedAfter(denier, pid, sizeKey, rejTs)) {
          waitingForStock.push({
            loc: dest, pid, size, deficit, source: denier, rejectedAt: new Date(rejTs).toISOString(),
            note: `rejected at ${denier} — reopens when stock arrives at ${denier} (or after the ${Math.round(cooldownMs / 3600e3)}h cooldown)`,
          });
          continue;
        }

        // ── ACTIONABLE-ONLY QUEUES (owner v9, 2026-07-13 — supersedes v3's
        // propose-don't-suppress) ────────────────────────────────────────────
        // A request enters a working queue ONLY if the source can physically
        // fulfil it right now. Source empty → no card; the demand parks in a
        // passive category instead, and the CASCADE emerges naturally:
        // Trophy needs X, hub2 has none, central does → this scan creates only
        // the central→hub2 leg (hub2's own buffer deficit); when hub2 receives,
        // the NEXT scan creates the Trophy leg. No downstream request exists
        // before its upstream leg is fulfilled, and staff never see work they
        // cannot complete. qty is capped to what the source actually has —
        // every card is fully pickable as written; the remainder re-proposes
        // after the upstream chain tops the source up.
        // Free = on-hand at the source MINUS units already promised to open
        // requests (any destination) MINUS units allocated to intents earlier
        // in THIS scan — two stores can never be sent after one physical unit.
        const srcKey = `${src}|${pid}|${sizeKey}`;
        const srcAvail = avail(cellQty(stock, src, pid, size)) - (sourceReserved.get(srcKey) || 0);
        if (srcAvail <= 0) {
          const upstreamOfSrc = routes[src];   // e.g. central for hub2-sourced legs
          const upstreamAvail = upstreamOfSrc ? avail(cellQty(stock, upstreamOfSrc, pid, size)) : 0;
          // "Chain is flowing" must be TRUE, not hopeful: stock already on its
          // way to the source, or stock one level up AND the source's own leg
          // is not itself parked behind a rejection cooldown / confirmed-out
          // (Codex P2 — otherwise demand sits mislabelled for the whole window).
          const srcRej = rejectedAt.get(`${src}|${pid}|${sizeKey}`);
          const srcParked = (srcRej && nowMs - srcRej.ts < cooldownMs && !arrivedAfter(srcRej.by || upstreamOfSrc, pid, sizeKey, srcRej.ts)) || confirmedOut(pid, sizeKey);
          // "Chain is flowing" additionally requires the source to HAVE a
          // buffer target for this cell — without one the engine will never
          // compute a source deficit, so no upstream leg would EVER create and
          // the demand would starve silently behind a self-healing label
          // (Sonnet HIGH, 2026-07-13). No target at the source = a CONFIG gap,
          // surfaced as blocked, not as flowing.
          const srcTarget = upstreamOfSrc ? resolveTarget(ctx, src, pid, size) : null;
          const srcCanPull = !!(srcTarget && srcTarget.target > 0);
          if ((inbound.get(`${src}|${pid}|${sizeKey}`) || 0) > 0 || (upstreamAvail > 0 && srcCanPull && !srcParked)) {
            awaitingUpstream.push({ loc: dest, pid, size, deficit, source: src, note: `waiting for ${src} to receive stock${upstreamOfSrc ? ` from ${upstreamOfSrc}` : ""}` });
          } else {
            awaitingSupplier.push({
              loc: dest, pid, size, deficit, source: src,
              note: srcParked ? `upstream leg blocked — ${src} recently rejected / confirmed out`
                : (upstreamAvail > 0 && !srcCanPull) ? `${src} has no buffer target for this size — set one (or transfer manually); stock waits at ${upstreamOfSrc}`
                : "upstream chain empty — supplier reorder or excess return needed",
            });
          }
          continue;
        }

        const qty = Math.min(deficit, srcAvail, maxUnits);
        bump(sourceReserved, srcKey, qty);   // claim the units within this scan
        intents.push({
          dest, source: src, productId: pid, size, sizeKey,
          qty, priority: have < t.minQty ? "high" : "normal", mode,
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
  // Outstanding deficit per (pid,size) across ALL destinations — surplus at one
  // location is NOT excess while another location starves for the same size
  // (bugfix 2026-07-12, the "Cortez contradiction": hub2 XL flagged for return
  // to Central while Marathon PE sat at 0/2 XL). Stock flows TOWARD deficits;
  // only what remains after every deficit is covered may leave the network arm.
  const deficitBySize = new Map();
  for (const b of belowTarget) {
    const k = `${b.pid}|${encodeSizeKey(b.size)}`;
    deficitBySize.set(k, (deficitBySize.get(k) || 0) + b.deficit);
  }
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
        // THREE distinct states (owner decision 2026-07-12 v5) — never conflated:
        //   configured target  → excess = qty − target (hub2 strict ≥1, stores ≥2)
        //   explicit target 0  → deliberately excluded here: EVERY unit is excess
        //   no target          → NOT excess; surfaced as noTarget below instead
        if (!t || typeof t.target !== "number") continue;
        const raw = num(cell?.qty) - t.target;
        // Net the surplus against what the rest of the network still NEEDS of
        // this exact size — that portion is held for refills, not for Central.
        const heldForRefills = Math.min(Math.max(raw, 0), deficitBySize.get(`${pid}|${sizeKey}`) || 0);
        const ex = raw - heldForRefills;
        const minEx = t.target === 0 ? 1 : (loc === "hub2" ? 1 : storeExcessMin);
        if (ex >= minEx) excess.push({ loc, pid, sizeKey, have: num(cell.qty), target: t.target, excess: ex, ...(heldForRefills > 0 ? { heldForRefills } : {}) });
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

  // ── Decision Queue + Unintroduced (v8): SETUP split from MIGRATION ──────────
  // (owner architecture 2026-07-13) Two completely different concepts that the
  // old queue conflated, now separated:
  //   • NEW PRODUCT (loc "central", isNew) — stock at Central, no targets at
  //     ANY destination AND no stock at any destination: genuinely entering the
  //     network for the first time. The ONLY place target quantities are a
  //     business decision. Introduction wizard → targets → initial distribution
  //     → engine takes over permanently.
  //   • UNINTRODUCED (exceptions.unintroduced, one entry per product) — already
  //     circulating at PE/Trophy/Hub 2 but with no targets anywhere: an
  //     existing product that simply never entered engine management. The
  //     standard run is ALREADY the approved policy for these, so they are NOT
  //     decisions — the one-tap "Introduce Existing Products" migration in
  //     Health applies the standard targets in bulk and the engine takes over.
  //   • Genuine decisions that remain in the queue:
  //       – noStandard: circulating product whose stocked sizes the standard
  //         run doesn't cover (numeric jeans etc.) — no approved quantities
  //         exist, a human must set them;
  //       – assortment leftover: stock at a location for a product that HAS
  //         targets elsewhere — include here, transfer away, or exclude.
  // Decision records (/stock_targets_decisions/{loc}/{pid}) suppress entries:
  //   keep         — permanent (legacy)
  //   snooze       — until the `until` timestamp passes (remind me later)
  //   until_change — until the product's network-wide stock FINGERPRINT changes
  //                  (any receive/sale/transfer resurfaces the card)
  const noTarget = [];
  const unintroduced = [];
  const decisionActive = (loc, pid) => {
    const d = targetDecisions?.[loc]?.[pid];
    if (!d) return false;
    if (d.decision === "keep") return true;
    if (d.decision === "snooze") return Date.parse(d.until || 0) > nowMs;
    if (d.decision === "until_change") return d.fingerprint === stockFingerprint(stock, pid);
    return false;
  };
  // Sizes the standard run covers (letters only — numeric sizes have no
  // approved standard quantity). MUST stay in lockstep with the client copy in
  // src/components/stock/introduceExistingCore.js.
  const STANDARD_SIZE_RE = /^(S|M|L|XL|XXL|XXXL)$/i;
  // Cell PRESENCE, not quantity (consistent with `circulates`): a standard
  // size whose cells all sold to zero still gets a target on migration — its
  // demand is proven and the engine should replenish or reorder it, not let
  // the product vanish from both workflows.
  const stockedStandardSizes = (pid) => {
    const out = new Set();
    for (const l of Object.keys(stock)) {
      for (const sk of Object.keys(stock[l]?.[pid] || {})) {
        if (STANDARD_SIZE_RE.test(sk)) out.add(sk);
      }
    }
    return [...out];
  };
  // NEW products at Central FIRST — the exceptions snapshot caps its item list,
  // and the introduction queue is the primary workflow, so it must never be the
  // part that gets truncated.
  // Circulation evidence is cell PRESENCE, not current quantity: applyMovement
  // never deletes a cell, so a destination cell at qty 0 still proves the
  // product has been out in the network — a sell-through to zero must NOT flip
  // a product back to "NEW" (it already circulated; it belongs to migration).
  const circulates = (pid) => dests.some((d) => stock?.[d]?.[pid] && Object.keys(stock[d][pid]).length > 0);
  for (const [pid, bySize] of Object.entries(stock?.central || {})) {
    if (!isClothing(products?.[pid])) continue;
    if (dests.some((d) => targets?.[d]?.[pid])) continue;   // introduced somewhere
    if (circulates(pid)) continue;                          // circulating → unintroduced, NOT new
    if (decisionActive("central", pid)) continue;
    const units = Object.values(bySize || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
    if (units > 0) noTarget.push({ loc: "central", pid, units, isNew: true });
  }
  const seenUnintroduced = new Set();
  for (const loc of dests) {
    for (const [pid, bySize] of Object.entries(stock?.[loc] || {})) {
      if (!isClothing(products?.[pid])) continue;
      if (targets?.[loc]?.[pid]) continue;             // some target here → managed
      if (!Object.keys(bySize || {}).length) continue;
      const units = Object.values(bySize || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
      if (!dests.some((d) => targets?.[d]?.[pid])) {
        // Zero targets anywhere + has circulated = awaiting migration, one
        // entry per product (never per location — no duplicate cards). A
        // sold-to-zero product still migrates: its demand is proven and the
        // engine will redistribute it the moment targets exist. The dedup
        // applies ONLY to the network-wide migration entry — noStandard
        // decisions stay per-location so no location's stock goes invisible.
        const standardSizes = stockedStandardSizes(pid);
        if (standardSizes.length) {
          if (seenUnintroduced.has(pid)) continue;
          seenUnintroduced.add(pid);
          unintroduced.push({
            pid, standardSizes,
            units: dests.reduce((t, d) => t + sumLoc(d, pid), 0),
            byLoc: Object.fromEntries(["central", ...dests].map((l) => [l, sumLoc(l, pid)])),
          });
        } else if (units > 0 && !decisionActive(loc, pid)) {
          noTarget.push({ loc, pid, units, noStandard: true });
        }
        continue;
      }
      if (units <= 0) continue;
      if (decisionActive(loc, pid)) continue;
      noTarget.push({ loc, pid, units });   // assortment leftover — genuine decision
    }
  }
  // SIZE-SCOPED blind-spot guard (review 2026-07-13): a MANAGED product can
  // still hold stocked sizes the standard run doesn't cover and no human ever
  // targeted (mixed letter+numeric garments — migrated on M/L while a "32"
  // sits in stock). The pid-level managed gate above would hide those cells
  // forever, so they surface here as a size-scoped noStandard decision.
  for (const loc of dests) {
    for (const [pid, byTarget] of Object.entries(targets?.[loc] || {})) {
      if (!isClothing(products?.[pid])) continue;
      if (!stock?.[loc]?.[pid]) continue;
      if (decisionActive(loc, pid)) continue;
      let units = 0;
      for (const [sk, c] of Object.entries(stock[loc][pid])) {
        const q = avail(num(c?.qty));
        if (q > 0 && !STANDARD_SIZE_RE.test(sk) && !byTarget[sk]) units += q;
      }
      if (units > 0) noTarget.push({ loc, pid, units, noStandard: true });
    }
  }
  // (v5: the Policy Warnings layer was REMOVED at the owner's direction — the
  // engine no longer second-guesses targets. Unconfigured stock is surfaced as
  // "No Target Configured" below; everything else is the warehouse's call.)

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
    resizes,
    errors,
    stats: { managedCells },
    exceptions: {
      noTarget: cap(noTarget),
      unintroduced: cap(unintroduced, 900),
      belowTarget: cap(belowTarget, 1500),
      missingSizes: cap(missingSizes),
      waitingForStock: cap(waitingForStock),
      awaitingUpstream: cap(awaitingUpstream, 900),
      awaitingSupplier: cap(awaitingSupplier, 900),
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

module.exports = { computeRefillPlan, computeConfidence, resolveTarget, encodeSizeKey, saTodayKey, isClothing, stockFingerprint };
