// ─── product-merge tests — the merge invariants, mutation-proofed ─────────────
// The invariants pinned here are the ones the owner's spec names as mandatory:
//   • a merge never changes any location's total quantity;
//   • the loser record survives as a redirect (old sales keep resolving);
//   • loser barcodes scan to the survivor afterwards;
//   • the matching duplicate row closes;
//   • Pine stock refuses the whole merge, atomically — nothing half-applies;
//   • the cell/ledger contract (v+1, paired movements, one atomic update).

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { performMerge, MergeRefused, PINE_LOCATIONS } = require("../lib/product-merge.cjs");

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

  return {
    data,
    updates,
    ref(path = "") {
      return {
        async get() {
          const v = at(path);
          const val = v === undefined ? null : v;
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

test("PINE GUARD: stock at marathon-pine or hub3 refuses the whole merge — atomically", async () => {
  for (const loc of PINE_LOCATIONS) {
    const w = baseWorld();
    w.stock[loc] = { pLoser: { "6": { qty: 1, v: 0, mv: "x" } } };
    await assertRefused(fakeDb(w), {}, /failed-precondition/, /Pine is out of scope/);

    const w2 = baseWorld();
    w2.stock[loc] = { pSurvivor: { "6": { qty: 0, v: 0, mv: "x" } } };
    await assertRefused(fakeDb(w2), {}, /failed-precondition/, /Pine is out of scope/,
      "even a qty-0 Pine cell refuses — presence is the signal");
  }
});

test("refused: unreadable location registry — never guessed", async () => {
  const w = baseWorld();
  delete w.locations;
  await assertRefused(fakeDb(w), {}, /failed-precondition/, /registry/);
});

// ─── THE LOCK ────────────────────────────────────────────────────────────────
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
  w.stock["marathon-pine"] = { pLoser: { "6": { qty: 1, v: 0, mv: "x" } } };
  const db = fakeDb(w);
  await assert.rejects(() => run(db));
  assert.strictEqual((db.data.product_merges_locks || {}).pLoser, undefined, "lock released on refusal");

  const db2 = fakeDb(baseWorld());
  await run(db2);
  assert.ok(db2.data.product_merges_locks.pLoser, "applied merge keeps the lock as a tombstone");
});
