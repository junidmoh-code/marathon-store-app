// The counter transactions against a fake RTDB: Marathon PE / Trophy draw from
// the SAME paths and get the SAME numbers as before; a prefixed store draws
// from its own path and never moves the shared counter.
import { describe, it, expect, beforeEach, vi } from "vitest";

let TREE = {};
vi.mock("../firebase", () => ({ database: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  runTransaction: async (r, fn) => {
    const parts = r.path.split("/");
    let node = TREE;
    for (const p of parts.slice(0, -1)) node = node[p] = node[p] || {};
    const leaf = parts[parts.length - 1];
    node[leaf] = fn(node[leaf] ?? null);
    return { snapshot: { val: () => node[leaf] } };
  },
}));
vi.mock("./serverTime", () => ({ saTodayKey: () => "2026-9-2" }));

import { getNextOrderNumber, getNextRefillNumber } from "./orderCounter";
import { __resetNetworkForTests } from "./networkStore";

beforeEach(() => { TREE = {}; __resetNetworkForTests(); });

describe("Section 2 — unchanged", () => {
  it("no shop, Marathon PE and Trophy share ONE /orderCounter", async () => {
    TREE = { orderCounter: { day: "2026-9-2", counter: 41 } };
    expect(await getNextOrderNumber()).toBe("042");
    expect(await getNextOrderNumber("marathon-pe")).toBe("043");
    expect(await getNextOrderNumber("trophy")).toBe("044");
    expect(TREE).toEqual({ orderCounter: { day: "2026-9-2", counter: 44 } });
  });
  it("refill carts share ONE /refillCounter, R###", async () => {
    expect(await getNextRefillNumber()).toBe("R001");
    expect(await getNextRefillNumber("trophy")).toBe("R002");
    expect(TREE).toEqual({ refillCounter: { day: "2026-9-2", counter: 2 } });
  });
  it("yesterday's counter resets; 999 wraps", async () => {
    TREE = { orderCounter: { day: "2026-9-1", counter: 500 } };
    expect(await getNextOrderNumber("marathon-pe")).toBe("001");
    TREE = { orderCounter: { day: "2026-9-2", counter: 999 } };
    expect(await getNextOrderNumber("marathon-pe")).toBe("001");
  });
});

describe("Section 1 — its own sequence", () => {
  it("Pine starts at P001 under its own path and leaves the shared counter alone", async () => {
    TREE = { orderCounter: { day: "2026-9-2", counter: 41 } };
    expect(await getNextOrderNumber("marathon-pine")).toBe("P001");
    expect(await getNextOrderNumber("marathon-pine")).toBe("P002");
    expect(await getNextOrderNumber("concrete")).toBe("C001");
    expect(TREE.orderCounter).toEqual({ day: "2026-9-2", counter: 41 });
    expect(TREE.orderCounter_byStore).toEqual({
      "marathon-pine": { day: "2026-9-2", counter: 2 },
      concrete: { day: "2026-9-2", counter: 1 },
    });
  });
  it("refill carts: RP001 / RC001 under /refillCounter_byStore", async () => {
    expect(await getNextRefillNumber("marathon-pine")).toBe("RP001");
    expect(await getNextRefillNumber("concrete")).toBe("RC001");
    expect(TREE.refillCounter).toBeUndefined();
    expect(Object.keys(TREE.refillCounter_byStore).sort()).toEqual(["concrete", "marathon-pine"]);
  });
});
