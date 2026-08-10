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

// ── SCOPE — THE ONE PLACE THAT DECIDES WHAT A BEANIE IS ──────────────────────
// Beanies and caps share subcategory "Caps & Hats" (323 live records), so the
// subcategory CANNOT separate them — the name is the only field that does. Caps
// are out of scope: 86 of them declare two or more sizes and genuinely hold
// stock across several, so a one-size row would orphan most of them.
// A mergedInto record is a redirect stub with no stock identity of its own
// (product-merge.cjs) and must never be collapsed in place.
//
// Exported and imported by the CLI and the tests rather than restated in each,
// so a change to the rule cannot pass a test that still applies the old one.
export function isInScope(product) {
  return !!product && /beanie/i.test(product.name || "") && !product.mergedInto;
}

// A record whose NAME says beanie but whose filing does not. It stays in scope
// (the name is decisive) but it is worth a human's eye before its identity is
// rewritten, so the census flags it and exits non-zero. Lives here, next to the
// scope rule it qualifies, so it is testable rather than buried in a live-data
// script with no unit surface. (CodeRabbit, PR #343.)
export function isUnexpectedSubcategory(product) {
  return isInScope(product) && product.subcategory !== "Caps & Hats";
}

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
// out_of_stock is a LIVE hold, not a terminal state — the customer is still
// owed the item and the order can be revived and dispatched on its size.
// (Kimi review, PR #343: it was missing, which is the fail-OPEN direction.)
export const LIVE_ORDER_STATUSES = new Set(["incoming", "ready", "coming_tomorrow", "on_hold", "out_of_stock"]);
export const CR_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export function orderBlocks(order, pid, nowMs) {
  if (!order) return null;
  // FAIL-SAFE ON AN UNRECOGNISED SHAPE. Every live order record carries a
  // top-level productId + size (verified across all 2,396 today), so the
  // structured read below is correct. But if a record ever nests its lines
  // instead, `order.productId !== pid` would quietly return "does not block"
  // and the gate would wave through a live order on a size about to be
  // retired. So: if the record MENTIONS this product but does not present the
  // shape this function understands, block it and say why. Being unable to
  // prove a thing is safe is not the same as it being safe.
  // (Kimi review, PR #343.)
  if (order.productId !== pid) {
    return JSON.stringify(order).includes(pid)
      ? `order ${order.id || ""} references this product in a shape this gate does not understand (no top-level productId) — clear it or check it by hand`
      : null;
  }
  if (!REAL_SIZE.test(String(order.size || ""))) return null;   // one-size / no real size — nothing to retire
  if (order.customerName === "Shop Refill") {
    if (order.clothingRefillStatus == null) return `unresolved refill line ${order.id || ""} (size ${order.size}) — Send would move stock in the retired size`;
    // An UNPARSEABLE resolution stamp must fail SAFE. `|| 0` treated a garbled
    // or missing timestamp as the epoch, i.e. "resolved long ago, undo window
    // closed, does not block" — the fail-OPEN direction on the one field that
    // decides whether an undo can still reverse stock on this size.
    // (CodeRabbit, PR #343.)
    const stamp = order.clothingRefilledAt || order.clothingOutOfStockAt || order.updatedAt || order.createdAt;
    const resolvedMs = Date.parse(stamp);
    if (!Number.isFinite(resolvedMs)) {
      return `refill line ${order.id || ""} has an unreadable resolution timestamp (${JSON.stringify(stamp)}) — cannot prove its undo window has closed`;
    }
    if (nowMs - resolvedMs < CR_UNDO_WINDOW_MS) {
      return `refill line ${order.id || ""} resolved ${new Date(resolvedMs).toISOString()} — inside the 24h undo window, and undo reverses stock in size ${order.size}`;
    }
    return null;
  }
  return LIVE_ORDER_STATUSES.has(order.status)
    ? `live customer order ${order.id || ""} (${order.status}, size ${order.size}) — dispatch would move stock in the retired size`
    : null;
}

// ── WHEN DID THIS PRODUCT LAST MOVE? ─────────────────────────────────────────
// Feeds the recent-activity gate. A movement whose timestamp cannot be read
// must NOT leave the product looking quiet — that is the fail-open direction on
// a gate whose entire job is to stop a race with a till. "I cannot tell when
// this last moved" is not "it has not moved", so unreadable stamps are counted
// separately and the caller blocks on them. (CodeRabbit, PR #343.)
// WINDOWED, and it must be. An unreadable stamp blocks its product, and over an
// UNBOUNDED ledger that block never expires: one piece of malformed debris from
// any point in a product's life would gate it forever, with no way to clear it —
// unlike the 24h undo window and the 15-minute activity window, which both
// self-clear. It fails safe, but a permanent unexplainable gate is its own trap.
// Reading only the recent slice keeps the gate answering the question it is
// actually asking ("is this product busy RIGHT NOW"), and the ids of the
// offending movements come back so the message can name them.
// (Sonnet re-review, PR #343.)
export function movementRecency(movements, { nowMs = Date.now(), windowDays = 45 } = {}) {
  const lastMs = new Map();
  const unreadable = new Map();
  const cutoff = nowMs - windowDays * 86400000;
  for (const [id, m] of Object.entries(movements || {})) {
    if (!m || !m.productId) continue;
    const raw = m.appliedAt || m.ts;
    const ts = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ts)) {
      // An unreadable stamp cannot be placed in time, so it cannot be excluded
      // by the window either — but the ledger key is push-ordered, so an id
      // below the window's key is old debris rather than live activity.
      // Without that discriminator every malformed record would be permanent.
      const idMs = pushKeyMs(id);
      if (idMs !== null && idMs < cutoff) continue;
      const seen = unreadable.get(m.productId) || [];
      seen.push(id);
      unreadable.set(m.productId, seen);
      continue;
    }
    if (ts < cutoff) continue;
    if (ts > (lastMs.get(m.productId) || 0)) lastMs.set(m.productId, ts);
  }
  return { lastMs, unreadable };
}

// Firebase push ids encode their creation time in the FIRST 8 characters, in a
// custom base-64 whose alphabet sorts lexicographically by time. Decoding it
// dates a record whose own timestamp field is unusable. Returns null for any id
// that is not a push key (the migration's own deterministic ids, for instance).
//
// The leading "-" is not a separator — it is the alphabet's ZERO character,
// which is simply what the timestamp's high bits decode to at present-day
// magnitudes. Skipping it shifts every digit and dates 2026 records to the year
// 5500s; the first version of this function did exactly that. Calibrated
// against live ledger ids: -OxNIloqoe_3VnGVZWi4 → 2026-07-12T21:50:07Z, which
// matches that record's own createdAt to the second.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
export function pushKeyMs(id) {
  if (typeof id !== "string" || id.length < 8) return null;
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    const v = PUSH_CHARS.indexOf(id[i]);
    if (v < 0) return null;
    ms = ms * 64 + v;
  }
  // A decode that lands outside any plausible ledger era means this was not a
  // push key at all (it just happened to use legal characters).
  return ms > 946684800000 && ms < 4102444800000 ? ms : null;   // 2000 … 2100
}

// ── TRANSFERS KEY THEIR SIZES, THEY DO NOT LABEL THEM ────────────────────────
// A transfer record is { from, to, status, lines: { <pid>: { <sizeKey>: qty } },
// received: { … same shape } }. The size is a KEY, so the obvious
// `/"size"\s*:\s*"M"/` scan over the record's JSON NEVER matches and the gate
// silently never fires — which is exactly what it did before this fix. Read the
// structure instead. (Kimi review, PR #343; proved against the live shape.)
export function transferBlocks(transfer, pid) {
  if (!transfer || transfer.status === "received") return null;
  // "Understood" is not merely "the pid key exists" — it is "the entry has the
  // DOCUMENTED shape", { <sizeKey>: <qty number> }. An entry like
  // { sizes: { M: 2 } } has the pid but hides its sizes one level down, and
  // treating that as read would return a clean bill on a transfer that really
  // does carry size M. Numbers all the way down, or it is not understood.
  const sizes = new Set();
  let understood = false;
  for (const node of [transfer.lines, transfer.received]) {
    const entry = node?.[pid];
    if (!entry || typeof entry !== "object") continue;
    const values = Object.values(entry);
    if (values.length && values.every((v) => typeof v === "number")) understood = true;
    for (const k of Object.keys(entry)) if (REAL_SIZE.test(k)) sizes.add(k);
  }
  if (sizes.size) return `open transfer (${transfer.status || "no status"}) ${transfer.from || "?"}→${transfer.to || "?"} carrying size ${[...sizes].sort().join(", ")}`;
  // Unrecognised shape that still names the product: same fail-safe rule as
  // orderBlocks — block rather than assume.
  //
  // The mention check runs whenever the structural read did not actually FIND
  // this product — not merely when both nodes are absent. A record nesting
  // differently — lines: { <loc>: { <pid>: { M: 2 } } } — leaves `lines`
  // present but `lines[pid]` missing, so the earlier guard skipped the check
  // and returned "does not block": the fail-OPEN direction this function exists
  // to close.
  //
  // `understood` is what keeps that from over-blocking: a transfer whose
  // lines[pid] IS found and holds only "_" was read correctly and carries
  // nothing this migration retires, so it passes. Read-and-found-nothing-real
  // is a clean bill; could-not-read is not. (CodeRabbit, PR #343.)
  if (!understood && JSON.stringify(transfer).includes(pid)) {
    return `open transfer (${transfer.status || "no status"}) references this product in a shape this gate does not understand — check it by hand`;
  }
  return null;
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
//
// ── WHY THE VERSION RE-CHECK EXISTS (Kimi review, PR #343) ───────────────────
// The client applyMovement gets its optimistic concurrency from the SECURITY
// RULE, not from its own code: the rule refuses any cell write whose `v` is not
// exactly data.v + 1, so a concurrent writer that landed in between makes the
// write bounce and the client re-reads and retries.
//
// The Admin SDK bypasses every rule. Copying the `v + 1` FIELD without the rule
// that enforces it copies the shape of the protection and none of its effect: a
// till sale landing between this function's read and its write would be
// silently overwritten, because the update SETS an absolute qty computed from
// the stale read. The unit would vanish with no error and no ledger gap that
// the totals check could see — before and after would both look right.
//
// So the guard is re-implemented here: read, compute, then re-read immediately
// before the write and confirm nothing moved; on a change, start over. The
// window is not closed (RTDB has no compare-and-set across paths), but it
// shrinks from "the whole run" to the microseconds between two adjacent reads,
// and a persistent conflict fails loudly instead of quietly winning. The
// operational half of this guard is the trading-hours window and the
// recent-activity gate in the CLI — neither replaces the other.
const CONFLICT_RETRIES = 5;

export async function applyMovementAdmin(io, movement, { nowIso }) {
  if (!movement || movement.type !== "adjustment") return { ok: false, reason: "invalid_type" };
  if (!movement.productId || !movement.size) return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0)) return { ok: false, reason: "qty_must_be_positive" };
  if (!(movement.reason && String(movement.reason).trim())) return { ok: false, reason: "adjustment_requires_reason" };
  if (!movement.movementId) return { ok: false, reason: "movement_id_required" };
  const mvId = assertSafeSegment(movement.movementId, "movementId");

  const loc = movement.to || movement.from;
  const delta = movement.to ? +Number(movement.qty) : -Number(movement.qty);
  if (!loc) return { ok: false, reason: "missing_location" };

  const path = stockCellPath(loc, movement.productId, movement.size);
  const sameCell = (a, b) => {
    const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);
    const v = (c) => (c && typeof c.v === "number" ? c.v : null);
    return q(a) === q(b) && v(a) === v(b);
  };

  for (let attempt = 1; attempt <= CONFLICT_RETRIES; attempt++) {
    // IDEMPOTENCY IS CHECKED INSIDE THE LOOP, not once before it. Checked only
    // at the top, two overlapping callers could both pass it before either
    // wrote — and for a POSITIVE leg (the IN into "_") there is no negative
    // floor to refuse the second one, so a 6-unit move could land 12 with the
    // single ledger record silently overwritten, erasing the evidence. Inside
    // the loop the check is re-run on every attempt, immediately before the
    // guarded write. (Sonnet re-review, PR #343. The CLI's own single-process
    // sequential loop cannot race itself; the run lock in the CLI is what
    // stops two processes, and this is the belt to that pair of braces.)
    const existing = await io.read(`stock_movements/${mvId}`);
    if (existing) return { ok: true, movementId: mvId, idempotent: true };

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

    // The re-check. Anything that moved this cell since the read above makes the
    // computed qty stale, and writing it would erase that other writer's change.
    const recheck = await io.read(path);
    if (!sameCell(cell, recheck)) continue;              // someone else wrote — recompute

    await io.update(updates);
    return { ok: true, movementId: mvId, qty: Number(movement.qty), newQty };
  }
  return { ok: false, reason: "conflict_retries_exhausted", location: loc };
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

// ── THE DRAIN CHECK — Step 2's precondition, on FRESH reads ─────────────────
// Step 2 is the irreversible half: the moment `sizes` becomes ["_"], any unit
// still sitting in a sized cell is invisible to the app and to the engine.
// Step 1 reporting success is NOT proof that the cells are empty, because the
// movement id is scoped to (product, location, size) with no attempt number:
//
//   run 1  Step 1 lands in full (M drained to 0, "_" holds the units) and the
//          operator stops before Step 2 — the state this file's header calls
//          safe, and it IS safe, because the product still declares M.
//   …then  a legitimate warehouse receive lands 2 units into M, exactly as it
//          should, because M is still a declared size.
//   run 2  planStep1 sees M = 2 and plans the pair again — but BOTH movement
//          ids already exist, so applyMovementAdmin no-ops each leg and
//          reports ok+idempotent. Nothing moves. Step 2 fires anyway and the
//          2 units are stranded in a size the product no longer declares.
//
// Reproduced end-to-end against these exact functions (Sonnet review, PR #343).
// The recent-activity gate does not cover it: the realistic trigger is a pause
// of hours, not minutes. So Step 2 asks the database directly, immediately
// before it commits, whether every sized cell is actually at zero — and the
// caller must refuse to collapse the product if any is not. Idempotency stays
// exactly as it is; what changes is that success is now verified, not inferred.
export async function assertDrained(io, pid) {
  const stock = (await io.read("stock")) || {};
  const residue = [];
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const [sizeKey, cell] of Object.entries(byPid?.[pid] || {})) {
      if (sizeKey === "_") continue;
      const q = typeof cell?.qty === "number" ? cell.qty : 0;
      if (q !== 0) residue.push(`${loc}/${sizeKey}=${q}`);
    }
  }
  return residue;
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
