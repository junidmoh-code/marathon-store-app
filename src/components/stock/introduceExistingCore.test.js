// ─── INTRODUCE EXISTING × CATEGORY POLICY — the stray-row guard ──────────────
// A category-mapped product is governed with NO explicit row, so "no row" no
// longer means "unintroduced". Before this guard, the one-tap migration would
// stamp generic standard-run rows onto a mapped product — rows that OUTRANK
// the category map forever (explicit > map) and quietly disable its off
// switch. Both layers refuse: the classifier hides mapped products, and the
// writer re-applies the rule against its own config even for a stale list.
// (Sonnet review, PR #352.)
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMock = vi.fn(() => Promise.resolve());
const gets = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-13T10:00:00.000Z" }));

const { computeUnintroduced, migrateToEngine } = await import("./introduceExistingCore.js");

const POLICY = {
  "fitted-caps": {
    perSize: true,
    "marathon-pe": { target: 2, reorderPoint: 0 },
    hub2: { target: 5, reorderPoint: 0 },
  },
};
const cell = (qty) => ({ qty, v: 1 });
const PRODUCTS = new Map([
  ["fc1", { id: "fc1", name: "TC fitted cap", productType: "clothing", categoryKey: "fitted-caps", sizes: ["S", "M"] }],
  ["tee1", { id: "tee1", name: "Nike Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M", "L"] }],
]);
const STOCK = {
  "marathon-pe": { fc1: { M: cell(1) }, tee1: { M: cell(2) } },
  hub2: {}, trophy: {}, central: {},
};

beforeEach(() => { updateMock.mockClear(); for (const k of Object.keys(gets)) delete gets[k]; });

describe("computeUnintroduced — a mapped product is governed, not unintroduced", () => {
  it("hides the mapped product and keeps the unmapped one, exactly as before", () => {
    const items = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"], POLICY);
    expect(items.map((i) => i.pid)).toEqual(["tee1"]);
  });
  it("without a map (or with a malformed one) behaviour is byte-for-byte the old one", () => {
    const before = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"]);
    expect(before.map((i) => i.pid).sort()).toEqual(["fc1", "tee1"]);
    const garbled = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"], "on");
    expect(garbled.map((i) => i.pid).sort()).toEqual(["fc1", "tee1"]);
  });
  it("items carry categoryKey so the writer can re-check on its own", () => {
    const items = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"]);
    expect(items.find((i) => i.pid === "fc1").categoryKey).toBe("fitted-caps");
  });
});

describe("migrateToEngine — the writer refuses mapped items even from a stale list", () => {
  it("writes rows for the unmapped item ONLY, and reports the mapped one as skipped", async () => {
    gets["stock_targets"] = {};
    // A STALE list computed before the map was armed: both items present.
    const items = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"]);
    const res = await migrateToEngine(items, { config: { categoryPolicy: POLICY } });
    expect(res.done).toBe(1);
    expect(res.skippedTaken).toBe(1);
    const keys = updateMock.mock.calls.flatMap((c) => Object.keys(c[1]));
    expect(keys.some((k) => k.includes("/fc1/"))).toBe(false);   // not one stray row
    expect(keys.some((k) => k.includes("/tee1/"))).toBe(true);
  });
});

describe("migrateToEngine — the LIVE policy re-read beats a config armed after render", () => {
  it("refuses a mapped item even when the handed config predates the arming", async () => {
    gets["stock_targets"] = {};
    gets["config/refillEngine/categoryPolicy"] = POLICY;   // armed AFTER the screen rendered
    const items = computeUnintroduced(STOCK, {}, PRODUCTS, ["marathon-pe", "trophy", "hub2"]);
    const res = await migrateToEngine(items, { config: {} });   // stale config: no map
    expect(res.done).toBe(1);
    expect(res.skippedTaken).toBe(1);
    const keys = updateMock.mock.calls.flatMap((c) => Object.keys(c[1]));
    expect(keys.some((k) => k.includes("/fc1/"))).toBe(false);
  });
});
