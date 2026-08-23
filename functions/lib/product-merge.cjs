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
//     Central, Hub 2 keeps its at Hub 2. Each loser cell is TRANSFERRED into
//     the survivor's cell AT THE SAME location+size, and the loser's cell node
//     is deleted. Per-location totals are conserved exactly — that invariant is
//     what the mutation tests pin.
//   • …EXCEPT at a cell that has already been COUNTED under the survivor, where
//     the loser's quantity is REMOVED instead (an adjustment movement off the
//     loser, nothing added to the survivor). Those pairs were physically
//     counted once, under the record that survives; transferring them on top
//     would double the count. The merge works this out itself from the count
//     records — no question, no toggle, no hub named in code. The whole rule,
//     and why every uncertain case still transfers, is in
//     lib/merge-disposition.cjs.
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
// ── EVERY LOCATION IS TREATED THE SAME — no location refuses a merge ─────────
// There was, until 2026-08-22, a guard that refused any merge where either
// product held a cell at marathon-pine or hub3. It was a copy of the HEADWEAR
// one-size collapse's scope decision, where Pine was excluded because its cells
// were qty-0 reconciliation husks and that migration REWROTE SIZE KEYS and
// minted /stock_targets rows off them. A merge does neither, and — the point of
// this whole module — a merge does not move stock BETWEEN locations: Pine's
// units stay at Pine, Central's at Central. There is nothing location-specific
// left for a location guard to protect, so there is no location guard. Every
// REGISTERED location is read, summed and transferred by the same code path,
// negatives included. (Registered is the operative word: the read loop walks
// /locations, so a cell filed under an id that is NOT in the registry is never
// seen — it is neither transferred nor deleted. That is the registry's job, not
// a location guard's, and an unreadable registry already refuses.)
// See MERGE-PINE-INVESTIGATION.md for the full trace.
//
// ── FAIL CLOSED, ALWAYS ──────────────────────────────────────────────────────
// Anything uncertain — a missing record, an already-merged party, a lock held
// by a concurrent merge, an unreadable registry — refuses with a coded error.
// A merge must never guess.

"use strict";

const {
  COUNT_SESSIONS_PATH, COUNTED_PATH, countedCellKeys, countCellKey, countRecordCounts, planMerge,
} = require("./merge-disposition.cjs");

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

/**
 * Read a path, or REFUSE with a coded message. A raw throw from a `.get()`
 * escapes as a generic "internal" error, which tells the operator nothing and
 * reads like a bug rather than a retryable condition.
 */
async function readOrRefuse(db, path, message) {
  try {
    return (await db.ref(path).get()).val();
  } catch (err) {
    throw new MergeRefused("failed-precondition", `${message} (${err && err.message ? err.message : err})`);
  }
}

// Key-order-independent equality for the drift fences. RTDB hands back plain
// objects whose key order is the wire's, not ours, so a raw JSON.stringify
// comparison could refuse a merge that nothing actually touched.
function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

// A stock node's countable size cells. "_meta" (and any non-object child) is
// bookkeeping, not stock — the node still gets deleted whole, _meta included.
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
 * @returns {{ ok: true, mergeId, moved: Array<{loc,size,qty}>,
 *             removed: Array<{loc,size,qty}>, movementIds,
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

    // ── THE COUNT STATE, READ ONLY WHERE IT CAN CHANGE THE ANSWER ────────────
    // Only a location the LOSER holds stock at has a cell to dispose of, so the
    // counted node is read for those locations and no others.
    //
    // A location with NO OPEN SESSION is not an error — it has counted nothing,
    // so its set is empty and every cell there transfers. That is the normal
    // case at Central.
    //
    // A node that CANNOT BE READ is different, and it REFUSES. Two reasons, and
    // either is sufficient. First, this module's rule everywhere else is that
    // uncertainty refuses rather than guesses — the /locations read above
    // already works exactly this way. Second, the client has already told the
    // operator, per location, what will happen; silently transferring because a
    // read failed would do something other than what the screen said, on stock.
    // A refused merge writes nothing and can be retried.
    const sessions = await readOrRefuse(db, COUNT_SESSIONS_PATH,
      "The hub count sessions could not be read — merge refused rather than guessed.") || {};
    const countedByLoc = {};
    const sessionIdByLoc = {};
    for (const loc of Object.keys(loserCells)) {
      const sessionId = sessions[loc] && sessions[loc].sessionId;
      if (!sessionId) { countedByLoc[loc] = new Set(); continue; }
      sessionIdByLoc[loc] = sessionId;
      const node = await readOrRefuse(db, `${COUNTED_PATH}/${loc}/${sessionId}`,
        `The count records at ${loc} could not be read — merge refused rather than guessed.`);
      countedByLoc[loc] = countedCellKeys(node);
    }
    const plan = planMerge({ loserId, survivorId, loserCells, countedByLoc });
    const removeKeys = new Set();
    const removalFenceCells = [];   // the exact records each removal rests on
    for (const row of plan) {
      for (const c of row.remove) {
        removeKeys.add(`${row.loc}/${c.sizeKey}`);
        removalFenceCells.push({
          loc: row.loc, sizeKey: c.sizeKey, sessionId: sessionIdByLoc[row.loc],
        });
      }
    }

    // ── BUILD THE ONE ATOMIC UPDATE ──────────────────────────────────────────
    const updates = {};
    const moved = [];
    const movementIds = [];
    const beforeSurvivorCells = {};

    const removed = [];
    for (const [loc, cells] of Object.entries(loserCells)) {
      for (const [sizeKey, cell] of Object.entries(cells)) {
        const q = asQty(cell);
        if (q === 0) continue; // node delete below removes the empty cell
        const sCell = (survivorCells[loc] && survivorCells[loc][sizeKey]) || null;
        const sQ = asQty(sCell);
        const rawSize = decodeSizeKey(sizeKey);
        const mvIdL = `merge_${mergeId}_L_${loc}_${sizeKey}`;
        const mvIdS = `merge_${mergeId}_S_${loc}_${sizeKey}`;

        // ── REMOVAL — this shelf was counted under the survivor ──────────────
        // No survivor cell is touched: its counted number already contains
        // these pairs. The write-off is a real adjustment MOVEMENT through the
        // same ledger contract as every other quantity change here — it is
        // never a silent deletion, it names the merge in `reason` and `link`,
        // and the loser's full before-state (this cell included) is recorded
        // under /product_merges for the reversal.
        if (removeKeys.has(`${loc}/${sizeKey}`)) {
          updates[`stock_movements/${mvIdL}`] = {
            productId: loserId, type: "adjustment", size: rawSize, qty: Math.abs(q),
            from: q > 0 ? loc : null, to: q < 0 ? loc : null,
            actor: actor.uid, actorRole: "admin", ts: nowIso, appliedAt: nowIso,
            reason: "product_merge_counted_removal",
            before: { [loc]: q }, after: { [loc]: 0 },
            link: { orderId: null, transferId: null, refillId: null, saleId: null,
                    deviceId: null, mergeId, mergedInto: survivorId, countedRemoval: true },
          };
          removed.push({ loc, size: rawSize, qty: q });
          movementIds.push(mvIdL);
          continue;
        }

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

    // Repoint every style-code claim the loser owns — primary or SIBLING.
    // A claim row may now name several owners (colourway siblings — see
    // lib/style-code-siblings.cjs), and a merge must never leave the same
    // survivor listed twice: once as primary and once as sibling, the owner
    // count would read 2 for one product and the count picker would ask a
    // question with one answer.
    const allClaims = (await db.ref("style_code_index").get()).val() || {};
    const styleCodesRepointed = {};
    for (const [codeKey, row] of Object.entries(allClaims)) {
      if (!row) continue;
      const siblings = row.siblings && typeof row.siblings === "object" ? row.siblings : {};
      if (row.productId === loserId) {
        updates[`style_code_index/${codeKey}/productId`] = survivorId;
        // Survivor was already a sibling of this code → drop its sibling entry
        // so it appears exactly once, as the new primary.
        if (siblings[survivorId]) updates[`style_code_index/${codeKey}/siblings/${survivorId}`] = null;
        styleCodesRepointed[codeKey] = row;
      } else if (siblings[loserId]) {
        // The loser was a sibling. Its entry follows the survivor — unless the
        // survivor already owns the code (as primary or sibling), in which case
        // the entry simply goes: the ownership it recorded is already present.
        updates[`style_code_index/${codeKey}/siblings/${loserId}`] = null;
        if (row.productId !== survivorId && !siblings[survivorId]) {
          updates[`style_code_index/${codeKey}/siblings/${survivorId}`] = siblings[loserId];
        }
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
      moved, removed, movementIds,
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
    // retried.
    //
    // BOTH SIDES ARE FENCED. The loser lock above excludes other MERGES, not a
    // POS sale or a transfer: until the commit lands the loser is a normal,
    // visible, sellable product. Its cells are read once (above), added to the
    // survivor as ABSOLUTE quantities, and then the whole node is DELETED — so
    // a sale landing on a loser cell in between would be added to the survivor
    // at its pre-sale quantity and then erased with the node, conjuring a unit
    // out of nothing and breaking the one invariant this module exists to hold.
    // The loser node is therefore re-read WHOLE, not cell by cell: a concurrent
    // write can also CREATE a size cell that the node delete would swallow
    // unseen.
    // ONE ROUND TRIP, BOTH SIDES. Every fence read is issued together and
    // awaited once, then judged. Reading them in sequence would push the
    // commit 10+ round trips past the FIRST fence read — and the widest of
    // those gaps would sit on the survivor, the live sellable record a POS
    // sale actually hits. A fence that takes longer to check widens the very
    // window it exists to close, so the checks must not queue behind each
    // other. Judging happens after all reads land, so the refusal reported is
    // deterministic regardless of which read returned first.
    // Every probe gets a rejection handler THE MOMENT it is created. The two
    // Promise.all calls are awaited in sequence, so if a SURVIVOR read fails
    // the loser reads are still in flight with nothing awaiting them — and in
    // Node 22 a promise that rejects with no handler attached terminates the
    // process, which in a Cloud Function kills the instance mid-request.
    // Attaching a no-op catch marks the promise handled without consuming it:
    // awaiting it later still throws normally.
    const probe = (path) => {
      const p = db.ref(path).get();
      if (p && typeof p.catch === "function") p.catch(() => {});
      return p;
    };
    const survivorProbes = [];
    for (const [loc, cells] of Object.entries(beforeSurvivorCells)) {
      for (const [sizeKey, sCell] of Object.entries(cells)) {
        survivorProbes.push({ loc, sizeKey, sCell, p: probe(`stock/${loc}/${survivorId}/${sizeKey}`) });
      }
    }
    const loserProbes = locationIds.map((loc) => ({
      loc, node: loserNodes[loc] || null, p: probe(`stock/${loc}/${loserId}`),
    }));
    // THE REMOVAL FENCE. A transfer is fenced by the survivor cell it writes;
    // a REMOVAL writes no survivor cell, so nothing above covers the one fact
    // it rests on — that this shelf, in this size, is counted under the
    // survivor. If that record were staled or deleted between the read and the
    // commit, the merge would write off units nobody ever counted. Each
    // removal re-reads its OWN count record (a single key, not the node) in the
    // same round trip as everything else.
    const removalProbes = removalFenceCells.map((c) => ({
      ...c,
      p: probe(`${COUNTED_PATH}/${c.loc}/${c.sessionId}/${countCellKey(survivorId, c.sizeKey)}`),
    }));
    const survivorLive = await Promise.all(survivorProbes.map((x) => x.p));
    const loserLive = await Promise.all(loserProbes.map((x) => x.p));
    const removalLive = await Promise.all(removalProbes.map((x) => x.p));

    for (let i = 0; i < survivorProbes.length; i += 1) {
      const { loc, sCell } = survivorProbes[i];
      const live = survivorLive[i].val();
      const seenV = sCell && typeof sCell.v === "number" ? sCell.v : null;
      const liveV = live && typeof live.v === "number" ? live.v : null;
      if (seenV !== liveV || asQty(live) !== asQty(sCell)) {
        throw new MergeRefused("aborted",
          `The surviving product's stock at ${loc} changed while the merge was being prepared. Nothing was changed — try again.`);
      }
    }
    // EVERY registered location, not just the ones the loser held: a receive or
    // a transfer_in landing during preparation would create a node the merge
    // never read, so it would be neither transferred nor deleted — stranding
    // stock on a record that is about to become invisible.
    for (let i = 0; i < loserProbes.length; i += 1) {
      const { loc, node } = loserProbes[i];
      if (stableJson(loserLive[i].val()) !== stableJson(node)) {
        throw new MergeRefused("aborted",
          `The product being merged away had its stock at ${loc} changed while the merge was being prepared. Nothing was changed — try again.`);
      }
    }

    for (let i = 0; i < removalProbes.length; i += 1) {
      const { loc, sizeKey } = removalProbes[i];
      if (!countRecordCounts(removalLive[i].val())) {
        throw new MergeRefused("aborted",
          `The count of ${decodeSizeKey(sizeKey)} at ${loc} changed while the merge was being prepared, so its stock is no longer safe to write off. Nothing was changed — try again.`);
      }
    }

    await db.ref().update(updates);

    return {
      ok: true, mergeId, moved, removed, movementIds,
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

module.exports = { performMerge, MergeRefused, encodeSizeKey, decodeSizeKey };
