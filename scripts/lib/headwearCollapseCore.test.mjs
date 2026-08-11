// ─── HEADWEAR ONE-SIZE COLLAPSE — BEHAVIOURAL TESTS ──────────────────────────
// Run: npx vitest run scripts/lib/headwearCollapseCore.test.mjs
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
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  applyMovementAdmin, planStep1, planStep2, planStep3, step2Done, verifyProduct,
  assertDrained, legIds, orderBlocks, transferBlocks, movementRecency, pushKeyMs, isInScope, isUnexpectedSubcategory,
  headwearKind, isExcludedHeadwear, isCapByShelfOnly, isRetiredSize, isRetiredSizeKey,
  invalidTargetRow, policyRowGate, HEADWEAR_KINDS, emptyKindCount,
} from "./headwearCollapseCore.mjs";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  // UNITS per size key, summed across locations — the input the keep-code rule
  // actually ranks on. Assembled exactly as the CLI assembles it.
  const heldUnits = {};
  for (const bySize of Object.values(cellsByLoc)) {
    for (const [k, c] of Object.entries(bySize)) if (c.qty !== 0) heldUnits[k] = (heldUnits[k] || 0) + c.qty;
  }

  const plans = await planStep1(db.io, pid, product.sizes || [], cellsByLoc);
  for (const pl of plans) for (const leg of pl.legs) {
    const r = await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW });
    if (!r.ok) return { ok: false, failedLeg: leg.id, reason: r.reason };
  }
  const idxCodes = {};
  const idx = (await db.io.read("barcodes")) || {};
  for (const [code, rec] of Object.entries(idx)) if (rec.productId === pid) idxCodes[code] = rec;
  const s2 = planStep2(pid, product, idxCodes, heldUnits);
  if (!skipStep2) await db.io.update(s2.updates);
  if (!skipStep3) {
    const targets = (await db.io.read("stock_targets")) || {};
    const rows = {};
    for (const [loc, byPid] of Object.entries(targets)) if (byPid?.[pid]) rows[loc] = byPid[pid];
    const s3 = planStep3(pid, rows, NOW);
    if (Object.keys(s3).length) await db.io.update(s3);
  }
  return { ok: true, keepCode: s2.keepCode, rule: s2.rule, codes: s2.codes,
    droppedCodes: s2.droppedCodes, step2Paths: Object.keys(s2.updates).length };
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

  // ── THE CAP CASES. Every one of these was unreachable on beanies (one size
  // held per product, one barcode each) and fires for real on caps.
  it("THREE sizes at one location sum into a single \"_\" cell", async () => {
    // The live shape: New Era Cleveland Guardians at marathon-pe holds L 2,
    // M 1, S 2, XL 1. On a per-LOCATION id scheme the second, third and fourth
    // IN legs would collide with the first, no-op as idempotent, and 4 of the 6
    // units would be silently dropped while every leg reported ok.
    const db = makeDb(seedProduct({
      sizes: ["S", "M", "L", "XL"],
      barcodes: { S: "00010001", M: "00010002", L: "00010003", XL: "00010004" },
      cells: { "marathon-pe": { S: 2, M: 1, L: 2, XL: 1 } },
    }));
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(6);

    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);

    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(6);
    for (const k of ["S", "M", "L", "XL"]) expect(cells[k].qty).toBe(0);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(6);
    // Four distinct pairs, i.e. eight legs — one pair per size, not one per location.
    expect(Object.keys(db.raw().stock_movements)).toHaveLength(8);
  });

  it("a negative and a positive size at the SAME location net correctly", async () => {
    // Live: New Era 59FIFTY Atlanta Braves fitted cap cream, marathon-pe M −3
    // and S 1. The mirrored pair (for M) and the normal pair (for S) both run
    // against the same "_" cell, and the order they run in must not matter.
    const db = makeDb(seedProduct({
      sizes: ["S", "M"], barcodes: { S: "00020001", M: "00020002" },
      cells: { "marathon-pe": { M: -3, S: 1 } },
    }));
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(-2);

    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);

    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(-2);      // the shortage survives, it is not laundered away
    expect(cells.M.qty).toBe(0);
    expect(cells.S.qty).toBe(0);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(-2);
  });

  it("a negative that exactly cancels a positive leaves \"_\" at zero, not a phantom cell", async () => {
    // Live: New Era 59FIFTY Toronto Blue Jays, marathon-pe L 1 and M −1.
    const db = makeDb(seedProduct({
      sizes: ["M", "L"], barcodes: { M: "00030001", L: "00030002" },
      cells: { "marathon-pe": { L: 1, M: -1 } },
    }));
    await migrate(db, "pB");
    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(0);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(0);
  });

  it("a fitted cap's centimetre sizes merge like any other — the key is not required to be a letter", async () => {
    // Live: "Ny fitted caps" declares ["55"…"63"] and holds 55:1 and 62:1.
    const db = makeDb(seedProduct({
      sizes: ["55", "56", "62"], barcodes: { "55": "00040001", "56": "00040002", "62": "00040003" },
      cells: { "marathon-pe": { "55": 1, "62": 1 } },
    }));
    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);
    const cells = db.raw().stock["marathon-pe"].pB;
    expect(cells._.qty).toBe(2);
    expect(cells["55"].qty).toBe(0);
    expect(cells["62"].qty).toBe(0);
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

  it("a spent movement id no-ops on a second application instead of applying twice", async () => {
    // Since a spent pair is no longer re-planned, this guard is only reachable
    // by calling the movement layer directly — which is exactly what two
    // overlapping processes would do. It is the last line of defence behind the
    // run lock, so it needs its own test rather than riding on the planner.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    const mv = { type: "adjustment", productId: "pB", size: "_", qty: 6, to: "hub2",
      movementId: "onesize_pB_hub2_in_us_M", reason: "receive from size M" };
    const first = await applyMovementAdmin(db.io, mv, { nowIso: NOW });
    expect(first).toMatchObject({ ok: true, newQty: 6 });
    expect(first.idempotent).toBeUndefined();

    const second = await applyMovementAdmin(db.io, mv, { nowIso: NOW });
    expect(second).toMatchObject({ ok: true, idempotent: true });
    // A POSITIVE leg has no floor to refuse it, so without the guard this cell
    // would hold 12 with a single ledger record claiming 6.
    expect(db.raw().stock.hub2.pB._.qty).toBe(6);
    expect(Object.keys(db.raw().stock_movements)).toHaveLength(1);
  });

  it("a spent MIRRORED pair is not re-planned either — only its missing leg is", async () => {
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" }, cells: { "marathon-pe": { S: -1 } } }));
    const ids = legIds("pB", "marathon-pe", "S");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "_", qty: 1, from: "marathon-pe",
      movementId: ids.negOut, allowNegative: true, reason: "carry oversell" }, { nowIso: NOW });
    // The source cell is STILL −1 (its closing leg has not run), so the naive
    // read of the cell would plan the whole mirrored pair over again.
    expect(db.raw().stock["marathon-pe"].pB.S.qty).toBe(-1);

    const product = await db.io.read("products/pB");
    const plans = await planStep1(db.io, "pB", product.sizes, { "marathon-pe": await db.io.read("stock/marathon-pe/pB") });
    expect(plans.map((p) => p.kind)).toEqual(["resume-neg-in"]);
    expect(plans[0].legs.map((l) => l.id)).toEqual([ids.negIn]);
  });

  it("a mirrored pair whose cell was SETTLED in the gap is still owed its closing leg", async () => {
    // CONSERVATION IS THE TEST, NOT THE CELL'S CURRENT VALUE. The mirrored pair
    // is net-zero: negOut debits "_" by n, negIn credits the sized cell by n.
    // Half-applied, the books read n LOW. A receive landing in the gap adds a
    // REAL unit, so the correct total rises with it — it does not settle the
    // debt negOut created.
    //
    //   S −1, "_" 5            total 4   (books correct)
    //   negOut                 total 3   (books 1 LOW — negIn is owed)
    //   receive 1 into S       total 4   (correct answer is now 5)
    //   resume negIn → S 1     total 5   ✓
    //
    // Refusing the resume here — which an earlier attempt did, calling it a
    // mint — leaves the network permanently short by the n that negOut removed,
    // and every re-run repeats the refusal because the cell never returns to −n.
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" },
      cells: { "marathon-pe": { S: -1, _: 5 } } }));
    const ids = legIds("pB", "marathon-pe", "S");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "_", qty: 1, from: "marathon-pe",
      movementId: ids.negOut, allowNegative: true, reason: "carry oversell" }, { nowIso: NOW });
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(3);       // 1 low, as expected
    db.poke("stock/marathon-pe/pB/S", { qty: 0, v: 9, mv: "receive", lastType: "received" });
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(4);       // the real receive

    const product = await db.io.read("products/pB");
    const plans = await planStep1(db.io, "pB", product.sizes, { "marathon-pe": await db.io.read("stock/marathon-pe/pB") });
    expect(plans.map((p) => p.kind)).toEqual(["resume-neg-in"]);
    expect(plans[0].legs[0].movement.qty).toBe(1);                // the LEDGER's quantity

    for (const pl of plans) for (const leg of pl.legs) {
      await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW });
    }
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(5);       // books healed
    expect(db.raw().stock["marathon-pe"].pB.S.qty).toBe(1);
    // The unit now sits in a size about to be retired, so identity must NOT
    // collapse until it is moved — which is assertDrained's job, not the
    // planner's.
    expect(await assertDrained(db.io, "pB")).toEqual(["marathon-pe/S=1"]);
  });

  it("a pending mirror resume defers this cell's positive balance to the next run", async () => {
    // With a mirror resume outstanding, the cell's positive quantity was read
    // BEFORE that resume applies, so planning a pair from it would use a number
    // about to change — and would execute legs against a cell whose sibling leg
    // is mid-flight. The resume lands alone, assertDrained refuses the collapse,
    // and the next run plans the remainder at its true value.
    const db = makeDb(seedProduct({ sizes: ["S"], barcodes: { S: "00033333" },
      cells: { "marathon-pe": { S: -1, _: 5 } } }));
    const ids = legIds("pB", "marathon-pe", "S");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "_", qty: 1, from: "marathon-pe",
      movementId: ids.negOut, allowNegative: true, reason: "carry oversell" }, { nowIso: NOW });
    db.poke("stock/marathon-pe/pB/S", { qty: 3, v: 9, mv: "big_receive", lastType: "received" });

    const product = await db.io.read("products/pB");
    const plans = await planStep1(db.io, "pB", product.sizes, { "marathon-pe": await db.io.read("stock/marathon-pe/pB") });
    expect(plans.map((p) => p.kind)).toEqual(["resume-neg-in"]);   // NOT also a positive pair
    for (const pl of plans) for (const leg of pl.legs) {
      await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW });
    }
    expect(db.raw().stock["marathon-pe"].pB.S.qty).toBe(4);
    expect(totalAt(db.raw(), "marathon-pe", "pB")).toBe(8);        // 4 + 4 received, books healed

    // The NEXT run plans the whole remaining balance, at its true value.
    const plans2 = await planStep1(db.io, "pB", product.sizes, { "marathon-pe": await db.io.read("stock/marathon-pe/pB") });
    expect(plans2.map((p) => p.kind)).toEqual(["positive"]);
    expect(plans2[0].qty).toBe(4);
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

  // ── THE CELL MOVED WHILE THE PAIR WAS HALF-APPLIED ────────────────────────
  // Both independent reviews of PR #345 reproduced these two. The resume lookup
  // used to live ONLY in the `q === 0` branch, on the assumption that a
  // half-applied pair always leaves its source cell at zero. It does — until
  // something else touches it, and the cell is still a DECLARED size, so a till
  // or a receive is entitled to.
  it("OUT landed, then the cell was OVERSOLD: the owed units are still credited, not lost", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    const ids = legIds("pB", "hub2", "M");
    // Run 1: the OUT lands, the process dies before the IN.
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "M", qty: 5, from: "hub2",
      movementId: ids.out, reason: "collapse" }, { nowIso: NOW });
    expect(db.raw().stock.hub2.pB.M.qty).toBe(0);
    // A till oversells M — legitimately, it is still a declared size.
    db.poke("stock/hub2/pB/M", { qty: -1, v: 9, mv: "till_oversell", lastType: "sold" });

    // Resume. The old code saw q < 0, planned ONLY the mirrored pair, never
    // planned ids.in, closed M at 0 and let Step 2 collapse — five units gone
    // with assertDrained and verifyProduct both green.
    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);
    const cells = db.raw().stock.hub2.pB;
    expect(cells._.qty).toBe(4);        // 5 owed, less the 1 oversold
    expect(cells.M.qty).toBe(0);
    expect(totalAt(db.raw(), "hub2", "pB")).toBe(4);
    // The IN leg really did run, at the LEDGER's quantity, not the cell's.
    expect((await db.io.read(`stock_movements/${ids.in}`)).qty).toBe(5);
  });

  it("OUT landed, then stock was RECEIVED into the same size: nothing is minted and the new stock is reported, not silently swallowed", async () => {
    const db = makeDb(seedProduct({ cells: { hub2: { M: 5 } } }));
    const ids = legIds("pB", "hub2", "M");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "M", qty: 5, from: "hub2",
      movementId: ids.out, reason: "collapse" }, { nowIso: NOW });
    // A warehouse receive puts 2 into M — still a declared size.
    db.poke("stock/hub2/pB/M", { qty: 2, v: 9, mv: "warehouse_receive", lastType: "received" });

    const product = await db.io.read("products/pB");
    const plans = await planStep1(db.io, "pB", product.sizes, { hub2: await db.io.read("stock/hub2/pB") });
    // The owed 5 is completed from the ledger…
    const resume = plans.find((p) => p.kind === "resume-in");
    expect(resume.qty).toBe(5);
    // …and the 2 that arrived later is NOT planned under the spent ids (which
    // would have no-opped the OUT and applied the IN at the wrong quantity).
    const stranded = plans.find((p) => p.kind === "stranded");
    expect(stranded.qty).toBe(2);
    expect(stranded.legs).toHaveLength(0);
    expect(stranded.note).toMatch(/already spent/);

    for (const pl of plans) for (const leg of pl.legs) {
      await applyMovementAdmin(db.io, { ...leg.movement, ts: NOW }, { nowIso: NOW });
    }
    const cells = db.raw().stock.hub2.pB;
    expect(cells._.qty).toBe(5);          // the owed units, exactly — nothing minted
    expect(cells.M.qty).toBe(2);          // the new stock, untouched
    expect(totalAt(db.raw(), "hub2", "pB")).toBe(7);
    // And identity must NOT collapse while those 2 units sit in a doomed size.
    expect(await assertDrained(db.io, "pB")).toEqual(["hub2/M=2"]);
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
    // The exact sequence: Step 1 lands in FULL, the operator stops (a state the
    // header calls safe, and it is — the product still declares M). A normal
    // warehouse receive then puts units into M.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 6 } } }));
    await migrate(db, "pB", { skipStep2: true, skipStep3: true });
    expect(db.raw().stock.hub2.pB.M.qty).toBe(0);
    expect(db.raw().stock.hub2.pB._.qty).toBe(6);

    db.poke("stock/hub2/pB/M", { qty: 2, v: 5, mv: "warehouse_receive", lastType: "received" });

    // Resume. Both ids are spent, so the pair is NOT re-planned — it is reported
    // as stranded and moves nothing at all. (It used to be re-planned and each
    // leg no-opped, which was harmless here but is the same code path that lost
    // units when only ONE of the two ids was spent.)
    const product = await db.io.read("products/pB");
    const cellsByLoc = { hub2: await db.io.read("stock/hub2/pB") };
    const plans = await planStep1(db.io, "pB", product.sizes, cellsByLoc);
    expect(plans.flatMap((p) => p.legs)).toHaveLength(0);
    expect(plans.map((p) => p.kind)).toEqual(["stranded"]);
    expect(db.raw().stock.hub2.pB._.qty).toBe(6);      // untouched

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
    const s2 = planStep2("pB", product, { "00011111": { productId: "pB", size: "M" } }, { M: 2 });
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
    const s2 = planStep2("pB", product, { "00011111": { productId: "pB", size: "M" } }, { M: 2 });
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
    expect(r.rule).toMatch(/most-stocked size/);
    expect(db.raw().products.pB.barcodes).toEqual({ _: "00060000" });
  });

  // ── THE KEEP-CODE RULE. Trivial on beanies (one code each), a real decision
  // on the 87 caps that carry several.
  it("every code of a SIX-code cap still resolves to it after the collapse", async () => {
    // Live shape: New Era Atlanta Braves fitted cap cream carries these six
    // per-size codes (it also has a later one-size code, deliberately left out
    // here so this exercises the most-stocked-size branch rather than the
    // existing-"_"-slot branch, which its own test covers). Losing a map slot
    // must not mean losing a scan — a former-M label and a former-L label must
    // both still ring up.
    const barcodes = { S: "00014441", M: "00014442", L: "00014443", XL: "00014444", XXL: "00014445", XXXL: "00014446" };
    const db = makeDb(seedProduct({ sizes: ["S", "M", "L", "XL", "XXL", "XXXL"], barcodes,
      cells: { "marathon-pe": { M: 3, S: 1 } } }));
    const r = await migrate(db, "pB");

    const raw = db.raw();
    expect(Object.keys(raw.products.pB.barcodes)).toEqual(["_"]);   // one slot, as a one-size product must have
    for (const code of Object.values(barcodes)) {
      // THE SCAN TEST: the reverse index still points at this product, at a size
      // the product declares. That is the whole of what resolution needs.
      expect(raw.barcodes[code].productId).toBe("pB");
      expect(raw.barcodes[code].size).toBe("_");
      expect(raw.products.pB.sizes).toContain(raw.barcodes[code].size);
    }
    // Exactly one keeps the slot; the other five are reported, not deleted.
    expect(r.droppedCodes).toHaveLength(5);
    expect([...r.droppedCodes, r.keepCode].sort()).toEqual(Object.values(barcodes).sort());
    for (const code of r.droppedCodes) expect(raw.barcodes[code]).toBeTruthy();
  });

  it("never CREATES an index record for a code the index does not have", async () => {
    // A code in the product's map with no /barcodes record: writing
    // `barcodes/{code}/size = "_"` would not rewrite a record, it would MINT
    // one holding a size and no productId — junk that resolves to nothing and
    // that the live rule (hasChildren(['productId'])) would reject if the Admin
    // SDK enforced rules rather than bypassing them.
    const product = { name: "Test cap", sizes: ["S", "M"], barcodes: { S: "00099001", M: "00099002" } };
    // BOTH shapes a real caller produces for "no record": the key absent, and
    // the key PRESENT with a null value (the census builds exactly the latter,
    // `indexCodes[code] = barcodesIdx[code] ?? null`).
    for (const indexCodes of [
      { "00099001": { productId: "pB", size: "S" } },
      { "00099001": { productId: "pB", size: "S" }, "00099002": null },
    ]) {
      const s2x = planStep2("pB", product, indexCodes, { S: 1, M: 4 });
      expect(s2x.unindexedCodes).toEqual(["00099002"]);
      expect(Object.keys(s2x.updates)).not.toContain("barcodes/00099002/size");
    }
    const indexCodes = { "00099001": { productId: "pB", size: "S" } };
    const s2 = planStep2("pB", product, indexCodes, { S: 1, M: 4 });

    expect(s2.unindexedCodes).toEqual(["00099002"]);
    expect(Object.keys(s2.updates)).not.toContain("barcodes/00099002/size");
    expect(Object.keys(s2.updates)).toContain("barcodes/00099001/size");
    // The keep-code rule still ran on the full picture, so the report is honest
    // about which code it would have kept.
    expect(s2.keepCode).toBe("00099002");
  });

  it("the most-stocked size wins the slot, counting units across ALL locations", async () => {
    // L leads at one location, M leads overall. The rule ranks on the network
    // total, so a per-location reading would pick the wrong code.
    const db = makeDb(seedProduct({ sizes: ["S", "M", "L"], barcodes: { S: "00050001", M: "00050002", L: "00050003" },
      cells: { "marathon-pe": { S: 1, L: 4 }, hub2: { M: 6 }, central: { M: 2 } } }));
    const r = await migrate(db, "pB");
    expect(r.keepCode).toBe("00050002");                 // M: 8 units beats L: 4
    expect(r.rule).toMatch(/size M, the most-stocked size \(8 units on hand\)/);
  });

  it("is deterministic — the answer does not depend on map order, and ties break the same way twice", async () => {
    const mk = (barcodes) => makeDb(seedProduct({ sizes: ["S", "M", "L"], barcodes, cells: { hub2: { M: 2, L: 2 } } }));
    // Same product, barcodes map enumerated in two different orders. RTDB gives
    // no order guarantee, so a rule that read "the first stock-holding size"
    // could return either code on different runs.
    const a = await migrate(mk({ S: "00060001", M: "00060002", L: "00060003" }), "pB");
    const b = await migrate(mk({ L: "00060003", M: "00060002", S: "00060001" }), "pB");
    expect(a.keepCode).toBe(b.keepCode);
    // M and L are tied at 2 units, so the size key breaks it: "L" < "M".
    expect(a.keepCode).toBe("00060003");
    expect(a.rule).toMatch(/size L, the most-stocked size \(2 units on hand\)/);
  });

  it("an existing \"_\" slot keeps the slot, whatever the stock says", async () => {
    // 21 live caps are already one-size but still carry their old per-size
    // codes in the index. Their "_" code is the one on every recent label, and
    // re-pointing the slot at an older per-size code would be a regression.
    const db = makeDb(seedProduct({ sizes: ["M"], barcodes: { M: "00070001", _: "00070009" },
      cells: { hub2: { M: 40 } } }));
    const r = await migrate(db, "pB");
    expect(r.keepCode).toBe("00070009");
    expect(r.rule).toMatch(/existing "_" slot/);
    expect(db.raw().products.pB.barcodes).toEqual({ _: "00070009" });
    expect(db.raw().barcodes["00070001"].productId).toBe("pB");   // still resolves
  });

  it("a cap with no stock anywhere falls back to declared order, and still yields exactly one code", async () => {
    // 42 live caps hold nothing at all, so there is no "most-stocked size" to
    // rank. The fallback must still be total and deterministic.
    const db = makeDb(seedProduct({ sizes: ["S", "M", "L"], barcodes: { S: "00080001", M: "00080002", L: "00080003" },
      cells: {} }));
    const r = await migrate(db, "pB");
    expect(r.keepCode).toBe("00080001");                 // first DECLARED size, i.e. S
    expect(r.rule).toMatch(/declared size S \(no stock on hand anywhere\)/);
    expect(Object.keys(db.raw().products.pB.barcodes)).toEqual(["_"]);
  });

  it("a size holding zero or a negative never wins the slot", async () => {
    // A negative cell is an oversell signal, not stock, and there are no labels
    // on shelves for it. M is at −3 and S at 1; S must take the slot.
    const db = makeDb(seedProduct({ sizes: ["S", "M"], barcodes: { S: "00090001", M: "00090002" },
      cells: { "marathon-pe": { M: -3, S: 1 } } }));
    const r = await migrate(db, "pB");
    expect(r.keepCode).toBe("00090001");
    expect(r.rule).toMatch(/size S, the most-stocked size \(1 unit on hand\)/);
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

  it("the movement records the CATALOGUE size, not the encoded cell key", async () => {
    // The cell key for a half size is "5_5"; the catalogue size is "5.5". The
    // old code recorded the KEY in the ledger, so a movement said it moved
    // "5_5" — arithmetic right, ledger disagreeing with the catalogue about
    // what was moved. No headwear size does this today, which is exactly why it
    // needs a test rather than an assertion that can never fire.
    const db = makeDb(seedProduct({ sizes: ["5.5", "M"], barcodes: { "5_5": "00044001", M: "00044002" },
      cells: { hub2: { "5_5": 2 } } }));
    await migrate(db, "pB");
    const raw = db.raw();
    const out = Object.values(raw.stock_movements).find((m) => m.from === "hub2");
    expect(out.size).toBe("5.5");                       // the catalogue form
    expect(Object.keys(raw.stock.hub2.pB)).toContain("5_5");   // the storage form
    expect(raw.stock.hub2.pB._.qty).toBe(2);
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

// ── ONE PREDICATE, STRUCTURALLY — the census, the migration, the probe and the
// policy model must be UNABLE to disagree about who is in scope ──────────────
// The behavioural tests above prove what the rule decides. These prove that
// every consumer asks the same rule, which is the property that actually failed
// in the field: PR #345's scope decision lived in one place, but the moment a
// second file restates a name pattern the two answer different questions and
// nothing fails until a live run collapses the wrong product. The check is on
// the SOURCE, because that is where the duplication would appear.
describe("the scope rule cannot be restated anywhere else", () => {
  const CONSUMERS = [
    "headwear-census.mjs",
    "collapse-one-size-headwear.mjs",
    "headwear-preflight-probe.mjs",
    "model-headwear-onesize-policy.mjs",
    "apply-headwear-policy.mjs",
    "headwear-excluded-report.mjs",
  ];
  const src = (f) => readFileSync(join(SCRIPTS_DIR, f), "utf8");

  it("every consumer imports its scope decision from the shared core", () => {
    for (const f of CONSUMERS) {
      const text = src(f);
      expect(text, `${f} must import from the shared core`).toMatch(/from "\.\/lib\/headwearCollapseCore\.mjs"/);
      // …and it must actually take a scope decision from there, not merely
      // import some unrelated helper out of the same module.
      expect(text, `${f} must take its scope decision from the core`)
        .toMatch(/\b(isInScope|headwearKind|isExcludedHeadwear|policyRowGate)\b/);
    }
  });

  it("the core is the ONLY file under scripts/ holding a headwear name pattern", () => {
    // A second copy of /beanie/i or /bucket\s*hats?/i anywhere else is the exact
    // shape of the drift this suite exists to prevent: this widening changed one
    // pattern, and any duplicate would have kept answering the old question.
    // The classifiers are exported for reporting precisely so no copy is needed.
    // Regex-literal-shaped spans only, and only those naming a HEADWEAR word.
    // Bare "bucket" is deliberately not enough — `storageBucket` is all over
    // this repo and a check that trips on it would be turned off within a week.
    // "bucket" must be followed by "hat" inside the same literal, as it is in
    // the real pattern (`\bbucket\s*hats?\b`).
    const RE_LITERAL = /\/(?:[^\n/\\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[a-z]*/g;
    const HEADWEAR_WORD = /beanie|bucket[^a-z]{0,8}hat|visor/i;
    // The mutation harness is the one exemption, and for the opposite reason to
    // a loophole: its entire job is to quote the core's source text verbatim so
    // it can reintroduce each bug. Every pattern in it is a QUOTATION of the
    // core, never a second decision — nothing in that file is ever imported or
    // run against live data.
    const QUOTES_THE_CORE = "mutation-proof-headwear-collapse.mjs";
    const offenders = [];
    for (const f of readdirSync(SCRIPTS_DIR).filter((n) => n.endsWith(".mjs") && n !== QUOTES_THE_CORE)) {
      const body = readFileSync(join(SCRIPTS_DIR, f), "utf8")
        // Comments quote the patterns constantly, and prose is not a decision.
        .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      if ((body.match(RE_LITERAL) || []).some((lit) => HEADWEAR_WORD.test(lit))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("the shared kind list is what the CLI validates --kind against", () => {
    // A hand-written `KIND !== "beanie" && KIND !== "cap"` check makes a newly
    // added kind unrunnable while the scope rule happily admits it — the
    // operator sees the products in the census and cannot pass them to the CLI.
    const text = src("collapse-one-size-headwear.mjs");
    expect(text).toMatch(/HEADWEAR_KINDS\.includes\(KIND\)/);
    expect(text).not.toMatch(/KIND !== "beanie"/);
  });

  it("no consumer builds a per-kind counter from a hardcoded literal", () => {
    // `{ beanie: 0, cap: 0 }` yields `undefined++` → NaN the moment a third kind
    // appears, and NaN in a summary line is a silent wrong number, not a crash.
    for (const f of CONSUMERS) {
      expect(src(f), `${f} must build its kind counter from the shared list`)
        .not.toMatch(/\{\s*beanie:\s*0\s*,\s*cap:\s*0\s*\}/);
    }
  });
});

describe("the scope decision writes nothing", () => {
  it("deciding scope over a whole catalogue touches no cell and no target row", async () => {
    // Widening scope must not be able to move stock or arm the refill engine as
    // a side effect. The predicates are pure functions, and this pins that:
    // every scope/reporting entry point is called over a catalogue that includes
    // the newly admitted bucket hats, against a db that records every write.
    const seed = seedProduct({ pid: "pB", cells: { hub2: { M: 5 } } });
    seed.products.pBucket = { name: "Nike bucket hat green", productType: "clothing", subcategory: "Caps & Hats", sizes: ["M"], barcodes: { M: "00088882" } };
    seed.barcodes["00088882"] = { productId: "pBucket", size: "M" };
    seed.stock.hub2.pBucket = { M: cell(7) };
    seed.stock_targets = { hub2: { pBucket: { M: { target: 3, minQty: 1 } } } };
    const db = makeDb(seed);
    const before = JSON.stringify(db.raw());

    for (const p of Object.values(db.raw().products)) {
      headwearKind(p); isInScope(p); isExcludedHeadwear(p); isCapByShelfOnly(p); isUnexpectedSubcategory(p);
      policyRowGate(p); policyRowGate(p, { remove: true });
    }
    emptyKindCount();
    expect(JSON.stringify(db.raw())).toBe(before);
    expect(db.stats.updates).toBe(0);
  });

  it("a newly in-scope bucket hat's own plans write no cell outside its product and no NEW target row", async () => {
    // planStep2 is the identity update and planStep3 the target retirement —
    // the two things a widening could plausibly leak into. Step 2 must name only
    // this product's identity and index; Step 3 must write nothing at all for a
    // product that has no explicit target row to retire.
    const product = { name: "Nike bucket hat green", subcategory: "Caps & Hats", sizes: ["M"], barcodes: { M: "00088882" } };
    const s2 = planStep2("pBucket", product, { "00088882": { productId: "pBucket", size: "M" } }, { M: 7 });
    expect(Object.keys(s2.updates).sort()).toEqual([
      "barcodes/00088882/size", "products/pBucket/barcodes", "products/pBucket/sizes",
    ]);
    expect(Object.keys(s2.updates).some((p) => p.startsWith("stock/") || p.startsWith("stock_targets/"))).toBe(false);
    expect(planStep3("pBucket", {}, NOW)).toEqual({});
    // …and where a row DOES exist, Step 3 retires it rather than arming one:
    // target 0 is the engine's own word for "deliberately excluded".
    const s3 = planStep3("pBucket", { hub2: { M: { target: 3, minQty: 1 } } }, NOW);
    expect(Object.values(s3).every((r) => r.target === 0 && r.minQty === 0)).toBe(true);
  });
});

describe("scope — beanies, caps and bucket hats are in; visors are not", () => {
  const CH = "Caps & Hats";

  it("takes beanies by name, caps by the shelf, and bucket hats by BOTH", () => {
    expect(headwearKind({ name: "Nike beanie green", subcategory: CH })).toBe("beanie");
    expect(headwearKind({ name: "NIKE BEANIE GREEN" })).toBe("beanie");           // case-insensitive, shelf-independent
    expect(headwearKind({ name: "Nike cap black", subcategory: CH })).toBe("cap");
    // The 24 live caps whose name carries no headwear word at all. A /cap/i rule
    // would have left every one of these sized while its siblings collapsed.
    expect(headwearKind({ name: "Armani exchange mustard", subcategory: CH })).toBe("cap");
    expect(headwearKind({ name: "New Era Atlanta Braves 59FIFTY fitted Black", subcategory: CH })).toBe("cap");
    expect(headwearKind({ name: "Nike Dri-FIT Fly Maroon", subcategory: CH })).toBe("cap");
    // …and one whose name says "cap" but with no word boundary after it, which
    // is exactly why the shelf decides and the name only reports.
    expect(headwearKind({ name: "New Era 59FIFTY Detroit Tigers capBlack", subcategory: CH })).toBe("cap");
  });

  // ── THE WIDENING (2026-08-11) ──────────────────────────────────────────────
  it("admits a bucket hat on the shelf, as its OWN kind — not folded into caps", () => {
    for (const name of [
      "Air Jordan bucket hat blue",
      "Nike x Clemson tigers bucket hat red",
      "Nike bucket hat green",
      "Lacoste bucket hat khaki",
      "NIKE BUCKET HATS PINK CAMO",     // case and plural
      "Kangol bucket  hat beige",       // the space in "bucket hat" is optional/repeatable
      "Adidas buckethat black",         // …including absent entirely
    ]) {
      const p = { name, subcategory: CH };
      expect(headwearKind(p)).toBe("bucket");
      expect(isInScope(p)).toBe(true);
      // In scope means NOT in the excluded list — the two must partition, never
      // overlap, or the census would print the same record under both headings.
      expect(isExcludedHeadwear(p)).toBe(false);
    }
  });

  it("keeps a bucket hat OFF the Caps & Hats shelf out, and still reports it", () => {
    // The owner's constraint on this widening was that nothing outside the shelf
    // may be pulled in. A bucket hat filed elsewhere is therefore NOT admitted —
    // unlike a beanie, whose name alone decides wherever it is filed. It is
    // still named as an exclusion so it cannot fall between the two lists.
    for (const sub of ["Clothing — Uncategorized", "Accessories", undefined]) {
      const p = { name: "Air Jordan bucket hat blue", subcategory: sub };
      expect(headwearKind(p)).toBe(null);
      expect(isInScope(p)).toBe(false);
      expect(isExcludedHeadwear(p)).toBe(true);
    }
  });

  it("still rejects every visor — on the shelf and off it", () => {
    for (const sub of [CH, "Clothing — Uncategorized"]) {
      for (const name of ["Alo Yoga Airlift Solar Visor White", "Alo yoga airlift solar visor black", "NIKE VISORS"]) {
        const p = { name, subcategory: sub };
        expect(headwearKind(p)).toBe(null);
        expect(isInScope(p)).toBe(false);
        expect(isExcludedHeadwear(p)).toBe(true);
      }
    }
    // A pathological name carrying both words is read as the visor — the
    // conservative side, since the visor is the thing not authorised.
    const both = { name: "Nike visor bucket hat hybrid", subcategory: CH };
    expect(headwearKind(both)).toBe(null);
    expect(isExcludedHeadwear(both)).toBe(true);
  });

  it("admits NOTHING that is not on the Caps & Hats shelf, except a beanie by name", () => {
    // The widening's stop condition, stated as a sweep rather than as a claim:
    // over a catalogue of every off-shelf shape this migration could plausibly
    // meet, the ONLY thing admitted is a beanie.
    const offShelf = [
      { name: "Nike Air Max 90", subcategory: "Footwear" },
      { name: "Nike bucket hat green", subcategory: "Footwear" },
      { name: "Alo Yoga Airlift Solar Visor Pink", subcategory: "Clothing — Uncategorized" },
      { name: "Nike cap black", subcategory: "Clothing — Uncategorized" },
      { name: "Armani exchange mustard", subcategory: "Clothing — Uncategorized" },
      { name: "Gucci bucket bag", subcategory: "Bags" },              // "bucket", no hat
      { name: "Nike hat rack", subcategory: "Accessories" },          // "hat", no bucket
      { name: "Ralph Lauren polo shirt", subcategory: "Clothing — Tops" },
      { name: "Casio watch", subcategory: "Watches" },
      { name: "", subcategory: "Footwear" },
      { name: "Nike beanie grey", subcategory: "Accessories" },       // the one exception
    ];
    const admitted = offShelf.filter(isInScope).map((p) => p.name);
    expect(admitted).toEqual(["Nike beanie grey"]);
    expect(headwearKind(offShelf.at(-1))).toBe("beanie");
  });

  it("admits from the shelf ONLY beanies, caps and bucket hats — never a visor", () => {
    const shelf = [
      { name: "Nike beanie green", subcategory: CH },
      { name: "Nike cap black", subcategory: CH },
      { name: "Armani exchange mustard", subcategory: CH },
      { name: "Air Jordan bucket hat blue", subcategory: CH },
      { name: "Alo Yoga Airlift Solar Visor White", subcategory: CH },
    ];
    expect(shelf.map(headwearKind)).toEqual(["beanie", "cap", "cap", "bucket", null]);
    // …and the one rejected shelf-mate is the visor, accounted for as excluded.
    expect(shelf.filter((p) => !isInScope(p)).map((p) => isExcludedHeadwear(p))).toEqual([true]);
  });

  it("scope and exclusion PARTITION every headwear-named record — no overlap, no gap", () => {
    // The two lists are the census's entire account of the Caps & Hats shelf. A
    // record in both is printed twice; a record in neither vanishes from the
    // report altogether, which is how the mis-filed visor was once lost.
    const catalogue = [
      { name: "Nike beanie green", subcategory: CH },
      { name: "Nike beanie green", subcategory: "Accessories" },
      { name: "Nike cap black", subcategory: CH },
      { name: "Air Jordan bucket hat blue", subcategory: CH },
      { name: "Air Jordan bucket hat blue", subcategory: "Accessories" },
      { name: "Alo Yoga Airlift Solar Visor White", subcategory: CH },
      { name: "Alo yoga airlift solar visor black", subcategory: "Clothing — Uncategorized" },
    ];
    for (const p of catalogue) {
      expect(isInScope(p) && isExcludedHeadwear(p)).toBe(false);        // no overlap
      expect(isInScope(p) || isExcludedHeadwear(p)).toBe(true);         // no gap
    }
  });

  it("rejects everything off the shelf that is not beanie-named, and every merge stub", () => {
    // Off the shelf and not beanie-named → not headwear, whatever it is called.
    expect(headwearKind({ name: "Nike cap black", subcategory: "Clothing — Uncategorized" })).toBe(null);
    // The one live mis-filed visor: out of scope AND still reported as an
    // exclusion, so it cannot fall silently between the two census lists.
    const strayVisor = { name: "Alo yoga airlift solar visor black", subcategory: "Clothing — Uncategorized" };
    expect(headwearKind(strayVisor)).toBe(null);
    expect(isExcludedHeadwear(strayVisor)).toBe(true);
    // …but an ordinary off-shelf product is not dragged into the excluded list.
    expect(isExcludedHeadwear({ name: "Nike Air Max 90", subcategory: "Footwear" })).toBe(false);
    // Merge stubs are redirects with no stock identity — never collapsed in place.
    expect(headwearKind({ name: "Nike beanie green", mergedInto: "pOther" })).toBe(null);
    expect(headwearKind({ name: "Nike cap black", subcategory: CH, mergedInto: "pOther" })).toBe(null);
    expect(headwearKind({ name: "Air Jordan bucket hat blue", subcategory: CH, mergedInto: "pOther" })).toBe(null);
    expect(isExcludedHeadwear({ name: "Air Jordan bucket hat blue", subcategory: CH, mergedInto: "pX" })).toBe(false);
    expect(isExcludedHeadwear({ name: "Alo Yoga Airlift Solar Visor White", subcategory: CH, mergedInto: "pX" })).toBe(false);
  });

  it("separates the caps admitted by the shelf alone, so the census can list them", () => {
    expect(isCapByShelfOnly({ name: "Armani exchange mustard", subcategory: CH })).toBe(true);
    expect(isCapByShelfOnly({ name: "Nike cap black", subcategory: CH })).toBe(false);
    expect(isCapByShelfOnly({ name: "Nike beanie green", subcategory: CH })).toBe(false);
    // A bucket hat's name IS decisive, so it never appears on the "trust the
    // shelf" list a human is asked to eyeball.
    expect(isCapByShelfOnly({ name: "Air Jordan bucket hat blue", subcategory: CH })).toBe(false);
  });

  it("flags a beanie filed outside Caps & Hats, and only an in-scope one", () => {
    // In scope (the name decides) but worth a human's eye — the census exits
    // non-zero on it rather than reading as clean.
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: "Accessories" })).toBe(true);
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: CH })).toBe(false);
    expect(isUnexpectedSubcategory({ name: "Nike cap black", subcategory: "Accessories" })).toBe(false);
    expect(isUnexpectedSubcategory({ name: "Nike beanie green", subcategory: "Accessories", mergedInto: "pX" })).toBe(false);
    // A bucket hat cannot be off-shelf AND in scope, so the flag can never fire
    // on one — it is not a beanie and the shelf is already required.
    expect(isUnexpectedSubcategory({ name: "Air Jordan bucket hat blue", subcategory: "Accessories" })).toBe(false);
  });

  it("every kind the scope rule can return is in the exported kind list", () => {
    // The list is what four separate scripts build their per-kind counters and
    // the CLI builds its --kind validation from. A kind the rule can return but
    // the list omits is an `undefined++` → NaN in every one of those summaries,
    // and a --kind the operator cannot run.
    const samples = [
      { name: "Nike beanie green", subcategory: CH },
      { name: "Nike cap black", subcategory: CH },
      { name: "Air Jordan bucket hat blue", subcategory: CH },
    ];
    const returned = [...new Set(samples.map(headwearKind))];
    expect(returned.every((k) => HEADWEAR_KINDS.includes(k))).toBe(true);
    expect([...HEADWEAR_KINDS].sort()).toEqual([...returned].sort());
    // emptyKindCount is the counter those scripts start from — it must be
    // total over the kind list and start every kind at zero.
    expect(emptyKindCount()).toEqual({ beanie: 0, cap: 0, bucket: 0 });
  });

  it("a visor survives a full headwear run untouched while a bucket hat collapses", async () => {
    const seed = seedProduct({ pid: "pB", cells: { hub2: { M: 5 } } });
    // A real multi-size cap — in scope.
    seed.products.pCap = { name: "Nike cap black", productType: "clothing", subcategory: CH, sizes: ["S", "M", "L"], barcodes: { S: "00077771", M: "00077772", L: "00077773" } };
    seed.barcodes["00077771"] = { productId: "pCap", size: "S" };
    seed.barcodes["00077772"] = { productId: "pCap", size: "M" };
    seed.barcodes["00077773"] = { productId: "pCap", size: "L" };
    seed.stock.hub2.pCap = { S: cell(2), M: cell(3), L: cell(4) };
    // A visor — same shelf, still NOT in scope.
    seed.products.pVisor = { name: "Alo Yoga Airlift Solar Visor White", productType: "clothing", subcategory: CH, sizes: ["M"], barcodes: { M: "00088881" } };
    seed.barcodes["00088881"] = { productId: "pVisor", size: "M" };
    seed.stock.hub2.pVisor = { M: cell(6) };
    // A bucket hat on the shelf — NOW in scope, and it really collapses.
    seed.products.pBucket = { name: "Nike bucket hat green", productType: "clothing", subcategory: CH, sizes: ["M"], barcodes: { M: "00088882" } };
    seed.barcodes["00088882"] = { productId: "pBucket", size: "M" };
    seed.stock.hub2.pBucket = { M: cell(7) };
    // A bucket hat filed OFF the shelf — out, and untouched, exactly like the visor.
    seed.products.pStray = { name: "Kangol bucket hat beige", productType: "clothing", subcategory: "Accessories", sizes: ["M"], barcodes: { M: "00088883" } };
    seed.barcodes["00088883"] = { productId: "pStray", size: "M" };
    seed.stock.hub2.pStray = { M: cell(8) };
    const db = makeDb(seed);

    // THE SCOPE RULE — the same exported predicate the CLI filters with, not a
    // restatement of it.
    const products = db.raw().products;
    const inScope = Object.entries(products).filter(([, p]) => isInScope(p)).map(([pid]) => pid).sort();
    expect(inScope).toEqual(["pB", "pBucket", "pCap"]);

    for (const pid of inScope) await migrate(db, pid);

    const raw = db.raw();
    // All three in-scope products collapsed…
    expect(raw.products.pB.sizes).toEqual(["_"]);
    expect(raw.products.pCap.sizes).toEqual(["_"]);
    expect(raw.stock.hub2.pCap._.qty).toBe(9);
    // …including the bucket hat, whose 7 units moved into the "_" cell.
    expect(raw.products.pBucket.sizes).toEqual(["_"]);
    expect(raw.products.pBucket.barcodes).toEqual({ _: "00088882" });
    expect(raw.barcodes["00088882"]).toEqual({ productId: "pBucket", size: "_" });
    expect(raw.stock.hub2.pBucket._.qty).toBe(7);
    expect(raw.stock.hub2.pBucket.M.qty).toBe(0);
    // …and the two out-of-scope neighbours are byte-identical to how they began.
    expect(raw.products.pVisor).toEqual(seed.products.pVisor);
    expect(raw.products.pStray).toEqual(seed.products.pStray);
    expect(raw.barcodes["00088881"]).toEqual({ productId: "pVisor", size: "M" });
    expect(raw.barcodes["00088883"]).toEqual({ productId: "pStray", size: "M" });
    expect(raw.stock.hub2.pVisor).toEqual({ M: cell(6) });
    expect(raw.stock.hub2.pStray).toEqual({ M: cell(8) });
    expect(raw.stock.hub2.pVisor._).toBeUndefined();
    expect(raw.stock.hub2.pStray._).toBeUndefined();
  });
});

describe("verification of a resumed run", () => {
  it("accepts the credit a resumed pair owes instead of calling it minted stock", async () => {
    // A resume leg is a credit whose DEBIT landed in the interrupted run, so it
    // legitimately raises the location total. Verified against "unchanged", a
    // run that healed the books reports "units lost or minted" and exits 1 —
    // after Step 2 has committed — pointing the operator at a rollback that
    // would genuinely damage data.
    const db = makeDb(seedProduct({ cells: { hub2: { M: 10 } } }));
    const ids = legIds("pB", "hub2", "M");
    await applyMovementAdmin(db.io, { type: "adjustment", productId: "pB", size: "M", qty: 10, from: "hub2",
      movementId: ids.out, reason: "collapse" }, { nowIso: NOW });
    const totalsBefore = { hub2: totalAt(db.raw(), "hub2", "pB") };
    expect(totalsBefore.hub2).toBe(0);                     // the interrupted state

    const r = await migrate(db, "pB");
    expect(r.ok).toBe(true);
    expect(db.raw().stock.hub2.pB._.qty).toBe(10);

    // Without the expected delta this reads as 10 units minted.
    const naive = await verifyProduct(db.io, "pB", r.keepCode, r.codes, totalsBefore);
    expect(naive.join(" ")).toMatch(/units lost or minted/);
    // With it, the run verifies clean.
    const withDelta = await verifyProduct(db.io, "pB", r.keepCode, r.codes, totalsBefore, { hub2: 10 });
    expect(withDelta).toEqual([]);
  });
});

describe("the policy-row decisions", () => {
  const collapsedCap = { name: "Nike cap black", subcategory: "Caps & Hats", sizes: ["_"] };

  it("requires target AND minQty as numbers, matching the live rule", () => {
    expect(invalidTargetRow({ target: 5, minQty: 3 })).toBe(null);
    // The live rule is hasChildren(['target','minQty']) with both numeric. The
    // policy statement never mentions minQty, so a row without it would have
    // been written by the Admin SDK and then bounced any client write.
    expect(invalidTargetRow({ target: 5 })).toMatch(/minQty/);
    expect(invalidTargetRow({ minQty: 3 })).toMatch(/target/);
    expect(invalidTargetRow({ target: "5", minQty: 3 })).toMatch(/target/);
    expect(invalidTargetRow({ target: 5, minQty: -1 })).toMatch(/negative/);
    expect(invalidTargetRow(null)).toMatch(/not an object/);
  });

  it("accepts an ABSENT reorderPoint but refuses a null one", () => {
    // Absent is the hub's intended setting and must stay expressible.
    expect(invalidTargetRow({ target: 15, minQty: 8 })).toBe(null);
    expect(invalidTargetRow({ target: 5, minQty: 3, reorderPoint: 0 })).toBe(null);
    // null is refused because RTDB DELETES a null child: the row would be
    // written correctly (no reorderPoint) but read back as absent, and a verify
    // comparing null to undefined would report a false failure.
    expect(invalidTargetRow({ target: 15, minQty: 8, reorderPoint: null })).toMatch(/omit the key/);
    // Anything the engine would silently ignore is refused rather than written.
    expect(invalidTargetRow({ target: 15, minQty: 8, reorderPoint: -1 })).toMatch(/omit the key/);
    expect(invalidTargetRow({ target: 15, minQty: 8, reorderPoint: "0" })).toMatch(/omit the key/);
  });

  it("arming demands scope AND a collapsed product", () => {
    expect(policyRowGate(collapsedCap)).toEqual({ ok: true });
    expect(policyRowGate({ ...collapsedCap, sizes: ["S", "M"] })).toMatchObject({ ok: false, reason: "not-collapsed" });
    expect(policyRowGate({ name: "Alo Yoga Airlift Solar Visor White", subcategory: "Caps & Hats", sizes: ["_"] }))
      .toMatchObject({ ok: false, reason: "not-headwear" });
    expect(policyRowGate(undefined)).toMatchObject({ ok: false, reason: "missing" });
  });

  it("REMOVING is always possible — the off switch cannot depend on current scope", () => {
    // The policy's only off switch is deleting the rows (an explicit row
    // outlives the ruleBasedTargets kill switch since #342). A product merged
    // or renamed AFTER arming fails isInScope while its rows are still live and
    // still driving the engine — refusing to remove them would leave a policy
    // that cannot be turned off.
    expect(policyRowGate({ ...collapsedCap, mergedInto: "pOther" }, { remove: true })).toMatchObject({ ok: true });
    expect(policyRowGate({ name: "Renamed to something else", subcategory: "Accessories" }, { remove: true })).toMatchObject({ ok: true });
    expect(policyRowGate(undefined, { remove: true })).toMatchObject({ ok: true });
    // …and each of those explains itself rather than passing silently.
    expect(policyRowGate({ ...collapsedCap, mergedInto: "pOther" }, { remove: true }).note).toBeTruthy();
    // A product that has NOT collapsed can still have a stray row removed.
    expect(policyRowGate({ ...collapsedCap, sizes: ["S", "M"] }, { remove: true })).toMatchObject({ ok: true });
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

describe("which sizes count as retired — the gate caps widened", () => {
  it("treats every non-sentinel size as retired, including the ones caps actually use", () => {
    // These are LIVE cap sizes. Under the old letter-only enumeration every one
    // of them read as "not a real size", so an open order against a 59FIFTY in
    // size 57 did not block and the product would have collapsed under it.
    for (const s of ["S", "M", "L", "XL", "XXL", "XXXL", "4XL", "28", "55", "57", "62", "63"]) {
      expect(isRetiredSize(s)).toBe(true);
    }
  });

  it("does NOT treat the one-size sentinel or its display label as retired", () => {
    expect(isRetiredSize("_")).toBe(false);
    expect(isRetiredSize("Free Size")).toBe(false);   // the synthetic label, folded by the chokepoint
    expect(isRetiredSize("")).toBe(false);
    expect(isRetiredSize(null)).toBe(false);
    expect(isRetiredSize(undefined)).toBe(false);
    expect(isRetiredSizeKey("_")).toBe(false);
    expect(isRetiredSizeKey("M")).toBe(true);
  });

  it("blocks a live order on a cap size the old enumeration could not see", () => {
    const nowMs = Date.parse(NOW);
    for (const size of ["4XL", "57", "28"]) {
      expect(orderBlocks({ id: "O9", productId: "pB", size, customerName: "Thabo", status: "incoming" }, "pB", nowMs))
        .toMatch(/live customer order/);
    }
  });

  it("blocks an unreceived transfer carrying a centimetre size", () => {
    expect(transferBlocks({ status: "sent", from: "central", to: "marathon-pe", lines: { pB: { "57": 1 } } }, "pB"))
      .toMatch(/carrying size 57/);
    expect(transferBlocks({ status: "sent", lines: { pB: { "4XL": 2 } } }, "pB")).toMatch(/carrying size 4XL/);
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
  it("a well-formed node cannot vouch for a malformed sibling node", () => {
    // lines[pid] reads cleanly and carries only "_", while received[pid] hides
    // its sizes one level down. A single sticky "understood" flag would let the
    // good node vouch for the bad one and return a clean bill on a transfer
    // that really does carry M.
    const mixed = { status: "sent", lines: { [pid]: { _: 2 } }, received: { [pid]: { sizes: { M: 2 } } } };
    expect(transferBlocks(mixed, pid)).toMatch(/shape this gate does not understand/);
    // reversed — the malformed node first
    const reversed = { status: "sent", lines: { [pid]: { sizes: { M: 2 } } }, received: { [pid]: { _: 2 } } };
    expect(transferBlocks(reversed, pid)).toMatch(/shape this gate does not understand/);
    // both well-formed and one-size only → still a clean pass
    expect(transferBlocks({ status: "sent", lines: { [pid]: { _: 2 } }, received: { [pid]: { _: 1 } } }, pid)).toBe(null);
  });

  it("never names a size it scraped out of a node it could not read", () => {
    // The malformed shape's own key is "sizes". Under the letter-only size test
    // that was harmless — "sizes" is not a letter size, so it contributed
    // nothing. Widening the test to "anything that is not the sentinel" (which
    // caps required: 28, 55 and 4XL are all real sizes) makes "sizes" itself
    // look like one, and the gate reports `carrying size sizes` about a record
    // nobody parsed. It blocks either way, so nothing is unsafe — but an
    // operator sent to clear "size sizes" off a transfer has been told a
    // confident falsehood, and the fix is that a node is only harvested if it
    // was understood.
    const msg = transferBlocks({ status: "sent", lines: { [pid]: { sizes: { M: 2 } } } }, pid);
    expect(msg).toMatch(/shape this gate does not understand/);
    expect(msg).not.toMatch(/size sizes/);
    expect(msg).not.toMatch(/carrying size/);
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
