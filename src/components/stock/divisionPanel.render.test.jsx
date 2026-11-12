// The Seating tab and the Engine Policy card under Junid's 12 Nov 2026 model:
// no owning shop anywhere, no Hub 3 non-footwear keep, no Hub 3 switch.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const reads = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => { reads.push(String(r.path)); return { exists: () => false, val: () => null }; },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("./useStock", () => ({ useLocations: () => ({}), useEngineConfig: () => ({}) }));

const { SeatRow } = await import("./SeatingTab.jsx");
const { readSeatingContext } = await import("./seatingStore.js");
const { ConcreteDivisionPanel, divisionHistoryLine } = await import("./EnginePolicyCard.jsx");

const seat = (loc) => ({ loc, pid: "tee", reason: "not_seated", label: "Not seated", units: 0, sizes: [], rowCount: 0, offRows: [], seated: false, hasCell: false });
const TEE = { id: "tee", name: "Tee", category: "Clothing", productType: "clothing", sizes: ["M"] };
const render = (el) => { let t; act(() => { t = TestRenderer.create(el); }); return JSON.stringify(t.toJSON()); };

describe("the Seating tab", () => {
  it("never names an owning shop, even handed an old context that carries one", () => {
    const out = render(<SeatRow seat={seat("hub3")} product={TEE} label="Hub 3" registry={{}} locations={[]} destinations={[]} ctx={{ hub3Owner: "concrete" }} viewer={{}} expanded={false} onToggle={() => {}} onDone={() => {}} onFail={() => {}} />);
    expect(out).not.toContain("Owned by");
  });
  it("reads only the product's stock and target rows — no seat owner read", async () => {
    reads.length = 0;
    const ctx = await readSeatingContext(["hub3", "concrete"], "tee");
    expect(ctx).toEqual({ stock: {}, targets: {} });
    expect(reads.sort()).toEqual(["stock/concrete/tee", "stock/hub3/tee", "stock_targets/concrete/tee", "stock_targets/hub3/tee"]);
  });
});

describe("the division panel on the Engine Policy card", () => {
  const POLICY = { shopOnly: { perSize: 2, oneSize: 5 } };
  const KEEPS = { hub3: { products: 0, cells: 0 }, concrete: { products: 3, cells: 4 }, "marathon-pine": { products: 1, cells: 2 } };
  it("shows the shop keep, Hub 3 as footwear only, and Concrete and Pine's counts — no switch", () => {
    const out = render(<ConcreteDivisionPanel policy={POLICY} keeps={KEEPS} />);
    for (const label of ["Kept in the shop, from Central", "2", "5", "footwear only", "Concrete keeps", "Pine keeps", "3 products · 4 sizes", "1 product · 2 sizes"]) expect(out).toContain(label);
    for (const gone of ["Hub 3 keeps", "Switch Hub 3", "Hub 3 keep is", "from Hub 3"]) expect(out).not.toContain(gone);
  });
  it("an old key still on the screen (before the switch-over) shows no Hub 3 control either", () => {
    const out = render(<ConcreteDivisionPanel policy={{ ...POLICY, fromHub3: { perSize: 1, oneSize: 5 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } }} keeps={KEEPS} />);
    expect(out).not.toContain("Switch Hub 3");
    expect(out).not.toContain("from Hub 3");
  });
  it("shows no counts when the census carries none", () => {
    expect(render(<ConcreteDivisionPanel policy={POLICY} />)).not.toContain("Concrete keeps");
  });
  it("history lines read for old and new entries", () => {
    const OLD = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } };
    expect(divisionHistoryLine({ before: { ...OLD }, after: { ...OLD, hub3Keep: { ...OLD.hub3Keep, on: true } } })).toBe("Hub 3 keep off -> on");
    expect(divisionHistoryLine({ before: OLD, after: POLICY })).toBe("fromHub3+hub3Keep+shopOnly -> shopOnly (Hub 3 keep removed)");
    expect(divisionHistoryLine({ before: POLICY, after: null })).toBe("shop keep 2/5 -> off");
  });
});
