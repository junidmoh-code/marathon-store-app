// ─── MISSING PRODUCTS — "NOT LISTED" (Junid, 23 Nov 2026) ─────────────────────
// Nothing disappears silently: a product with stock at Central that no shop
// or hub of a division holds is a card on that division's list, or a row
// under "Not listed" with its reason. (Fixture and mocks: the screen's own
// render test, MissingProductsScreen.render.test.jsx.)
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
const listeners = {};
// Every database read the screen makes (search must add none).
const reads = { onValue: 0, get: 0 };
const emit = (path, value) => { paths[path] = value; for (const cb of listeners[path] || []) cb({ val: () => value }); };
const updateMock = vi.fn(() => Promise.resolve());
const txnCalls = [];
let txnData = {};
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { reads.onValue++; (listeners[r.path] ||= []).push(cb); cb({ val: () => paths[r.path] ?? null }); return () => { listeners[r.path] = (listeners[r.path] || []).filter((x) => x !== cb); }; },
  update: (...a) => updateMock(...a),
  get: (r) => { reads.get++; return Promise.resolve({ val: () => gets[r.path] ?? null }); },
  push: () => ({ key: `req${++pushN}` }),
  // A real transaction: the function sees the stored value; undefined aborts.
  runTransaction: (r, fn) => { const cur = txnData[r.path] ?? null; const next = fn(cur); txnCalls.push({ path: r.path, cur, next }); if (next !== undefined) txnData[r.path] = next; return Promise.resolve({ committed: next !== undefined, snapshot: { val: () => (next === undefined ? cur : next) } }); },
}));
vi.mock("./solvedLogStore", () => ({
  useSolvedLog: () => ({ entries: [], settled: true, error: null, hasMore: false, loadMore: () => {} }),
  saveSolvedRows: vi.fn(async () => {}), markSolvedUndone: vi.fn(async () => {}),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
const seatCalls = [];
vi.mock("firebase/functions", () => ({ httpsCallable: () => async (arg) => { seatCalls.push(arg); return { data: { ok: true } }; } }));
const perm = { permRecord: { stockRole: "admin", displayName: "Junid" }, isSuperAdmin: true };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: MissingProductsScreen } = await import("./MissingProductsScreen.jsx");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");

const S1_LIVE = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } };
// The live shape (22 Nov 2026): Concrete's and Pine's clothing is kept in the
// shop straight from Central; Marathon's shops are fed through Hub 2.
const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: { hub2: { L: 3, M: 3, S: 2 }, "marathon-pe": { L: 2, M: 2, S: 2 }, trophy: { L: 2, M: 2, S: 2 } },
  footwearRunByLocation: { hub1: { 8: 2, 9: 2 }, hub2: { 8: 2, 9: 2 } },
  centralFedClothing: { concrete: 4 },
  concreteDivision: { shopOnly: { oneSize: 5, perSize: 2 } },
};
// ids are p<upload ms>: newest upload first is the order a list opens in.
const TEE = "p1795200000000", JACKET = "p1795150000000", HOODIE = "p1795120000000", GONE_TEE = "p1795110000000";
const SHOE_A = "p1795000000000", SHOE_B = "p1795100000000", SHOE_C = "p1794900000000", TWIN = "p1794000000000";
const KID = "p1795103464793", KID2 = "p1795103158565";
const KID_SIZES = ["24", "25", "26"];
const PRODUCTS = [
  { id: SHOE_A, name: "Air Zoom Alpha", brand: "Nike", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/a.jpg" },
  { id: SHOE_B, name: "Gazelle Bold", brand: "Adidas", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/b.jpg" },
  { id: SHOE_C, name: "Samba OG", brand: "Adidas", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/c.jpg" },
  { id: TWIN, name: "Air Zoom Alpha", brand: "Nike", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/twin.jpg" },
  { id: KID, name: "Nike SB dunk low grey small", category: "Footwear", subcategory: "Sneakers", categoryKey: "kids-shoes", productType: "sneaker", sizes: KID_SIZES, photoUrl: "https://x/k.jpg" },
  { id: KID2, name: "Nike SB dunk small black white", category: "Footwear", subcategory: "Sneakers", categoryKey: "kids-shoes", productType: "sneaker", sizes: KID_SIZES, photoUrl: "https://x/k2.jpg" },
  { id: TEE, name: "Essentials Tee Olive", brand: "Fear of God", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"], photoUrl: "https://x/t.jpg" },
  { id: JACKET, name: "Varsity Jacket", brand: "Nike", styleCode: "DD1391-100", productType: "clothing", categoryKey: "jackets", subcategory: "Jackets & Coats", sizes: ["S", "M", "L"] },
  { id: HOODIE, name: "Box Hoodie", brand: "Stussy", productType: "clothing", categoryKey: "hoodies", subcategory: "Hoodies", sizes: ["S", "M", "L"] },
  { id: GONE_TEE, name: "T shirt white 70740", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const SIZES = { S: cell(9), M: cell(9), L: cell(9) };
const baseStock = () => ({
  central: {
    [SHOE_A]: { 8: cell(9), 9: cell(9) }, [SHOE_B]: { 8: cell(9), 9: cell(9) }, [SHOE_C]: { 8: cell(1) },
    [TEE]: { ...SIZES }, [JACKET]: { ...SIZES },
    [HOODIE]: { L: cell(3) },                       // Central has only L of the hoodie
    [KID]: { 24: cell(2), 25: cell(2), 26: cell(2) }, [KID2]: { 24: cell(2), 25: cell(2), 26: cell(2) },
  },
  hub3: { [TWIN]: { 8: cell(3) } },                 // the same-named record already has stock at Hub 3
  // Concrete keeps M of two tees; Central holds NONE of the plain white one.
  concrete: { [GONE_TEE]: { M: cell(1) }, [HOODIE]: { M: cell(1) } },
});
const sneakerReq = (over = {}) => ({ productId: SHOE_A, size: "8", qty: 2, requestingLocation: "hub1", status: "open", requestSource: "solve", createdFrom: { manual: true, source: "central", via: "missing_sneakers" }, ...over });

const openPolicy = vi.fn();
const mount = async (products = PRODUCTS) => { let tree; await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={products} onExit={() => {}} onOpenEnginePolicy={openPolicy} />); }); await act(async () => {}); await act(async () => {}); return tree; };
const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const textOf = (tree) => flat(tree.toJSON());
const host = (tree, attr, value) => tree.root.findAll((n) => typeof n.type === "string" && n.props && (value === undefined ? n.props[attr] !== undefined : n.props[attr] === value));
// The cards on screen, in order — a slot that is closing is not a card any more.
const slots = (tree) => host(tree, "data-slot").filter((n) => n.props.style.height !== 0);
const cardsOf = (tree) => slots(tree).map((s) => s.findAll((n) => typeof n.type === "string" && n.props["data-card"])[0].props["data-card-name"]);
const card = (tree, pid) => host(tree, "data-card", pid)[0];
const dests = (tree, pid) => card(tree, pid).findAll((n) => n.type === "button" && n.props["data-dest"]);
const offered = (tree, pid) => dests(tree, pid).map((b) => b.props["data-dest"]);
// (every offered location can be chosen; nothing renders disabled)
const live = (tree, pid) => dests(tree, pid).map((b) => b.props["data-dest"]);
const picked = (tree, pid) => dests(tree, pid).filter((b) => b.props["aria-pressed"]).map((b) => b.props["data-dest"]);
const solveBtn = (tree, pid) => card(tree, pid).findAll((n) => n.type === "button" && n.props["data-action"] === "solve")[0];
const pick = async (tree, pid, dest) => { await act(async () => { dests(tree, pid).find((b) => b.props["data-dest"] === dest).props.onClick(); }); };
const solve = async (tree, pid) => { await act(async () => { await solveBtn(tree, pid).props.onClick(); }); await act(async () => {}); };
const stockLine = (tree, pid) => flat(card(tree, pid).findAll((n) => typeof n.type === "string" && n.props["data-stock"])[0].children);
// Choose a location, then Solve — the two deliberate steps.
const tapDest = async (tree, pid, dest) => { await pick(tree, pid, dest); await solve(tree, pid); };
const division = async (tree, sec) => { await act(async () => { host(tree, "data-division", sec)[0].props.onClick(); }); await act(async () => {}); };
const kind = async (tree, k) => { await act(async () => { host(tree, "data-kind", k)[0].props.onClick(); }); await act(async () => {}); };
const count = (tree, sec) => flat(host(tree, "data-division-count", sec)[0].children);
const toast = (tree) => { const t = host(tree, "data-toast")[0]; return t ? { kind: t.props["data-toast"], text: flat(t.children), undo: t.findAll((n) => n.type === "button" && n.props["data-action"] === "undo")[0] } : null; };
const requestsIn = (upd) => Object.entries(upd).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);
const lastUpdate = () => updateMock.mock.calls[updateMock.mock.calls.length - 1][1];
const MARATHON = 2, CONCRETE = 1;

beforeEach(() => {
  updateMock.mockClear(); pushN = 0; seatCalls.length = 0; txnCalls.length = 0; txnData = {};
  for (const k of Object.keys(gets)) delete gets[k];
  __resetNetworkForTests();
  for (const p of ["settings/missingProductsHidden", "settings/concreteOnlyIndex", "settings/marathonOnlyIndex", "settings/stockHold/held", "stock_targets", "refill_engine/seats/concrete", "refill_engine/seats/marathon-pine"]) emit(p, null);
  emit("network", S1_LIVE);
  emit("config/refillEngine", CONFIG);
  emit("refill_requests", null);
  emit("stock", baseStock());
  gets["config/refillEngine/footwearRunByLocation"] = CONFIG.footwearRunByLocation;
  gets["config/refillEngine/policyGroups/footwear-all/policy/hub3"] = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
  perm.permRecord = { stockRole: "admin", displayName: "Junid" }; perm.isSuperAdmin = true;
});

const buttons = (tree) => tree.root.findAll((n) => n.type === "button").map((b) => flat(b.children));
// What a tap wrote: the cells and requests of the one update it made.
const stockLocs = (upd) => [...new Set(Object.keys(upd).filter((k) => k.startsWith("stock/")).map((k) => k.split("/")[1]))];
// Put the last update into the transaction store, as the database would hold it.
const land = (upd) => { for (const [k, v] of Object.entries(upd)) txnData[k] = v; };


const { strandedAtCentral } = await import("./notListedCore");
const LOCS = { [MARATHON]: ["marathon-pe", "trophy", "hub1", "hub2"], [CONCRETE]: ["marathon-pine", "concrete", "hub3"] };
const line = (tree) => host(tree, "data-not-listed-line")[0];
const openNotListed = async (tree) => { await act(async () => { line(tree).props.onClick(); }); await act(async () => {}); };
const nlRows = (tree) => host(tree, "data-not-listed-row").map((n) => ({ pid: n.props["data-not-listed-row"], reason: n.props["data-reason"], text: flat(n.findAll((x) => typeof x.type === "string" && x.props["data-reason-text"] !== undefined)[0].children) }));
const back = async (tree) => { await act(async () => { host(tree, "data-action", "exit")[0].props.onClick(); }); await act(async () => {}); };
const reasonOf = async (tree, sec, pid) => { await division(tree, sec); await openNotListed(tree); const r = nlRows(tree).find((x) => x.pid === pid); await back(tree); return r; };
// Every card on a division's two lists.
const listedPids = async (tree, sec) => {
  await division(tree, sec);
  const out = new Set();
  for (const k of ["sneakers", "clothing"]) { await kind(tree, k); for (const s of host(tree, "data-card")) out.add(s.props["data-card"]); }
  return out;
};
const withStock = (more) => { const s = baseStock(); for (const [loc, byPid] of Object.entries(more)) s[loc] = { ...(s[loc] || {}), ...byPid }; return s; };
const P = (id, over) => ({ id, name: `Product ${id}`, productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"], ...over });

beforeEach(() => { openPolicy.mockClear(); });

describe("the line at the bottom", () => {
  it("is one small line under the cards, and its number is the number of rows it opens", async () => {
    const NOPOL = "p1790000000001";
    emit("stock", withStock({ central: { [NOPOL]: { _: cell(4) } } }));
    const tree = await mount([...PRODUCTS, P(NOPOL, { name: "Leather keyring", productType: "accessory", categoryKey: "keyrings", subcategory: "Keyrings", sizes: ["_"] })]);
    for (const sec of [MARATHON, CONCRETE]) {
      await division(tree, sec);
      for (const k of ["sneakers", "clothing"]) {
        await kind(tree, k);
        const l = line(tree);
        expect(l).toBeDefined();
        // it is the LAST thing in the list — nothing is drawn under it
        const list = host(tree, "data-list")[0];
        const kids = list.children.filter((c) => typeof c === "object");
        expect(kids[kids.length - 1].props.n).toBe(l.props["data-not-listed-line"]);
        expect(l.props.style.height).toBeLessThanOrEqual(40);
      }
      const n = line(tree).props["data-not-listed-line"];
      await openNotListed(tree);
      expect(nlRows(tree).length).toBe(n);
      expect(textOf(tree)).toContain(`Not listed (${n})`);
      await back(tree);
    }
  });

  it("opening it reads nothing from the database", async () => {
    const tree = await mount();
    const before = { ...reads };
    await openNotListed(tree);
    await division(tree, CONCRETE);
    await openNotListed(tree);
    expect(reads).toEqual(before);
  });
});

describe("every reason, with the product off the main list and in Not listed", () => {
  it("no policy", async () => {
    const X = "p1790000000002";
    emit("stock", withStock({ central: { [X]: { _: cell(4) } } }));
    const tree = await mount([...PRODUCTS, P(X, { name: "Leather keyring", productType: "accessory", categoryKey: "keyrings", subcategory: "Keyrings", sizes: ["_"] })]);
    expect((await listedPids(tree, MARATHON)).has(X)).toBe(false);
    expect(await reasonOf(tree, MARATHON, X)).toEqual({ pid: X, reason: "noPolicy", text: "No policy" });
  });

  it("hidden — and Unhide puts it back on the list", async () => {
    emit("settings/missingProductsHidden", { [TEE]: { at: 1, by: "u1", reason: "seasonal" } });
    const tree = await mount();
    expect((await listedPids(tree, MARATHON)).has(TEE)).toBe(false);
    await division(tree, MARATHON);
    await openNotListed(tree);
    expect(nlRows(tree).find((r) => r.pid === TEE)).toEqual({ pid: TEE, reason: "hidden", text: "Hidden" });
    const btn = host(tree, "data-not-listed-row", TEE)[0].findAll((n) => n.type === "button" && n.props["data-action"] === "not-listed-unhide")[0];
    await act(async () => { await btn.props.onClick(); });
    expect(lastUpdate()).toEqual({ "settings/missingProductsHidden/p1795200000000": null });
    // the write lands: the product is a card again, and no longer "not listed"
    await act(async () => { emit("settings/missingProductsHidden", null); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(nlRows(tree).find((r) => r.pid === TEE)).toBeUndefined();
    await back(tree);
    expect((await listedPids(tree, MARATHON)).has(TEE)).toBe(true);
  });

  it("marked for the other division — and Unmark offered", async () => {
    emit("settings/concreteOnlyIndex", { [JACKET]: true });
    const tree = await mount();
    expect((await listedPids(tree, MARATHON)).has(JACKET)).toBe(false);
    await division(tree, MARATHON);
    await openNotListed(tree);
    expect(nlRows(tree).find((r) => r.pid === JACKET)).toMatchObject({ reason: "markedConcrete", text: "Marked Concrete" });
    const btn = host(tree, "data-not-listed-row", JACKET)[0].findAll((n) => n.type === "button" && n.props["data-action"] === "not-listed-unmark")[0];
    await act(async () => { await btn.props.onClick(); });
    // One write: the mark off, with its index — nothing about stock, seats or requests.
    const upd = updateMock.mock.calls.map((c) => c[1]).find((u) => Object.keys(u).some((k) => k.includes(JACKET)));
    expect(upd[`products/${JACKET}/concreteProduct`]).toBe(false);
    expect(Object.keys(upd).filter((k) => /^(stock|refill|stock_targets)/.test(k))).toEqual([]);
  });

  it("finished line", async () => {
    const X = "p1790000000003";
    emit("stock", withStock({ central: { [X]: { S: cell(2) } } }));
    const tree = await mount([...PRODUCTS, P(X, { deactivated: true, deactivatedAt: 1 })]);
    expect((await listedPids(tree, MARATHON)).has(X)).toBe(false);
    expect((await reasonOf(tree, MARATHON, X))?.reason).toBe("finished");
  });

  it("requested — a shop has an empty row and the request is waiting at Central (the Adidas tracksuit)", async () => {
    const X = "p1782998928611";
    emit("stock", withStock({ central: { [X]: { M: cell(18), L: cell(20) } }, trophy: { [X]: { M: cell(0) } } }));
    emit("refill_requests", { r1: { productId: X, size: "M", qty: 3, requestingLocation: "hub2", status: "open", requestSource: "scan", createdFrom: { engine: true, source: "central" } } });
    const tree = await mount([...PRODUCTS, P(X, { name: "Adidas tracksuit full black", categoryKey: "tracksuits", sizes: ["S", "M", "L"] })]);
    expect((await listedPids(tree, MARATHON)).has(X)).toBe(false);
    expect(await reasonOf(tree, MARATHON, X)).toEqual({ pid: X, reason: "requested", text: "Requested — waiting at Central" });
    // …and on Concrete, where no shop or hub has it, it is a card.
    expect((await listedPids(tree, CONCRETE)).has(X)).toBe(true);
  });

  it("empty rows at a shop and no request — Engine Policy offered", async () => {
    const X = "p1790000000004";
    emit("stock", withStock({ central: { [X]: { S: cell(2) } }, trophy: { [X]: { S: cell(0) } } }));
    const tree = await mount([...PRODUCTS, P(X)]);
    await division(tree, MARATHON);
    await openNotListed(tree);
    expect(nlRows(tree).find((r) => r.pid === X)).toMatchObject({ reason: "emptyRows" });
    const btn = host(tree, "data-not-listed-row", X)[0].findAll((n) => n.type === "button" && n.props["data-action"] === "not-listed-policy")[0];
    await act(async () => { await btn.props.onClick(); });
    expect(openPolicy).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("no product record", async () => {
    const X = "p1790000000006";
    emit("stock", withStock({ central: { [X]: { S: cell(5) } } }));
    const tree = await mount();
    expect(await reasonOf(tree, MARATHON, X)).toEqual({ pid: X, reason: "noRecord", text: "No product record" });
  });

  it("category in neither list", async () => {
    const X = "p1790000000007";
    emit("stock", withStock({ central: { [X]: { 8: cell(3) } } }));
    const tree = await mount([...PRODUCTS, P(X, { productType: "sneaker", category: "Clothing", categoryKey: "sneakers", sizes: ["8"] })]);
    expect((await listedPids(tree, MARATHON)).has(X)).toBe(false);
    expect((await reasonOf(tree, MARATHON, X))?.reason).toBe("noView");
  });

  it("Central's size is not on the product", async () => {
    const X = "p1790000000008";
    emit("stock", withStock({ central: { [X]: { XL: cell(3) } } }));
    const tree = await mount([...PRODUCTS, P(X, { sizes: ["S", "M"] })]);
    expect((await listedPids(tree, MARATHON)).has(X)).toBe(false);
    expect((await reasonOf(tree, MARATHON, X))?.reason).toBe("undeclaredSize");
  });

  it("at both Pine and Concrete", async () => {
    const X = "p1790000000009";
    emit("stock", withStock({ central: { [X]: { S: cell(2), M: cell(2) } } }));
    emit("refill_engine/seats/concrete", { [X]: { at: 1 } });
    emit("refill_engine/seats/marathon-pine", { [X]: { at: 1 } });
    const tree = await mount([...PRODUCTS, P(X)]);
    expect((await listedPids(tree, CONCRETE)).has(X)).toBe(false);
    expect((await reasonOf(tree, CONCRETE, X))?.reason).toBe("bothShops");
  });
});

describe("nothing disappears", () => {
  it("every product with Central stock and none at a division's shops and hubs is a card or a Not-listed row — never neither, never both", async () => {
    const extra = [P("p1790000000010", { productType: "accessory", categoryKey: "keyrings", sizes: ["_"] }), P("p1790000000011", { deactivated: true, deactivatedAt: 1 }), P("p1790000000012", { sizes: ["S"] })];
    emit("stock", withStock({ central: { p1790000000010: { _: cell(1) }, p1790000000011: { S: cell(1) }, p1790000000012: { XL: cell(1) }, p1790000000013: { S: cell(1) } }, trophy: { [TEE]: { S: cell(0) } } }));
    emit("settings/missingProductsHidden", { [JACKET]: { at: 1, by: "u1" } });
    const tree = await mount([...PRODUCTS, ...extra]);
    for (const sec of [MARATHON, CONCRETE]) {
      const cards = await listedPids(tree, sec);
      await openNotListed(tree);
      const rows = nlRows(tree).map((r) => r.pid);
      await back(tree);
      const stranded = strandedAtCentral({ allStock: paths.stock, locations: LOCS[sec] }).map((s) => s.pid);
      expect(stranded.length).toBeGreaterThan(0);
      for (const pid of stranded) expect([cards.has(pid), rows.includes(pid)].filter(Boolean).length).toBe(1);
      for (const pid of rows) expect(stranded).toContain(pid);
    }
  });
});

describe("search", () => {
  it("narrows Not listed with the list, and says when the matches are on the other tab", async () => {
    const X = "p1782998928611";
    emit("stock", withStock({ central: { [X]: { M: cell(18) } }, trophy: { [X]: { M: cell(0) } } }));
    const tree = await mount([...PRODUCTS, P(X, { name: "Adidas tracksuit full black", categoryKey: "tracksuits", sizes: ["M"] })]);
    const input = host(tree, "data-search-input")[0];
    await act(async () => { input.props.onChange({ target: { value: "tracksuit full black" } }); });
    // Marathon, Sneakers (the screen opens there): nothing found, and it is not on Clothing either…
    expect(host(tree, "data-nothing-found").length).toBe(1);
    expect(line(tree).props["data-not-listed-line"]).toBe(1);
    // …on Concrete it IS a card — on the Clothing tab, and Sneakers says so.
    await division(tree, CONCRETE);
    const hint = host(tree, "data-action", "other-kind")[0];
    expect(flat(hint.children)).toBe("1 under Clothing");
    await act(async () => { hint.props.onClick(); });
    expect(host(tree, "data-card").map((n) => n.props["data-card"])).toEqual([X]);
  });
});
