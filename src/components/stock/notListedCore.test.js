// "Not listed" — the products the rule is about, and why the cores made no card.
import { describe, it, expect } from "vitest";
import { strandedAtCentral, coreReason, notListedRows, openRequestPids, viewOf, totalsByReason, REASONS } from "./notListedCore";

const cell = (qty) => ({ qty });
const tee = (over = {}) => ({ id: "p1", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M"], ...over });
const LOCS = ["marathon-pe", "trophy", "hub1", "hub2"];

describe("strandedAtCentral", () => {
  it("units at Central and NOT ONE unit at the division's shops and hubs — a row at 0 is zero", () => {
    const allStock = {
      central: { a: { S: cell(3) }, b: { S: cell(2) }, c: { S: cell(0) }, d: { S: cell(5) }, e: { M: cell(-2), L: cell(1) } },
      trophy: { a: { S: cell(0) }, b: { S: cell(1) } },
      hub3: { d: { S: cell(4) } },                       // another division's hub: not this division's business
    };
    expect(strandedAtCentral({ allStock, locations: LOCS })).toEqual([{ pid: "d", centralUnits: 5 }, { pid: "a", centralUnits: 3 }, { pid: "e", centralUnits: 1 }]);
  });
});

describe("coreReason", () => {
  const base = { pid: "p1", listKind: "marathon", allStock: { central: { p1: { S: cell(3) } } }, locations: LOCS };
  it("chosen: marked for the other division, finished line", () => {
    expect(coreReason({ ...base, product: tee({ concreteProduct: true }) })).toBe("markedConcrete");
    expect(coreReason({ ...base, listKind: "concrete", product: tee({ marathonProduct: true }) })).toBe("markedMarathon");
    expect(coreReason({ ...base, listKind: "concrete", product: tee({ concreteProduct: true }) })).not.toBe("markedConcrete");
    expect(coreReason({ ...base, product: tee({ deactivated: true, deactivatedAt: 1 }) })).toBe("finished");
  });
  it("data: no record, a category in neither list", () => {
    expect(coreReason({ ...base, product: null })).toBe("noRecord");
    expect(coreReason({ ...base, product: tee({ productType: "sneaker", category: "Clothing", categoryKey: "sneakers" }) })).toBe("noView");
  });
  it("a shop or hub has an empty row: requested when a request is open there, paused when every such shop is paused, else empty rows", () => {
    const allStock = { ...base.allStock, trophy: { p1: { S: cell(0) } } };
    expect(coreReason({ ...base, allStock, product: tee(), openPids: new Set(["p1"]) })).toBe("requested");
    expect(coreReason({ ...base, allStock, product: tee() })).toBe("emptyRows");
    expect(coreReason({ ...base, allStock, product: tee(), paused: (l) => l === "trophy" })).toBe("paused");
    expect(coreReason({ ...base, allStock: { ...allStock, hub2: { p1: { S: cell(0) } } }, product: tee(), paused: (l) => l === "trophy" })).toBe("emptyRows");
  });
  it("sneakers: on its way to a hub, or already requested", () => {
    const shoe = { id: "p1", name: "Dunk", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] };
    expect(viewOf(shoe)).toBe("sneakers");
    expect(coreReason({ ...base, product: shoe, heldAt: () => true })).toBe("heldAtHub");
    expect(coreReason({ ...base, product: shoe, openPids: new Set(["p1"]) })).toBe("requested");
  });
});

describe("notListedRows", () => {
  const allStock = { central: { a: { S: cell(4) }, b: { S: cell(3) }, c: { S: cell(2) }, d: { S: cell(1) } }, trophy: { c: { S: cell(0) } } };
  const byId = new Map([["a", tee({ id: "a", name: "A" })], ["b", tee({ id: "b", name: "B" })], ["c", tee({ id: "c", name: "C" })]]);
  const stranded = strandedAtCentral({ allStock, locations: LOCS });
  const rows = notListedRows({ stranded, listedPids: new Set(["a"]), whyByPid: new Map([["b", "noPolicy"], ["a", "noSize"]]), hiddenMap: null, byId, listKind: "marathon", allStock, locations: LOCS });
  it("every stranded product not on the list, once, with one reason — listed ones never", () => {
    expect(rows.map((r) => [r.pid, r.reason])).toEqual([["b", "noPolicy"], ["c", "emptyRows"], ["d", "noRecord"]]);
    expect(rows.map((r) => r.text)).toEqual([REASONS.noPolicy.text, REASONS.emptyRows.text, REASONS.noRecord.text]);
  });
  it("hidden wins over the row's own reason", () => {
    const r = notListedRows({ stranded, listedPids: new Set(), whyByPid: new Map([["b", "noPolicy"]]), hiddenMap: { b: { at: 1 } }, byId, listKind: "marathon", allStock, locations: LOCS });
    expect(r.find((x) => x.pid === "b").reason).toBe("hidden");
  });
  it("totals by reason, with units", () => {
    expect(totalsByReason(rows)).toEqual({ noPolicy: { n: 1, units: 3 }, emptyRows: { n: 1, units: 2 }, noRecord: { n: 1, units: 1 } });
  });
  it("openRequestPids: open, non-shadow, at the division's locations only", () => {
    const s = openRequestPids([
      { productId: "a", status: "open", requestingLocation: "hub2" },
      { productId: "b", status: "open", requestingLocation: "concrete" },
      { productId: "c", status: "cancelled", requestingLocation: "hub2" },
      { productId: "d", status: "open", shadow: true, requestingLocation: "hub2" },
    ], LOCS);
    expect([...s]).toEqual(["a"]);
  });
});
