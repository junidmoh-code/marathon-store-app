// ─── Missing Products chooser × Pine follows Trophy (Junid, 22 Nov 2026), rendered
// What Junid saw on the live screen, and what the screen says now:
//   • a card reading "28 units at Central" said, with Pine picked, "Central has
//     none of this product's sizes" and "No refill policy covers this product
//     at Marathon Pine". Both were untrue: Pine ALREADY carried it (an empty,
//     counted cell), so there was nothing left to solve — the panel now says so,
//     and that its refills wait for Pine's count;
//   • a no-size product Central holds is sendable to Pine, and the number is
//     Trophy's (Pine follows Trophy), not the division's 5;
//   • the Solve button never reads "Close".
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: () => Promise.resolve({ committed: true, snapshot: { val: () => null } }),
}));
vi.mock("./solvedLogStore", () => ({
  useSolvedLog: () => ({ entries: [], settled: true, error: null, hasMore: false, loadMore: () => {} }),
  saveSolvedRows: vi.fn(async () => {}), markSolvedUndone: vi.fn(async () => {}),
}));
vi.mock("../concrete/concreteStore", () => ({ markConcreteProduct: vi.fn(), restoreMarathonListing: vi.fn() }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "admin", displayName: "Junid" }, isSuperAdmin: true }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");

// The live shape on 22 Nov 2026: Marathon's four routes in config, Pine and
// Concrete routed by the registry (its seed), the division key on.
const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: { hub2: { L: 3, M: 3, S: 2, XL: 2 }, "marathon-pe": { L: 2, M: 2, S: 2, XL: 1 }, trophy: { L: 2, M: 2, S: 2, XL: 1 } },
  categoryPolicy: {
    sunglasses: { hub2: { target: 5, minQty: 1, reorderPoint: 1 }, trophy: { target: 5, minQty: 3, reorderPoint: 3 } },
    bags: { hub2: { target: 4, minQty: 2, reorderPoint: 0 }, trophy: { target: 2, minQty: 1, reorderPoint: 0 } },
  },
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
};
const LINK = { "marathon-pine": "trophy" };
const RAYBAN = { id: "ray1", name: "Ray-ban sunglasses black g-15 lens #1", categoryKey: "sunglasses", category: "Accessories", sizes: ["_"] };
const BAG = { id: "bag1", name: "Sling bag black", categoryKey: "bags", category: "Accessories", sizes: [] };
const TEE = { id: "tee1", name: "Essentials Tee Olive", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "XL"] };
const WRONG = { id: "tee2", name: "YL Bolling BS-511", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["M", "L"] };
const cell = (qty, extra = {}) => ({ qty, v: 1, mv: "m1", state: "live", ...extra });
const counted = (qty) => cell(qty, { trusted: true, trustedVia: "solve", lastType: "count" });

const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const textOf = (tree) => flat(tree.toJSON());
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const labelOf = (b) => flat(TestRenderer.create(<>{b.props.children}</>).toJSON());
const buttonExactly = (tree, label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);
const boxes = (tree) => buttonsOf(tree).filter((b) => b.props.role === "checkbox");
const box = (tree, name) => boxes(tree).find((b) => (b.children || []).join("").replace(/^✓ /, "") === name);
const confirmBtn = (tree) => buttonsOf(tree).find((b) => b.props["data-action"] === "confirm-solve");

function render({ products, stock, config = CONFIG }) {
  paths["config/refillEngine"] = config;
  // As the screen builds it (MissingProductsScreen): the division's list, with
  // the engine config, so a shop kept from Central lists what it is missing.
  const list = computeMissingProducts({ allStock: stock, products, section: 1, centralFed: config });
  let tree;
  const Host = () => {
    const [solved, setSolved] = React.useState([]);
    const [resolving, setResolving] = React.useState({});
    return <NetworkTransfer products={products} category="clothing" view="list" allStock={stock} cards={list}
      targets={{}} targetsSettled targetsError={false} section={1}
      solvedSession={solved} setSolvedSession={setSolved} resolving={resolving} setResolving={setResolving} />;
  };
  act(() => { tree = TestRenderer.create(<Host />); });
  return tree;
}
// Open the card's Solve panel and pick a shop (Pine and Concrete are a switch).
async function openAt(tree, shop) {
  await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
  const b = box(tree, shop);
  if (b && b.props["aria-checked"] !== true) await act(async () => { b.props.onClick(); });
  await act(async () => {});
}

beforeEach(() => {
  updateMock.mockClear(); pushN = 0;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  __resetNetworkForTests();
});

describe("a no-size product Central holds is sendable to Pine", () => {
  it("28 one-size units at Central, Pine holds none: 5 go to Pine, and the panel says whose number that is", async () => {
    const tree = render({ products: [RAYBAN], stock: { central: { ray1: { _: cell(28) } } }, config: { ...CONFIG, policyFollow: LINK } });
    expect(textOf(tree)).toContain("Central holds 28 units.");
    await openAt(tree, "Pine");
    const t = textOf(tree);
    expect(t).toMatch(/5 units \(One size×5\) go to Marathon Pine/);
    expect(t).toContain("Marathon Pine keeps this in the shop, the same as Trophy: 5 per design, refilled straight from Central.");
    expect(t).not.toMatch(/Central has none/);
    expect(t).not.toMatch(/No refill policy covers/);
    expect(confirmBtn(tree).props.disabled).toBe(false);
    expect(labelOf(confirmBtn(tree))).toBe("Solve — send 5 to Marathon Pine first");
  });
  it("a product that declares no sizes at all is the one-size cell too", async () => {
    const tree = render({ products: [BAG], stock: { central: { bag1: { _: cell(12) } } }, config: { ...CONFIG, policyFollow: LINK } });
    await openAt(tree, "Pine");
    // Trophy keeps 2 bags per design, so Pine does: 2 are sent, not the division's 5.
    expect(textOf(tree)).toMatch(/2 units \(One size×2\) go to Marathon Pine/);
    expect(textOf(tree)).toContain("the same as Trophy: 2 per design");
    expect(confirmBtn(tree).props.disabled).toBe(false);
  });
  it("with the link off Pine keeps its own 5 per design, and nothing says Trophy", async () => {
    const tree = render({ products: [BAG], stock: { central: { bag1: { _: cell(12) } } } });
    await openAt(tree, "Pine");
    expect(textOf(tree)).toMatch(/5 units \(One size×5\) go to Marathon Pine/);
    expect(textOf(tree)).toContain("Marathon Pine keeps this in the shop: 5 per design, refilled straight from Central.");
    expect(textOf(tree)).not.toMatch(/Trophy/);
  });
  it("sized clothing follows Trophy's size run: XL keeps 1 at Pine, and the line lists the sizes", async () => {
    const tree = render({ products: [TEE], stock: { central: { tee1: { S: cell(9), M: cell(9), XL: cell(9) } } }, config: { ...CONFIG, policyFollow: LINK } });
    await openAt(tree, "Pine");
    expect(textOf(tree)).toMatch(/5 units \(S×2 · M×2 · XL×1\) go to Marathon Pine/);
    expect(textOf(tree)).toContain("the same as Trophy: S×2 · M×2 · XL×1, refilled straight from Central.");
  });
  it("Concrete is untouched by the link: its own 5 per design, 2 of every size", async () => {
    const tree = render({ products: [BAG], stock: { central: { bag1: { _: cell(12) } } }, config: { ...CONFIG, policyFollow: LINK } });
    await openAt(tree, "Concrete");
    expect(textOf(tree)).toMatch(/5 units \(One size×5\) go to Concrete/);
    expect(textOf(tree)).toContain("Concrete keeps this in the shop: 5 per design, refilled straight from Central.");
  });
});

describe("a shop that already carries the product: Pine picked on a card listed for Concrete", () => {
  // What Junid saw (the Ray-Ban, 20 Nov): Pine ALREADY carried the product —
  // an empty, counted cell, its 5 already requested from Central — so Solve
  // had nothing left to do there, and the panel fell through to "Central has
  // none of this product's sizes" and "No refill policy covers this product at
  // Marathon Pine" beside a card that read 28 units at Central. A card reaches
  // that state today when it is listed for Concrete and Pine is picked.
  const FED = { ...CONFIG, policyFollow: LINK, centralFedClothing: { concrete: 4 } };
  const STOCK = {
    central: { tee1: { S: cell(10), M: cell(10), XL: cell(8) } },
    "marathon-pine": { tee1: { S: counted(0), M: counted(0), XL: counted(0) } },
  };
  it("says Pine already carries it and its refills wait for the count — never 'Central has none', never 'No refill policy'", async () => {
    const tree = render({ products: [TEE], stock: STOCK, config: { ...FED, pausedLocations: { "marathon-pine": true, hub3: true } } });
    expect(textOf(tree)).toContain("Central holds 28 units.");
    await openAt(tree, "Pine");
    const t = textOf(tree);
    expect(t).toContain("Marathon Pine already carries this, so there is nothing to solve. Its refills are paused while Marathon Pine is being counted; when the count is finished the scan asks Central for it.");
    expect(t).not.toMatch(/Central has none/);
    expect(t).not.toMatch(/No refill policy covers/);
    // The confirm is off, and the sentence beside it is the same true one.
    expect(confirmBtn(tree).props.disabled).toBe(true);
    expect(confirmBtn(tree).props.title).toMatch(/already carries this/);
  });
  it("not paused: the scan refills it when the shelf runs low", async () => {
    const tree = render({ products: [TEE], stock: STOCK, config: FED });
    await openAt(tree, "Pine");
    expect(textOf(tree)).toContain("Marathon Pine already carries this, so there is nothing to solve. The scan asks Central for it when the shelf runs low.");
  });
  it("a request already open for Pine is named: nothing more to solve", async () => {
    gets["refill_engine/open/marathon-pine/tee1"] = { S: { qty: 2, source: "central", refillId: "r1", createdAt: "2026-11-20T17:27:04.850Z" }, M: { qty: 2, source: "central", refillId: "r2", createdAt: "2026-11-20T17:27:04.850Z" } };
    gets["refill_requests/r1"] = { status: "open", productId: "tee1", size: "S", qty: 2, requestingLocation: "marathon-pine" };
    gets["refill_requests/r2"] = { status: "open", productId: "tee1", size: "M", qty: 2, requestingLocation: "marathon-pine" };
    const tree = render({ products: [TEE], stock: STOCK, config: FED });
    await openAt(tree, "Pine");
    expect(textOf(tree)).toContain("Marathon Pine already carries this and 4 are already requested from Central for it, so there is nothing more to solve.");
  });
  it("the same card can still be solved to Concrete, which does not carry it", async () => {
    const tree = render({ products: [TEE], stock: STOCK, config: FED });
    await openAt(tree, "Concrete");
    expect(textOf(tree)).toMatch(/6 units \(S×2 · M×2 · XL×2\) go to Concrete/);
    expect(confirmBtn(tree).props.disabled).toBe(false);
  });
  it("Central's units sit in a size the product does not list: the panel says which, not 'none'", async () => {
    const tree = render({ products: [WRONG], stock: { central: { tee2: { XL: cell(3) } } }, config: { ...CONFIG, policyFollow: LINK } });
    await openAt(tree, "Pine");
    expect(textOf(tree)).toContain("Central holds 3 units, but in a size this product does not list (XL) — nothing to send to Marathon Pine until the product's sizes are corrected.");
  });
});

describe("the Solve button's label", () => {
  it("reads Solve when closed; while the chooser is open nothing reads Close — the way out is Cancel and the action names the shop", async () => {
    const tree = render({ products: [RAYBAN], stock: { central: { ray1: { _: cell(28) } } }, config: { ...CONFIG, policyFollow: LINK } });
    expect(buttonExactly(tree, "Solve")).toBeTruthy();
    expect(buttonExactly(tree, "Close")).toBeUndefined();
    await openAt(tree, "Pine");
    expect(buttonExactly(tree, "Close")).toBeUndefined();
    expect(buttonsOf(tree).some((b) => /close/i.test(labelOf(b)))).toBe(false);
    expect(buttonExactly(tree, "Solve")).toBeUndefined();          // not left there greyed, or relabelled
    expect(buttonExactly(tree, "Cancel")).toBeTruthy();
    expect(labelOf(confirmBtn(tree))).toMatch(/^Solve — /);
    await act(async () => { buttonExactly(tree, "Cancel").props.onClick(); });
    expect(buttonExactly(tree, "Solve")).toBeTruthy();
  });
});
