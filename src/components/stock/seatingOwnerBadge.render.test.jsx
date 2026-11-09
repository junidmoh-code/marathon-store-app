// The owning shop on a Hub 3 non-sneaker seat, and the division keeps on the
// Engine Policy card (Junid, 9 Nov 2026).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const OWNERS = { tee: "concrete" };
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    const m = String(r.path).match(/^refill_engine\/seats\/hub3\/([^/]+)\/owner$/);
    const v = m ? OWNERS[m[1]] : undefined;
    return { exists: () => v !== undefined, val: () => v ?? null };
  },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("./useStock", () => ({ useLocations: () => ({}), useEngineConfig: () => ({}) }));

const { SeatRow } = await import("./SeatingTab.jsx");
const { readSeatingContext } = await import("./seatingStore.js");
const { ConcreteDivisionPanel } = await import("./EnginePolicyCard.jsx");

const seat = (loc) => ({ loc, pid: "tee", reason: "not_seated", label: "Not seated", units: 0, sizes: [], rowCount: 0, offRows: [], seated: false, hasCell: false });
const TEE = { id: "tee", name: "Tee", category: "Clothing", productType: "clothing", sizes: ["M"] };
const SHOE = { id: "shoe", name: "Shoe", category: "Footwear", sizes: ["8"] };
const render = (el) => { let t; act(() => { t = TestRenderer.create(el); }); return JSON.stringify(t.toJSON()); };
const row = (over) => render(<SeatRow seat={seat(over.loc || "hub3")} product={over.product || TEE} label="Hub 3" registry={{}} locations={[]} destinations={[]} ctx={{ hub3Owner: over.owner ?? "concrete" }} viewer={{}} expanded={false} onToggle={() => {}} onDone={() => {}} onFail={() => {}} />);

describe("the owning shop on the Seating tab", () => {
  it("names the shop on a Hub 3 non-sneaker seat", () => {
    const out = row({});
    expect(out).toContain("Owned by ");
    expect(out).toContain("Concrete");
    expect(row({ owner: "marathon-pine" })).toContain("Pine");
  });
  it("says nothing for a sneaker, for another location, or with no owner", () => {
    expect(row({ product: SHOE })).not.toContain("Owned by");
    expect(row({ loc: "concrete" })).not.toContain("Owned by");
    expect(render(<SeatRow seat={seat("hub3")} product={TEE} label="Hub 3" registry={{}} locations={[]} destinations={[]} ctx={{}} viewer={{}} expanded={false} onToggle={() => {}} onDone={() => {}} onFail={() => {}} />)).not.toContain("Owned by");
  });
  it("reads the owner once, keyed, only when Hub 3 is asked for", async () => {
    expect((await readSeatingContext(["hub3"], "tee")).hub3Owner).toBe("concrete");
    expect((await readSeatingContext(["hub2"], "tee")).hub3Owner).toBe(null);
    expect((await readSeatingContext(["hub3"], "none")).hub3Owner).toBe(null);
  });
});

describe("the division keeps on the Engine Policy card", () => {
  const POLICY = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } };
  const KEEPS = { hub3: { products: 7, cells: 9 }, concrete: { products: 3, cells: 4 }, "marathon-pine": { products: 1, cells: 2 } };
  it("shows Hub 3, Concrete and Pine's counts", () => {
    const out = render(<ConcreteDivisionPanel policy={POLICY} busy={false} onSave={() => {}} keeps={KEEPS} />);
    for (const label of ["Hub 3 keeps", "Concrete keeps", "Pine keeps", "7 products · 9 sizes", "3 products · 4 sizes", "1 product · 2 sizes"]) expect(out).toContain(label);
  });
  it("shows no counts when the census carries none", () => {
    expect(render(<ConcreteDivisionPanel policy={POLICY} busy={false} onSave={() => {}} />)).not.toContain("Hub 3 keeps");
  });
});
