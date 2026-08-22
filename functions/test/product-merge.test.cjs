// ─── product-merge tests — the merge invariants, mutation-proofed ─────────────
// The invariants pinned here are the ones the owner's spec names as mandatory:
//   • a merge never changes any location's total quantity;
//   • the loser record survives as a redirect (old sales keep resolving);
//   • loser barcodes scan to the survivor afterwards;
//   • the matching duplicate row closes;
//   • NO location refuses a merge — Pine (marathon-pine / hub3) included;
//   • the cell/ledger contract (v+1, paired movements, one atomic update).

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { performMerge, MergeRefused } = require("../lib/product-merge.cjs");

const NOW = 1770000000000;
const ACTOR = { uid: "admin1", email: "gunidmoh@gmail.com" };

// Minimal Admin-RTDB fake: path get/set, multi-path root update (null deletes),
// and a transaction that mirrors first-write-wins.
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const updates = []; // every .update() call, for atomicity assertions

  const at = (path) => String(path).split("/").filter(Boolean)
    .reduce((n, k) => (n == null ? undefined : n[k]), data);
  const put = (path, value) => {
    const parts = String(path).split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) {
      if (node[k] == null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    if (value === null) delete node[last];
    else node[last] = value;
  };

  // { match, fn, skip } — fires ONCE after a get whose path includes match,
  // after `skip` earlier matches have gone by. The skip matters for the LOSER
  // drift fence, which re-reads the very path the initial read used: firing on
  // the first match would model a write that landed BEFORE the merge looked,
  // which is not drift at all.
  let onGet = null;

  return {
    data,
    updates,
    afterGetOf(match, fn, skip = 0) { onGet = { match, fn, skip }; },
    ref(path = "") {
      return {
        async get() {
          // The hook fires BEFORE the value is captured, so a "concurrent
          // write landing just before this read" is modelled faithfully.
          if (onGet && String(path).includes(onGet.match)) {
            if (onGet.skip > 0) onGet.skip -= 1;
            else { const { fn } = onGet; onGet = null; fn({ getPath: at, setPath: put }); }
          }
          const v = at(path);
          // A DEEP COPY, because the real SDK hands back a detached snapshot.
          // Returning the live object would make every read alias the store, so
          // a value captured earlier would silently follow later writes — and a
          // drift fence comparing the two could never see drift at all.
          const val = v === undefined ? null : (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
          return { val: () => val, exists: () => val !== null };
        },
        async set(value) { put(path || "", value); },
        async update(patch) {
          updates.push({ base: path || "", patch });
          for (const [k, v] of Object.entries(patch)) put(path ? `${path}/${k}` : k, v);
        },
        async transaction(fn) {
          const cur = at(path);
          const next = fn(cur === undefined ? null : cur);
          if (next === undefined) {
            return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
          }
          put(path, next);
          return { committed: true, snapshot: { val: () => next } };
        },
      };
    },
  };
}

const LOCATIONS = {
  central: { id: "central" }, hub1: { id: "hub1" }, hub2: { id: "hub2" }, hub3: { id: "hub3" },
  "marathon-pe": { id: "marathon-pe" }, trophy: { id: "trophy" }, "marathon-pine": { id: "marathon-pine" },
  in_transit: { id: "in_transit" },
};

function baseWorld() {
  return {
    locations: LOCATIONS,
    products: {
      pLoser: {
        id: "pLoser", name: "Nike SB Dunk Low (dup)", sizes: ["6", "7"],
        barcodes: { "6": "00000601", "7": "00000701" },
        styleCodeNormalised: "BQ6817302",
      },
      pSurvivor: {
        id: "pSurvivor", name: "Nike SB Dunk Low", sizes: ["6", "8"],
        barcodes: { "6": "00000699" },
      },
    },
    stock: {
      central: { pLoser: { "6": { qty: 3, v: 4, mv: "m1" }, "7": { qty: 0, v: 1, mv: "m2" } } },
      hub2: {
        pLoser: { "6": { qty: 2, v: 9, mv: "m3" }, _meta: { note: "junk" } },
        pSurvivor: { "6": { qty: 5, v: 2, mv: "m4" } },
      },
      trophy: { pSurvivor: { "8": { qty: 1, v: 0, mv: "m5" } } },
    },
    barcodes: {
      "00000601": { productId: "pLoser", size: "6", at: "2026-01-01T00:00:00Z" },
      "00000701": { productId: "pLoser", size: "7", at: "2026-01-01T00:00:00Z" },
      "00000699": { productId: "pSurvivor", size: "6", at: "2026-01-01T00:00:00Z" },
    },
    style_code_index: { BQ6817302: { productId: "pLoser", claimedAt: 1 } },
    duplicate_candidates: {
      pLoser__pSurvivor: {
        productIdA: "pLoser", productIdB: "pSurvivor",
        reason: "styleCodeCollision", detectedAt: 42, status: "open",
      },
    },
  };
}

// Every location's total on-hand across BOTH products.
function totalsByLocation(data) {
  const out = {};
  for (const [loc, prods] of Object.entries(data.stock || {})) {
    let sum = 0;
    for (const cells of Object.values(prods)) {
      for (const [k, cell] of Object.entries(cells)) {
        if (k === "_meta" || !cell || typeof cell !== "object") continue;
        sum += typeof cell.qty === "number" ? cell.qty : 0;
      }
    }
    out[loc] = sum;
  }
  return out;
}

async function run(db, over = {}) {
  return performMerge(db, { loserId: "pLoser", survivorId: "pSurvivor", actor: ACTOR, nowMs: NOW, ...over });
}

// ─── THE CONSERVATION INVARIANT ──────────────────────────────────────────────
test("a merge never changes any location's total quantity", async () => {
  const db = fakeDb(baseWorld());
  const before = totalsByLocation(db.data);
  await run(db);
  const after = totalsByLocation(db.data);
  assert.deepStrictEqual(after, before, "per-location totals must be identical before and after");
});

test("cells transfer to the survivor AT THEIR OWN locations, summing on collision", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  // hub2 size 6: survivor 5 + loser 2 = 7, at hub2 — nothing moved between locations.
  assert.strictEqual(db.data.stock.hub2.pSurvivor["6"].qty, 7);
  // central size 6: survivor had no cell — created with the loser's 3, v = 0.
  assert.strictEqual(db.data.stock.central.pSurvivor["6"].qty, 3);
  assert.strictEqual(db.data.stock.central.pSurvivor["6"].v, 0, "a NEW cell is born at v=0");
  // survivor's untouched trophy cell is untouched.
  assert.deepStrictEqual(db.data.stock.trophy.pSurvivor["8"], { qty: 1, v: 0, mv: "m5" });
  // the loser's stock nodes are GONE everywhere — including qty-0 cells and _meta,
  // because cell existence alone arms the refill engine.
  assert.strictEqual(db.data.stock.central.pLoser, undefined);
  assert.strictEqual(db.data.stock.hub2.pLoser, undefined);
});

test("the cell/ledger contract: v+1, mv, and paired movements with before/after", async () => {
  const db = fakeDb(baseWorld());
  const out = await run(db);
  const cell = db.data.stock.hub2.pSurvivor["6"];
  assert.strictEqual(cell.v, 3, "existing survivor cell v goes 2 → 3, exactly +1");
  assert.strictEqual(cell.lastType, "adjustment");
  const mvS = db.data.stock_movements[cell.mv];
  assert.ok(mvS, "the cell's mv points at a real ledger entry");
  assert.deepStrictEqual(mvS.before, { hub2: 5 });
  assert.deepStrictEqual(mvS.after, { hub2: 7 });
  assert.strictEqual(mvS.productId, "pSurvivor");
  const loserLeg = out.movementIds.find((id) => id.includes("_L_hub2_6"));
  const mvL = db.data.stock_movements[loserLeg];
  assert.deepStrictEqual(mvL.before, { hub2: 2 });
  assert.deepStrictEqual(mvL.after, { hub2: 0 });
  assert.strictEqual(mvL.productId, "pLoser");
  assert.strictEqual(mvL.reason, "product_merge");
  // qty-0 loser cell produced NO movements — there was nothing to move.
  assert.ok(!out.movementIds.some((id) => id.endsWith("_central_7")));
});

test("the whole merge is ONE atomic multi-path update", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  assert.strictEqual(db.updates.length, 1, "everything must land in a single update()");
  assert.strictEqual(db.updates[0].base, "", "…rooted at the top");
});

// ─── THE REDIRECT ────────────────────────────────────────────────────────────
test("the loser survives as a redirect — an old sale referencing it still resolves", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  const loser = db.data.products.pLoser;
  assert.ok(loser, "the record is NOT deleted");
  assert.strictEqual(loser.name, "Nike SB Dunk Low (dup)", "name intact for old sale rendering");
  assert.strictEqual(loser.mergedInto, "pSurvivor");
  assert.strictEqual(loser.mergedAt, NOW);
  assert.strictEqual(loser.mergedBy, "admin1");
});

test("loser barcodes scan to the survivor afterwards; survivor's own codes untouched", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  assert.strictEqual(db.data.barcodes["00000601"].productId, "pSurvivor");
  assert.strictEqual(db.data.barcodes["00000601"].size, "6", "the size on the row is preserved");
  assert.strictEqual(db.data.barcodes["00000701"].productId, "pSurvivor");
  assert.strictEqual(db.data.barcodes["00000699"].productId, "pSurvivor");
  // per-size label code inherited ONLY where the survivor had none (size 7):
  assert.strictEqual(db.data.products.pSurvivor.barcodes["7"], "00000701");
  assert.strictEqual(db.data.products.pSurvivor.barcodes["6"], "00000699", "survivor keeps its own size-6 code");
});

test("the loser's style-code claim repoints to the survivor", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  assert.strictEqual(db.data.style_code_index.BQ6817302.productId, "pSurvivor");
  assert.strictEqual(db.data.style_code_index.BQ6817302.claimedAt, 1, "claim history preserved");
});

test("the survivor inherits sizes it received stock in — and nothing else changes on it", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  assert.deepStrictEqual(db.data.products.pSurvivor.sizes, ["6", "8"],
    "moved stock was size 6 only, which the survivor already lists — sizes unchanged");
  assert.strictEqual(db.data.products.pSurvivor.name, "Nike SB Dunk Low");
});

test("a size the survivor never listed is appended when its stock arrives", async () => {
  const world = baseWorld();
  world.stock.central.pLoser["7"].qty = 4; // size 7 now holds stock
  const db = fakeDb(world);
  await run(db);
  assert.deepStrictEqual(db.data.products.pSurvivor.sizes, ["6", "8", "7"]);
  assert.strictEqual(db.data.stock.central.pSurvivor["7"].qty, 4);
});

test("negative loser cells transfer as negatives — the shortage signal is preserved", async () => {
  const world = baseWorld();
  world.stock.central.pLoser["6"].qty = -3;
  const db = fakeDb(world);
  const before = totalsByLocation(db.data);
  await run(db);
  assert.strictEqual(db.data.stock.central.pSurvivor["6"].qty, -3);
  assert.deepStrictEqual(totalsByLocation(db.data), before);
});

// ─── NO LOCATION IS SPECIAL — the Pine refusal, removed 2026-08-22 ───────────
// Until this date a merge was refused outright if EITHER product held a cell at
// marathon-pine or hub3. That exclusion was copied from the headwear one-size
// collapse (which rewrote size keys on Pine's qty-0 reconciliation husks) and
// protected nothing about merges: a merge never moves stock between locations,
// so Pine's units stay at Pine. These tests pin the replacement contract —
// every location goes through one code path, sign and all.

// The live case that exposed it: "Lacoste Audyssor White Gray" merged into
// "Lacoste Audysol White". Survivor hub1 17 / central 16 / marathon-pine 7 /
// hub3 −2; loser hub1 13. Reproduced cell for cell.
function lacosteWorld() {
  return {
    locations: LOCATIONS,
    products: {
      pLoser: { id: "pLoser", name: "Lacoste Audyssor White Gray", sizes: ["8"] },
      pSurvivor: { id: "pSurvivor", name: "Lacoste Audysol White", sizes: ["8"] },
    },
    stock: {
      hub1: {
        pSurvivor: { "8": { qty: 17, v: 3, mv: "s1" } },
        pLoser: { "8": { qty: 13, v: 5, mv: "l1" } },
      },
      central: { pSurvivor: { "8": { qty: 16, v: 2, mv: "s2" } } },
      "marathon-pine": { pSurvivor: { "8": { qty: 7, v: 1, mv: "s3" } } },
      hub3: { pSurvivor: { "8": { qty: -2, v: 4, mv: "s4" } } },
    },
    barcodes: {},
    style_code_index: {},
  };
}

test("THE LIVE CASE: a merge where a product holds Pine and hub3 stock SUCCEEDS", async () => {
  const db = fakeDb(lacosteWorld());
  const before = totalsByLocation(db.data);
  const out = await run(db);
  assert.strictEqual(out.ok, true, "no location may refuse a merge");

  // Pine's units stay at Pine, untouched and unchanged in total.
  assert.deepStrictEqual(db.data.stock["marathon-pine"].pSurvivor["8"],
    { qty: 7, v: 1, mv: "s3" }, "Pine's cell is not even rewritten — nothing moved there");
  assert.strictEqual(db.data.stock.central.pSurvivor["8"].qty, 16, "Central keeps its 16");
  // The one collision sums, at its own location.
  assert.strictEqual(db.data.stock.hub1.pSurvivor["8"].qty, 30, "hub1: 17 + 13, at hub1");
  assert.strictEqual(db.data.stock.hub1.pSurvivor["8"].v, 4, "…and v goes 3 → 4, exactly +1");
  assert.strictEqual(db.data.stock.hub1.pLoser, undefined, "the loser's hub1 node is gone");
  // The negative cell keeps its sign — not refused, not zeroed.
  assert.strictEqual(db.data.stock.hub3.pSurvivor["8"].qty, -2, "hub3 stays at −2, sign intact");

  // Per-location totals conserved EXACTLY, for every location.
  assert.deepStrictEqual(totalsByLocation(db.data), before);
  assert.deepStrictEqual(before,
    { hub1: 30, central: 16, "marathon-pine": 7, hub3: -2 }, "…and those totals are the real ones");
});

test("Pine and hub3 stock on EITHER side merges — loser side too, qty-0 husks included", async () => {
  for (const loc of ["marathon-pine", "hub3"]) {
    // Loser holds it.
    const w = baseWorld();
    w.stock[loc] = { pLoser: { "6": { qty: 4, v: 0, mv: "x" } } };
    const db = fakeDb(w);
    const before = totalsByLocation(db.data);
    assert.strictEqual((await run(db)).ok, true, `a loser cell at ${loc} must not refuse`);
    assert.strictEqual(db.data.stock[loc].pSurvivor["6"].qty, 4, `${loc}'s 4 stay at ${loc}`);
    assert.strictEqual(db.data.stock[loc].pSurvivor["6"].v, 0, "a new cell is born at v=0");
    assert.strictEqual(db.data.stock[loc].pLoser, undefined);
    assert.deepStrictEqual(totalsByLocation(db.data), before);

    // Survivor holds it — a qty-0 reconciliation husk, the exact shape the old
    // guard called "presence". It is simply left alone.
    const w2 = baseWorld();
    w2.stock[loc] = { pSurvivor: { "6": { qty: 0, v: 7, mv: "x" } } };
    const db2 = fakeDb(w2);
    const before2 = totalsByLocation(db2.data);
    assert.strictEqual((await run(db2)).ok, true, `a survivor husk at ${loc} must not refuse`);
    assert.deepStrictEqual(db2.data.stock[loc].pSurvivor["6"], { qty: 0, v: 7, mv: "x" },
      "an untouched survivor cell is not rewritten");
    assert.deepStrictEqual(totalsByLocation(db2.data), before2);
  }
});

test("a NEGATIVE loser cell at Pine transfers with its sign, and sums into a negative survivor cell", async () => {
  const w = baseWorld();
  w.stock["marathon-pine"] = {
    pLoser: { "6": { qty: -3, v: 1, mv: "x" } },
    pSurvivor: { "6": { qty: -2, v: 5, mv: "y" } },
  };
  const db = fakeDb(w);
  const before = totalsByLocation(db.data);
  const out = await run(db);
  assert.strictEqual(db.data.stock["marathon-pine"].pSurvivor["6"].qty, -5,
    "−2 + −3 = −5 — no clamp, no zeroing");
  assert.deepStrictEqual(totalsByLocation(db.data), before);
  // Both ledger legs describe a negative move: the sign flips from/to.
  const mvL = db.data.stock_movements[out.movementIds.find((id) => id.includes("_L_marathon-pine_6"))];
  const mvS = db.data.stock_movements[out.movementIds.find((id) => id.includes("_S_marathon-pine_6"))];
  assert.strictEqual(mvL.qty, 3, "the ledger records magnitude…");
  assert.strictEqual(mvL.to, "marathon-pine", "…and a negative loser leg reads as an inbound correction");
  assert.strictEqual(mvL.from, null);
  assert.deepStrictEqual(mvS.before, { "marathon-pine": -2 });
  assert.deepStrictEqual(mvS.after, { "marathon-pine": -5 });
});

test("a second merge of the same pair credits NOTHING extra", async () => {
  const db = fakeDb(lacosteWorld());
  await run(db);
  const afterFirst = JSON.parse(JSON.stringify(db.data.stock));
  const totals = totalsByLocation(db.data);
  await assert.rejects(() => run(db), (err) => {
    assert.ok(err instanceof MergeRefused);
    assert.match(err.message, /already merged/);
    return true;
  });
  assert.deepStrictEqual(db.data.stock, afterFirst, "no cell moved a second time");
  assert.deepStrictEqual(totalsByLocation(db.data), totals);
  assert.strictEqual(db.data.stock.hub1.pSurvivor["8"].qty, 30, "hub1 is 30, not 43");
});

test("the loser is a hidden redirect after a Pine-holding merge, and old references resolve", async () => {
  const w = lacosteWorld();
  w.barcodes = { "00000801": { productId: "pLoser", size: "8", at: "2026-01-01T00:00:00Z" } };
  const db = fakeDb(w);
  await run(db);
  assert.ok(db.data.products.pLoser, "the record is NOT deleted");
  assert.strictEqual(db.data.products.pLoser.mergedInto, "pSurvivor");
  assert.strictEqual(db.data.products.pLoser.name, "Lacoste Audyssor White Gray");
  assert.strictEqual(db.data.barcodes["00000801"].productId, "pSurvivor",
    "a label already stuck on stock still scans — to the survivor");
});

// ─── CLOSURES + AUDIT ────────────────────────────────────────────────────────
test("the matching duplicate_candidates row closes as merged, keeping its history", async () => {
  const db = fakeDb(baseWorld());
  await run(db);
  const row = db.data.duplicate_candidates.pLoser__pSurvivor;
  assert.strictEqual(row.status, "merged");
  assert.strictEqual(row.detectedAt, 42, "original detection time preserved");
  assert.strictEqual(row.mergedBy, "admin1");
});

test("the full before-state is recorded — the reversal recipe", async () => {
  const db = fakeDb(baseWorld());
  const out = await run(db);
  const rec = db.data.product_merges[out.mergeId];
  assert.ok(rec, "audit record exists");
  assert.strictEqual(rec.before.loserStock.central["6"].qty, 3, "loser cells as they were");
  assert.strictEqual(rec.before.survivorCells.hub2["6"].qty, 5, "touched survivor cells as they were");
  assert.strictEqual(rec.before.barcodes["00000601"].productId, "pLoser", "barcode rows as they pointed");
  assert.strictEqual(rec.before.duplicateRow.status, "open");
  assert.deepStrictEqual(rec.moved.map((m) => `${m.loc}/${m.size}/${m.qty}`).sort(),
    ["central/6/3", "hub2/6/2"]);
});

// ─── REFUSALS — fail closed, write nothing ───────────────────────────────────
async function assertRefused(db, over, codeRe, msgRe) {
  const snapshotBefore = JSON.stringify({ ...db.data, product_merges_locks: undefined });
  await assert.rejects(() => run(db, over), (err) => {
    assert.ok(err instanceof MergeRefused, `expected MergeRefused, got ${err}`);
    assert.match(err.code, codeRe);
    if (msgRe) assert.match(err.message, msgRe);
    return true;
  });
  const snapshotAfter = JSON.stringify({ ...db.data, product_merges_locks: undefined });
  assert.strictEqual(snapshotAfter, snapshotBefore, "a refused merge writes NOTHING");
}

test("refused: unknown loser / unknown survivor / self-merge", async () => {
  await assertRefused(fakeDb(baseWorld()), { loserId: "pGhost" }, /not-found/);
  await assertRefused(fakeDb(baseWorld()), { survivorId: "pGhost" }, /not-found/);
  await assertRefused(fakeDb(baseWorld()), { survivorId: "pLoser" }, /invalid-argument/);
});

test("refused: either party already merged away", async () => {
  const w1 = baseWorld(); w1.products.pLoser.mergedInto = "pOther";
  await assertRefused(fakeDb(w1), {}, /failed-precondition/, /already merged/);
  const w2 = baseWorld(); w2.products.pSurvivor.mergedInto = "pOther";
  await assertRefused(fakeDb(w2), {}, /failed-precondition/, /itself merged/);
});

test("refused: unreadable location registry — never guessed", async () => {
  const w = baseWorld();
  delete w.locations;
  await assertRefused(fakeDb(w), {}, /failed-precondition/, /registry/);
});

test("refused: an id that is not a legal RTDB key — before any lock or read", async () => {
  const isBadKeyRefusal = (err) => {
    assert.ok(err instanceof MergeRefused);
    assert.strictEqual(err.code, "invalid-argument");
    assert.match(err.message, /not a legal database key/);
    return true;
  };
  for (const bad of ["a/b", "p.1", "p#1", "p$1", "p[1]", "p 1"]) {
    const db = fakeDb(baseWorld());
    await assert.rejects(() => run(db, { loserId: bad }), isBadKeyRefusal);
    await assert.rejects(() => run(db, { survivorId: bad }), isBadKeyRefusal);
    assert.strictEqual(db.data.product_merges_locks, undefined, "no lock may be taken for a bad id");
  }
});

// ─── THE DRIFT FENCE ─────────────────────────────────────────────────────────
test("a sale landing on a survivor cell mid-merge REFUSES the merge — never erased", async () => {
  const db = fakeDb(baseWorld());
  // Between the merge's initial reads and its pre-commit recheck, a concurrent
  // POS sale lands on the survivor's hub2 cell (qty −1, v +1) — exactly the
  // write the absolute-qty update would otherwise silently erase. The hook
  // fires on the recheck's per-cell read, i.e. AFTER preparation, BEFORE commit.
  db.afterGetOf("stock/hub2/pSurvivor/6", ({ getPath, setPath }) => {
    const cell = getPath("stock/hub2/pSurvivor/6");
    setPath("stock/hub2/pSurvivor/6", { ...cell, qty: cell.qty - 1, v: cell.v + 1 });
  });
  await assert.rejects(() => run(db), (err) => {
    assert.ok(err instanceof MergeRefused);
    assert.match(err.code, /aborted/);
    assert.match(err.message, /changed while the merge/);
    return true;
  });
  // Nothing committed: the sale survives, the loser is untouched.
  assert.strictEqual(db.data.stock.hub2.pSurvivor["6"].qty, 4, "the concurrent sale's write survives");
  assert.strictEqual(db.data.stock.hub2.pLoser["6"].qty, 2, "loser cells untouched");
  assert.strictEqual(db.data.products.pLoser.mergedInto, undefined);
  assert.strictEqual(db.updates.length, 0, "the atomic update never ran");
});

test("a sale landing on a LOSER cell mid-merge REFUSES the merge — no unit is conjured", async () => {
  // The loser lock excludes other MERGES, not a POS sale: until the commit lands
  // the loser is a normal sellable product. Its quantity is added to the
  // survivor as an ABSOLUTE number and its node is then deleted, so an
  // unfenced sale here would vanish and hub2's total would rise by one.
  const db = fakeDb(baseWorld());
  db.afterGetOf("stock/hub2/pLoser", ({ getPath, setPath }) => {
    const cell = getPath("stock/hub2/pLoser/6");
    setPath("stock/hub2/pLoser/6", { ...cell, qty: cell.qty - 1, v: cell.v + 1 });
  }, 1); // skip the initial read — fire on the fence's re-read
  await assert.rejects(() => run(db), (err) => {
    assert.ok(err instanceof MergeRefused);
    assert.match(err.code, /aborted/);
    assert.match(err.message, /merged away had its stock at hub2 changed/);
    return true;
  });
  assert.strictEqual(db.data.stock.hub2.pLoser["6"].qty, 1, "the concurrent sale's write survives");
  assert.strictEqual(db.data.stock.hub2.pSurvivor["6"].qty, 5, "the survivor gained nothing");
  assert.strictEqual(db.updates.length, 0, "the atomic update never ran");
});

test("a size cell CREATED on the loser mid-merge refuses — the node delete never swallows it unseen", async () => {
  const db = fakeDb(baseWorld());
  db.afterGetOf("stock/hub2/pLoser", ({ setPath }) => {
    setPath("stock/hub2/pLoser/9", { qty: 2, v: 0, mv: "arrival" });
  }, 1);
  await assert.rejects(() => run(db), (err) => {
    assert.match(err.message, /merged away had its stock at hub2 changed/);
    return true;
  });
  assert.strictEqual(db.data.stock.hub2.pLoser["9"].qty, 2, "the new cell survives");
  assert.strictEqual(db.updates.length, 0);
});

test("a node appearing at a location the loser held NOTHING at refuses — nothing is stranded", async () => {
  // A receive landing on the duplicate mid-merge. Its location was never read,
  // so its cells would be neither transferred nor deleted — left on a record
  // about to become invisible.
  const db = fakeDb(baseWorld());
  db.afterGetOf("stock/trophy/pSurvivor", ({ setPath }) => {
    setPath("stock/trophy/pLoser", { "6": { qty: 5, v: 0, mv: "receive" } });
  });
  await assert.rejects(() => run(db), (err) => {
    assert.ok(err instanceof MergeRefused);
    assert.match(err.message, /merged away had its stock at trophy changed/);
    return true;
  });
  assert.strictEqual(db.data.stock.trophy.pLoser["6"].qty, 5, "the receive survives");
  assert.strictEqual(db.updates.length, 0);
});

test("the loser fence is key-order blind — an identical node in a different order commits", async () => {
  // NOTE the size keys. Integer-like keys ("6", "7") are ordered NUMERICALLY by
  // the JS spec no matter how they are inserted, so a reversal on those would be
  // a no-op and this test would prove nothing. Clothing keys reorder for real.
  const w = baseWorld();
  w.stock.central.pLoser = { M: { qty: 2, v: 1, mv: "a" }, L: { qty: 3, v: 1, mv: "b" } };
  const db = fakeDb(w);
  db.afterGetOf("stock/central/pLoser", ({ getPath, setPath }) => {
    const node = getPath("stock/central/pLoser");
    assert.deepStrictEqual(Object.keys(node), ["M", "L"], "the fixture really is insertion-ordered");
    const flipped = Object.fromEntries(Object.entries(node).reverse());
    assert.deepStrictEqual(Object.keys(flipped), ["L", "M"], "…and the flip really flips");
    setPath("stock/central/pLoser", flipped);
  }, 1);
  const out = await run(db);
  assert.strictEqual(out.ok, true, "a re-ordered but identical node must not refuse");
  assert.strictEqual(db.data.stock.central.pSurvivor.M.qty, 2);
  assert.strictEqual(db.data.stock.central.pSurvivor.L.qty, 3);
});

test("a fresh concurrent lock aborts the second merge; a stale one is taken over", async () => {
  const w = baseWorld();
  w.product_merges_locks = { pLoser: { mergeId: "other", at: NOW - 1000, by: "admin2" } };
  const db = fakeDb(w);
  await assert.rejects(() => run(db), /in progress/);

  const w2 = baseWorld();
  w2.product_merges_locks = { pLoser: { mergeId: "crashed", at: NOW - 11 * 60 * 1000, by: "admin2" } };
  const db2 = fakeDb(w2);
  const out = await run(db2);
  assert.strictEqual(out.ok, true, "a stale lock from a crashed merge must not deadlock the product");
});

test("a refused merge releases its lock; an applied merge keeps a tombstone", async () => {
  const w = baseWorld();
  delete w.locations; // refuses INSIDE the try, i.e. with the lock already held
  const db = fakeDb(w);
  await assert.rejects(() => run(db));
  assert.strictEqual((db.data.product_merges_locks || {}).pLoser, undefined, "lock released on refusal");

  const db2 = fakeDb(baseWorld());
  await run(db2);
  assert.ok(db2.data.product_merges_locks.pLoser, "applied merge keeps the lock as a tombstone");
});
