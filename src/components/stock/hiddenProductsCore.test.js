import { describe, it, expect } from "vitest";
import {
  HIDDEN_ROOT, HIDE_REASONS, reasonLabel, hideEntry,
  bulkHideUpdate, unhideUpdate, partitionHidden, hiddenRows, sortAndFilterHidden,
} from "./hiddenProductsCore";
import { computeMissingProducts, buildChips, countByCategory } from "./missingProductsCore";

// Live catalogue shapes, matching missingProductsCore.test.js.
const TEE     = { id: "t1", name: "Nike Tee",     productType: "clothing", sizes: ["S", "M", "L"] };
const JERSEY  = { id: "j1", name: "Real Madrid",  productType: "clothing", sizes: ["M", "L"] };
const BAG     = { id: "b1", name: "Nike Duffel",  productType: "clothing", sizes: ["_"] };
const PERFUME = { id: "pf1", name: "Queen of Fire", categoryKey: "perfumes", sizes: ["_"] };
const PRODUCTS = [TEE, JERSEY, BAG, PERFUME];
const cell = (qty) => ({ qty });

// Four stranded cards: three clothing, one perfume — all Only in Central.
const STOCK = {
  central: { t1: { M: cell(4) }, j1: { L: cell(2) }, b1: { _: cell(6) }, pf1: { _: cell(9) } },
  hub2: {}, "marathon-pe": {}, trophy: {},
};
const cards = () => computeMissingProducts({ allStock: STOCK, products: PRODUCTS });

// ── the node contract ────────────────────────────────────────────────────────
describe("the hidden set's node", () => {
  it("lives under /settings — the subtree whose live console rule already covers it", () => {
    // /settings is the established home for app-owned feature state (stockHold,
    // displaySlots, hubSneakerCount). Moving this node ANYWHERE else means a
    // console rules change — a decision, not a refactor.
    expect(HIDDEN_ROOT).toBe("settings/missingProductsHidden");
  });
  it("records who and when, and OMITS an absent reason (never writes undefined)", () => {
    // undefined inside a multi-path update kills the whole batch — the
    // non-enforced save outage (PR #327). Absent means absent.
    expect(hideEntry({ at: 123, by: "u1" })).toEqual({ at: 123, by: "u1" });
    expect(hideEntry({ at: 123, by: "u1", reason: "seasonal" })).toEqual({ at: 123, by: "u1", reason: "seasonal" });
    expect(Object.keys(hideEntry({ at: 1, by: "u", reason: undefined }))).not.toContain("reason");
  });
  it("drops an unknown reason instead of storing free text", () => {
    expect(hideEntry({ at: 1, by: "u", reason: "because" })).toEqual({ at: 1, by: "u" });
  });
  it("null-safes the actor (a mid-signout hide is still recorded)", () => {
    expect(hideEntry({ at: 1 }).by).toBe(null);
  });
  it("names the two owner reasons and labels the reasonless case honestly", () => {
    expect(HIDE_REASONS.map((r) => r.key)).toEqual(["awaiting_stock", "seasonal"]);
    expect(reasonLabel("seasonal")).toBe("Seasonal");
    expect(reasonLabel(null)).toBe("No reason given");
  });
});

// ── the view filter ──────────────────────────────────────────────────────────
describe("partitionHidden — a view filter and nothing more", () => {
  it("removes a hidden product from the visible list and surfaces it in hidden", () => {
    const all = cards();
    const { visible, hidden } = partitionHidden(all, { t1: { at: 1, by: "u" } });
    expect(visible.map((c) => c.pid)).not.toContain("t1");
    expect(hidden.map((c) => c.pid)).toEqual(["t1"]);
    expect(visible.length + hidden.length).toBe(all.length);
  });
  it("preserves order and reconstructs the compute's output byte-for-byte", () => {
    // The partition must never mutate or reshape what computeMissingProducts
    // returned — hiding is strictly downstream of the single unforked compute.
    const all = cards();
    const before = JSON.stringify(all);
    const { visible, hidden } = partitionHidden(all, { j1: { at: 1 } });
    expect(JSON.stringify(all)).toBe(before);
    const merged = [...all].map((c) => (c.pid === "j1" ? hidden[0] : visible[all.filter((x) => x.pid !== "j1").indexOf(c)]));
    expect(JSON.stringify(merged)).toBe(before);
  });
  it("fails OPEN: a null / empty / unloaded map hides nothing", () => {
    const all = cards();
    for (const m of [null, undefined, {}]) {
      const { visible, hidden } = partitionHidden(all, m);
      expect(visible.length).toBe(all.length);
      expect(hidden.length).toBe(0);
    }
  });
  it("computeMissingProducts itself has no hidden input — same args, same output, hidden set or not", () => {
    // The engine-mirror guarantee at the app layer: the compute cannot see the
    // hidden set, so a hidden product's card build is untouched. (The engine's
    // own byte-for-byte proof lives in functions/test/refill-hidden-invariance.)
    const a = JSON.stringify(cards());
    partitionHidden(cards(), { t1: { at: 1 }, pf1: { at: 1 } });
    const b = JSON.stringify(cards());
    expect(b).toBe(a);
  });
});

// ── chips and counts with hidden items present ───────────────────────────────
describe("chips and counts stay correct with hidden items present", () => {
  it("hiding one clothing card drops the Clothing chip by exactly one; Perfume is untouched", () => {
    const all = cards();
    const before = buildChips(all, 5);
    const { visible } = partitionHidden(all, { t1: { at: 1 } });
    const after = buildChips(visible, 5);
    const n = (chips, key) => chips.find(([k]) => k === key)[2];
    expect(n(after, "clothing")).toBe(n(before, "clothing") - 1);
    expect(n(after, "perfume")).toBe(n(before, "perfume"));
    expect(n(after, "sneakers")).toBe(5);
  });
  it("chips still account for every VISIBLE card (the drift-guard invariant, on the visible set)", () => {
    const { visible } = partitionHidden(cards(), { pf1: { at: 1 }, b1: { at: 1 } });
    const counts = countByCategory(visible);
    const total = Object.values(counts).reduce((t, n) => t + n, 0);
    expect(total).toBe(visible.length);
  });
});

// ── bulk hide (one gesture, one update) ──────────────────────────────────────
describe("bulkHideUpdate — writes ONLY the selected set", () => {
  it("one path per selected pid, all under the hidden root, nothing else", () => {
    const u = bulkHideUpdate(["a", "b", "c"], { at: 9, by: "u1", reason: "seasonal" });
    expect(Object.keys(u).sort()).toEqual([
      `${HIDDEN_ROOT}/a`, `${HIDDEN_ROOT}/b`, `${HIDDEN_ROOT}/c`,
    ]);
    for (const v of Object.values(u)) expect(v).toEqual({ at: 9, by: "u1", reason: "seasonal" });
  });
  it("empty selection writes nothing; falsy pids are dropped", () => {
    expect(bulkHideUpdate([], { at: 1 })).toEqual({});
    expect(bulkHideUpdate(null, { at: 1 })).toEqual({});
    expect(Object.keys(bulkHideUpdate(["x", null, ""], { at: 1 }))).toEqual([`${HIDDEN_ROOT}/x`]);
  });
  it("unhide is the exact inverse — null at the same paths, one action", () => {
    expect(unhideUpdate(["a"])).toEqual({ [`${HIDDEN_ROOT}/a`]: null });
  });
});

// ── the hidden tab's rows: join, state-change rule, sort/filter ──────────────
describe("hiddenRows — hide follows the PRODUCT, not the card", () => {
  const MAP = {
    t1: { at: 300, by: "u1", reason: "awaiting_stock" },
    gone: { at: 100, by: "u2", reason: "seasonal" },   // no card any more
    b1: { at: 200, by: "u1" },                          // no reason
  };
  it("a hidden product still stranded joins its live card; one that resolved is flagged, not dropped", () => {
    const rows = hiddenRows(MAP, cards());
    const byPid = Object.fromEntries(rows.map((r) => [r.pid, r]));
    expect(byPid.t1.resolved).toBe(false);
    expect(byPid.t1.card.pid).toBe("t1");
    // THE STATE-CHANGE RULE: sold out / collapsed / now carried → the card is
    // gone from the main list on its own, and the entry stays HERE, inert,
    // labelled resolved, until a human unhides it. Nothing auto-deletes.
    expect(byPid.gone.resolved).toBe(true);
    expect(byPid.gone.card).toBe(null);
    expect(byPid.gone.reason).toBe("seasonal");
    expect(rows.length).toBe(3);
  });
  it("filters by reason — including the reasonless bucket — and sorts by date hidden both ways", () => {
    const rows = hiddenRows(MAP, cards());
    expect(sortAndFilterHidden(rows, { reason: "seasonal" }).map((r) => r.pid)).toEqual(["gone"]);
    expect(sortAndFilterHidden(rows, { reason: "none" }).map((r) => r.pid)).toEqual(["b1"]);
    expect(sortAndFilterHidden(rows, { reason: "all", sort: "newest" }).map((r) => r.at)).toEqual([300, 200, 100]);
    expect(sortAndFilterHidden(rows, { sort: "oldest" }).map((r) => r.at)).toEqual([100, 200, 300]);
  });
  it("does not mutate its input when sorting", () => {
    const rows = hiddenRows(MAP, cards());
    const order = rows.map((r) => r.pid);
    sortAndFilterHidden(rows, { sort: "oldest" });
    expect(rows.map((r) => r.pid)).toEqual(order);
  });
});
