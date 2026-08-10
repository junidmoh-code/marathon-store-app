// ─── BEANIE ONE-SIZE COLLAPSE — BEHAVIOURAL TESTS ────────────────────────────
// Run: npx vitest run scripts/lib/beanieCollapseCore.test.mjs
//
// Every test here asserts BEHAVIOUR against a fake RTDB — what the data looks
// like after the operation, what a scan resolves to, what a re-run does.
// Nothing greps for a function name or an id string as a proxy for correctness.
//
// ── THE FAKE MUST BEHAVE LIKE RTDB, OR IT PROVES NOTHING ─────────────────────
// Real RTDB DELETES a child written as null, and never stores an empty object
// or empty array — a node whose children all vanish disappears with them. A
// fake that keeps empty husks around would "prove" that e.g. a product with an
// emptied barcodes map still resolves, which cannot happen in production. This
// fake reproduces the deletion rule, and one test asserts the fake itself does
// so (a fake this suite depends on is part of the system under test).
//
// update() is all-or-nothing and validates EVERY path before applying ANY of
// them — that is what makes Step 2's atomicity testable: a fake that applied
// paths one at a time could never fail the "partial application is impossible"
// test, so it would pass vacuously.

import { describe, it, expect } from "vitest";
import {
  applyMovementAdmin, planStep1, planStep2, planStep3, step2Done, verifyProduct,
  assertDrained, legIds, orderBlocks, transferBlocks, movementRecency, pushKeyMs, isInScope, isUnexpectedSubcategory,
} from "./beanieCollapseCore.mjs";

// ── fake RTDB ────────────────────────────────────────────────────────────────
function makeDb(seed = {}) {
  const isEmptyish = (v) => v === null || v === undefined ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
    (Array.isArray(v) && v.length === 0);

  // The SEED goes through the same rule as a write: RTDB cannot hold an empty
  // container, so a fixture that declares `stock_targets: {}` must present as
  // "no such node" — otherwise a test could assert against a husk that could
  // never exist live.
  const pruneEmpties = (obj) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        pruneEmpties(v);
        if (Object.keys(v).length === 0) delete obj[k];
      } else if (isEmptyish(v)) delete obj[k];
    }
    return obj;
  };
  let root = pruneEmpties(structuredClone(seed));

  const readPath = (path) => {
    let node = root;
    for (const seg of path.split("/").filter(Boolean)) {
      if (node == null || typeof node !== "object") return null;
      node = node[seg];
    }
    return node === undefined ? null : structuredClone(node);
  };

  const writePath = (path, value) => {
    const segs = path.split("/").filter(Boolean);
    const leaf = segs.pop();
    let node = root;
    for (const seg of segs) {
      if (node[seg] == null || typeof node[seg] !== "object") node[seg] = {};
      node = node[seg];
    }
    if (isEmptyish(value)) {
      delete node[leaf];
      pruneEmpties(root);        // RTDB prunes emptied ancestors too
    } else {
      node[leaf] = structuredClone(value);
    }
  };

  let failNextUpdate = null;
  // Fires after a cell read — how a concurrent writer (a till sale) is injected
  // into the exact window between the read that computes the write and the
  // re-read that guards it.
  let afterCellRead = null;
  const stats = { updates: 0, pathsPerUpdate: [] };

  return {
    stats,
    raw: () => structuredClone(root),
    failNextUpdateWith(err) { failNextUpdate = err; },
    onAfterCellRead(fn) { afterCellRead = fn; },
    /** Write outside the io interface — stands in for another client. */
    poke(path, value) { writePath(path, value); },
    io: {
      read: async (p) => {
        const v = readPath(p);
        if (afterCellRead && p.startsWith("stock/")) afterCellRead(p);
        return v;
      },
      update: async (updates) => {
        // Validate everything first — one bad path rejects the WHOLE update and
        // applies nothing, exactly like RTDB.
        for (const path of Object.keys(updates)) {
          if (!path || /[.#$[\]]/.test(path)) throw new Error(`invalid path: ${path}`);
        }
        if (failNextUpdate) { const e = failNextUpdate; failNextUpdate = null; throw new Error(e); }
        stats.updates++;
        stats.pathsPerUpdate.push(Object.keys(updates).length);
        for (const [path, value] of Object.entries(updates)) writePath(path, value);
      },
    },
  };
}

const NOW = "2026-08-10T10:00:00.000Z";
const cell = (qty, v = 3) => ({ qty, v, mv: "seed", lastType: "received", updatedAt: NOW, updatedBy: "seed" });

function seedProduct({ pid = "pB", sizes = ["M"], barcodes = { M: "00011111" }, cells = {}, targets = {} } = {}) {
  const stock = {};
  for (const [loc, bySize] of Object.entries(cells)) {
    stock[loc] = { [pid]: Object.fromEntries(Object.entries(bySize).map(([k, q]) => [k, cell(q)])) };
  }
  const barcodeIdx = {};
  for (const [size, code] of Object.entries(barcodes)) barcodeIdx[code] = { productId: pid, size };
  const stock_targets = {};
  for (const [loc, rows] of Object.entries(targets)) stock_targets[loc] = { [pid]: rows };
  return {
    products: { [pid]: { name: "Test beanie", productType: "clothing", subcategory: "Caps & Hats", sizes, barcodes } },
    stock, barcodes: barcodeIdx, stock_targets,
  };
}

// Run the whole per-product migration the way the CLI does.
async function migrate(db, pid, { skipStep2 = false, skipStep3 = false } = {}) {
  const product = await db.io.read(`products/${pid}`);
  const stock = (await db.io.read("stock")) || {};
  const cellsByLoc = {};
  for (const [loc, byPid] of Object.entries(stock)) if (byPid?.[pid]) cellsByLoc[loc] = byPid[pid];
  const heldKeys = [];
  for (const bySize of Object.values(cellsByLoc)) for (const [k, c] of Object.entries(bySize)) if (c.qty !== 0) heldKeys.push(k);

  const plans = await planStep1(db.io, pid, product.sizes || [], cellsByLoc);
  for (const pl of plans) for (const leg of pl.legs) {
    const r = await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW });
    if (!r.ok) return { ok: false, failedLeg: leg.id, reason: r.reason };
  }
  const idxCodes = {};
  const idx = (await db.io.read("barcodes")) || {};
  for (const [code, rec] of Object.entries(idx)) if (rec.productId === pid) idxCodes[code] = rec;
  const s2 = planStep2(pid, product, idxCodes, heldKeys);
  if (!skipStep2) await db.io.update(s2.updates);
  if (!skipStep3) {
    const targets = (await db.io.read("stock_targets")) || {};
    const rows = {};
    for (const [loc, byPid] of Object.entries(targets)) if (byPid?.[pid]) rows[loc] = byPid[pid];
    const s3 = planStep3(pid, rows, NOW);
    if (Object.keys(s3).length) await db.io.update(s3);
  }
  return { ok: true, keepCode: s2.keepCode, rule: s2.rule, codes: s2.codes, step2Paths: Object.keys(s2.updates).length };
}

const totalAt = (raw, loc, pid) =>
  Object.values(raw.stock?.[loc]?.[pid] || {}).reduce((t, c) => t + (typeof c.qty === "number" ? c.qty : 0), 0);

// ─────────────────────────────────────────────────────────────────────────────
describe("the fake reproduces RTDB semantics this suite depends on", () => {
  it("deletes a child written as null, an empty object or an empty array", async () => {
    const db = makeDb({ a: { b: 1, c: 2 }, d: { e: 1 }, f: { g: 1 } });
    await db.io.update({ "a/b": null, "d/e": {}, "f/g": [] });
    expect(await db.io.read("a/b")).toBe(null);
    expect(await db.io.read("d")).toBe(null);        // last child gone → node gone
    expect(await db.io.read("f")).toBe(null);
  });

  it("update() is all-or-nothing — a rejected path applies none of them", async () => {
    const db = makeDb({ x: { y: 1 } });
    await expect(db.io.update({ "x/y": 2, "bad.path/z": 3 })).rejects.toThrow();
    expect((await db.io.read("x/y"))).toBe(1);
  });
});

describe("STEP 1 — stock merges into one \"_\" cell", () => {
  it("M 100 + L 100 at one location becomes a single \"_\" cell of 200, location total unchanged", async () => {
    const db = makeDb(seedProduct({ sizes: ["M", "L"], barcodes: { M: "00011111", L: "00022222" },
      cells: { hub2: { M: 100, L: 100 } } }));
    const before = totalAt(db.raw(), "hub2", "pB");
    expect(before).toBe(200);

    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);

    const cells = db.raw().stock.hub2.pB;
    expect(cells._.qty).toBe(200);
    expect(cells.M.qty).toBe(0);
    expect(cells.L.qty).toBe(0);
    expect(totalAt(db.raw(), "hub2", "pB")).toBe(before);
  });

  it("merges per location independently and never crosses locations", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 8 }, "marathon-pe": { M: 1 }, central: { M: 40 } } }));
    await migrate(db, "pB");
    const raw = db.raw();
    expect(raw.stock.hub2.pB._.qty).toBe(8);
    expect(raw.stock["marathon-pe"].pB._.qty).toBe(1);
    expect(raw.stock.central.pB._.qty).toBe(40);
    expect(totalAt(raw, "hub2", "pB")).toBe(8);
    expect(totalAt(raw, "central", "pB")).toBe(40);
  });

  it("adds into an EXISTING \"_\" cell rather than overwriting it", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5, _: 3 } } }));
    await migrate(db, "pB");
    expect(db.raw().stock.hub2.pB._.qty).toBe(8);
  });

  it("a negative sized cell is carried into \"_\" by a MIRRORED pair — total still unchanged", async () => {
    // The live case: Nike beanie green, marathon-pe S = −1. A normal OUT leg
    // would overdraw; the mirror moves the shortage instead of the stock.
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" }, cells: { "marathon-pe": { S: -1 } } }));
    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);
    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(-1);
    expect(cells.S.qty).toBe(0);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(-1);
  });

  it("refuses to overdraw: a positive OUT leg can never drive a cell negative", async () => {
    // Directly exercising the guard applyMovement enforces — plan says 5, cell holds 5,
    // a second identical OUT under a DIFFERENT id must be refused, not applied.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    await migrate(db, "pB");
    const r = await applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "M", qty: 5, from: "hub2",
      movementId: "manual_second_out", reason: "second withdrawal",
    }, { nowIso: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_stock");
    expect(db.raw().stock.hub2.pB.M.qty).toBe(0);
  });

  it("cell writes bump v by exactly 1 and change mv; a NEW cell starts at v=0", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 7 } } }));   // M seeded at v=3, no "_" cell
    await migrate(db, "pB");
    const cells = db.raw().stock.hub2.pB;
    expect(cells.M.v).toBe(4);
    expect(cells.M.mv).toBe(legIds("pB", "hub2", "M").out);
    expect(cells._.v).toBe(0);
    expect(cells._.mv).toBe(legIds("pB", "hub2", "M").in);
  });

  it("the movement and its cell land in ONE update — the ledger can never disagree with the cell", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 4 } } }));
    const ids = legIds("pB", "hub2", "M");
    db.failNextUpdateWith("network died");
    // The write is one call, so a failure surfaces as a throw and the run stops
    // — there is no path on which the cell moved but the ledger did not.
    await expect(applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "M", qty: 4, from: "hub2",
      movementId: ids.out, reason: "collapse",
    }, { nowIso: NOW })).rejects.toThrow(/network died/);
    // Nothing landed: no ledger entry AND no cell change.
    expect(await db.io.read(`stock_movements/${ids.out}`)).toBe(null);
    expect(db.raw().stock.hub2.pB.M.qty).toBe(4);
  });
});

describe("idempotency and interruption", () => {
  it("a full re-run is a no-op — quantities identical, no extra ledger entries", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 9 }, central: { M: 20 } } }));
    await migrate(db, "pB");
    const afterFirst = db.raw();
    const movementsFirst = Object.keys(afterFirst.stock_movements || {}).length;

    await migrate(db, "pB");
    const afterSecond = db.raw();
    expect(afterSecond.stock.hub2.pB._.qty).toBe(9);
    expect(afterSecond.stock.central.pB._.qty).toBe(20);
    expect(Object.keys(afterSecond.stock_movements || {}).length).toBe(movementsFirst);
    expect(afterSecond.stock.hub2.pB._.v).toBe(afterFirst.stock.hub2.pB._.v);
  });

  it("interrupted between the OUT and IN legs: everything stays sellable, and the re-run completes it", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 10 } } }));
    const ids = legIds("pB", "hub2", "M");
    // Only the OUT leg lands — the process dies before the IN.
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "M", qty: 10, from: "hub2",
      movementId: ids.out, reason: "collapse" }, { nowIso: NOW });

    // MID-FLIGHT INVARIANT: identity is untouched, so the size the units are in
    // is still a declared size and every barcode still resolves to it.
    const mid = db.raw();
    expect(mid.products.pB.sizes).toEqual(["M"]);
    expect(mid.barcodes["00011111"].size).toBe("M");
    // The units are momentarily "missing" from the total — that is the honest
    // half-applied state, and it is why the OUT/IN pair must be completable.
    expect(totalAt(mid, "hub2", "pB")).toBe(0);

    // Resume: the IN leg's quantity comes from the LEDGER, not the emptied cell.
    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);
    expect(db.raw().stock.hub2.pB._.qty).toBe(10);
    expect(totalAt(db.raw(), "hub2", "pB")).toBe(10);
  });

  it("interrupted mid negative pair: the re-run relies on movement idempotency and must not double-deduct", async () => {
    // The positive pair resumes from the LEDGER (the emptied cell no longer
    // describes the work), but the negative pair's source cell is unchanged
    // until its second leg lands — so a re-run re-plans BOTH legs and only the
    // movement-id guard stops the first one applying twice. Without that guard
    // "_" goes to −2 and a unit of shortage is invented.
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" }, cells: { "marathon-pe": { S: -1 } } }));
    const ids = legIds("pB", "marathon-pe", "S");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "_", qty: 1, from: "marathon-pe",
      movementId: ids.negOut, allowNegative: true, reason: "carry oversell" }, { nowIso: NOW });
    expect(db.raw().stock["marathon-pe"].pB._.qty).toBe(-1);
    expect(db.raw().stock["marathon-pe"].pB.S.qty).toBe(-1);   // second leg not yet run

    await migrate(db, "pB");
    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(-1);      // NOT −2
    expect(cells.S.qty).toBe(0);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(-1);
  });

  it("interrupted before Step 2: stock is split across the sized cell and \"_\" and BOTH are sellable", async () => {
    // Two locations; the second location's pair never runs.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 6 }, central: { M: 4 } } }));
    const ids = legIds("pB", "hub2", "M");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "M", qty: 6, from: "hub2", movementId: ids.out, reason: "c" }, { nowIso: NOW });
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "_", qty: 6, to: "hub2", movementId: ids.in, reason: "c" }, { nowIso: NOW });

    const mid = db.raw();
    // Identity untouched → a scan still resolves, and the declared size still
    // matches the cell holding central's units.
    expect(mid.products.pB.sizes).toEqual(["M"]);
    expect(mid.barcodes["00011111"].size).toBe("M");
    expect(mid.stock.hub2.pB._.qty).toBe(6);
    expect(mid.stock.central.pB.M.qty).toBe(4);
    // Nothing lost network-wide.
    expect(totalAt(mid, "hub2", "pB") + totalAt(mid, "central", "pB")).toBe(10);
  });
});

describe("Step 2's drain precondition — a spent pair cannot certify an undrained cell", () => {
  it("stock arriving in a still-declared size AFTER its pair landed is caught before identity collapses", async () => {
    // The exact sequence: Step 1 lands in full, the operator stops (a state the
    // header calls safe, and it is — the product still declares M). A normal
    // warehouse receive then puts units into M. On resume, planStep1 plans the
    // pair again but both movement ids are spent, so each leg no-ops and
    // reports ok. Without the drain check, Step 2 fires and strands the units.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 6 } } }));
    await migrate(db, "pB", { skipStep2: true, skipStep3: true });
    expect(db.raw().stock.hub2.pB.M.qty).toBe(0);
    expect(db.raw().stock.hub2.pB._.qty).toBe(6);

    db.poke("stock/hub2/pB/M", { qty: 2, v: 5, mv: "warehouse_receive", lastType: "received" });

    // Resume: the legs report success while moving nothing.
    const product = await db.io.read("products/pB");
    const cellsByLoc = { hub2: await db.io.read("stock/hub2/pB") };
    const plans = await planStep1(db.io, "pB", product.sizes, cellsByLoc);
    const results = [];
    for (const pl of plans) for (const leg of pl.legs) {
      results.push(await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW }));
    }
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.some((r) => r.idempotent)).toBe(true);

    // THE GUARD: Step 2's precondition asks the database, and refuses.
    const residue = await assertDrained(db.io, "pB");
    expect(residue).toEqual(["hub2/M=2"]);

    // Identity is therefore untouched and those 2 units are still sellable.
    expect(db.raw().products.pB.sizes).toEqual(["M"]);
    expect(db.raw().barcodes["00011111"].size).toBe("M");
  });

  it("reports no residue on a genuinely drained product, so a normal run is unaffected", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 6 }, central: { M: 4 } } }));
    await migrate(db, "pB", { skipStep2: true, skipStep3: true });
    expect(await assertDrained(db.io, "pB")).toEqual([]);
  });

  it("a zero sized cell and a negative one are told apart — the mirror's residue also blocks", async () => {
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" }, cells: { "marathon-pe": { S: -1 } } }));
    expect(await assertDrained(db.io, "pB")).toEqual(["marathon-pe/S=-1"]);
    await migrate(db, "pB", { skipStep2: true, skipStep3: true });
    expect(await assertDrained(db.io, "pB")).toEqual([]);   // mirror closed it at 0
  });
});

describe("STEP 2 — one atomic identity update", () => {
  it("sizes, the barcodes map and every index record land in a SINGLE update call", async () => {
    const db = makeDb(seedProduct({ sizes: ["M"], barcodes: { M: "00011111" }, cells: { hub2: { M: 2 } } }));
    const before = db.stats.updates;
    const product = await db.io.read("products/pB");
    const s2 = planStep2("pB", product, { "00011111": { productId: "pB", size: "M" } }, ["M"]);
    await db.io.update(s2.updates);
    expect(db.stats.updates).toBe(before + 1);
    expect(db.stats.pathsPerUpdate.at(-1)).toBe(3);   // sizes + map + 1 index record
    const raw = db.raw();
    expect(raw.products.pB.sizes).toEqual(["_"]);
    expect(raw.products.pB.barcodes).toEqual({ _: "00011111" });
    expect(raw.barcodes["00011111"].size).toBe("_");
  });

  it("a partial application is impossible — a failing update leaves the OLD identity intact and scannable", async () => {
    const db = makeDb(seedProduct({ sizes: ["M"], barcodes: { M: "00011111" }, cells: { hub2: { M: 2 } } }));
    const product = await db.io.read("products/pB");
    const s2 = planStep2("pB", product, { "00011111": { productId: "pB", size: "M" } }, ["M"]);
    db.failNextUpdateWith("rejected");
    await expect(db.io.update(s2.updates)).rejects.toThrow();
    const raw = db.raw();
    // The two orderings that would break scanning are BOTH absent: sizes and the
    // index still agree with each other.
    expect(raw.products.pB.sizes).toEqual(["M"]);
    expect(raw.products.pB.barcodes).toEqual({ M: "00011111" });
    expect(raw.barcodes["00011111"].size).toBe("M");
  });

  it("every barcode resolves to its product with size \"_\" after the collapse", async () => {
    const db = makeDb(seedProduct({ sizes: ["M"], barcodes: { M: "00011111" }, cells: { hub2: { M: 3 } } }));
    // A second index record pointing here that the product's map forgot.
    const seeded = db.raw();
    seeded.barcodes["00099999"] = { productId: "pB", size: "M" };
    const db2 = makeDb(seeded);
    const r = await migrate(db2, "pB");
    const raw = db2.raw();
    for (const code of ["00011111", "00099999"]) {
      expect(raw.barcodes[code].productId).toBe("pB");
      expect(raw.barcodes[code].size).toBe("_");
      // The POS resolve test: index size must be a size the product declares.
      expect(raw.products.pB.sizes).toContain(raw.barcodes[code].size);
    }
    expect(r.codes).toContain("00099999");
  });

  it("the \"_\" slot goes to the stock-holding size's code, so labels in the field keep scanning", async () => {
    const db = makeDb(seedProduct({ sizes: ["S", "M"], barcodes: { S: "00050000", M: "00060000" },
      cells: { hub2: { M: 12 } } }));
    const r = await migrate(db, "pB");
    expect(r.keepCode).toBe("00060000");
    expect(r.rule).toMatch(/stock-holding size M/);
    expect(db.raw().products.pB.barcodes).toEqual({ _: "00060000" });
  });

  it("step2Done recognises the finished state, so a re-run needs no identity write", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 2 } } }));
    await migrate(db, "pB");
    const product = await db.io.read("products/pB");
    const idx = { "00011111": await db.io.read("barcodes/00011111") };
    expect(step2Done(product, idx, "00011111")).toBe(true);
  });
});

describe("size keys — a display label can never reach a storage key", () => {
  it("\"Free Size\" folds to the \"_\" sentinel instead of minting a Free_Size cell", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 4 } } }));
    await migrate(db, "pB");
    // A later movement written with the DISPLAY label must land in the same "_"
    // cell the collapse created — this is the phantom-cell incident's exact shape.
    await applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "Free Size", qty: 2, to: "hub2",
      movementId: "later_receive", reason: "receive under the display label",
    }, { nowIso: NOW });
    const cells = db.raw().stock.hub2.pB;
    expect(Object.keys(cells).sort()).toEqual(["M", "_"]);   // ASCII: "M" < "_"
    expect(cells._.qty).toBe(6);
    expect(cells.Free_Size).toBeUndefined();
  });

  it("a half size is ENCODED into the key, so no \".\" ever reaches RTDB", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 4 } } }));
    const r = await applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "5.5", qty: 1, to: "hub2",
      movementId: "half_size", reason: "half size",
    }, { nowIso: NOW });
    expect(r.ok).toBe(true);           // it applies — encoded, not refused
    expect(Object.keys(db.raw().stock.hub2.pB)).toContain("5_5");
    expect(Object.keys(db.raw().stock.hub2.pB).some((k) => k.includes("."))).toBe(false);
  });
});

describe("STEP 3 — target rows", () => {
  it("retires explicit rows on dead sizes to target 0 and leaves \"_\" rows alone", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 3 } },
      targets: { hub2: { M: { target: 3, minQty: 2 }, _: { target: 15, minQty: 8 } }, "marathon-pe": { M: { target: 1, minQty: 1 } } } }));
    await migrate(db, "pB");
    const t = db.raw().stock_targets;
    expect(t.hub2.pB.M.target).toBe(0);
    expect(t.hub2.pB.M.source).toBe("excluded");
    expect(t.hub2.pB._.target).toBe(15);            // untouched
    expect(t["marathon-pe"].pB.M.target).toBe(0);
  });

  it("writes NO new target row anywhere — the collapse never arms a product", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 3 } } }));   // no target rows at all
    await migrate(db, "pB");
    expect(db.raw().stock_targets).toBeUndefined();      // no node was created at all
    // and with rows present, the count never grows
    const db2 = makeDb(seedProduct({ cells: { hub2: { M: 3 } }, targets: { hub2: { M: { target: 3 } } } }));
    await migrate(db2, "pB");
    const rows = db2.raw().stock_targets.hub2.pB;
    expect(Object.keys(rows)).toEqual(["M"]);
    expect(rows.M.target).toBe(0);
  });

  it("re-running does not rewrite an already-retired row", () => {
    const retired = { hub2: { M: { target: 0, minQty: 0, source: "excluded" } } };
    expect(Object.keys(planStep3("pB", retired, NOW))).toHaveLength(0);
  });
});

describe("scope — caps are untouched by every path", () => {
  it("a cap sharing the subcategory is never selected, and its cells/identity survive a beanie run", async () => {
    const seed = seedProduct({ pid: "pB", cells: { hub2: { M: 5 } } });
    // A real multi-size cap alongside it.
    seed.products.pCap = { name: "Nike cap black", productType: "clothing", subcategory: "Caps & Hats", sizes: ["S", "M", "L"], barcodes: { S: "00077771", M: "00077772", L: "00077773" } };
    seed.barcodes["00077771"] = { productId: "pCap", size: "S" };
    seed.barcodes["00077772"] = { productId: "pCap", size: "M" };
    seed.barcodes["00077773"] = { productId: "pCap", size: "L" };
    seed.stock.hub2.pCap = { S: cell(2), M: cell(3), L: cell(4) };
    const db = makeDb(seed);

    // THE SCOPE RULE — the same exported predicate the CLI filters with, not a
    // restatement of it.
    const products = db.raw().products;
    const inScope = Object.entries(products).filter(([, p]) => isInScope(p)).map(([pid]) => pid);
    expect(inScope).toEqual(["pB"]);

    for (const pid of inScope) await migrate(db, pid);

    const raw = db.raw();
    expect(raw.products.pCap.sizes).toEqual(["S", "M", "L"]);
    expect(raw.products.pCap.barcodes).toEqual({ S: "00077771", M: "00077772", L: "00077773" });
    expect(raw.barcodes["00077772"].size).toBe("M");
    expect(raw.stock.hub2.pCap).toEqual({ S: cell(2), M: cell(3), L: cell(4) });
    expect(raw.stock.hub2.pCap._).toBeUndefined();
  });

  it("flags a beanie filed outside Caps & Hats, and only an in-scope one", () => {
    // In scope (the name decides) but worth a human's eye — the census exits
    // non-zero on it rather than reading as clean.
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: "Accessories" })).toBe(true);
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: "Caps & Hats" })).toBe(false);
    expect(isUnexpectedSubcategory({ name: "Nike cap black", subcategory: "Accessories" })).toBe(false);
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: "Accessories", mergedInto: "pX" })).toBe(false);
  });

  it("the scope predicate takes beanies by name and rejects caps and merge stubs", () => {
    expect(isInScope({ name: "Nike beanie green", subcategory: "Caps & Hats" })).toBe(true);
    expect(isInScope({ name: "NIKE BEANIE GREEN" })).toBe(true);              // case-insensitive
    expect(isInScope({ name: "Nike cap black", subcategory: "Caps & Hats" })).toBe(false);
    expect(isInScope({ name: "Alo Yoga Airlift Solar Visor White", subcategory: "Caps & Hats" })).toBe(false);
    expect(isInScope({ name: "Nike beanie green", mergedInto: "pOther" })).toBe(false);
  });
});

describe("verification", () => {
  it("verifyProduct passes on a clean collapse and reports a lost unit", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 6 } } }));
    const before = { hub2: 6 };
    const r = await migrate(db, "pB");
    expect(await verifyProduct(db.io, "pB", r.keepCode, r.codes, before)).toEqual([]);

    // Simulate a unit vanishing after the fact — verification must SAY so.
    await db.io.update({ "stock/hub2/pB/_/qty": 5 });
    const problems = await verifyProduct(db.io, "pB", r.keepCode, r.codes, before);
    expect(problems.join(" ")).toMatch(/hub2 total 6 → 5/);
  });
});

describe("the open-reference gate", () => {
  const pid = "pB";
  const nowMs = Date.parse(NOW);
  it("blocks an unresolved refill line (Send would move the retired size)", () => {
    expect(orderBlocks({ id: "R1-1", productId: pid, size: "M", customerName: "Shop Refill", status: "incoming", clothingRefillStatus: null }, pid, nowMs))
      .toMatch(/unresolved refill line/);
  });
  it("blocks a resolved line still inside the 24h undo window", () => {
    const resolvedAt = new Date(nowMs - 3 * 3600e3).toISOString();
    expect(orderBlocks({ id: "R1-2", productId: pid, size: "M", customerName: "Shop Refill", status: "incoming", clothingRefillStatus: "available", clothingRefilledAt: resolvedAt }, pid, nowMs))
      .toMatch(/undo window/);
  });
  it("does NOT block a line resolved beyond the undo window, even though its status is still incoming", () => {
    const resolvedAt = new Date(nowMs - 30 * 24 * 3600e3).toISOString();
    expect(orderBlocks({ id: "R1-3", productId: pid, size: "M", customerName: "Shop Refill", status: "incoming", clothingRefillStatus: "available", clothingRefilledAt: resolvedAt }, pid, nowMs))
      .toBe(null);
  });
  it("blocks a live customer order and ignores a collected one", () => {
    expect(orderBlocks({ id: "O1", productId: pid, size: "M", customerName: "Thabo", status: "incoming" }, pid, nowMs)).toMatch(/live customer order/);
    expect(orderBlocks({ id: "O2", productId: pid, size: "M", customerName: "Thabo", status: "collected" }, pid, nowMs)).toBe(null);
  });
  it("ignores an order that already carries the one-size sentinel", () => {
    expect(orderBlocks({ id: "O3", productId: pid, size: "_", customerName: "Thabo", status: "incoming" }, pid, nowMs)).toBe(null);
  });
  it("blocks a refill line whose resolution timestamp cannot be read", () => {
    // Fail SAFE: an unreadable stamp cannot prove the 24h undo window closed.
    for (const bad of [undefined, "", "not-a-date", null]) {
      expect(orderBlocks({ id: "R9", productId: pid, size: "M", customerName: "Shop Refill",
        status: "incoming", clothingRefillStatus: "available", clothingRefilledAt: bad }, pid, nowMs))
        .toMatch(/unreadable resolution timestamp|undo window/);
    }
  });
  it("blocks an out_of_stock order — the customer is still owed the item", () => {
    expect(orderBlocks({ id: "O4", productId: pid, size: "M", customerName: "Thabo", status: "out_of_stock" }, pid, nowMs)).toMatch(/live customer order/);
  });
  it("blocks a record that names the product in a shape it cannot read, instead of waving it through", () => {
    // No top-level productId — the nested-line-item shape this gate does not
    // understand. It must fail SAFE.
    const nested = { id: "O5", status: "incoming", items: [{ productId: pid, size: "M", qty: 1 }] };
    expect(orderBlocks(nested, pid, nowMs)).toMatch(/shape this gate does not understand/);
    // …and an unreadable record about a DIFFERENT product is still ignored.
    const other = { id: "O6", status: "incoming", items: [{ productId: "pOther", size: "M" }] };
    expect(orderBlocks(other, pid, nowMs)).toBe(null);
  });
});

describe("the transfer gate reads the real record shape", () => {
  const pid = "pB";
  it("blocks an unreceived transfer carrying the product in a real size", () => {
    // Sizes are KEYS in a transfer, not a "size" field — the shape that made a
    // JSON scan silently never fire.
    const t = { from: "central", to: "marathon-pe", status: "sent", lines: { [pid]: { S: 1 } } };
    expect(transferBlocks(t, pid)).toMatch(/carrying size S/);
  });
  it("ignores a received transfer and one about another product", () => {
    expect(transferBlocks({ status: "received", lines: { [pid]: { M: 2 } } }, pid)).toBe(null);
    expect(transferBlocks({ status: "sent", lines: { pOther: { M: 2 } } }, pid)).toBe(null);
  });
  it("ignores an open transfer that carries the product already one-size", () => {
    expect(transferBlocks({ status: "sent", lines: { [pid]: { _: 3 } } }, pid)).toBe(null);
  });
  it("blocks an unrecognised shape that still names the product", () => {
    expect(transferBlocks({ status: "sent", payload: `something about ${pid}` }, pid)).toMatch(/shape this gate does not understand/);
  });
  it("blocks a `lines` node nested differently — an empty structural read is not a clean bill", () => {
    // These carry `lines`, so an "only when both nodes are absent" fail-safe
    // skipped the mention check and returned "does not block".
    const byLocation = { status: "sent", lines: { "marathon-pe": { [pid]: { M: 2 } } } };
    const nestedSizes = { status: "sent", lines: { [pid]: { sizes: { M: 2 } } } };
    expect(transferBlocks(byLocation, pid)).toMatch(/shape this gate does not understand/);
    expect(transferBlocks(nestedSizes, pid)).toMatch(/shape this gate does not understand/);
    // …and an oddly-nested record about another product is still ignored.
    expect(transferBlocks({ status: "sent", lines: { "marathon-pe": { pOther: { M: 2 } } } }, pid)).toBe(null);
  });
});

describe("the recent-activity gate's input", () => {
  it("takes the LATEST readable stamp, preferring appliedAt", () => {
    const { lastMs, unreadable } = movementRecency({
      a: { productId: "pB", appliedAt: "2026-08-10T09:00:00.000Z" },
      b: { productId: "pB", appliedAt: "2026-08-10T11:00:00.000Z" },
      c: { productId: "pB", ts: "2026-08-10T10:00:00.000Z" },
      d: { productId: "pOther", appliedAt: "2026-08-10T12:00:00.000Z" },
    }, { nowMs: Date.parse("2026-08-10T12:00:00.000Z") });
    expect(lastMs.get("pB")).toBe(Date.parse("2026-08-10T11:00:00.000Z"));
    expect(unreadable.size).toBe(0);
  });

  it("windows the lookback, so old debris cannot gate a product forever", () => {
    // A push id encodes its own creation time, which is how a record with an
    // unusable timestamp field can still be dated. Old debris is ignored;
    // recent debris still blocks.
    // Real ids from the live ledger, decoded against their own createdAt:
    //   -OxNIloqoe_3VnGVZWi4 → 2026-07-12T21:50:07Z (old, outside a 45d window
    //                          measured from the 2026-11 "now" below)
    //   -OzfaJNGf-A9sOcSP2l1 → 2026-08-10T12:15:18Z
    const oldId = "-OxNIloqoe_3VnGVZWi4";
    const freshId = "-OzfaJNGf-A9sOcSP2l1";
    expect(new Date(pushKeyMs(oldId)).toISOString()).toBe("2026-07-12T21:50:07.670Z");
    expect(new Date(pushKeyMs(freshId)).toISOString()).toBe("2026-08-10T12:15:18.545Z");
    const nowMs = Date.parse("2026-08-20T10:00:00.000Z");     // 45d window starts 2026-07-06
    const { unreadable } = movementRecency({
      [oldId]: { productId: "pB", appliedAt: "garbage" },
      [freshId]: { productId: "pB", appliedAt: "garbage" },
    }, { nowMs, windowDays: 20 });                            // window starts 2026-07-31
    expect(unreadable.get("pB")).toEqual([freshId]);          // the old one dropped out
  });

  it("drops readable movements older than the window", () => {
    const nowMs = Date.parse("2026-08-10T10:00:00.000Z");
    const { lastMs } = movementRecency({
      a: { productId: "pB", appliedAt: "2026-01-01T00:00:00.000Z" },   // ~7 months old
    }, { nowMs });
    expect(lastMs.has("pB")).toBe(false);
  });

  it("counts an unreadable stamp instead of letting the product read as quiet", () => {
    // Every stamp unreadable: without the separate count, lastMs would hold
    // nothing for pB and the gate would treat a possibly-active product as idle.
    const { lastMs, unreadable } = movementRecency({
      a: { productId: "pB", appliedAt: "not-a-date" },
      b: { productId: "pB" },                                  // no stamp at all
      c: { productId: "pB", ts: "" },
    }, { nowMs: Date.parse("2026-08-10T12:00:00.000Z") });
    expect(lastMs.has("pB")).toBe(false);
    // Not push ids, so they cannot be dated out of the window — they block.
    expect(unreadable.get("pB")).toEqual(["a", "b", "c"]);
  });

  it("a readable stamp alongside an unreadable one still counts the unreadable one", () => {
    const { lastMs, unreadable } = movementRecency({
      a: { productId: "pB", appliedAt: "2026-08-10T09:00:00.000Z" },
      b: { productId: "pB", appliedAt: "garbage" },
    }, { nowMs: Date.parse("2026-08-10T12:00:00.000Z") });
    expect(lastMs.get("pB")).toBe(Date.parse("2026-08-10T09:00:00.000Z"));
    expect(unreadable.get("pB")).toEqual(["b"]);
  });
});

describe("concurrency — the version guard the Admin SDK does not get from rules", () => {
  it("refuses to overwrite a cell a concurrent writer changed between the read and the write", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    const ids = legIds("pB", "hub2", "M");
    // Another writer touches the cell in the window between this function's
    // read and its write, EVERY time. It RECEIVES a unit rather than selling
    // one, so the cell never starves — the only reason the write can fail is
    // that its computed quantity is stale, which is precisely the guard.
    db.onAfterCellRead(() => {
      const cur = db.raw().stock.hub2.pB.M;
      db.poke("stock/hub2/pB/M", { ...cur, qty: cur.qty + 1, v: cur.v + 1, mv: "concurrent_receive" });
    });
    const r = await applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "M", qty: 5, from: "hub2",
      movementId: ids.out, reason: "collapse",
    }, { nowIso: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("conflict_retries_exhausted");
    // The sale's units are intact — nothing was clobbered, and no ledger entry
    // claims a move that did not happen.
    expect(await db.io.read(`stock_movements/${ids.out}`)).toBe(null);
  });

  it("commits normally once the cell is quiet", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    const ids = legIds("pB", "hub2", "M");
    let fired = 0;
    db.onAfterCellRead(() => {                    // one interfering write, then quiet
      if (fired++) return;
      const cur = db.raw().stock.hub2.pB.M;
      db.poke("stock/hub2/pB/M", { ...cur, qty: cur.qty - 1, v: cur.v + 1, mv: "concurrent_sale" });
    });
    const r = await applyMovementAdmin(db.io, {
      type: "adjustment", productId: "pB", size: "M", qty: 4, from: "hub2",
      movementId: ids.out, reason: "collapse",
    }, { nowIso: NOW });
    expect(r.ok).toBe(true);
    // Computed from the POST-sale quantity (4), not the stale 5 — so the sale
    // survives instead of being erased.
    expect(db.raw().stock.hub2.pB.M.qty).toBe(0);
    const mv = await db.io.read(`stock_movements/${ids.out}`);
    expect(mv.before.hub2).toBe(4);
  });
});
