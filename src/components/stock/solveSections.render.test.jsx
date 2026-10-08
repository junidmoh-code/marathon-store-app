// ─── The Solve, rendered: ONE division per list, one confirm ─────────────────
// Mounts the real NetworkTransfer over the real card build and presses the
// real buttons; the assertion is the ONE multi-path update the confirm writes.
//   • "Missing from Marathon" offers Marathon PE and Trophy only; "Missing from
//     Concrete" offers Marathon Pine and Concrete only (owner rule 8 Oct 2026);
//   • each ticked store's excess goes to ITS division's hub — Hub 2 for
//     Marathon PE and Trophy, Hub 3 for Pine and Concrete (there is no
//     Concrete Stockroom);
//   • a store with Solve off is shown, cannot be ticked, nothing is written;
//   • Central short across two stores: dealt in tick order, shown before the
//     confirm, never the same unit twice.
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
const S1_LIVE = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } };
// /network with Section 1's switches both OFF (the seed before 7 Oct 2026).
const OFF = { solve: false, autoRefill: "off" };
const S1_DARK = { locations: { "marathon-pine": OFF, concrete: OFF, hub3: OFF } };
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

// The Marathon list (HealthView's default), or — with `division: 1` — the
// "Missing from Concrete" list's own cards (computeMissingProducts section 1).
function render({ stock = stockWith(PLENTY), products = PRODUCTS, cards, division = 2, category = "clothing", targets = {} } = {}) {
  const list = cards || computeMissingProducts({ allStock: stock, products, ...(division === 1 ? { section: 1 } : {}) });
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <NetworkTransfer products={products} category={category} allStock={stock} cards={list}
        targets={targets} targetsSettled={true} targetsError={false} />
    );
  });
  return tree;
}
const renderConcrete = (opts = {}) => render({ ...opts, division: 1 });
// Tick exactly these stores, in this order (untick the rest first).
const setTicks = (tree, names) => {
  for (const b of boxes(tree)) if (b.props["aria-checked"]) act(() => { b.props.onClick(); });
  for (const n of names) tick(tree, n);
};
const destsOf = (tree) => buttonsOf(tree).map((b) => (b.children || []).join("")).filter((x) => x.startsWith("→ "));
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

describe("ONE DIVISION PER LIST — Solve offers only the list's own stores", () => {
  it("Missing from Marathon offers Marathon PE and Trophy only; the default store is ticked", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon PE", "Trophy"]);
    expect(textOf(tree)).not.toMatch(/Marathon Pine|Hub 3/);
    expect(ticked(tree)).toEqual(["Marathon PE"]);
  });

  it("Missing from Concrete offers Marathon Pine and Concrete only — never Marathon PE or Trophy", async () => {
    paths.network = S1_LIVE;
    const tree = renderConcrete();
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon Pine", "Concrete"]);
    expect(textOf(tree)).not.toMatch(/Marathon PE|Trophy|Hub 2/);
    expect(ticked(tree)).toHaveLength(1);
    expect(["Marathon Pine", "Concrete"]).toContain(ticked(tree)[0]);
  });

  it("SOLVE OFF: on the Concrete list Pine and Concrete are shown, cannot be ticked, say why, and nothing is written", async () => {
    paths.network = S1_DARK;
    const tree = renderConcrete();
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(true);
    expect(box(tree, "Concrete").props.disabled).toBe(true);
    expect(textOf(tree)).toMatch(/Marathon Pine: Solve is off for this store \(Network card\)\./);
    expect(textOf(tree)).toMatch(/Concrete: Solve is off for this store \(Network card\)\./);
    act(() => { box(tree, "Marathon Pine").props.onClick(); });
    expect(ticked(tree)).toEqual([]);
    const go = buttonSaying(tree, "Solve — ");
    expect(!go || go.props.disabled === true).toBe(true);
    if (go) await act(async () => { await go.props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("SOLVE OFF for Concrete changes nothing on the Marathon list — the confirm is exactly Marathon PE's", async () => {
    paths.network = S1_DARK;
    const tree = render();
    await open(tree);
    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(written()).sort()).toEqual([
      "refill_requests/req1", "refill_requests/req2", "refill_requests/req3",
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
  });
});

describe("THE SEED (7 Oct 2026): Pine and Concrete are solvable before their counts are finished", () => {
  it("no /network node: on the Concrete list Pine's Solve seeds Pine and Hub 3 TRUSTED and asks Central for Pine's first batch", async () => {
    const tree = renderConcrete();          // no /network node → the seed: Section 1 Solve on, Auto-refill solved
    await open(tree);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(false);
    expect(box(tree, "Concrete").props.disabled).toBe(false);
    setTicks(tree, ["Marathon Pine"]);
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

describe("SOLVE TRUSTS WHAT IT INTRODUCES at a \"solved\" location", () => {
  it("an existing EMPTY untrusted Hub 3 cell is trusted in the same write; a Hub 3 cell holding legacy units is left for a count", async () => {
    paths["stock/hub3/tee1"] = { S: { qty: 0, v: 3, mv: "old", lastType: "sold" }, M: { qty: 4, v: 2, mv: "old2", lastType: "adjustment" } };
    gets["stock/hub3/tee1"] = paths["stock/hub3/tee1"];
    const tree = renderConcrete();
    await open(tree);
    setTicks(tree, ["Marathon Pine"]);
    await confirm(tree);
    const upd = written();
    expect(upd["stock/hub3/tee1/S/trusted"]).toBe(true);
    expect(upd["stock/hub3/tee1/S/state"]).toBe("live");
    expect(Object.keys(upd).some((k) => k === "stock/hub3/tee1/S" || /stock\/hub3\/tee1\/S\/(qty|v|mv|lastType)$/.test(k))).toBe(false);
    expect(Object.keys(upd).some((k) => k.startsWith("stock/hub3/tee1/M"))).toBe(false);
  });
});

describe("two stores of ONE division in one confirm — the division's hub is seeded once", () => {
  it("Pine + Concrete: ONE update; Hub 3 seeded once, each shop's own request naming Hub 3", async () => {
    paths.network = S1_LIVE;
    const tree = renderConcrete();
    await open(tree);
    setTicks(tree, ["Marathon Pine", "Concrete"]);
    const text = textOf(tree);
    expect(text).toMatch(/Central's stock is dealt in the order ticked: Marathon Pine → Concrete\./);
    expect(text).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Marathon Pine first — requested from Central now; Central picks it from Source › Marathon Pine/);
    expect(text).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Concrete first/);
    expect(text).toMatch(/Hub 3 is seeded now; its own ~8 units follow/);
    expect(buttonSaying(tree, "Solve — 2 stores")).toBeTruthy();
    await confirm(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual([
      "stock/concrete/tee1/L", "stock/concrete/tee1/M", "stock/concrete/tee1/S",
      "stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S",
      "stock/marathon-pine/tee1/L", "stock/marathon-pine/tee1/M", "stock/marathon-pine/tee1/S",
    ]);
    const reqs = requests(upd);
    expect(reqs).toHaveLength(6);
    for (const r of reqs) {
      expect(r).toMatchObject({ productId: TEE, status: "open", qty: 2, createdFrom: { firstBatch: true, source: "central", hub: "hub3" } });
      expect(r.createdFrom.store).toBe(r.requestingLocation);
      expect(["marathon-pine", "concrete"]).toContain(r.requestingLocation);
    }
    const ids = new Set(reqs.map((r) => `${r.requestingLocation}|${r.createdFrom.solveId}`));
    expect([...ids].sort()).toEqual([
      `concrete|fb_${TEE}_${NOW.toString(36)}_concrete`,
      `marathon-pine|fb_${TEE}_${NOW.toString(36)}_marathon-pine`,
    ]);
    expect(applyMovementMock).not.toHaveBeenCalled();
  });

  it("Marathon PE + Trophy: Hub 2 seeded once; nothing for Section 1", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await open(tree);
    setTicks(tree, ["Marathon PE", "Trophy"]);
    await confirm(tree);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/hub2/")).sort()).toEqual(["stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S"]);
    expect(Object.keys(upd).some((k) => /hub3|marathon-pine|\/concrete\//.test(k))).toBe(false);
    expect(requests(upd).map((r) => r.requestingLocation).sort()).toEqual(["marathon-pe", "marathon-pe", "marathon-pe", "trophy", "trophy", "trophy"]);
  });

  it("Pine and Concrete follow the same policy as Marathon PE (no numbers of their own), and Hub 3 follows Hub 2", async () => {
    paths.network = S1_LIVE;
    const tree = renderConcrete();
    await open(tree);
    setTicks(tree, ["Concrete"]);
    expect(textOf(tree)).toMatch(/6 units \(S×2 · M×2 · L×2\) go to Concrete first/);
    await confirm(tree);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual([
      "stock/concrete/tee1/L", "stock/concrete/tee1/M", "stock/concrete/tee1/S",
      "stock/hub3/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/S",
    ]);
    expect(requests(upd).every((r) => r.requestingLocation === "concrete" && r.createdFrom.hub === "hub3")).toBe(true);
    expect(requests(upd)[0].createdFrom.solveId).toBe(`fb_${TEE}_${NOW.toString(36)}`);
  });

  it("THERE IS NO CONCRETE STOCKROOM: a stale /network mapping to it is ignored — Concrete's excess goes to Hub 3, like Pine's", async () => {
    paths.network = { ...S1_LIVE, backStock: { concrete: { "t-shirts": "concrete-stockroom" } }, locations: { ...S1_LIVE.locations, "concrete-stockroom": { type: "hub", section: 1, live: true } } };
    const tree = renderConcrete();
    await open(tree);
    setTicks(tree, ["Concrete", "Marathon Pine"]);
    await confirm(tree);
    const upd = written();
    const hubOfReq = Object.fromEntries(requests(upd).map((r) => [r.requestingLocation, r.createdFrom.hub]));
    expect(hubOfReq).toEqual({ concrete: "hub3", "marathon-pine": "hub3" });
    expect(Object.keys(upd).some((k) => k.includes("concrete-stockroom"))).toBe(false);
  });
});

describe("Central runs short across two stores of one division", () => {
  // 3 S, 2 M, 0 L. Every shop's policy is 2 of each.
  const SHORT = { S: cell(3), M: cell(2), L: cell(0) };

  it("shows what each store will actually get BEFORE the confirm — dealt in tick order — and writes exactly that", async () => {
    paths.network = S1_LIVE;
    const tree = renderConcrete({ stock: stockWith(SHORT) });
    await open(tree);
    setTicks(tree, ["Marathon Pine", "Concrete"]);
    const text = textOf(tree);
    expect(text).toMatch(/4 units \(S×2 · M×2\) go to Marathon Pine first/);
    expect(text).toMatch(/1 unit \(S×1\) go to Concrete first/);
    expect(text).toMatch(/Central is short: S 1 of 2\./);
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    expect(reqs).toEqual([["concrete", "S", 1], ["marathon-pine", "M", 2], ["marathon-pine", "S", 2]]);
    const dealt = (sz) => requests(written()).filter((r) => r.size === sz).reduce((t, r) => t + r.qty, 0);
    expect(dealt("S")).toBe(3);
    expect(dealt("M")).toBe(2);
    expect(Object.keys(written())).toEqual(expect.arrayContaining(["stock/concrete/tee1/M", "stock/concrete/tee1/L", "stock/hub3/tee1/M", "stock/hub3/tee1/L"]));
  });

  it("the order ticked decides who is served first: Concrete ticked first, Pine gets the remainder", async () => {
    paths.network = S1_LIVE;
    const tree = renderConcrete({ stock: stockWith(SHORT) });
    await open(tree);
    setTicks(tree, ["Concrete", "Marathon Pine"]);
    expect(textOf(tree)).toMatch(/dealt in the order ticked: Concrete → Marathon Pine\./);
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    expect(reqs).toEqual([["concrete", "M", 2], ["concrete", "S", 2], ["marathon-pine", "S", 1]]);
  });

  it("an engine lock already promising Central's units — at a MARATHON hub — is netted before Concrete's are dealt (Central is shared)", async () => {
    paths.network = S1_LIVE;
    gets[`refill_engine/open/hub1/${TEE}`] = { S: { qty: 2, source: "central", createdAt: "2026-10-02T08:00:00.000Z", runId: "scan1" } };
    const tree = renderConcrete({ stock: stockWith(SHORT) });
    await open(tree);
    setTicks(tree, ["Marathon Pine", "Concrete"]);
    await confirm(tree);
    const reqs = requests(written()).map((r) => [r.requestingLocation, r.size, r.qty]).sort();
    // S: 3 − 2 reserved = 1 free → Pine takes it; Concrete gets no S request.
    expect(reqs).toEqual([["marathon-pine", "M", 2], ["marathon-pine", "S", 1]]);
  });
});

describe("the hub's own presence, and the wall, per list", () => {
  it("Hub 3 already holds the product: on the Concrete list it is an 'only in Hub 3' card solved into Pine/Concrete with no Central request; on the Marathon list Marathon PE still gets its first batch and nothing is written for Section 1", async () => {
    paths.network = S1_LIVE;
    const stock = { ...stockWith(PLENTY), hub3: { [TEE]: { M: cell(1) } } };
    const s1 = computeMissingProducts({ allStock: stock, products: PRODUCTS, section: 1 });
    expect(s1.map((c) => [c.pid, c.source])).toEqual([[TEE, "hub3"]]);
    const cTree = renderConcrete({ stock });
    await open(cTree);
    expect(boxes(cTree).map(boxLabel)).toEqual(["Marathon Pine", "Concrete"]);
    setTicks(cTree, ["Marathon Pine"]);
    await confirm(cTree);
    const cUpd = updateMock.mock.calls[0][1];
    expect(requests(cUpd)).toEqual([]);
    expect(Object.keys(cUpd).some((k) => /hub2|marathon-pe\/|trophy/.test(k))).toBe(false);
    updateMock.mockClear();
    const tree = render({ stock });
    await open(tree);
    await confirm(tree);
    const upd = written();
    expect(requests(upd).every((r) => r.requestingLocation === "marathon-pe")).toBe(true);
    expect(Object.keys(upd).some((k) => /hub3|marathon-pine|\/concrete\//.test(k))).toBe(false);
  });

  it("a product stranded at Hub 2 is a Marathon card: Marathon PE and Trophy only — Section 1 is not even offered", async () => {
    paths.network = S1_LIVE;
    const stock = { hub2: { [TEE]: { M: cell(4) } } };
    const tree = render({ stock });
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon PE", "Trophy"]);
    setTicks(tree, ["Marathon PE", "Trophy"]);
    await confirm(tree);
    expect(Object.keys(written()).sort()).toEqual([
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
      "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S",
    ]);
  });

  it("Move manually offers the list's own division only: Marathon → Hub 2 / Marathon PE / Trophy; Concrete → Hub 3 / Marathon Pine / Concrete; from Hub 2 Marathon's shops", async () => {
    paths.network = S1_LIVE;
    const tree = render();
    await act(async () => { buttonExactly(tree, "Move manually").props.onClick(); });
    expect(destsOf(tree)).toEqual(["→ Hub 2", "→ Marathon PE", "→ Trophy"]);
    const cTree = renderConcrete();
    await act(async () => { buttonExactly(cTree, "Move manually").props.onClick(); });
    expect(destsOf(cTree)).toEqual(["→ Hub 3", "→ Marathon Pine", "→ Concrete"]);
    const hubTree = render({ stock: { hub2: { [TEE]: { M: cell(4) } } } });
    await act(async () => { buttonExactly(hubTree, "Move manually").props.onClick(); });
    expect(destsOf(hubTree)).toEqual(["→ Marathon PE", "→ Trophy"]);
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

describe("the other division's list", () => {
  it("a viewer who may see both divisions switches with \"Missing from Concrete\"; with Solve off there it routes nothing, and Move offers only Concrete's", async () => {
    paths.network = S1_DARK;
    // Marathon PE carries the tee → nothing missing from Marathon; missing from Concrete.
    const stock = { ...stockWith(PLENTY), "marathon-pe": { [TEE]: { M: cell(1) } } };
    const tree = render({ stock });
    expect(textOf(tree)).toMatch(/No stranded products/);
    const chip = (label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);
    expect(chip("Missing from Marathon")).toBeTruthy();
    await act(async () => { chip("Missing from Concrete").props.onClick(); });
    expect(textOf(tree)).toMatch(/Essentials Tee Olive/);
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon Pine", "Concrete"]);
    expect(box(tree, "Marathon Pine").props.disabled).toBe(true);
    expect(box(tree, "Concrete").props.disabled).toBe(true);
    await act(async () => { buttonExactly(tree, "Move manually").props.onClick(); });
    expect(destsOf(tree)).toEqual(["→ Hub 3", "→ Marathon Pine", "→ Concrete"]);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("PERFUME follows the same per-division rule", () => {
  const SCENT = "scent1";
  const SCENTS = [{ id: SCENT, name: "Gentleman Givenchy perfume", category: "Perfume", subcategory: "Perfume", categoryKey: "perfumes", sizes: ["_"] }];
  const SCENT_STOCK = { central: { [SCENT]: { _: cell(48) } } };
  // The live perfume policy (hub2 + Marathon PE); Section 1 follows it by template.
  const PERFUME_CONFIG = { ...CONFIG, categoryPolicy: { perfumes: { hub2: { target: 10, minQty: 5, reorderPoint: 5 }, "marathon-pe": { target: 8, minQty: 4, reorderPoint: 3 } } } };

  it("Missing from Concrete: a perfume solves only into Pine / Concrete with Hub 3 seeded — Marathon PE and Trophy are never offered or written", async () => {
    paths["config/refillEngine"] = PERFUME_CONFIG;
    const tree = renderConcrete({ products: SCENTS, stock: SCENT_STOCK, category: "perfume" });
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon Pine", "Concrete"]);
    setTicks(tree, ["Marathon Pine", "Concrete"]);
    await confirm(tree);
    const upd = written();
    const keys = Object.keys(upd);
    expect(keys.filter((k) => k.startsWith("stock/")).sort()).toEqual([`stock/concrete/${SCENT}/_`, `stock/hub3/${SCENT}/_`, `stock/marathon-pine/${SCENT}/_`]);
    expect(keys.some((k) => /hub2|hub1|marathon-pe\/|trophy/.test(k))).toBe(false);
    for (const r of requests(upd)) expect(["marathon-pine", "concrete"]).toContain(r.requestingLocation);
  });

  it("Missing from Marathon: the same perfume offers Marathon PE and Trophy only, and seeds Hub 2", async () => {
    paths["config/refillEngine"] = PERFUME_CONFIG;
    const tree = render({ products: SCENTS, stock: SCENT_STOCK, category: "perfume" });
    await open(tree);
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon PE", "Trophy"]);
    await confirm(tree);
    const keys = Object.keys(written());
    expect(keys).toEqual(expect.arrayContaining([`stock/hub2/${SCENT}/_`, `stock/marathon-pe/${SCENT}/_`]));
    expect(keys.some((k) => /hub3|marathon-pine|\/concrete\//.test(k))).toBe(false);
  });
});

// ── CENTRAL-FED CLOTHING (Concrete, owner 8 Oct 2026; centralFed.js) ─────────
// Production-shaped routes: config.routes names only Marathon. With
// centralFedClothing { concrete: 4 } a clothing Solve to Concrete asks Central
// for 4 of EVERY size, straight to the shop — nothing at Hub 3.
describe("Concrete clothing kept in the shop — 4 per size, straight from Central", () => {
  const PROD_CFG = {
    ruleBasedTargets: true, maxUnitsPerIntent: 20,
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    defaultRunByStore: { hub2: { L: 3, M: 3, S: 2 }, "marathon-pe": { L: 2, M: 2, S: 2 }, trophy: { L: 2, M: 2, S: 2 } },
  };
  const FULL = [{ id: TEE, name: "Essentials Tee Olive", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L", "XL", "XXL"] }];
  const CENTRAL_ALL = { S: cell(9), M: cell(9), L: cell(9), XL: cell(9), XXL: cell(2) };

  it("Solve to Concrete: 4 of every size from Central to the shop, trusted Concrete seeds only, NOTHING at Hub 3, and the panel never names a hub", async () => {
    paths["config/refillEngine"] = { ...PROD_CFG, centralFedClothing: { concrete: 4 } };
    const tree = render({ division: 1, products: FULL, stock: stockWith(CENTRAL_ALL) });
    await open(tree);
    setTicks(tree, ["Concrete"]);
    expect(textOf(tree)).toMatch(/keeps this clothing in the shop: 4 of every size, refilled straight from Central/);
    expect(textOf(tree)).not.toMatch(/Hub 3 is seeded|seeded at Hub 3/);
    await confirm(tree);
    const upd = written();
    const stockKeys = Object.keys(upd).filter((k) => k.startsWith("stock/")).sort();
    expect(stockKeys.every((k) => k.startsWith(`stock/concrete/${TEE}/`))).toBe(true);
    expect(stockKeys).toEqual(["L", "M", "S", "XL", "XXL"].map((s) => `stock/concrete/${TEE}/${s}`));
    for (const k of stockKeys) expect(upd[k]).toMatchObject({ trusted: true, trustedVia: "solve" });
    const reqs = requests(upd);
    expect(reqs.map((r) => [r.size, r.qty]).sort()).toEqual([["L", 4], ["M", 4], ["S", 4], ["XL", 4], ["XXL", 2]]);
    for (const r of reqs) expect(r).toMatchObject({ requestingLocation: "concrete", createdFrom: { firstBatch: true, source: "central", store: "concrete", direct: true } });
    expect(Object.keys(upd).some((k) => /hub3|hub2|marathon/.test(k))).toBe(false);
  });

  it("a size Central has none of is neither requested nor seeded — it stays on Missing from Concrete", async () => {
    paths["config/refillEngine"] = { ...PROD_CFG, centralFedClothing: { concrete: 4 } };
    const tree = render({ division: 1, products: FULL, stock: stockWith({ S: cell(9), M: cell(9) }) });
    await open(tree);
    setTicks(tree, ["Concrete"]);
    expect(textOf(tree)).toMatch(/L · XL · XXL: Central has none — they stay on the Missing list until it does/);
    await confirm(tree);
    const upd = written();
    expect(Object.keys(upd).filter((k) => k.startsWith("stock/")).sort()).toEqual([`stock/concrete/${TEE}/M`, `stock/concrete/${TEE}/S`]);
    expect(requests(upd).map((r) => r.size).sort()).toEqual(["M", "S"]);
  });

  it("REVIEW FIX: an UNTRUSTED Concrete cell holding nothing is requested and trusted in place (metadata only); one holding units is left for a count", async () => {
    paths["config/refillEngine"] = { ...PROD_CFG, centralFedClothing: { concrete: 4 } };
    const stock = { ...stockWith(CENTRAL_ALL), concrete: { [TEE]: { S: { qty: 0, v: 5, mv: "old", lastType: "sold" }, M: { qty: 3, v: 2, mv: "old2", lastType: "adjustment" } } } };
    gets[`stock/concrete/${TEE}`] = stock.concrete[TEE];
    const cards = computeMissingProducts({ allStock: stock, products: FULL, section: 1, centralFed: { ...PROD_CFG, centralFedClothing: { concrete: 4 } } });
    const tree = render({ division: 1, products: FULL, stock, cards });
    await open(tree);
    setTicks(tree, ["Concrete"]);
    await confirm(tree);
    const upd = written();
    expect(requests(upd).map((r) => r.size).sort()).toEqual(["L", "S", "XL", "XXL"]);       // never M (holds 3 uncounted)
    expect(upd[`stock/concrete/${TEE}/S/trusted`]).toBe(true);                          // trusted in place
    for (const f of ["qty", "v", "mv", "lastType"]) expect(`stock/concrete/${TEE}/S/${f}` in upd).toBe(false);
    expect(`stock/concrete/${TEE}/S` in upd).toBe(false);                                 // no whole-cell overwrite
    expect(Object.keys(upd).some((k) => k.startsWith(`stock/concrete/${TEE}/M`))).toBe(false);
  });

  it("REVIEW FIX: an explicit /stock_targets row for a size wins over N (0 = excluded), as in the engine", async () => {
    paths["config/refillEngine"] = { ...PROD_CFG, centralFedClothing: { concrete: 4 } };
    const targets = { concrete: { [TEE]: { L: { target: 0, minQty: 0 }, XL: { target: 2, minQty: 1 } } } };
    const tree = render({ division: 1, products: FULL, stock: stockWith(CENTRAL_ALL), targets });
    await open(tree);
    setTicks(tree, ["Concrete"]);
    await confirm(tree);
    expect(requests(written()).map((r) => [r.size, r.qty]).sort()).toEqual([["M", 4], ["S", 4], ["XL", 2], ["XXL", 2]]);
  });

  it("Pine is unchanged on the same list: its Solve still seeds Hub 3 + Pine and its batch follows at Hub 3", async () => {
    paths["config/refillEngine"] = { ...PROD_CFG, centralFedClothing: { concrete: 4 } };
    const tree = render({ division: 1, products: FULL, stock: stockWith(CENTRAL_ALL) });
    await open(tree);
    setTicks(tree, ["Marathon Pine"]);
    await confirm(tree);
    const keys = Object.keys(written()).filter((k) => k.startsWith("stock/"));
    expect(keys.some((k) => k.startsWith(`stock/hub3/${TEE}/`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`stock/marathon-pine/${TEE}/`))).toBe(true);
  });

  it("with the setting off, Concrete's clothing Solve is exactly the Hub 3 Solve it was", async () => {
    paths["config/refillEngine"] = PROD_CFG;
    const tree = render({ division: 1, products: FULL, stock: stockWith(CENTRAL_ALL) });
    await open(tree);
    setTicks(tree, ["Concrete"]);
    await confirm(tree);
    expect(Object.keys(written()).some((k) => k.startsWith(`stock/hub3/${TEE}/`))).toBe(true);
    for (const r of requests(written())) expect(r.createdFrom.direct).toBeUndefined();
  });
});
