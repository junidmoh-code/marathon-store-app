// ─── BEANIE ONE-SIZE COLLAPSE — CORE (pure logic, io-injected) ────────────────
//
// The migration's decision-making, extracted from the CLI so the behaviour is
// testable against a fake RTDB. NOTHING in here touches firebase directly: every
// read/write goes through an injected `io` with two methods —
//
//   io.read(path)      → Promise<value|null>
//   io.update(updates) → Promise<void>   ONE atomic multi-path update from root
//
// The live CLI (scripts/collapse-one-size-beanies.mjs) binds these to the Admin
// SDK; the tests bind them to a fake that reproduces real RTDB semantics —
// including the one that invalidates naive fakes: RTDB DELETES a child whose
// written value is null, an empty object or an empty array.
//
// ── WHY MOVEMENTS ARE RE-IMPLEMENTED HERE (applyMovementAdmin) ───────────────
// All stock writes go through applyMovement — but the canonical implementation
// (src/components/stock/applyMovement.js) is a CLIENT module: it imports the
// client firebase handle and stamps auth.currentUser. A server-side migration
// cannot call it. applyMovementAdmin reproduces its CONTRACT, field for field:
//   • the movement and every touched cell land in ONE atomic multi-path update
//   • the movement id is the idempotency key — if it exists, no-op
//   • cell writes increment `v` by exactly 1 and change `mv`; new cells start
//     at v=0 (client: `typeof v === "number" ? v+1 : 0`)
//   • a negative-going adjustment may not overdraw the cell — refused unless
//     the caller opts in with allowNegative (same escape hatch the client has)
//   • before/after per-location audit snapshot derived from the SAME read that
//     computes the write
// The behavioural tests pin each of these points; drift between the two
// implementations fails a test, not a stock count.
//
// ── SIZE KEYS ────────────────────────────────────────────────────────────────
// Everything goes through the existing chokepoint (src/utils/sizeKey.js):
// stockCellPath builds every cell path, so a display label ("Free Size") can
// never reach a storage key — stockSizeKey folds it to the "_" sentinel, and
// assertSafeSegment throws on anything illegal before a write exists.
//
// ── MOVEMENT IDS ─────────────────────────────────────────────────────────────
// Deterministic per (product, location, size), so a re-run is a no-op:
//   positive stock   OUT  onesize_<pid>_<loc>_out_<sizeKey>     (sized cell → 0)
//                    IN   onesize_<pid>_<loc>_in_us_<sizeKey>   ("_" cell += n)
//   negative stock   OUT  onesize_<pid>_<loc>_out_us_<sizeKey>  ("_" cell -= n, allowNegative)
//                    IN   onesize_<pid>_<loc>_in_<sizeKey>      (sized cell → 0)
//
// The IN id carries the SOURCE size key. The spec's shape (one `_in_us` per
// location) collides when a product holds stock in TWO sizes at one location:
// the second pair's IN leg would hit the first's id, be skipped as idempotent,
// and silently lose that size's units. Per-size ids keep re-runs no-ops AND
// make the M+L merge correct — the mutation test "M 100 + L 100 → single _
// cell of 200" fails on the collided shape. (Live census 2026-08-10 found zero
// multi-size holders, so real ids differ from the spec only in suffix.)
//
// A NEGATIVE sized cell (census: Nike beanie green, marathon-pe S = −1, an
// oversell signal) cannot ride the normal pair — the OUT leg would overdraw.
// The MIRRORED pair moves the shortage instead of the stock: OUT from "_" with
// allowNegative (the honest-shortage escape hatch applyMovement documents),
// then IN to the sized cell to bring it to 0. Total unchanged; the −1 keeps
// telling the truth from the cell scans actually hit. OUT runs first so an
// interruption leaves the total conservatively LOW, never fabricated HIGH.

import { encodeSizeKey, stockSizeKey, stockCellPath, assertSafeSegment } from "../../src/utils/sizeKey.js";

const ACTOR = "system:beanie-onesize-collapse";
const BATCH = "beanie-onesize-collapse";

// ── WHAT COUNTS AS AN OPEN REFERENCE ─────────────────────────────────────────
// A product is gated only when some FUTURE action would still move stock in the
// size key this migration is about to retire. An order's base status alone does
// not say that:
//
//   • A "Shop Refill" (CR) line resolves via clothingRefillStatus, NOT status —
//     its base status stays "incoming" forever (App.jsx:17183; the engine's own
//     resolution test is `clothingRefillStatus != null`). The live census found
//     43 beanie CR lines at "incoming"; 37 were fulfilled weeks ago and can
//     never clear, so gating on status would block those products permanently
//     and gain nothing.
//   • What a RESOLVED CR line can still do is be UNDONE, and undo reverses real
//     stock keyed by the line's size (App.jsx:10232, reverseCRRefill). The undo
//     control exists only while the batch sits in the completed list, bounded by
//     RESOLVED_VISIBLE_MS = 24h (App.jsx:9468). Past that it is terminal in the
//     UI as well as in the ledger.
//   • An UNRESOLVED CR line is a live pick: Send fires the hub→shop transfer on
//     that size. Always blocks.
//   • A customer order in a live status still has its dispatch ahead of it.
export const REAL_SIZE = /^(XS|S|M|L|XL|XXL|XXXL)$/;
export const LIVE_ORDER_STATUSES = new Set(["incoming", "ready", "coming_tomorrow", "on_hold"]);
export const CR_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export function orderBlocks(order, pid, nowMs) {
  if (!order || order.productId !== pid) return null;
  if (!REAL_SIZE.test(String(order.size || ""))) return null;   // one-size / no real size — nothing to retire
  if (order.customerName === "Shop Refill") {
    if (order.clothingRefillStatus == null) return `unresolved refill line ${order.id || ""} (size ${order.size}) — Send would move stock in the retired size`;
    const resolvedMs = Date.parse(order.clothingRefilledAt || order.clothingOutOfStockAt || order.updatedAt || order.createdAt) || 0;
    if (nowMs - resolvedMs < CR_UNDO_WINDOW_MS) {
      return `refill line ${order.id || ""} resolved ${new Date(resolvedMs).toISOString()} — inside the 24h undo window, and undo reverses stock in size ${order.size}`;
    }
    return null;
  }
  return LIVE_ORDER_STATUSES.has(order.status)
    ? `live customer order ${order.id || ""} (${order.status}, size ${order.size}) — dispatch would move stock in the retired size`
    : null;
}

export const legIds = (pid, loc, sizeKey) => ({
  out: `onesize_${pid}_${loc}_out_${sizeKey}`,
  in: `onesize_${pid}_${loc}_in_us_${sizeKey}`,
  negOut: `onesize_${pid}_${loc}_out_us_${sizeKey}`,
  negIn: `onesize_${pid}_${loc}_in_${sizeKey}`,
});

function emptyLink() {
  return { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null };
}

// ── applyMovementAdmin — see header for the contract this mirrors ─────────────
export async function applyMovementAdmin(io, movement, { nowIso }) {
  if (!movement || movement.type !== "adjustment") return { ok: false, reason: "invalid_type" };
  if (!movement.productId || !movement.size) return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0)) return { ok: false, reason: "qty_must_be_positive" };
  if (!(movement.reason && String(movement.reason).trim())) return { ok: false, reason: "adjustment_requires_reason" };
  if (!movement.movementId) return { ok: false, reason: "movement_id_required" };
  const mvId = assertSafeSegment(movement.movementId, "movementId");

  const existing = await io.read(`stock_movements/${mvId}`);
  if (existing) return { ok: true, movementId: mvId, idempotent: true };

  const loc = movement.to || movement.from;
  const delta = movement.to ? +Number(movement.qty) : -Number(movement.qty);
  if (!loc) return { ok: false, reason: "missing_location" };

  const path = stockCellPath(loc, movement.productId, movement.size);
  const cell = await io.read(path);
  const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
  const newQty = curQty + delta;
  if (delta < 0 && newQty < 0 && !movement.allowNegative) {
    return { ok: false, reason: "insufficient_stock", location: loc, available: curQty, requested: Number(movement.qty) };
  }

  const mv = {
    type: "adjustment",
    productId: movement.productId,
    size: movement.size,
    qty: Number(movement.qty),
    from: movement.from ?? null,
    to: movement.to ?? null,
    before: { [loc]: curQty },
    after: { [loc]: newQty },
    actor: ACTOR,
    actorRole: "admin",
    ts: movement.ts || nowIso,
    appliedAt: nowIso,
    reason: movement.reason,
    link: emptyLink(),
  };

  const updates = {};
  updates[`stock_movements/${mvId}`] = mv;
  const newV = cell && typeof cell.v === "number" ? cell.v + 1 : 0;
  updates[`${path}/qty`] = newQty;
  updates[`${path}/v`] = newV;
  updates[`${path}/mv`] = mvId;
  updates[`${path}/lastType`] = "adjustment";
  updates[`${path}/updatedAt`] = nowIso;
  updates[`${path}/updatedBy`] = ACTOR;
  await io.update(updates);
  return { ok: true, movementId: mvId, qty: Number(movement.qty), newQty };
}

// ── STEP 1 — plan the paired movements for one product ───────────────────────
// Resume-aware: a pair whose OUT leg already landed derives the IN leg's qty
// from the LEDGER, never from the (already emptied) live cell — that is what
// makes an interrupted run completable. Returns [{loc, sizeKey, pairs:[...]}].
export async function planStep1(io, pid, declaredSizes, cellsByLoc) {
  const plans = [];
  for (const [loc, bySize] of Object.entries(cellsByLoc || {})) {
    for (const [sizeKey, cell] of Object.entries(bySize || {})) {
      if (sizeKey === "_") continue;
      const q = cell && typeof cell.qty === "number" ? cell.qty : 0;
      const ids = legIds(pid, loc, sizeKey);
      // raw size for the movement record: beanie sizes are letters, so the
      // encoded key IS the raw size; assert that rather than assume it.
      const size = sizeKey;
      if (encodeSizeKey(size) !== sizeKey) throw new Error(`size key ${sizeKey} does not round-trip`);

      if (q > 0) {
        plans.push({ loc, sizeKey, kind: "positive", qty: q, legs: [
          { id: ids.out, movement: { type: "adjustment", productId: pid, size, qty: q, from: loc, movementId: ids.out,
            reason: `Collapse to one-size: move size ${size} → _` } },
          { id: ids.in, movement: { type: "adjustment", productId: pid, size: "_", qty: q, to: loc, movementId: ids.in,
            reason: `Collapse to one-size: receive from size ${size}` } },
        ] });
      } else if (q < 0) {
        const n = -q;
        plans.push({ loc, sizeKey, kind: "negative", qty: q, legs: [
          { id: ids.negOut, movement: { type: "adjustment", productId: pid, size: "_", qty: n, from: loc, movementId: ids.negOut,
            allowNegative: true, reason: `Collapse to one-size: carry oversell of size ${size} into _` } },
          { id: ids.negIn, movement: { type: "adjustment", productId: pid, size, qty: n, to: loc, movementId: ids.negIn,
            reason: `Collapse to one-size: close oversold size ${size} cell` } },
        ] });
      } else {
        // qty 0 — but an INTERRUPTED prior run leaves exactly this state with
        // the OUT landed and the IN missing. The ledger, not the cell, says so.
        const out = await io.read(`stock_movements/${ids.out}`);
        const inMv = await io.read(`stock_movements/${ids.in}`);
        if (out && !inMv) {
          const n = Number(out.qty);
          plans.push({ loc, sizeKey, kind: "resume-in", qty: n, legs: [
            { id: ids.in, movement: { type: "adjustment", productId: pid, size: "_", qty: n, to: loc, movementId: ids.in,
              reason: `Collapse to one-size: receive from size ${size}` } },
          ] });
        }
        const negOut = await io.read(`stock_movements/${ids.negOut}`);
        const negIn = await io.read(`stock_movements/${ids.negIn}`);
        if (negOut && !negIn) {
          const n = Number(negOut.qty);
          plans.push({ loc, sizeKey, kind: "resume-neg-in", qty: -n, legs: [
            { id: ids.negIn, movement: { type: "adjustment", productId: pid, size, qty: n, to: loc, movementId: ids.negIn,
              reason: `Collapse to one-size: close oversold size ${size} cell` } },
          ] });
        }
      }
    }
  }
  return plans;
}

// ── STEP 2 — ONE atomic multi-path update per product ────────────────────────
// products/{pid}/sizes = ["_"], products/{pid}/barcodes = {"_": keepCode}, and
// EVERY /barcodes/{code}/size = "_". Split across separate writes in any order
// and every scan for the product breaks in the window (see the balaclava
// header for the two failure orderings) — so this function returns exactly ONE
// updates object, and the CLI hands it to ONE io.update call.
//
// KEEP-CODE RULE (reported per product): the code minted for the size that
// holds (or held) the product's stock owns the "_" slot, so labels already on
// physical stock keep scanning and ensureBarcodes reuses the slot instead of
// minting a fresh code. Every in-scope beanie has exactly ONE code (census
// 2026-08-10), which is then trivially that code; with several, prefer the
// stock-holding size's code, then the declared size's, then the smallest code
// for determinism.
export function planStep2(pid, product, indexCodes, stockSizeKeysHeld) {
  const map = { ...(product.barcodes || {}) };
  const codes = [...new Set([...Object.values(map).map(String), ...Object.keys(indexCodes || {})])].sort();
  if (codes.length === 0) return { error: "no_barcodes" };

  let keepCode = null, rule = null;
  const bySlot = Object.fromEntries(Object.entries(map).map(([slot, c]) => [slot, String(c)]));
  const held = [...(stockSizeKeysHeld || [])].filter((k) => k !== "_");
  if (codes.length === 1) { keepCode = codes[0]; rule = "only code"; }
  else if (held.length && bySlot[held[0]]) { keepCode = bySlot[held[0]]; rule = `code of stock-holding size ${held[0]}`; }
  else if (bySlot[(product.sizes || [])[0]]) { keepCode = bySlot[(product.sizes || [])[0]]; rule = `code of declared size ${(product.sizes || [])[0]}`; }
  else { keepCode = codes[0]; rule = "smallest code (deterministic tie-break)"; }

  const updates = {};
  updates[`products/${assertSafeSegment(pid, "productId")}/sizes`] = ["_"];
  updates[`products/${pid}/barcodes`] = { [stockSizeKey(null)]: keepCode };   // {"_": code} via the chokepoint
  for (const code of codes) updates[`barcodes/${assertSafeSegment(code, "barcode")}/size`] = "_";
  return { updates, keepCode, rule, codes };
}

// Already in the Step 2 end state? (makes a re-run a read-only no-op)
export function step2Done(product, indexCodes, keepCode) {
  const sizesOk = JSON.stringify(product.sizes || null) === JSON.stringify(["_"]);
  const map = product.barcodes || {};
  const mapOk = Object.keys(map).length === 1 && String(map["_"]) === String(keepCode);
  const idxOk = Object.values(indexCodes || {}).every((rec) => rec && rec.size === "_");
  return sizesOk && mapOk && idxOk;
}

// ── STEP 3 — retire explicit target rows on dead sizes ───────────────────────
// target 0 = "deliberately excluded" (the engine's own vocabulary). Rows keyed
// "_" are untouched; rows already retired are skipped so re-runs are no-ops.
export function planStep3(pid, targetRowsByLoc, nowIso) {
  const updates = {};
  for (const [loc, rows] of Object.entries(targetRowsByLoc || {})) {
    for (const [sizeKey, row] of Object.entries(rows || {})) {
      if (sizeKey === "_") continue;
      if (row && row.target === 0 && row.source === "excluded") continue;
      updates[`stock_targets/${assertSafeSegment(loc, "location")}/${pid}/${assertSafeSegment(sizeKey, "size key")}`] = {
        target: 0, minQty: 0,
        source: "excluded", batchId: BATCH, approvedBy: "owner", approvedAt: nowIso,
      };
    }
  }
  return updates;
}

// ── per-product verification (fresh reads, after execute) ────────────────────
// Location totals must equal the totals BEFORE the product's migration; every
// sized cell must sit at 0; identity and index must be fully collapsed.
export async function verifyProduct(io, pid, keepCode, allCodes, totalsBefore) {
  const problems = [];
  const product = await io.read(`products/${pid}`);
  if (JSON.stringify(product?.sizes || null) !== JSON.stringify(["_"])) problems.push(`sizes = ${JSON.stringify(product?.sizes)}`);
  const map = product?.barcodes || {};
  if (!(Object.keys(map).length === 1 && String(map["_"]) === String(keepCode))) problems.push(`barcodes map = ${JSON.stringify(map)}`);
  for (const code of allCodes) {
    const rec = await io.read(`barcodes/${code}`);
    if (!rec || rec.productId !== pid || rec.size !== "_") problems.push(`index ${code} = ${JSON.stringify(rec)}`);
  }
  const stock = (await io.read("stock")) || {};
  const totalsAfter = {};
  for (const [loc, byPid] of Object.entries(stock)) {
    const bySize = byPid?.[pid];
    if (!bySize) continue;
    let sum = 0;
    for (const [sizeKey, cell] of Object.entries(bySize)) {
      const q = typeof cell?.qty === "number" ? cell.qty : 0;
      sum += q;
      if (sizeKey !== "_" && q !== 0) problems.push(`${loc}/${sizeKey} still holds ${q}`);
    }
    totalsAfter[loc] = sum;
  }
  for (const loc of new Set([...Object.keys(totalsBefore || {}), ...Object.keys(totalsAfter)])) {
    const b = totalsBefore?.[loc] || 0, a = totalsAfter[loc] || 0;
    if (b !== a) problems.push(`${loc} total ${b} → ${a} (units lost or minted)`);
  }
  const targets = (await io.read("stock_targets")) || {};
  for (const [loc, byPid] of Object.entries(targets)) {
    for (const [sizeKey, row] of Object.entries(byPid?.[pid] || {})) {
      if (sizeKey !== "_" && row && row.target !== 0) problems.push(`target row ${loc}/${sizeKey} target=${row.target} not retired`);
    }
  }
  return problems;
}
