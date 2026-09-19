import { describe, test, expect } from "vitest";
import {
  MIRROR_LEGS, MIRROR_STORES, LEG_BY_NAME, LEG_BY_NODE, CHANGE_FED_LEGS,
  rowKey, rowKeySegments, rowPath, storeKey, MirrorRowKeyError, DOC_ROW_KEY,
} from "../nodes";

describe("the node registry", () => {
  test("every leg names a store the database actually creates", () => {
    for (const l of MIRROR_LEGS) expect(MIRROR_STORES).toContain(l.store);
  });

  test("leg names and node paths are both unique", () => {
    expect(Object.keys(LEG_BY_NAME)).toHaveLength(MIRROR_LEGS.length);
    expect(Object.keys(LEG_BY_NODE)).toHaveLength(MIRROR_LEGS.length);
  });

  test("no node is an ancestor of another", () => {
    // Two legs where one node sits under the other would double-mirror the
    // same bytes and give a change record two legs to land in.
    for (const a of MIRROR_LEGS) {
      for (const b of MIRROR_LEGS) {
        if (a === b) continue;
        expect(b.node.startsWith(`${a.node}/`)).toBe(false);
      }
    }
  });

  test("every leg declares a feed this build knows how to run", () => {
    for (const l of MIRROR_LEGS) {
      expect(["changes", "keyRange", "tsRange"]).toContain(l.feed);
    }
  });

  test("only append-only nodes use a ranged feed", () => {
    // A ranged feed cannot carry a DELETE and cannot carry an in-place edit.
    // Using one on a mutable node is the silent-drift failure, so the two that
    // do are named here rather than inferred.
    const ranged = MIRROR_LEGS.filter((l) => l.feed !== "changes").map((l) => l.node);
    expect(ranged.sort()).toEqual(["insights_log", "stock_movements"]);
  });

  test("a tsRange leg names the field it ranges on, and its store indexes it", () => {
    const l = LEG_BY_NAME.movements;
    expect(l.tsField).toBe("ts");
    expect(l.feed).toBe("tsRange");
  });

  test("the change-fed set is every mutable leg and nothing else", () => {
    expect(CHANGE_FED_LEGS.map((l) => l.name).sort())
      .toEqual(MIRROR_LEGS.filter((l) => l.feed === "changes").map((l) => l.name).sort());
    expect(CHANGE_FED_LEGS).not.toContain(LEG_BY_NAME.insights);
  });
});

describe("row keys", () => {
  test("segments join and split symmetrically", () => {
    expect(rowKey(["hub1", "p1"])).toBe("hub1|p1");
    expect(rowKeySegments("hub1|p1")).toEqual(["hub1", "p1"]);
  });

  test("a segment containing the separator is REFUSED, not silently joined", () => {
    // "|" is a legal RTDB key character, so this is a real possibility and not
    // a theoretical one. Two rows collapsing into one would be invisible.
    expect(() => rowKey(["hub1", "p|1"])).toThrow(MirrorRowKeyError);
    expect(() => rowKey(["a|b", "c"])).toThrow(MirrorRowKeyError);
  });

  test("an empty or non-string segment is refused", () => {
    expect(() => rowKey(["hub1", ""])).toThrow(MirrorRowKeyError);
    expect(() => rowKey(["hub1", null])).toThrow(MirrorRowKeyError);
    expect(() => rowKey(["hub1", 7])).toThrow(MirrorRowKeyError);
  });

  test("rowPath rebuilds the RTDB path at every depth", () => {
    expect(rowPath(LEG_BY_NAME.locations, DOC_ROW_KEY)).toBe("locations");
    expect(rowPath(LEG_BY_NAME.products, "p1")).toBe("products/p1");
    expect(rowPath(LEG_BY_NAME.stock, "hub1|p1")).toBe("stock/hub1/p1");
    expect(rowPath(LEG_BY_NAME.displayRows, "marathon-pe|p1|r9"))
      .toBe("settings/displayRows/marathon-pe/p1/r9");
  });

  test("docs legs key by their full path, so two of them cannot collide", () => {
    // Both are depth 0 and both would key at "" in their own store.
    expect(storeKey(LEG_BY_NAME.locations, DOC_ROW_KEY)).toBe("locations");
    expect(storeKey(LEG_BY_NAME.transitConfig, DOC_ROW_KEY)).toBe("config/transit");
    expect(storeKey(LEG_BY_NAME.users, "u1")).toBe("users/u1");
  });

  test("a leg with its own store keys by the bare row key", () => {
    expect(storeKey(LEG_BY_NAME.products, "p1")).toBe("p1");
    expect(storeKey(LEG_BY_NAME.stock, "hub1|p1")).toBe("hub1|p1");
  });
});
