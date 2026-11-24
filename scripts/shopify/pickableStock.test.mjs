// The shelf-hold rule (pickableStock.mjs): a cell that rejected a website pick
// counts for nothing on the website until it moves again — and nothing else changes.
import { describe, it, expect, beforeEach } from "vitest";
import {
  CELL_HOLDS_PATH, PICKABLE_CONFIG_PATH, cellQty, cellStampMs, holdStands, rulesFrom, pickableTree, cellHeld, holdRow, isStaleSingle, STALE_SINGLE_DEFAULT,
  readPickableRules, readCellHolds, forgetPickableRules,
} from "./pickableStock.mjs";
import { networkTotals } from "./inventory.mjs";
import { desiredFor } from "./inventorySync.mjs";
import { createRequire } from "node:module";

const T = Date.parse("2026-11-24T08:00:00Z");
const cell = (qty, updatedAt) => ({ qty, ...(updatedAt ? { updatedAt: new Date(updatedAt).toISOString() } : {}) });

describe("holdStands", () => {
  it("stands while the cell shows a piece and has not moved since the rejection", () => {
    expect(holdStands({ at: T }, cell(1, T - 864e5))).toBe(true);
    expect(holdStands({ at: T }, cell(3, T))).toBe(true); // a movement in the same millisecond is not AFTER
  });
  it("ends by itself the moment the cell moves (a sale, a delivery, a count)", () => {
    expect(holdStands({ at: T }, cell(1, T + 1))).toBe(false);
  });
  it("hides nothing at an empty cell", () => {
    expect(holdStands({ at: T }, cell(0, T - 1))).toBe(false);
    expect(holdStands({ at: T }, null)).toBe(false);
  });
  it("a cell with no stamp, or a bare number, never moved through the ledger: the hold stands", () => {
    expect(holdStands({ at: T }, { qty: 2 })).toBe(true);
    expect(holdStands({ at: T }, 2)).toBe(true);
    expect(holdStands({ at: T }, { qty: 2, updatedAt: "not a date" })).toBe(true);
  });
  it("a row without a usable time is no hold at all", () => {
    for (const hold of [null, {}, { at: 0 }, { at: "x" }, { at: -5 }]) expect(holdStands(hold, cell(1))).toBe(false);
  });
  it("reads a cell the way networkTotals does", () => {
    expect(cellQty({ qty: -2 })).toBe(0);
    expect(cellQty("3")).toBe(3);
    expect(cellStampMs(cell(1, T))).toBe(T);
    expect(cellStampMs(5)).toBe(null);
  });
});

describe("pickableTree", () => {
  const tree = () => ({
    hub1: { P: { 8: cell(1, T - 20 * 864e5), 9: cell(2, T - 864e5) } },
    hub2: { P: { 8: cell(2, T - 864e5) } },
    central: { P: { 8: cell(4, T - 864e5) }, Q: { 8: cell(7) } },
  });
  const holds = { 8: { hub1: { at: T, kind: "hub_out_of_stock" } } };

  it("empties ONLY the held cell: other sizes, other places and other products are untouched", () => {
    const input = tree();
    const { tree: out, hidden } = pickableTree(input, "P", holds);
    expect(networkTotals(out, "P", ["8", "9"])).toEqual({ 8: 6, 9: 2 });
    expect(networkTotals(input, "P", ["8", "9"])).toEqual({ 8: 7, 9: 2 }); // the input is not mutated
    expect(out.central.Q).toBe(input.central.Q);
    expect(hidden).toEqual([{ loc: "hub1", sizeKey: "8", qty: 1, why: "hub_out_of_stock", at: T }]);
  });
  it("gives the same tree back when nothing is held", () => {
    const input = tree();
    expect(pickableTree(input, "P", null).tree).toBe(input);
    expect(pickableTree(input, "P", { 8: { trophy: { at: T } } }).tree).toBe(input);
    expect(pickableTree(input, "P", { 8: { hub2: { at: T - 2 * 864e5 } } }).tree).toBe(input); // hub2 moved since
  });
  it("the kill switch counts every cell again", () => {
    const input = tree();
    const { tree: out, hidden } = pickableTree(input, "P", holds, rulesFrom({ holdsOff: true }));
    expect(out).toBe(input);
    expect(hidden).toEqual([]);
  });
  it("rulesFrom: on unless switched off explicitly", () => {
    expect(rulesFrom(null).holds).toBe(true);
    expect(rulesFrom({ holdsOff: false }).holds).toBe(true);
    expect(rulesFrom({ holdsOff: "true" }).holds).toBe(true); // only the boolean switches it off
    expect(rulesFrom({ holdsOff: true }).holds).toBe(false);
  });
  it("cellHeld answers the router's one-cell question the same way", () => {
    expect(cellHeld(holds[8], "hub1", cell(1, T - 1))).toBe(true);
    expect(cellHeld(holds[8], "hub1", cell(1, T + 1))).toBe(false);
    expect(cellHeld(holds[8], "hub2", cell(1, T - 1))).toBe(false);
    expect(cellHeld(holds[8], "hub1", cell(1, T - 1), rulesFrom({ holdsOff: true }))).toBe(false);
    expect(cellHeld(null, "hub1", cell(1))).toBe(false);
  });
});

describe("the lone stale piece (Marathon PE, untouched over 14 days: 31 of 54 website lines rejected)", () => {
  const rule = rulesFrom(null).staleSingle;
  const DAY = 864e5;
  it("the default is Marathon PE at 14 days, and only that", () => {
    expect(rule).toEqual({ days: 14, locations: ["marathon-pe"] });
    expect(STALE_SINGLE_DEFAULT.locations).toEqual(["marathon-pe"]);
  });
  it("exactly one piece, at a listed place, with a stamp older than the limit", () => {
    expect(isStaleSingle(cell(1, T - 15 * DAY), "marathon-pe", rule, T)).toBe(true);
    expect(isStaleSingle(cell(1, T - 14 * DAY), "marathon-pe", rule, T)).toBe(false); // 14 days exactly is not OVER 14
    expect(isStaleSingle(cell(1, T - 14 * DAY - 1), "marathon-pe", rule, T)).toBe(true);
    expect(isStaleSingle(cell(2, T - 40 * DAY), "marathon-pe", rule, T)).toBe(false); // two pieces: counted
    expect(isStaleSingle(cell(0, T - 40 * DAY), "marathon-pe", rule, T)).toBe(false);
    expect(isStaleSingle(cell(1, T - 40 * DAY), "trophy", rule, T)).toBe(false);      // below the bar: not listed
    expect(isStaleSingle(cell(1, T - 40 * DAY), "hub1", rule, T)).toBe(false);
  });
  it("no stamp is no evidence of age: the piece is counted", () => {
    expect(isStaleSingle({ qty: 1 }, "marathon-pe", rule, T)).toBe(false);
    expect(isStaleSingle(1, "marathon-pe", rule, T)).toBe(false);
    expect(isStaleSingle(cell(1, T - 40 * DAY), "marathon-pe", rule, NaN)).toBe(false);
  });
  it("the website does not count it, and counts it again the moment the cell moves", () => {
    const tree = { "marathon-pe": { P: { M: cell(1, T - 30 * DAY), L: cell(1, T - 2 * DAY) } }, trophy: { P: { M: cell(1, T - 30 * DAY) } } };
    const { tree: out, hidden } = pickableTree(tree, "P", null, rulesFrom(null), T);
    expect(networkTotals(out, "P", ["M", "L"])).toEqual({ M: 1, L: 1 });
    expect(hidden).toEqual([{ loc: "marathon-pe", sizeKey: "M", qty: 1, why: "stale_single", at: T - 30 * DAY }]);
    const moved = { ...tree, "marathon-pe": { P: { ...tree["marathon-pe"].P, M: cell(1, T - 1) } } };
    expect(networkTotals(pickableTree(moved, "P", null, rulesFrom(null), T).tree, "P", ["M", "L"])).toEqual({ M: 2, L: 1 });
  });
  it("Junid's switches: off, other days, other places", () => {
    expect(rulesFrom({ staleSingle: { off: true } }).staleSingle).toBe(null);
    expect(rulesFrom({ staleSingle: { days: 30 } }).staleSingle).toEqual({ days: 30, locations: ["marathon-pe"] });
    expect(rulesFrom({ staleSingle: { days: 0 } }).staleSingle.days).toBe(14);
    expect(rulesFrom({ staleSingle: { locations: ["marathon-pe", "trophy"] } }).staleSingle.locations).toEqual(["marathon-pe", "trophy"]);
    expect(rulesFrom({ staleSingle: { locations: [] } }).staleSingle.locations).toEqual(["marathon-pe"]);
    const tree = { "marathon-pe": { P: { M: cell(1, T - 30 * DAY) } } };
    expect(pickableTree(tree, "P", null, rulesFrom({ staleSingle: { off: true } }), T).tree).toBe(tree);
    // The two rules are independent: holds off leaves the stale rule on.
    expect(pickableTree(tree, "P", null, rulesFrom({ holdsOff: true }), T).hidden).toHaveLength(1);
  });
  it("a held cell is reported as held, not as stale", () => {
    const tree = { "marathon-pe": { P: { M: cell(1, T - 30 * DAY) } } };
    const { hidden } = pickableTree(tree, "P", { M: { "marathon-pe": { at: T - DAY, kind: "shop_not_found" } } }, rulesFrom(null), T);
    expect(hidden).toEqual([{ loc: "marathon-pe", sizeKey: "M", qty: 1, why: "shop_not_found", at: T - DAY }]);
  });
});

describe("holdRow", () => {
  it("builds the row at its exact path", () => {
    expect(holdRow({ pid: "P", sizeKey: "5_5", loc: "hub1", at: T, kind: "hub_out_of_stock", orderId: 9001, line: 2, qty: 1, by: "u1" }))
      .toEqual({ path: `${CELL_HOLDS_PATH}/P/5_5/hub1`, value: { at: T, kind: "hub_out_of_stock", orderId: "9001", line: 2, qty: 1, by: "u1" } });
  });
  it("refuses a key that could not be a path segment, an unknown kind, or no time", () => {
    const ok = { pid: "P", sizeKey: "8", loc: "hub1", at: T, kind: "shop_not_found", orderId: "1", line: 0 };
    expect(holdRow(ok)).not.toBe(null);
    for (const bad of [{ pid: "a/b" }, { sizeKey: "5.5" }, { sizeKey: "" }, { loc: "hub$1" }, { kind: "because" }, { at: 0 }, { at: NaN }]) expect(holdRow({ ...ok, ...bad })).toBe(null);
  });
});

describe("readers", () => {
  beforeEach(() => forgetPickableRules());
  it("the rules are read from the config node, once a minute", async () => {
    let reads = 0;
    const get = async (p) => { reads += 1; expect(p).toBe(PICKABLE_CONFIG_PATH); return { holdsOff: true }; };
    expect((await readPickableRules(get, 1000)).holds).toBe(false);
    expect((await readPickableRules(get, 30e3)).holds).toBe(false);
    expect(reads).toBe(1);
    await readPickableRules(get, 62e3);
    expect(reads).toBe(2);
  });
  it("an unreadable config or hold node never stops a push: the defaults, and no holds", async () => {
    const boom = async () => { throw new Error("PERMISSION_DENIED"); };
    expect((await readPickableRules(boom, 1)).holds).toBe(true);
    expect(await readCellHolds(boom, "P")).toBe(null);
  });
});

describe("desiredFor — what the website is told", () => {
  beforeEach(() => forgetPickableRules());
  const db = (store) => ({ ref: (path) => ({ get: async () => ({ val: () => path.split("/").reduce((n, p) => (n == null ? undefined : n[p]), store) ?? null }) }) });
  const store = (extra = {}) => ({
    shopify_sync: { P: { shopifyProductId: "gid://shopify/Product/1", variants: { 8: { shopifyVariantId: "v8" }, 9: { shopifyVariantId: "v9" } } } },
    stock: { hub1: { P: { 8: cell(1, T - 20 * 864e5), 9: cell(1, T - 864e5) } }, central: { P: { 8: cell(2, T - 864e5) } } },
    ...extra,
  });
  it("a held cell is not counted, and is named in `hidden`", async () => {
    const r = await desiredFor(db(store({ [CELL_HOLDS_PATH]: { P: { 8: { hub1: { at: T, kind: "shop_not_found" } } } } })), "P", ["hub1", "central"]);
    expect(r.totals).toEqual({ 8: 2, 9: 1 });
    expect(r.hidden).toEqual([{ loc: "hub1", sizeKey: "8", qty: 1, why: "shop_not_found", at: T }]);
  });
  it("no hold, or the switch off: exactly the count as before", async () => {
    expect((await desiredFor(db(store()), "P", ["hub1", "central"])).totals).toEqual({ 8: 3, 9: 1 });
    forgetPickableRules();
    const off = store({ [CELL_HOLDS_PATH]: { P: { 8: { hub1: { at: T } } } }, config: { onlineOrders: { pickable: { holdsOff: true } } } });
    expect((await desiredFor(db(off), "P", ["hub1", "central"])).totals).toEqual({ 8: 3, 9: 1 });
  });
});

describe("the Cloud Function writes the same path and kind (functions cannot import an ES module)", () => {
  it("lib.cjs mirrors CELL_HOLDS_PATH and the shop kind", () => {
    const lib = createRequire(import.meta.url)("../../functions/displayChecks/lib.cjs");
    expect(lib.ONLINE_CELL_HOLDS_PATH).toBe(CELL_HOLDS_PATH);
    expect(holdRow({ pid: "P", sizeKey: "8", loc: "trophy", at: T, kind: lib.SHOP_NOT_FOUND_HOLD, orderId: "1", line: 0 })).not.toBe(null);
  });
});
