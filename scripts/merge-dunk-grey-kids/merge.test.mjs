// The duplicate-dunk merge, end to end against the fake RTDB (real delete
// semantics: empty objects/arrays vanish) and the app's real performMerge.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { KEEP_ID, REMOVE_ID, MERGE_NOTE, mapSizes, narrowDb } from "./core.mjs";
import { investigate } from "./investigate.mjs";
import { planFrom } from "./plan.mjs";
import { run } from "./apply.mjs";

const require = createRequire(import.meta.url);
const { makeFakeDb } = require("../../functions/test/helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-11-28T15:00:00.000Z");
const SIZES = ["24", "25", "26", "31", "32"];
const cell = (qty, v = 1) => ({ qty, v, mv: "m0", lastType: "received" });
const base = (over = {}) => ({
  locations: { central: { name: "Central" }, hub1: { name: "Hub 1" }, hub3: { name: "Hub 3" } },
  products: {
    [KEEP_ID]: { name: "Nike SB dunk low grey small", styleCode: "845013-100", styleCodeNormalised: "845013100", brand: "Nike", categoryKey: "kids-shoes", sizes: SIZES, barcodes: { 24: "00039616" } },
    [REMOVE_ID]: { name: "Nike dunk low  grey and white", brand: "Nike", categoryKey: "kids-shoes", sizes: SIZES, barcodes: { 24: "00040275", 31: "00040282" } },
  },
  style_code_index: { 845013100: { productId: KEEP_ID } },
  barcodes: {
    "00039616": { productId: KEEP_ID, size: "24" },
    "00040275": { productId: REMOVE_ID, size: "24" },
    "00040282": { productId: REMOVE_ID, size: "31" },
  },
  stock: {
    central: { [KEEP_ID]: { 31: cell(2), 32: cell(1) }, [REMOVE_ID]: { 24: cell(3), 25: cell(3), 31: cell(4), 32: cell(5) } },
    hub1: { [KEEP_ID]: { 24: cell(2) } },
    hub3: { [KEEP_ID]: { 26: cell(2) }, [REMOVE_ID]: { 24: cell(0, 0), 25: cell(0, 0) } },
  },
  stock_movements: {
    s1: { productId: KEEP_ID, type: "sold", qty: 1, size: "24", from: "hub1", ts: "2026-11-28T14:54:57.789Z" },
  },
  ...over,
});

describe("size map", () => {
  it("same labels map 1:1; any other label is left unmapped, never converted", () => {
    expect(mapSizes(["24", "25"], ["24", "25", "26"])).toEqual({ pairs: [{ from: "24", to: "24" }, { from: "25", to: "25" }], unmapped: [] });
    expect(mapSizes(["11C", "24"], ["24"]).unmapped).toEqual(["11C"]);
    expect(mapSizes(undefined, ["24"])).toEqual({ pairs: [], unmapped: [] }); // RTDB drops empty arrays
  });
});

describe("plan (dry run)", () => {
  it("transfers every duplicate unit into the original at the same location and keeps the total", async () => {
    const db = makeFakeDb(base());
    const { plan, safeToApply } = planFrom(await investigate(db));
    expect(safeToApply).toBe(true);
    expect(plan.totals).toMatchObject({ keepBefore: 7, removeBefore: 15, combinedBefore: 22, keepAfter: 22, combinedAfter: 22 });
    expect(plan.totalsUnchanged).toBe(true);
    expect(plan.rows.find((r) => r.loc === "central" && r.size === "31")).toMatchObject({ duplicateQty: 4, originalBefore: 2, originalAfter: 6, action: "transfer" });
    expect(plan.rows.filter((r) => r.loc === "hub3").every((r) => r.action === "empty-cell-dropped")).toBe(true);
  });

  it("an open refill request on the duplicate blocks the merge", async () => {
    const db = makeFakeDb(base({ refill_requests: { r1: { productId: REMOVE_ID, status: "open", size: "24", qty: 3, requestingLocation: "hub3" }, r2: { productId: REMOVE_ID, status: "fulfilled", size: "25" } } }));
    const out = planFrom(await investigate(db));
    expect(out.safeToApply).toBe(false);
    expect(out.blockers.join(" ")).toMatch(/1 open refill request/);
  });

  it("a size the original does not carry blocks the merge and is listed", async () => {
    const w = base();
    w.products[REMOVE_ID].sizes = [...SIZES, "11C"];
    w.stock.central[REMOVE_ID]["11C"] = cell(2);
    const out = planFrom(await investigate(makeFakeDb(w)));
    expect(out.safeToApply).toBe(false);
    expect(out.plan.unmappedHeld).toEqual([{ loc: "central", size: "11C", qty: 2 }]);
  });

  it("a duplicate carrying its own style code, or another category, is not merged", async () => {
    const w = base();
    w.products[REMOVE_ID].styleCodeNormalised = "DH9765001";
    w.products[REMOVE_ID].categoryKey = "sneakers";
    const out = planFrom(await investigate(makeFakeDb(w)));
    expect(out.safeToApply).toBe(false);
    expect(out.blockers.join(" ")).toMatch(/style code.*different shoe/);
    expect(out.blockers.join(" ")).toMatch(/Different categories/);
  });

  it("a cell counted under the original (a write-off, total would drop) blocks the merge", async () => {
    const w = base({ settings: { hubSneakerCount: { sessions: { central: { sessionId: "s1" } }, counted: { central: { s1: { [`${KEEP_ID}::31`]: { at: 1 } } } } } } });
    const out = planFrom(await investigate(makeFakeDb(w)));
    expect(out.plan.countedRemovals.map((r) => r.size)).toEqual(["31"]);
    expect(out.plan.totalsUnchanged).toBe(false);
    expect(out.safeToApply).toBe(false);
  });
});

describe("apply", () => {
  it("refuses — and writes nothing — while a blocker stands", async () => {
    const w = base({ refill_requests: { r1: { productId: REMOVE_ID, status: "open", size: "24", qty: 3 } } });
    const db = makeFakeDb(w);
    const before = JSON.stringify(db.state.root);
    const r = await run(db, { apply: true, nowMs: NOW, log: () => {} });
    expect(r.applied).toBe(false);
    expect(JSON.stringify(db.state.root)).toBe(before);
  });

  it("dry run writes nothing", async () => {
    const db = makeFakeDb(base());
    const before = JSON.stringify(db.state.root);
    expect((await run(db, { apply: false, nowMs: NOW, log: () => {} })).dryRun).toBe(true);
    expect(JSON.stringify(db.state.root)).toBe(before);
  });

  it("merges through the app's own performMerge, with the note on every movement, and verifies", async () => {
    const db = makeFakeDb(base());
    const r = await run(db, { apply: true, nowMs: NOW, log: () => {} });
    expect(r.applied).toBe(true);
    expect(r.verify).toMatchObject({ ok: true, problems: [] });
    const root = db.state.root;
    expect(root.stock.central[KEEP_ID]).toMatchObject({ 24: { qty: 3, v: 0 }, 25: { qty: 3 }, 31: { qty: 6, v: 2 }, 32: { qty: 6 } });
    // The duplicate's nodes are gone everywhere — the empty hub3 husk too.
    expect(root.stock.central[REMOVE_ID]).toBeUndefined();
    expect(root.stock.hub3[REMOVE_ID]).toBeUndefined();
    expect(root.stock.hub3[KEEP_ID]).toEqual({ 26: cell(2) });
    expect(root.products[REMOVE_ID].mergedInto).toBe(KEEP_ID);
    expect(root.products[KEEP_ID].styleCodeNormalised).toBe("845013100");
    expect(root.barcodes["00040275"].productId).toBe(KEEP_ID);
    expect(root.barcodes["00040282"].productId).toBe(KEEP_ID);
    const merges = Object.values(root.stock_movements).filter((m) => m.link?.mergeId);
    expect(merges).toHaveLength(8);
    expect(merges.every((m) => m.reason === "product_merge" && m.note === MERGE_NOTE)).toBe(true);
    const sumKeep = Object.values(root.stock).reduce((t, l) => t + Object.values(l[KEEP_ID] || {}).reduce((a, c) => a + c.qty, 0), 0);
    expect(sumKeep).toBe(22);
  });

  it("never reads /barcodes or /style_code_index whole", async () => {
    const db = makeFakeDb(base());
    const guarded = {
      ref(p = "") {
        const real = db.ref(p);
        if (p === "barcodes" || p === "style_code_index") {
          return { ...real, get: () => { throw new Error(`whole read of ${p}`); }, once: () => { throw new Error(`whole read of ${p}`); }, orderByChild: real.orderByChild };
        }
        return real;
      },
    };
    const nd = narrowDb(guarded, { loserId: REMOVE_ID, barcodeCodes: ["00040275", "00040282"], note: "n" });
    expect(Object.keys((await nd.ref("barcodes").get()).val())).toEqual(["00040275", "00040282"]);
    expect((await nd.ref("style_code_index").get()).val()).toBeNull();
  });
});
