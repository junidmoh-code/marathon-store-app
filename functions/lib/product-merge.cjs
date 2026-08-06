// ─── PRODUCT MERGE — two records, one shoe ───────────────────────────────────
// Joins a duplicated product (the LOSER) into the record that survives (the
// SURVIVOR). Runs ONLY here, server-side on the Admin SDK, because three of its
// steps are impossible under client auth: /barcodes is create-only (a repoint is
// an overwrite), the whole thing must be ONE atomic multi-path update, and the
// loser's ledger movements must be minted in the same commit as the cells they
// describe.
//
// WHAT A MERGE DOES — and deliberately does NOT do:
//   • Stock does NOT move between locations. Central keeps its quantity at
//     Central, Hub 2 keeps its at Hub 2. Each loser cell is added into the
//     survivor's cell AT THE SAME location+size, and the loser's cell node is
//     deleted. Per-location totals are conserved exactly — that invariant is
//     what the mutation tests pin.
//   • The loser is NOT deleted. Its /products record stays, gaining only a
//     `mergedInto` pointer — because its id is stamped on past sales, laybys,
//     movements and barcode rows, and deleting it would orphan all of them.
//     The client hides any product carrying `mergedInto`; lookups follow it.
//   • Every /barcodes row owned by the loser is repointed to the survivor, so
//     physical labels already stuck on stock keep scanning.
//   • Every /style_code_index claim owned by the loser is repointed, so a
//     future scan of that code lands on the survivor.
//   • The matching /duplicate_candidates pair row (if any) is closed "merged".
//   • The full before-state of everything CHANGED is recorded first, under
//     /product_merges/{mergeId} — the reversal recipe. (The loser's own record
//     is not in it because the merge does not alter it beyond the pointer.)
//
// ── THE CELL/LEDGER CONTRACT ─────────────────────────────────────────────────
// The client's applyMovement is THE single writer to /stock, and this module is
// its one server-side sibling. It preserves the exact same invariants, in the
// same one atomic update():
//   • every touched survivor cell has qty and v written together, v = old v + 1
//     (a NEW cell is created with v = 0), mv = the movement id, lastType set;
//   • every quantity change is paired with an append-only /stock_movements
//     entry carrying before/after derived from the same reads as the write;
//   • movement ids are DETERMINISTIC (merge_{mergeId}_…) so a replay of the
//     same merge could never double-book.
// A merge writes TWO movements per moved cell — the loser's decrement and the
// survivor's increment — so summing the ledger per product stays re-derivable.
//
// ── PINE IS OUT OF SCOPE — refused, not skipped ──────────────────────────────
// Pine (marathon-pine, and its hub3 lane) mixes its own product with Marathon
// and Trophy product and is handled separately. A merge involving a product
// that holds ANY stock cell at those locations is REFUSED with a clear message,
// never partially applied — skipping the Pine cells would leave stock stranded
// on a hidden record.
//
// ── FAIL CLOSED, ALWAYS ──────────────────────────────────────────────────────
// Anything uncertain — a missing record, an already-merged party, a lock held
// by a concurrent merge, an unreadable registry — refuses with a coded error.
// A merge must never guess.

"use strict";

const PINE_LOCATIONS = ["marathon-pine", "hub3"];
const MERGE_LOCK_STALE_MS = 10 * 60 * 1000; // takeover window for a crashed merge

// Byte-compatible with src/utils/sizeKey.js — the ONE cross-app encoding.
// Mirrors the client exactly, including its non-string behaviour (numbers are
// stringified, anything else passes through untouched); the "_" one-size
// sentinel belongs to stockSizeKey, not here.
function encodeSizeKey(size) {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(/[.#$/\[\]\s]/g, "_");
}
function decodeSizeKey(key) {
  if (typeof key !== "string") return key;
  return key.replace(/(\d)_(\d)/g, "$1.$2");
}

class MergeRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "invalid-argument" | "not-found" | "failed-precondition" | "aborted"
    this.refused = true;
  }
}

const asQty = (cell) => (cell && typeof cell.qty === "number" ? cell.qty : 0);

// A stock node's countable size cells. "_meta" (and any non-object child) is
// bookkeeping, not stock — but its EXISTENCE still matters for the Pine guard.
function sizeCellsOf(node) {
  const out = {};
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === "_meta") continue;
    if (v && typeof v === "object") out[k] = v;
  }
  return out;
}

/**
 * Perform the merge. `db` is the Admin RTDB (or a test fake with the same
 * surface: ref().get/set/update/transaction).
 *
 * @returns {{ ok: true, mergeId, moved: Array<{loc,size,qty}>, movementIds,
 *             barcodesRepointed, styleCodesRepointed, duplicateRowClosed }}
 * @throws {MergeRefused} on any refusal — nothing is written.
 */
// A legal RTDB key: no path separators, no forbidden key characters, no
// whitespace. An id with "/" would resolve reads to a NESTED node (not a
// product) and an id with ".#$[]" would make the derived write paths throw
// after the lock is taken — both are refused up front instead.
const SAFE_KEY = /^[^./#$[\]\s]+$/;

async function performMerge(db, { loserId, survivorId, actor, nowMs }) {
  if (typeof loserId !== "string" || !loserId.trim()) throw new MergeRefused("invalid-argument", "loserId is required.");
  if (typeof survivorId !== "string" || !survivorId.trim()) throw new MergeRefused("invalid-argument", "survivorId is required.");
  if (!SAFE_KEY.test(loserId) || !SAFE_KEY.test(survivorId)) {
    throw new MergeRefused("invalid-argument", "A product id is not a legal database key.");
  }
  if (loserId === survivorId) throw new MergeRefused("invalid-argument", "A product cannot be merged into itself.");
  if (!actor || !actor.uid) throw new MergeRefused("invalid-argument", "actor is required.");
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();

  const loser = (await db.ref(`products/${loserId}`).get()).val();
  const survivor = (await db.ref(`products/${survivorId}`).get()).val();
  if (!loser) throw new MergeRefused("not-found", "The product being merged away no longer exists.");
  if (!survivor) throw new MergeRefused("not-found", "The surviving product no longer exists.");
  if (loser.mergedInto) throw new MergeRefused("failed-precondition", "That product was already merged away.");
  if (survivor.mergedInto) throw new MergeRefused("failed-precondition", "The chosen survivor was itself merged away — merge into its survivor instead.");

  const mergeId = `${loserId}__into__${survivorId}_${now}`;

  // ── CONCURRENCY LOCK ────────────────────────────────────────────────────────
  // Two admins double-confirming the same loser must not both apply: each would
  // read the loser's cells and both would add them to the survivor. The lock is
  // a create-only transaction on the loser id; the loser side is what matters
  // because its cells are what get double-counted. A crashed merge leaves a
  // stale lock — taken over after MERGE_LOCK_STALE_MS as long as no mergedInto
  // ever landed (an applied merge is caught by the check above).
  const lockRef = db.ref(`product_merges_locks/${loserId}`);
  const lockRes = await lockRef.transaction((cur) => {
    if (cur === null) return { mergeId, at: now, by: actor.uid };
    if (Number(cur.at) < now - MERGE_LOCK_STALE_MS) return { mergeId, at: now, by: actor.uid };
    return undefined; // held and fresh — abort
  });
  const heldLock = lockRes && lockRes.committed && lockRes.snapshot && lockRes.snapshot.val();
  if (!heldLock || heldLock.mergeId !== mergeId) {
    throw new MergeRefused("aborted", "Another merge of this product is in progress. Try again in a moment.");
  }

  try {
    // ── READS ────────────────────────────────────────────────────────────────
    const registry = (await db.ref("locations").get()).val();
    const locationIds = registry && typeof registry === "object" ? Object.keys(registry) : null;
    if (!locationIds || !locationIds.length) throw new MergeRefused("failed-precondition", "The location registry could not be read — merge refused rather than guessed.");

    const loserCells = {};    // { loc: { sizeKey: cell } }
    const survivorCells = {};
    const loserNodes = {};    // raw nodes (incl. _meta) — for the before-state + full delete
    for (const loc of locationIds) {
      const lNode = (await db.ref(`stock/${loc}/${loserId}`).get()).val();
      const sNode = (await db.ref(`stock/${loc}/${survivorId}`).get()).val();
      if (lNode) { loserNodes[loc] = lNode; loserCells[loc] = sizeCellsOf(lNode); }
      if (sNode) survivorCells[loc] = sizeCellsOf(sNode);
    }

    // Pine guard — ANY presence at a Pine location refuses the whole merge.
    for (const loc of PINE_LOCATIONS) {
      if (loserNodes[loc] || survivorCells[loc]) {
        throw new MergeRefused("failed-precondition",
          `Merge refused: a product holds stock at ${loc}. Pine is out of scope for merges — resolve its Pine stock first.`);
      }
    }

    // ── BUILD THE ONE ATOMIC UPDATE ──────────────────────────────────────────
    const updates = {};
    const moved = [];
    const movementIds = [];
    const beforeSurvivorCells = {};

    for (const [loc, cells] of Object.entries(loserCells)) {
      for (const [sizeKey, cell] of Object.entries(cells)) {
        const q = asQty(cell);
        if (q === 0) continue; // node delete below removes the empty cell
        const sCell = (survivorCells[loc] && survivorCells[loc][sizeKey]) || null;
        const sQ = asQty(sCell);
        const rawSize = decodeSizeKey(sizeKey);
        const mvIdL = `merge_${mergeId}_L_${loc}_${sizeKey}`;
        const mvIdS = `merge_${mergeId}_S_${loc}_${sizeKey}`;

        // Survivor cell: applyMovement's exact write shape. New cell → v = 0.
        const cellPath = `stock/${loc}/${survivorId}/${sizeKey}`;
        updates[`${cellPath}/qty`] = sQ + q;
        updates[`${cellPath}/v`] = sCell && typeof sCell.v === "number" ? sCell.v + 1 : 0;
        updates[`${cellPath}/mv`] = mvIdS;
        updates[`${cellPath}/lastType`] = "adjustment";
        updates[`${cellPath}/updatedAt`] = nowIso;
        updates[`${cellPath}/updatedBy`] = actor.uid;

        const base = {
          productId: null, type: "adjustment", size: rawSize, qty: Math.abs(q),
          from: null, to: null, actor: actor.uid, actorRole: "admin",
          ts: nowIso, appliedAt: nowIso, reason: "product_merge",
          link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, mergeId },
        };
        // Loser leg: its cell goes to zero (then the node is deleted).
        updates[`stock_movements/${mvIdL}`] = {
          ...base, productId: loserId,
          from: q > 0 ? loc : null, to: q < 0 ? loc : null,
          before: { [loc]: q }, after: { [loc]: 0 },
          link: { ...base.link, mergedInto: survivorId },
        };
        // Survivor leg: the same quantity arrives on its cell at the same loc.
        updates[`stock_movements/${mvIdS}`] = {
          ...base, productId: survivorId,
          to: q > 0 ? loc : null, from: q < 0 ? loc : null,
          before: { [loc]: sQ }, after: { [loc]: sQ + q },
          link: { ...base.link, mergedFrom: loserId },
        };

        moved.push({ loc, size: rawSize, qty: q });
        movementIds.push(mvIdL, mvIdS);
        if (!beforeSurvivorCells[loc]) beforeSurvivorCells[loc] = {};
        beforeSurvivorCells[loc][sizeKey] = sCell;
      }
      // The loser's whole node at this location goes — including qty-0 cells
      // and _meta. A zero-qty cell is not harmless: the refill engine treats
      // cell EXISTENCE as "this store carries this product".
      updates[`stock/${loc}/${loserId}`] = null;
    }

    // Survivor learns the sizes it just inherited stock in (and nothing else —
    // the survivor's own name, photo and identity are untouched).
    const survivorSizes = Array.isArray(survivor.sizes) ? survivor.sizes.map(String) : [];
    const survivorSizeKeys = new Set(survivorSizes.map(encodeSizeKey));
    const inheritedSizes = [];
    for (const { size } of moved) {
      const k = encodeSizeKey(size);
      if (size !== "_" && !survivorSizeKeys.has(k)) { survivorSizeKeys.add(k); inheritedSizes.push(size); }
    }
    if (inheritedSizes.length) {
      updates[`products/${survivorId}/sizes`] = [...survivorSizes, ...inheritedSizes];
    }

    // Loser's per-size label codes the survivor doesn't have yet — carried over
    // so a reprint of that size keeps its PERMANENT code.
    const loserBarcodeMap = loser.barcodes && typeof loser.barcodes === "object" ? loser.barcodes : {};
    const survivorBarcodeMap = survivor.barcodes && typeof survivor.barcodes === "object" ? survivor.barcodes : {};
    const inheritedBarcodes = {};
    for (const [sizeKey, code] of Object.entries(loserBarcodeMap)) {
      if (code && !survivorBarcodeMap[sizeKey]) {
        updates[`products/${survivorId}/barcodes/${sizeKey}`] = code;
        inheritedBarcodes[sizeKey] = code;
      }
    }

    // Repoint every /barcodes row the loser owns — the full node is scanned
    // because it, not the product's mirror map, is the authority a POS scan hits.
    const allBarcodes = (await db.ref("barcodes").get()).val() || {};
    const barcodesRepointed = {};
    for (const [code, row] of Object.entries(allBarcodes)) {
      if (row && row.productId === loserId) {
        updates[`barcodes/${code}/productId`] = survivorId;
        barcodesRepointed[code] = row;
      }
    }

    // Repoint every style-code claim the loser owns.
    const allClaims = (await db.ref("style_code_index").get()).val() || {};
    const styleCodesRepointed = {};
    for (const [codeKey, row] of Object.entries(allClaims)) {
      if (row && row.productId === loserId) {
        updates[`style_code_index/${codeKey}/productId`] = survivorId;
        styleCodesRepointed[codeKey] = row;
      }
    }

    // Close the matching duplicate pair, if one was ever flagged.
    const pairId = [loserId, survivorId].sort().join("__");
    const dupRow = (await db.ref(`duplicate_candidates/${pairId}`).get()).val();
    if (dupRow) {
      updates[`duplicate_candidates/${pairId}/status`] = "merged";
      updates[`duplicate_candidates/${pairId}/mergedAt`] = now;
      updates[`duplicate_candidates/${pairId}/mergedBy`] = actor.uid;
    }

    // The loser becomes a redirect. Record stays; the pointer is the only change.
    updates[`products/${loserId}/mergedInto`] = survivorId;
    updates[`products/${loserId}/mergedAt`] = now;
    updates[`products/${loserId}/mergedBy`] = actor.uid;

    // The reversal recipe: everything this update CHANGES, as it was. Deep-copied
    // so the recorded before-state can never alias an object the update mutates.
    const frozen = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
    updates[`product_merges/${mergeId}`] = {
      loserId, survivorId, at: now, by: actor.uid, byEmail: actor.email || null,
      moved, movementIds,
      before: {
        loserStock: frozen(loserNodes),             // full nodes, incl. _meta and qty-0 cells
        survivorCells: frozen(beforeSurvivorCells), // only the cells this merge touched
        survivorSizes: inheritedSizes.length ? frozen(survivorSizes) : null,
        inheritedBarcodes,
        barcodes: frozen(barcodesRepointed),        // rows as they pointed before
        styleCodeIndex: frozen(styleCodesRepointed),
        duplicateRow: frozen(dupRow),
      },
    };

    // ── THE DRIFT FENCE ──────────────────────────────────────────────────────
    // The update above writes ABSOLUTE survivor quantities derived from the
    // reads at the top — and the Admin SDK bypasses the RTDB rule that rejects
    // a wrong `v`, so nothing server-side would catch a POS sale or transfer
    // landing on a survivor cell in between: its quantity would be silently
    // erased. Re-read every touched survivor cell immediately before the
    // commit and REFUSE on any drift (v or qty). The remaining window is the
    // milliseconds between this recheck and the update — down from the full
    // preparation time — and a refused merge writes nothing and can simply be
    // retried. (Loser cells are protected by the loser lock above.)
    for (const [loc, cells] of Object.entries(beforeSurvivorCells)) {
      for (const [sizeKey, sCell] of Object.entries(cells)) {
        const live = (await db.ref(`stock/${loc}/${survivorId}/${sizeKey}`).get()).val();
        const seenV = sCell && typeof sCell.v === "number" ? sCell.v : null;
        const liveV = live && typeof live.v === "number" ? live.v : null;
        if (seenV !== liveV || asQty(live) !== asQty(sCell)) {
          throw new MergeRefused("aborted",
            `The surviving product's stock at ${loc} changed while the merge was being prepared. Nothing was changed — try again.`);
        }
      }
    }

    await db.ref().update(updates);

    return {
      ok: true, mergeId, moved, movementIds,
      barcodesRepointed: Object.keys(barcodesRepointed),
      styleCodesRepointed: Object.keys(styleCodesRepointed),
      duplicateRowClosed: !!dupRow,
    };
  } catch (err) {
    // A refused or failed merge releases the lock; an APPLIED merge keeps it as
    // a tombstone (the mergedInto check refuses any rerun anyway).
    await lockRef.set(null).catch(() => {});
    throw err;
  }
}

module.exports = { performMerge, MergeRefused, PINE_LOCATIONS, encodeSizeKey, decodeSizeKey };
