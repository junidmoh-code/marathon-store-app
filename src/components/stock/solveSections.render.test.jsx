// ─── The Solve, rendered: ONE screen, both sections, one confirm ─────────────
// Mounts the real NetworkTransfer over the real card build and presses the
// real buttons; the assertion is the ONE multi-path update the confirm writes.
//   • a Section 1 block and a Section 2 block, a tick per store;
//   • each ticked store's excess goes to ITS OWN hub — Hub 2 for Marathon PE
//     and Trophy, Hub 3 for Pine and Concrete (or the Concrete Stockroom
//     where the owner mapped the category);
//   • a store that is not live is shown, cannot be ticked, and nothing is
//     written for it;
//   • Central short across two sections: dealt in tick order, shown before
//     the confirm, never the same unit twice.
// (firstBatchSolve.render.test.jsx proves the single Section 2 store is,
// write for write, the Solve this replaced.)
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-10-02T10:00:00.000Z");
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
  runTransaction: (r, fn) => { txnPaths.push(r.path); return Promise.resolve({ committed: fn(TXN_CELL[r.path] ?? null) !== undefined, snapshot: { val: () => null } }); },
}));
const txnPaths = [];
const TXN_CELL = {};
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "admin" }, isSuperAdmin: true };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
const applyMovementMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");

// /network with Section 1 counted in and live.
const S1_LIVE = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true }, "concrete-stockroom": { live: true } } };
// /network with Section 1's switches both OFF (the seed before 7 Oct 2026).
const OFF = { solve: false, autoRefill: "off" };
const S1_DARK = { locations: { "marathon-pine": OFF, concrete: OFF, hub3: OFF, "concrete-stockroom": OFF } };
// The engine config: Section 2 has its own numbers; Section 1 has NONE — it
// follows its templates (Pine and Concrete like Marathon PE, Hub 3 like Hub 2).
const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", hub3: "central", "marathon-pe": "hub2", trophy: "hub2", "marathon-pine": "hub3", concrete: "hub3" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: {
    hub2: { L: 3, M: 3, S: 2 },
    "marathon-pe": { L: 2, M: 2, S: 2 },
    trophy: { L: 2, M: 2, S: 2 },
  },
};
const TEE = "tee1";
const PRODUCTS = [{ id: TEE, name: "Essentials Tee Olive", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"] }];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const stockWith = (central) => ({ central: { [TEE]: central } });
const PLENTY = { S: cell(9), M: cell(9), L: cell(9) };

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
const boxes = (tree) => buttonsOf(tree).filter((b) => b.props.role === "checkbox");
const boxLabel = (b) => (b.children || []).join("").replace(/^✓ /, "");
const box = (tree, name) => boxes(tree).find((b) => boxLabel(b) === name);
const tick = (tree, name) => act(() => { box(tree, name).props.onClick(); });
const ticked = (tree) => boxes(tree).filter((b) => b.props["aria-checked"]).map(boxLabel);

function render({ stock = stockWith(PLENTY), products = PRODUCTS, cards } = {}) {
  const list = cards || computeMissingProducts({ allStock: stock, products });
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <NetworkTransfer products={products} category="clothing" allStock={stock} cards={list}
        targets={{}} targetsSettled={true} targetsError={false} />
    );
  });
  return tree;
}
const open = async (tree) => { await act(async () => { buttonExactly(tree, "Solve").props.onClick(); }); };
const confirm = async (tree) => { await act(async () => { await buttonSaying(tree, "Solve — ").props.onClick(); }); };
const written = () => updateMock.mock.calls[0][1];
const requests = (upd) => Object.entries(upd).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);

beforeEach(() => {
  updateMock.mockClear();
  applyMovementMock.mockClear();
  pushN = 0;
  txnPaths.length = 0;
  for (const k of Object.keys(TXN_CELL)) delete TXN_CELL[k];
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  __resetNetworkForTests();
  paths["config/refillEngine"] = CONFIG;
});

describe("one screen: a block per section, a tick per store", () => {
  it("shows the Section 1 block (Pine, Concrete) and the Section 2 block (Marathon PE, Trophy); the default store is ticked", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    const text = textOf(tree);
    expect(text).toMatch(/Carry atMarathon.*Marathon PE.*Trophy.*Concrete.*Marathon Pine.*Concrete/);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon PE", "Trophy", "Marathon Pine", "Concrete"]);
    expect(ticked(tree)).toEqual(["Marathon PE"]);
    expect(boxes(tree).every((b) => !b.props.disabled)).toBe(true);
  });

  it("SOLVE OFF: Pine and Concrete are shown, cannot be ticked, and say why", async () => {
    paths.network = S1_DARK;
    const tree = render();
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(true);
    expect(box(tree, "Concrete").props.disabled).toBe(true);
    expect(box(tree, "Marathon PE").props.disabled).toBe(false);
    expect(textOf(tree)).toMatch(/Marathon Pine: Solve is off for this store \(Network card\)\./);
    expect(textOf(tree)).toMatch(/Concrete: Solve is off for this store \(Network card\)\./);
  });

  it("SOLVE OFF: nothing is ever written for a store whose Solve is off — the confirm is exactly Marathon PE's", async () => {
    paths.network = S1_DARK;
    const tree = render();
    await open(tree);
    // a tap on the disabled tick changes nothing even if it were delivered
    act(() => { box(tree, "Marathon Pine").props.onClick(); });
    expect(ticked(tree)).toEqual(["Marathon PE"]);
    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const keys = Object.keys(written());
    expect(keys.some((k) => /marathon-pine|concrete|hub3/.test(k))).toBe(false);
    expect(keys.sort()).toEqual([
      "refill_requests/req1", "refill_requests/req2", "refill_requests/req3",
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
  });
});

describe("THE SEED (7 Oct 2026): Pine and Concrete are solvable before their counts are finished", () => {
  it("no /network node: Pine is tickable; its Solve seeds Pine and Hub 3 TRUSTED and asks Central for Pine's first batch", async () => {
    const tree = render();          // no /network node → the seed: Section 1 Solve on, Auto-refill solved
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(false);
    expect(box(tree, "Concrete").props.disabled).toBe(false);
    tick(tree, "Marathon Pine");
    tick(tree, "Marathon PE");      // un-tick the default: Pine alone
    expect(ticked(tree)).toEqual(["Marathon Pine"]);
    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = written();
    const stockKeys = Object.keys(upd).filter((k) => k.startsWith("stock/")).sort();
    expect(stockKeys).toEqual([
      "stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S",
      "stock/marathon-pine/tee1/L", "stock/marathon-pine/tee1/M", "stock/marathon-pine/tee1/S",
    ]);
    // every seed is trusted from the start (stockTrust.js) — the engine may arm it at a "solved" location
    for (const k of stockKeys) expect(upd[k]).toMatchObject({ qty: 0, mv: "seed", trusted: true, trustedVia: "solve" });
    const reqs = requests(upd);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) expect(r).toMatchObject({ requestingLocation: "marathon-pine", status: "open", createdFrom: { firstBatch: true, source: "central", hub: "hub3", store: "marathon-pine" } });
    // nothing for Marathon, nothing across the wall
    expect(Object.keys(upd).some((k) => /hub1|hub2|marathon-pe\//.test(k))).toBe(false);
    expect(applyMovementMock).not.toHaveBeenCalled();
  });
});

describe("both sections in ONE confirm — each store's excess goes to its own hub", () => {
  it("Marathon PE + Pine: ONE update; Marathon PE's seeds at Hub 2, Pine's at Hub 3, each shop's own request naming its hub", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    tick(tree, "Marathon Pine");
    expect(ticked(tree)).toEqual(["Marathon PE", "Marathon Pine"]);
    // the panel says what each store gets, and in which order Central is dealt
    const text = textOf(tree);
    expect(text).toMatch(/Central's stock is dealt in the order ticked: Marathon PE → Marathon Pine\./);
    expect(text).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Marathon PE first/);
    expect(text).toMatch(/Hub 2 is seeded now; its own ~8 units follow/);
    expect(text).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Marathon Pine first — requested from Central now; Central picks it from Source › Marathon Pine/);
    expect(text).toMatch(/Hub 3 is seeded now; its own ~8 units follow/);
    expect(buttonSaying(tree, "Solve — 2 stores")).toBeTruthy();

    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);          // ONE confirm, ONE atomic update
    const upd = written();
    const stockKeys = Object.keys(upd).filter((k) => k.startsWith("stock/")).sort();
    expect(stockKeys).toEqual([
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
      "stock/marathon-pine/tee1/L", "stock/marathon-pine/tee1/M", "stock/marathon-pine/tee1/S",
    ]);
    const reqs = requests(upd);
    expect(reqs).toHaveLength(6);
    for (const r of reqs) {
      expect(r).toMatchObject({ productId: TEE, status: "open", qty: 2, createdFrom: { firstBatch: true, source: "central" } });
      // THE WALL: a shop's hub is on its own side
      expect(r.createdFrom.hub).toBe(r.requestingLocation === "marathon-pe" ? "hub2" : "hub3");
      expect(r.createdFrom.store).toBe(r.requestingLocation);
    }
    expect(reqs.filter((r) => r.requestingLocation === "marathon-pe")).toHaveLength(3);
    expect(reqs.filter((r) => r.requestingLocation === "marathon-pine")).toHaveLength(3);
    // one solve id per store, so the server can net one shop's lock against the other's hub leg
    const ids = new Set(reqs.map((r) => `${r.requestingLocation}|${r.createdFrom.solveId}`));
    expect([...ids].sort()).toEqual([
      `marathon-pe|fb_${TEE}_${NOW.toString(36)}_marathon-pe`,
      `marathon-pine|fb_${TEE}_${NOW.toString(36)}_marathon-pine`,
    ]);
    // nothing moved: Solve never calls the stock writer
    expect(applyMovementMock).not.toHaveBeenCalled();
  });

  it("Pine and Concrete follow the same policy as Marathon PE (no numbers of their own), and Hub 3 follows Hub 2", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    tick(tree, "Marathon PE");                 // untick the default
    tick(tree, "Concrete");
    expect(ticked(tree)).toEqual(["Concrete"]);
    expect(textOf(tree)).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Concrete first/);
    await confirm(tree);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual([
      "stock/concrete/tee1/L", "stock/concrete/tee1/M", "stock/concrete/tee1/S",
      "stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S",
    ]);
    expect(requests(upd).every((r) => r.requestingLocation === "concrete" && r.createdFrom.hub === "hub3")).toBe(true);
    // a single ticked store keeps the single-store solve id
    expect(requests(upd)[0].createdFrom.solveId).toBe(`fb_${TEE}_${NOW.toString(36)}`);
  });

  it("the owner mapped Concrete's t-shirts to the Concrete Stockroom: Concrete's excess goes THERE, Pine's still to Hub 3", async () => {
    paths.network = { ...S1_LIVE, backStock: { concrete: { "t-shirts": "concrete-stockroom" } } };
    paths["config/refillEngine"] = { ...CONFIG, routes: { ...CONFIG.routes, concrete: "concrete-stockroom", "concrete-stockroom": "central" } };
    const tree = render();
    await open(tree);
    tick(tree, "Marathon PE");
    tick(tree, "Concrete");
    tick(tree, "Marathon Pine");
    await confirm(tree);
    const upd = written();
    const hubOfReq = Object.fromEntries(requests(upd).map((r) => [r.requestingLocation, r.createdFrom.hub]));
    expect(hubOfReq).toEqual({ concrete: "concrete-stockroom", "marathon-pine": "hub3" });
    expect(Object.keys(upd).some((k) => k.startsWith("stock/concrete-stockroom/tee1/"))).toBe(true);
    expect(Object.keys(upd).some((k) => k.startsWith("stock/hub2/"))).toBe(false);
  });

  it("all four stores at once: Hub 2 is seeded once for both Section 2 shops, Hub 3 once for both Section 1 shops", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    for (const name of ["Trophy", "Marathon Pine", "Concrete"]) tick(tree, name);
    expect(buttonSaying(tree, "Solve — 4 stores")).toBeTruthy();
    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/hub2/")).sort()).toEqual(["stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S"]);
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/hub3/")).sort()).toEqual(["stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S"]);
    expect(requests(upd)).toHaveLength(12);
  });
});

describe("Central runs short across two sections", () => {
  // 3 S, 2 M, 0 L. Every shop's policy is 2 of each.
  const SHORT = { S: cell(3), M: cell(2), L: cell(0) };

  it("shows what each store will actually get BEFORE the confirm — dealt in tick order — and writes exactly that", async () => {
    paths.network = S1_LIVE;
    const tree = render({ stock: stockWith(SHORT) });
    await open(tree);
    tick(tree, "Marathon Pine");               // ticked second: Marathon PE is served first
    const text = textOf(tree);
    expect(text).toMatch(/4 units \(S×2 · M×2\) go to Marathon PE first/);
    expect(text).toMatch(/1 unit \(S×1\) go to Marathon Pine first/);
    expect(text).toMatch(/Central is short: S 1 of 2\./);
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    expect(reqs).toEqual([["marathon-pe", "M", 2], ["marathon-pe", "S", 2], ["marathon-pine", "S", 1]]);
    // NEVER THE SAME UNIT TWICE
    const dealt = (sz) => requests(written()).filter((r) => r.size === sz).reduce((t, r) => t + r.qty, 0);
    expect(dealt("S")).toBe(3);
    expect(dealt("M")).toBe(2);
    // the sizes Central could not send still get their carriage seeds at the store and ITS hub
    expect(Object.keys(written())).toEqual(expect.arrayContaining(["stock/marathon-pine/tee1/M", "stock/hub3/tee1/M", "stock/marathon-pine/tee1/L", "stock/hub3/tee1/L"]));
  });

  it("the order ticked decides who is served first: Pine ticked first, Marathon PE gets the remainder", async () => {
    paths.network = S1_LIVE;
    const tree = render({ stock: stockWith(SHORT) });
    await open(tree);
    tick(tree, "Marathon PE");                 // untick the default…
    tick(tree, "Marathon Pine");               // …Pine first…
    tick(tree, "Marathon PE");                 // …then Marathon PE
    expect(textOf(tree)).toMatch(/dealt in the order ticked: Marathon Pine → Marathon PE\./);
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    expect(reqs).toEqual([["marathon-pe", "S", 1], ["marathon-pine", "M", 2], ["marathon-pine", "S", 2]]);
  });

  it("an engine lock already promising Central's units is netted before anything is dealt", async () => {
    paths.network = S1_LIVE;
    // Hub 1 holds an open lock on 2 of Central's S (it reserves; it is not Hub 2 or Hub 3 presence).
    gets[`refill_engine/open/hub1/${TEE}`] = { S: { qty: 2, source: "central", createdAt: "2026-10-02T08:00:00.000Z", runId: "scan1" } };
    const tree = render({ stock: stockWith(SHORT) });
    await open(tree);
    tick(tree, "Marathon Pine");
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    // S: 3 − 2 reserved = 1 free → Marathon PE takes it; Pine gets no S request.
    expect(reqs).toEqual([["marathon-pe", "M", 2], ["marathon-pe", "S", 1]]);
  });
});

describe("the hub's own presence, and the wall, per store", () => {
  it("Hub 3 already holds the product: Pine takes the old seed-only Solve (no request from Central); Marathon PE, behind Hub 2, still gets its first batch", async () => {
    paths.network = S1_LIVE;
    const stock = { ...stockWith(PLENTY), hub3: { [TEE]: { M: cell(1) } } };
    // (the Section 2 list: stranded for Section 2 — the default list handed in)
    const tree = render({ stock });
    await open(tree);
    tick(tree, "Marathon Pine");
    const text = textOf(tree);
    expect(text).toMatch(/→ seeds Hub 3 \+ Marathon Pine at qty 0/);
    expect(text).toMatch(/go to Marathon PE first/);
    await confirm(tree);
    const upd = written();
    expect(requests(upd).every((r) => r.requestingLocation === "marathon-pe")).toBe(true);
    expect(Object.keys(upd)).toEqual(expect.arrayContaining(["stock/marathon-pine/tee1/S", "stock/marathon-pine/tee1/M", "stock/marathon-pine/tee1/L", "stock/hub3/tee1/S", "stock/hub3/tee1/L"]));
  });

  it("a product stranded at Hub 2 can be solved into Marathon PE and Trophy only — Pine and Concrete say it must go back to Central", async () => {
    paths.network = S1_LIVE;
    const stock = { hub2: { [TEE]: { M: cell(4) } } };
    const tree = render({ stock });
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(true);
    expect(box(tree, "Concrete").props.disabled).toBe(true);
    expect(textOf(tree)).toMatch(/Marathon Pine: the stock is at Hub 2, in the other section — send it back to Central first\./);
    tick(tree, "Trophy");
    await confirm(tree);
    // hub-stranded: seeds the shops only, exactly as the old Solve did
    expect(Object.keys(written()).sort()).toEqual([
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
      "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S",
    ]);
  });

  it("Move manually from Central offers the card's own section first, then the other; from Hub 2 only Section 2's shops", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await act(async () => { buttonExactly(tree, "Move manually").props.onClick(); });
    const dests = buttonsOf(tree).map((b) => (b.children || []).join("")).filter((t) => t.startsWith("→ "));
    expect(dests).toEqual(["→ Hub 2", "→ Marathon PE", "→ Trophy", "→ Hub 3", "→ Marathon Pine", "→ Concrete"]);
    const hubTree = render({ stock: { hub2: { [TEE]: { M: cell(4) } } } });
    await act(async () => { buttonExactly(hubTree, "Move manually").props.onClick(); });
    expect(buttonsOf(hubTree).map((b) => (b.children || []).join("")).filter((t) => t.startsWith("→ "))).toEqual(["→ Marathon PE", "→ Trophy"]);
  });
});

describe("undo: two shops of one confirm share their hub's seeds", () => {
  it("undoing Marathon PE's solve leaves Hub 2 seeded while Trophy's stands; undoing Trophy's then takes the hub seeds too", async () => {
    const tree = render();                     // the seed registry: Section 2 only
    await open(tree);
    tick(tree, "Trophy");
    await confirm(tree);
    const undoButtons = () => buttonsOf(tree).filter((b) => (b.children || []).join("") === "Undo");
    expect(undoButtons()).toHaveLength(2);
    expect(textOf(tree)).toMatch(/6 units requested from Central for Marathon PE \(Hub 2's batch follows\)/);
    // every request row is still open and untouched
    for (let i = 1; i <= 6; i++) gets[`refill_requests/req${i}`] = { status: "open", size: "M" };
    await act(async () => { await undoButtons()[0].props.onClick(); });
    const first = txnPaths.filter((p) => p.startsWith("stock/"));
    expect(first.some((p) => p.startsWith("stock/hub2/"))).toBe(false);
    expect(first.every((p) => p.startsWith("stock/marathon-pe/"))).toBe(true);
    expect(first).toHaveLength(3);
    txnPaths.length = 0;
    expect(undoButtons()).toHaveLength(1);
    await act(async () => { await undoButtons()[0].props.onClick(); });
    const second = txnPaths.filter((p) => p.startsWith("stock/")).sort();
    expect(second).toEqual([
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S",
    ]);
  });
});

describe("the other section's list", () => {
  it("a viewer who may see both sections can look at Section 1's stranded stock; Solve there routes nothing while its Solve is off", async () => {
    paths.network = S1_DARK;
    // Marathon PE carries the tee → nothing stranded for Section 2; stranded for Section 1.
    const stock = { ...stockWith(PLENTY), "marathon-pe": { [TEE]: { M: cell(1) } } };
    const tree = render({ stock });
    expect(textOf(tree)).toMatch(/No stranded products/);
    await act(async () => { buttonSaying(tree, "Concrete").props.onClick(); });
    expect(textOf(tree)).toMatch(/Essentials Tee Olive/);
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(true);
    expect(box(tree, "Concrete").props.disabled).toBe(true);
    // by hand it can still be moved: Central → Hub 3 / Pine / Concrete are offered
    await act(async () => { buttonExactly(tree, "Move manually").props.onClick(); });
    const dests = buttonsOf(tree).map((b) => (b.children || []).join("")).filter((t) => t.startsWith("→ "));
    expect(dests.slice(0, 3)).toEqual(["→ Hub 3", "→ Marathon Pine", "→ Concrete"]);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
