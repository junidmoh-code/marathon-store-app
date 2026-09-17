// ─── The Solve, rendered: only the SHOP's request goes out for an in-scope card ─
// Mounts the real NetworkTransfer over the real card build and presses the real
// buttons; the assertion is the ONE multi-path update the Solve writes. Out of
// scope cards are proven byte-for-byte on the old path from the same screen.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: (r, fn) => Promise.resolve(txnOutcome(r.path, fn)),
}));
// runTransaction outcomes by path: default = committed; a test can make one
// path abort (Central got to that request first).
const abortPaths = new Set();
const txnPaths = [];
const txnOutcome = (path, fn) => { txnPaths.push(path); return abortPaths.has(path) ? { committed: false } : { committed: true, snapshot: { val: () => fn(null) } }; };
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

// THE PATH AS IT WOULD RUN: firstBatchEligible is forced `enabled: true` here
// because the live default is OFF (FIRST_BATCH_ENABLED — incident 2026-09-17).
// The default's own behaviour — the old Solve, byte-for-byte — is proven in
// firstBatchOff.render.test.jsx against the real flag.
vi.mock("./firstBatchCore", async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, firstBatchEligible: (a) => m.firstBatchEligible({ ...a, enabled: true }) };
});

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");

const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: {
    hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
    "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  categoryPolicy: { bags: { hub2: { target: 4, minQty: 2 }, trophy: { target: 2, minQty: 1 } } },
};
const TEE = "tee1";
const TWIN = "tee2";
const BAG = "bag1";
const PRODUCTS = [
  { id: TEE, name: "Essentials Tee Olive", productType: "clothing", subcategory: "T-Shirts", sizes: ["S", "M", "L"] },
  { id: TWIN, name: "Essentials Tee Olive", productType: "clothing", subcategory: "T-Shirts", sizes: ["S", "M", "L"] },
  { id: BAG, name: "Gym Bag", productType: "clothing", categoryKey: "bags", subcategory: "Bags", sizes: ["_"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const STOCK = {
  central: {
    [TEE]: { S: cell(4), M: cell(4), L: cell(0) },
    [TWIN]: { S: cell(1), M: cell(0), L: cell(0) },
    [BAG]: { _: cell(10) },
  },
};

// Every rendered string, flattened in order — what the operator reads.
const flat = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(flat).join("");
  return flat(n.children);
};
const textOf = (tree) => flat(tree.toJSON());
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonSaying = (tree, needle) =>
  buttonsOf(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && c.includes(needle)));
const buttonExactly = (tree, label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);

function render({ products = PRODUCTS, stock = STOCK, targets = {}, category = "clothing" } = {}) {
  const cards = computeMissingProducts({ allStock: stock, products });
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <NetworkTransfer products={products} category={category} allStock={stock} cards={cards}
        targets={targets} targetsSettled={true} targetsError={false} />
    );
  });
  return tree;
}
// Open the Solve panel of the FIRST card, pick a store, confirm.
async function solve(tree, store) {
  await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
  if (store) await act(async () => { buttonExactly(tree, store).props.onClick(); });
  const confirm = buttonSaying(tree, "Solve — ");
  await act(async () => { await confirm.props.onClick(); });
  return confirm;
}
const onlyProduct = (id) => PRODUCTS.filter((p) => p.id === id);

beforeEach(() => {
  updateMock.mockClear();
  pushN = 0;
  abortPaths.clear();
  txnPaths.length = 0;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["config/refillEngine"] = CONFIG;
});

describe("in scope — a Central-stranded tee solved at Marathon PE", () => {
  it("the panel says what goes to the shop now and that Hub 2 follows; the button names the shop", () => {
    const tree = render({ products: onlyProduct(TEE) });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/4 units \(S×2 · M×2\) go to Marathon PE first — requested from Central now; Central picks it from Source › Marathon at the next release/);
    expect(text).toMatch(/Hub 2's own ~5 units follow automatically after Marathon PE's request is fulfilled/);
    expect(text).toMatch(/L: Central has none — seeded at Hub 2 \+ Marathon PE/);
    expect(text).not.toMatch(/seeds Hub 2 \+/);
    expect(buttonSaying(tree, "Solve — send 4 to Marathon PE first")).toBeTruthy();
  });

  it("ONE atomic update: shop seeds for every size, NO Hub 2 seed for a size Central can send, one shop request per such size", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = updateMock.mock.calls[0][1];
    const keys = Object.keys(upd).sort();
    expect(keys).toEqual([
      "refill_requests/req1", "refill_requests/req2",
      "stock/hub2/tee1/L",                                   // the size Central lacks: old path
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
    expect(upd["stock/marathon-pe/tee1/S"]).toEqual({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: new Date(NOW).toISOString(), updatedBy: "u1" });
    for (const k of ["refill_requests/req1", "refill_requests/req2"]) {
      expect(upd[k]).toMatchObject({ productId: TEE, requestingLocation: "marathon-pe", status: "open", qty: 2, createdFrom: { firstBatch: true, source: "central", store: "marathon-pe", hub: "hub2", by: "u1" } });
      expect(upd[k].createdFrom.solveId).toBe(`fb_${TEE}_${NOW.toString(36)}`);
    }
    expect([upd["refill_requests/req1"].size, upd["refill_requests/req2"].size].sort()).toEqual(["M", "S"]);
    // nothing else was written — no order, no lock (the server claims that)
    expect(keys.some((k) => k.startsWith("orders/") || k.startsWith("refill_engine/"))).toBe(false);
    expect(textOf(tree)).toMatch(/4 units requested from Central for Marathon PE — Central picks it from Source › Marathon at the next release/);
  });

  it("the shop's policy quantity is capped by Central: the twin has 1 S → ×1, and its M/L follow the old path", async () => {
    const tree = render({ products: onlyProduct(TWIN) });
    await solve(tree, "Trophy");
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual([
      "refill_requests/req1",
      "stock/hub2/tee2/L", "stock/hub2/tee2/M",
      "stock/trophy/tee2/L", "stock/trophy/tee2/M", "stock/trophy/tee2/S",
    ]);
    expect(upd["refill_requests/req1"]).toMatchObject({ productId: TWIN, size: "S", qty: 1, requestingLocation: "trophy" });
  });

  it("the product LEAVES the unsolved tab on the shop seed alone — before Hub 2's batch exists", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    const upd = updateMock.mock.calls[0][1];
    const after = { central: STOCK.central, "marathon-pe": { [TEE]: {} }, hub2: { [TEE]: {} } };
    for (const [k, v] of Object.entries(upd)) {
      const [root, loc, pid, size] = k.split("/");
      if (root === "stock") after[loc][pid][size] = v;
    }
    // Hub 2 holds ONLY the normal-path size L; the shop holds all three.
    expect(Object.keys(after.hub2[TEE])).toEqual(["L"]);
    expect(computeMissingProducts({ allStock: after, products: onlyProduct(TEE) })).toEqual([]);
    // …and even with NO Hub 2 node at all the card is gone (the shop alone carries it)
    delete after.hub2;
    expect(computeMissingProducts({ allStock: after, products: onlyProduct(TEE) })).toEqual([]);
  });

  it("duplicate-name twins: solving one writes only its own productId's paths", async () => {
    const tree = render({ products: PRODUCTS.filter((p) => p.id === TEE || p.id === TWIN) });
    await solve(tree);   // first card = the one with more units (tee1: 8 vs tee2: 1)
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).every((k) => k.startsWith("refill_requests/") || k.includes(`/${TEE}/`))).toBe(true);
    expect(Object.values(upd).filter((v) => v.productId).every((v) => v.productId === TEE)).toBe(true);
  });
});

describe("mapped categories and explicit rows — on the path since 2026-09-17, with their own policies", () => {
  it("a one-size mapped category (bags: map hub2 4 / trophy 2): the SHOP's map quantity goes first, one '_' request, no Hub 2 seed", async () => {
    const tree = render({ products: onlyProduct(BAG) });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/2 units \(One size×2\) go to Trophy first — requested from Central now; Central picks it from Source › Trophy/);
    expect(text).toMatch(/Hub 2's own ~4 units follow automatically after Trophy's request is fulfilled/);
    expect(text).not.toMatch(/seeds Hub 2 \+/);
    await act(async () => { await buttonSaying(tree, "Solve — send 2 to Trophy first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual(["refill_requests/req1", "stock/trophy/bag1/_"]);
    expect(upd["refill_requests/req1"]).toMatchObject({ productId: BAG, size: "_", qty: 2, requestingLocation: "trophy", status: "open", createdFrom: { firstBatch: true, source: "central", store: "trophy", hub: "hub2" } });
  });
  it("the map names Trophy only: the Marathon PE chip is offered but its confirm is blocked with the no-policy sentence, and nothing is written", async () => {
    const tree = render({ products: onlyProduct(BAG) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => { buttonExactly(tree, "Marathon PE").props.onClick(); });
    expect(textOf(tree)).toMatch(/No refill policy covers this product at Marathon PE/);
    const confirm = buttonSaying(tree, "Solve — ");
    expect(confirm.props.disabled).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });
  it("an explicit Hub 2 row is Hub 2's policy, not an exclusion: the tee still takes the path and the shop's run quantity", async () => {
    const tree = render({ products: onlyProduct(TEE), targets: { hub2: { [TEE]: { M: { target: 6 } } } } });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    // Hub 2's estimate reads the ROW for M (6) and the run for S (2)
    expect(textOf(tree)).toMatch(/Hub 2's own ~8 units follow automatically/);
    await act(async () => { await buttonSaying(tree, "Solve — send 4 to Marathon PE first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual([
      "refill_requests/req1", "refill_requests/req2",
      "stock/hub2/tee1/L",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
    expect([upd["refill_requests/req1"].qty, upd["refill_requests/req2"].qty]).toEqual([2, 2]);
  });
});

describe("location history nominates the shop (the operator can still switch)", () => {
  // Three other t-shirts are kept at Trophy, none at PE: the category's own
  // placement says Trophy. The tee itself has no shop cell (it is a card).
  const TROPHY_TEES = [1, 2, 3].map((n) => ({ id: `tt${n}`, name: `Tee ${n}`, productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] }));
  const KEYED_TEE = { ...PRODUCTS[0], categoryKey: "t-shirts" };
  const stockWithHistory = { ...STOCK, trophy: { tt1: { M: cell(1) }, tt2: { M: cell(0) }, tt3: { M: cell(2) } } };
  it("the panel opens on the shop history names, says why, and the write goes there", async () => {
    const tree = render({ products: [KEYED_TEE, ...TROPHY_TEES], stock: stockWithHistory });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/Trophy first — where 3 of 3 t-shirts lines are kept\./);
    expect(text).toMatch(/go to Trophy first/);
    await act(async () => { await buttonSaying(tree, "Solve — send 4 to Trophy first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    expect(upd["refill_requests/req1"].requestingLocation).toBe("trophy");
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual([
      "stock/hub2/tee1/L", "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S",
    ]);
  });
  it("the product's OWN row at Marathon PE outranks the category's Trophy placement", () => {
    const tree = render({ products: [KEYED_TEE, ...TROPHY_TEES], stock: stockWithHistory, targets: { "marathon-pe": { [TEE]: { M: { target: 2 } } } } });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/Marathon PE first — this product has its own target row there\./);
    expect(text).toMatch(/go to Marathon PE first/);
  });
  it("no history → today's default (Marathon PE, the first store with qualifying sizes) and NO sentence", () => {
    const tree = render({ products: onlyProduct(TEE) });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).not.toMatch(/(Marathon PE|Trophy) first — (this product|where |a colourway|\d+ colourway)/);
    expect(text).toMatch(/go to Marathon PE first/);
  });
  it("the operator's tap still wins: history says Trophy, the tap says Marathon PE, the request goes to Marathon PE", async () => {
    const tree = render({ products: [KEYED_TEE, ...TROPHY_TEES], stock: stockWithHistory });
    await solve(tree, "Marathon PE");
    expect(updateMock.mock.calls[0][1]["refill_requests/req1"].requestingLocation).toBe("marathon-pe");
  });
});

describe("Central's open reservations are netted out — a unit the engine already promised is never asked for twice", () => {
  const lock = (qty, source) => ({ qty, createdAt: "t", runId: "scan-1", refillId: "eng1", ...(source ? { source } : {}) });
  it("an engine hub2<-central lock on M (3 of Central's 4) → M×1; a hub2->shop lock is not a Central reservation; the write matches the panel", async () => {
    gets[`refill_engine/open/hub2/${TEE}`] = { M: lock(3) };                  // route hub2→central
    gets[`refill_engine/open/trophy/${TEE}`] = { S: lock(9, "hub2") };        // Hub 2 → Trophy: not Central's
    gets["refill_requests/eng1"] = { status: "open" };                        // a LIVE lock has an open request behind it
    const tree = render({ products: onlyProduct(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });   // flushes the lock read
    const text = textOf(tree);
    expect(text).toMatch(/3 units \(S×2 · M×1\) go to Marathon PE first/);
    expect(text).not.toMatch(/One moment — checking/);
    await act(async () => { await buttonSaying(tree, "Solve — send 3 to Marathon PE first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    const reqs = Object.keys(upd).filter((k) => k.startsWith("refill_requests/")).map((k) => upd[k]);
    expect(reqs.map((r) => [r.size, r.qty]).sort()).toEqual([["M", 1], ["S", 2]]);
  });
  it("a size the engine has FULLY promised takes the normal path (Hub 2 + shop seeded, no request for it)", async () => {
    gets[`refill_engine/open/hub2/${TEE}`] = { M: lock(4), S: lock(4) };
    gets["refill_requests/eng1"] = { status: "open" };
    const tree = render({ products: onlyProduct(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(textOf(tree)).toMatch(/S · M · L: Central has none — seeded at Hub 2 \+ Marathon PE|seeds Hub 2 \+ Marathon PE at qty 0/);
    await act(async () => { await buttonSaying(tree, "Solve — ").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).some((k) => k.startsWith("refill_requests/"))).toBe(false);
    expect(Object.keys(upd).sort()).toEqual([
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
  });
  it("the confirm waits for the lock read: before it settles the button is gated and says so", () => {
    const tree = render({ products: onlyProduct(TEE) });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });   // sync: the read is still in flight
    expect(textOf(tree)).toMatch(/One moment — checking what Central has already promised/);
    expect(buttonSaying(tree, "Solve — send").props.disabled).toBe(true);
  });
  it("the write re-reads the lock table LIVE: a lock that lands after the panel opened is honoured", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(textOf(tree)).toMatch(/4 units \(S×2 · M×2\) go to Marathon PE first/);
    gets[`refill_engine/open/hub2/${TEE}`] = { M: lock(3) };            // lands now
    gets["refill_requests/eng1"] = { status: "open" };
    await act(async () => { await buttonSaying(tree, "Solve — send 4 to Marathon PE first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    const reqs = Object.keys(upd).filter((k) => k.startsWith("refill_requests/")).map((k) => upd[k]);
    expect(reqs.map((r) => [r.size, r.qty]).sort()).toEqual([["M", 1], ["S", 2]]);
    expect(textOf(tree)).toMatch(/3 units requested from Central for Marathon PE/);
  });
});

describe("a DEAD lock is not a reservation (Sonnet + adversarial review, PR #608)", () => {
  const lock = (qty, refillId) => ({ qty, createdAt: "t", runId: "first_batch:fb_tee1_old", refillId, source: "central" });
  it("an undo-then-re-solve: the undone solve's own lock (its request cancelled) is ignored, and the shop asks its full policy quantity", async () => {
    gets[`refill_engine/open/marathon-pe/${TEE}`] = { M: lock(2, "old1"), S: lock(2, "old2") };
    gets["refill_requests/old1"] = { status: "cancelled", cancelReason: "solve_undone" };
    gets["refill_requests/old2"] = null;                                    // the row is gone altogether
    const tree = render({ products: onlyProduct(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(textOf(tree)).toMatch(/4 units \(S×2 · M×2\) go to Marathon PE first/);
    await act(async () => { await buttonSaying(tree, "Solve — send 4 to Marathon PE first").props.onClick(); });
    const reqs = Object.values(updateMock.mock.calls[0][1]).filter((v) => v.productId);
    expect(reqs.map((r) => [r.size, r.qty]).sort()).toEqual([["M", 2], ["S", 2]]);
  });
  it("a sibling shop's lock whose request was FULFILLED minutes ago (Central's cell already decremented) is not subtracted a second time", async () => {
    gets[`refill_engine/open/trophy/${TEE}`] = { M: { qty: 3, runId: "scan-1", refillId: "f1", source: "central" } };
    gets["refill_requests/f1"] = { status: "fulfilled" };
    const tree = render({ products: onlyProduct(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(textOf(tree)).toMatch(/4 units \(S×2 · M×2\) go to Marathon PE first/);
  });
});

describe("the history line and the operator's tap agree (spec review, PR #608)", () => {
  const TROPHY_TEES = [1, 2, 3].map((n) => ({ id: `tt${n}`, name: `Tee ${n}`, productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] }));
  const KEYED_TEE = { ...PRODUCTS[0], categoryKey: "t-shirts" };
  it("after tapping the other shop the line says what history suggested and what was chosen — never 'X first' over a panel sending to Y", async () => {
    const tree = render({ products: [KEYED_TEE, ...TROPHY_TEES], stock: { ...STOCK, trophy: { tt1: { M: cell(1) }, tt2: { M: cell(0) }, tt3: { M: cell(2) } } } });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => { buttonExactly(tree, "Marathon PE").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/Trophy was suggested — where 3 of 3 t-shirts lines are kept\. You chose Marathon PE\./);
    expect(text).not.toMatch(/Trophy first/);
    expect(text).toMatch(/go to Marathon PE first/);
  });
});

describe("a sneaker or slide that reaches this list is never seeded (adversarial review, PR #608)", () => {
  // A clothing-TYPED record carrying a footwear key: the tab admits it
  // (isClothing wins), the first-batch path refuses it, and the OLD path's
  // Hub 2 seed would arm its carriedOnly Hub 2 policy — so Solve is blocked.
  const MISTYPED = { id: "sn9", name: "Air Force 1", productType: "clothing", categoryKey: "sneakers", sizes: ["S", "M"] };
  it("the row says why, the button is disabled, and nothing is written", async () => {
    const tree = render({ products: [MISTYPED], stock: { central: { sn9: { S: cell(4), M: cell(4) } } } });
    expect(textOf(tree)).toMatch(/Solve unavailable — this is a sneaker or slide — it is refilled from the Sneakers tab, never seeded here\./);
    const solveBtn = buttonExactly(tree, "Solve");
    expect(solveBtn.props.disabled).toBe(true);
    await act(async () => { solveBtn.props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
    expect(Object.keys(gets).some((k) => k.startsWith("stock/"))).toBe(false);
  });
});

describe("a per-location SIZE MAP category (soccer-jerseys live shape) solves with the map's own numbers", () => {
  const rows = (t) => Object.fromEntries(["S", "M", "L", "XL", "XXL", "XXXL"].map((k) => [k, { target: t, minQty: 1, reorderPoint: 1 }]));
  const JERSEY = { id: "sj1", name: "Real Madrid Home", productType: "clothing", categoryKey: "soccer-jerseys", subcategory: "Jerseys", sizes: ["S", "M", "L"] };
  it("the shop gets the map's 2 per size Central can send, Hub 2's estimate is the map's 4, and a size with no units anywhere follows the normal path", async () => {
    paths["config/refillEngine"] = { ...CONFIG, categoryPolicy: { "soccer-jerseys": { perSize: true, hub2: { sizes: rows(4) }, "marathon-pe": { sizes: rows(2) } } } };
    const tree = render({ products: [JERSEY], stock: { central: { sj1: { S: cell(5), M: cell(1), L: cell(0) } } } });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/3 units \(S×2 · M×1\) go to Marathon PE first/);
    expect(text).toMatch(/Hub 2's own ~8 units follow automatically/);
    await act(async () => { await buttonSaying(tree, "Solve — send 3 to Marathon PE first").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    const reqs = Object.values(upd).filter((v) => v.productId);
    expect(reqs.map((r) => [r.size, r.qty]).sort()).toEqual([["M", 1], ["S", 2]]);
    // L has zero units anywhere → a dead 0 at both legs → not a qualifying size → not seeded at all
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual(["stock/marathon-pe/sj1/M", "stock/marathon-pe/sj1/S"]);
  });
});

describe("out of scope — byte-for-byte the old Solve", () => {
  const oldShape = (upd, pid, sizes, store) => {
    const want = [];
    for (const s of sizes) { want.push(`stock/hub2/${pid}/${s}`); want.push(`stock/${store}/${pid}/${s}`); }
    expect(Object.keys(upd).sort()).toEqual(want.sort());
    expect(Object.keys(upd).some((k) => k.startsWith("refill_requests/"))).toBe(false);
  };
  it("no routes in config (a shop not routed via Hub 2) → old path", async () => {
    paths["config/refillEngine"] = { ...CONFIG, routes: { ...CONFIG.routes, "marathon-pe": "hub3", trophy: "hub3" } };
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    oldShape(updateMock.mock.calls[0][1], TEE, ["S", "M", "L"], "marathon-pe");
  });
  it("a hub-stranded card (Only in Hub 2) → old path: store seed only, no request", async () => {
    const stock = { hub2: { [TEE]: { S: cell(3), M: cell(3), L: cell(3) } } };
    const tree = render({ products: onlyProduct(TEE), stock });
    await solve(tree);
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual(["stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S"]);
  });
  it("Central has NONE of any size → old path even for an in-scope product", async () => {
    // (a card needs units at Central, so give it units in a size the store has no target for)
    const stock = { central: { [TEE]: { XXXXL: cell(3), S: cell(0) } } };
    const tree = render({ products: [{ ...onlyProduct(TEE)[0], sizes: ["S"] }], stock });
    await solve(tree);
    oldShape(updateMock.mock.calls[0][1], TEE, ["S"], "marathon-pe");
  });
});

describe("the undo strip after a first-batch Solve", () => {
  const undoButton = (tree) => buttonExactly(tree, "Undo");
  const stripText = (tree) => textOf(tree);
  it("undo cancels the open requests (CAS) and removes the seeds; a request Central already started stands, and the strip says so", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    expect(stripText(tree)).toMatch(/Solved — Essentials Tee Olive: 4 units requested from Central for Marathon PE/);
    // Live rows: req1 still open and untouched; req2 open too — but Central
    // wins the race on req2 (its cancel CAS aborts).
    gets["refill_requests/req1"] = { status: "open", size: "S", qty: 2 };
    gets["refill_requests/req2"] = { status: "open", size: "M", qty: 2 };
    abortPaths.add("refill_requests/req2");
    await act(async () => { await undoButton(tree).props.onClick(); });
    const text = stripText(tree);
    expect(text).toMatch(/4 of 4 seeded cells removed/);
    expect(text).toMatch(/Central had already started on size M — that request stands/);
  });
  it("a RETRY after a partial undo: its own landed cancel is done — no CAS on it, no blocker, and the seeds are removed", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    gets["refill_requests/req1"] = { status: "cancelled", cancelReason: "solve_undone", size: "S", qty: 2 };
    gets["refill_requests/req2"] = { status: "open", size: "M", qty: 2 };
    txnPaths.length = 0;
    await act(async () => { await undoButton(tree).props.onClick(); });
    expect(txnPaths.filter((p) => p.startsWith("refill_requests/"))).toEqual(["refill_requests/req2"]);
    expect(txnPaths.filter((p) => p.startsWith("stock/"))).toHaveLength(4);
    expect(stripText(tree)).not.toMatch(/can no longer be undone|stands/);
  });
  it("undo is refused outright when a request is no longer open, and nothing is written", async () => {
    const tree = render({ products: onlyProduct(TEE) });
    await solve(tree);
    updateMock.mockClear();
    gets["refill_requests/req1"] = { status: "fulfilled", size: "S", qty: 2 };
    gets["refill_requests/req2"] = { status: "open", size: "M", qty: 2 };
    await act(async () => { await undoButton(tree).props.onClick(); });
    expect(stripText(tree)).toMatch(/Central has already sent the S request for Marathon PE — this solve can no longer be undone/);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
