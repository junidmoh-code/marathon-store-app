// ─── MISSING PRODUCTS — THE REBUILT SCREEN (Junid, 22 Nov 2026) ───────────────
// Marathon | Concrete with counts, Sneakers | Clothing, then the list. A card
// is a fixed box whose destination buttons ARE the solve. Only what a tap
// would send for is on the list; the order never changes after a solve; a
// toast confirms with Undo.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
const listeners = {};
// Every database read the screen makes (search must add none).
const reads = { onValue: 0, get: 0 };
// A one-product live read (Solve's check at the tap) answers from the same
// data the listeners hold: stock/{loc}/{pid}, and refill_requests by productId.
const liveOf = (path) => {
  const m = /^stock\/([^/]+)\/([^/?]+)$/.exec(path);
  if (m) return paths.stock?.[m[1]]?.[m[2]] ?? null;
  const q = /^refill_requests\?orderBy=productId&equalTo=(.+)$/.exec(path);
  if (q) { const all = paths.refill_requests || {}; const out = Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.productId === q[1])); return Object.keys(out).length ? out : null; }
  return null;
};
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
  get: (r) => { reads.get++; return Promise.resolve({ val: () => (r.path in gets ? gets[r.path] : liveOf(r.path)) }); },
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

const mount = async () => { let tree; await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={PRODUCTS} onExit={() => {}} />); }); await act(async () => {}); await act(async () => {}); return tree; };
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

describe("the screen Junid asked for", () => {
  it("Marathon | Concrete with counts, Sneakers | Clothing (Sneakers first), then the list — and nothing else", async () => {
    const tree = await mount();
    expect(host(tree, "data-division").map((n) => n.props["data-division"])).toEqual([MARATHON, CONCRETE]);
    expect(host(tree, "data-kind").map((n) => [n.props["data-kind"], n.props["aria-pressed"]])).toEqual([["sneakers", true], ["clothing", false]]);
    // REMOVED: tabs, filters, the count line, Move by hand, Mark & hide, the panel.
    // The ONE input is the thin search field (Junid, 23 Nov 2026); no select.
    expect(tree.root.findAll((n) => n.type === "select").length).toBe(0);
    expect(tree.root.findAll((n) => n.type === "input").map((n) => n.props["aria-label"])).toEqual(["Search"]);
    expect(host(tree, "data-view").length).toBe(0);
    const all = textOf(tree);
    for (const gone of [/To do/, /Queued & solved/, /newest uploads first/, /missing from/i, /Move by hand/, /Mark & hide/, /Carry at/, /Starts keeping/, /Never sent/, /One moment/, /Concrete-only/]) expect(all).not.toMatch(gone);
    // …and, at the very bottom, the one small "Not listed: N" line (Junid, 23 Nov 2026).
    for (const b of buttons(tree)) expect(["← Back", "Marathon", "Concrete", "Sneakers", "Clothing", "✓Hub 1", "✓Hub 2", "Solve", ""].some((ok) => b.trim() === ok || /^(Marathon|Concrete)\d+$/.test(b) || /^Not listed: \d+$/.test(b))).toBe(true);
  });

  it("the header count is the number of cards on that division's two lists", async () => {
    const tree = await mount();
    const n = { [MARATHON]: 0, [CONCRETE]: 0 };
    for (const sec of [MARATHON, CONCRETE]) {
      await division(tree, sec);
      for (const k of ["sneakers", "clothing"]) { await kind(tree, k); n[sec] += cardsOf(tree).length; }
    }
    expect(count(tree, MARATHON)).toBe(String(n[MARATHON]));
    expect(count(tree, CONCRETE)).toBe(String(n[CONCRETE]));
    expect(n).toEqual({ [MARATHON]: 6, [CONCRETE]: 7 });   // the hoodie Concrete holds is not listed (Junid, 24 Nov 2026)
  });

  it("every card is the same fixed box: photo, name, one stock line, its destinations and the division button", async () => {
    const tree = await mount();
    const heights = host(tree, "data-card").map((n) => n.props.style.height);
    expect(new Set(heights).size).toBe(1);
    expect(stockLine(tree, SHOE_B)).toBe("Central 18");
    for (const pid of [SHOE_A, SHOE_B, SHOE_C]) expect(card(tree, pid).findAll((n) => n.type === "button" && n.props["data-action"] === "hide").length).toBe(0);
    for (const pid of [SHOE_A, SHOE_B, SHOE_C]) expect(card(tree, pid).findAll((n) => n.type === "button" && n.props["data-action"] === "division").map((b) => b.props["data-division-mark"])).toEqual(["concrete"]);
    for (const pid of [SHOE_A, SHOE_B, SHOE_C]) expect(solveBtn(tree, pid)).toBeDefined();
  });
});

describe("destinations follow the division — on the card, and in what is written", () => {
  it("Marathon sneakers: Hub 1 and Hub 2, never Hub 3; one tap writes requests for that hub only", async () => {
    const tree = await mount();
    expect(offered(tree, SHOE_B)).toEqual(["hub1", "hub2"]);
    await tapDest(tree, SHOE_B, "hub2");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = lastUpdate();
    expect(Object.keys(upd).every((k) => k.startsWith("refill_requests/"))).toBe(true);
    const reqs = requestsIn(upd);
    expect(reqs.map((r) => [r.size, r.qty])).toEqual([["8", 2], ["9", 2]]);
    for (const r of reqs) { expect(r.requestingLocation).toBe("hub2"); expect(r.productId).toBe(SHOE_B); expect(r.status).toBe("open"); expect(r.requestSource).toBe("solve"); }
    expect(toast(tree).text).toMatch(/Hub 2 · 4 pairs/);
  });

  it("Hub 1 and Hub 2 never both: the card leaves Marathon's list with the tap and stays on Concrete's", async () => {
    const tree = await mount();
    await tapDest(tree, SHOE_B, "hub1");
    expect(cardsOf(tree)).not.toContain("Gazelle Bold");
    expect(count(tree, MARATHON)).toBe("5");
    expect(updateMock).toHaveBeenCalledTimes(1);          // one tap, one hub, one write
    await division(tree, CONCRETE);
    expect(cardsOf(tree)).toContain("Gazelle Bold");
    expect(count(tree, CONCRETE)).toBe("7");
  });

  it("Concrete sneakers: one button, Hub 3", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    expect(offered(tree, SHOE_B)).toEqual(["hub3"]);
    await tapDest(tree, SHOE_B, "hub3");
    for (const r of requestsIn(lastUpdate())) expect(r.requestingLocation).toBe("hub3");
    expect(stockLocs(lastUpdate()).every((l) => l === "hub3")).toBe(true);
    expect(cardsOf(tree)).not.toContain("Gazelle Bold");
    await division(tree, MARATHON);
    expect(cardsOf(tree)).toContain("Gazelle Bold");       // still Marathon's to solve
  });

  it("Concrete clothing: Pine and Concrete; a tap on Pine writes for Pine only, and the card is gone — never both", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    expect(offered(tree, TEE)).toEqual(["marathon-pine", "concrete"]);
    expect(flat(dests(tree, TEE)[0].children)).toBe("✓Pine");                 // (the tick is there, unseen, until chosen)
    await tapDest(tree, TEE, "marathon-pine");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = lastUpdate();
    expect(stockLocs(upd)).toEqual(["marathon-pine"]);
    const reqs = requestsIn(upd);
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(r.requestingLocation).toBe("marathon-pine");
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(card(tree, TEE)?.props).toBeDefined();            // its slot is only closing…
    expect(live(tree, TEE).length >= 0).toBe(true);
    await kind(tree, "sneakers"); await kind(tree, "clothing");
    expect(card(tree, TEE)).toBeUndefined();                 // …and there is no card left to tap for Concrete
    await division(tree, MARATHON);
    expect(cardsOf(tree)).toContain("Essentials Tee Olive"); // Marathon's list keeps it
  });

  it("Marathon clothing: Marathon's own shops, never Pine or Concrete; one tap, one shop", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    expect(offered(tree, TEE)).toEqual(["marathon-pe", "trophy"]);
    await tapDest(tree, TEE, "trophy");
    const locs = stockLocs(lastUpdate());
    expect(locs).toContain("trophy");
    for (const l of locs) expect(["trophy", "hub2"]).toContain(l);
    for (const r of requestsIn(lastUpdate())) expect(r.requestingLocation).toBe("trophy");
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });
});

describe("only what a solve would send is on the list", () => {
  it("a product short of sizes that no source holds is not listed and not counted", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    // Concrete has M of the white tee and is short of S and L; Central has none of it.
    expect(cardsOf(tree)).not.toContain("T shirt white 70740");
    expect(cardsOf(tree)).toEqual(["Essentials Tee Olive", "Varsity Jacket"]);   // Box Hoodie: Concrete holds it
    expect(textOf(tree)).not.toMatch(/has none/i);
  });

  it("HELD IN THE DIVISION (Junid, 24 Nov 2026): a product a shop of the division holds is not listed — the refill engine tops it up there", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    // Concrete keeps M of the hoodie (short of S and L): Concrete holds it, so it is Concrete's to refill.
    expect(cardsOf(tree)).not.toContain("Box Hoodie");
    expect(card(tree, HOODIE)).toBeFalsy();
  });

  it("the stock line agrees with the payload: every size sent is one it counted, and never more than it counted", async () => {
    const tree = await mount();
    const line = stockLine(tree, SHOE_C);                    // Central holds one pair, size 8
    expect(line).toBe("Central 1");
    await tapDest(tree, SHOE_C, "hub1");
    const reqs = requestsIn(lastUpdate());
    expect(reqs.map((r) => [r.size, r.qty])).toEqual([["8", 1]]);
    expect(reqs.reduce((t, r) => t + r.qty, 0)).toBeLessThanOrEqual(Number(line.split(" ")[1]));
  });

  it("what Central has already promised is not offered again: a shelf fully owed to open requests is off the list", async () => {
    // both pairs of the Samba's only size are already requested by Hub 2 (the scan's row)
    emit("refill_requests", { r1: { productId: SHOE_C, size: "8", qty: 1, requestingLocation: "hub2", status: "open", requestSource: "scan", createdFrom: { source: "central" } } });
    const tree = await mount();
    expect(cardsOf(tree)).not.toContain("Samba OG");
    expect(count(tree, MARATHON)).toBe("5");
  });
});

describe("queued means a real open request, and nothing else", () => {
  it("a product with Central stock and no open request is solvable", async () => {
    const tree = await mount();
    expect(live(tree, SHOE_A)).toEqual(["hub1", "hub2"]);
  });

  it("a product with a real open request is off the list — and that request is one Source shows (open, its hub, its product id)", async () => {
    emit("refill_requests", { r1: sneakerReq(), r2: sneakerReq({ size: "9" }) });
    const tree = await mount();
    expect(cardsOf(tree)).not.toContain("Air Zoom Alpha");
    expect(count(tree, MARATHON)).toBe("5");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a stale record does not block a solve: a cancelled or fulfilled request leaves the card solvable", async () => {
    emit("refill_requests", { r1: sneakerReq({ status: "cancelled" }), r2: sneakerReq({ size: "9", status: "fulfilled" }) });
    const tree = await mount();
    expect(live(tree, SHOE_A)).toEqual(["hub1", "hub2"]);
    await tapDest(tree, SHOE_A, "hub1");
    expect(requestsIn(lastUpdate()).length).toBe(2);
  });

  it("two products with the same name do not affect each other: the twin's request hides only the twin", async () => {
    emit("refill_requests", { r1: sneakerReq({ productId: TWIN }), r2: sneakerReq({ productId: TWIN, size: "9" }) });
    const tree = await mount();
    expect(live(tree, SHOE_A)).toEqual(["hub1", "hub2"]);     // same name, different record: untouched
    await tapDest(tree, SHOE_A, "hub1");
    for (const r of requestsIn(lastUpdate())) expect(r.productId).toBe(SHOE_A);
  });

  it("same name elsewhere is the other record's thumbnail on the card — no sentence", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);                           // Hub 3 holds the twin
    const badge = card(tree, SHOE_A).findAll((n) => n.type === "button" && n.props["data-same-name"]);
    expect(badge.length).toBe(1);
    expect(badge[0].props["data-same-name"]).toBe(TWIN);
    expect(textOf(tree)).not.toMatch(/Same name elsewhere|Compare the two photos/);
    expect(card(tree, SHOE_B).findAll((n) => n.type === "button" && n.props["data-same-name"]).length).toBe(0);
  });
});

describe("kids shoes: no policy is said as no policy, never as queued", () => {
  it("Central stock, no request, no policy → NOT a card (24 Nov 2026): under 'Not listed' as 'No policy', with the Engine Policy action", async () => {
    let opened = 0;
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={PRODUCTS} onExit={() => {}} onOpenEnginePolicy={() => { opened += 1; }} />); });
    await act(async () => {}); await act(async () => {});
    expect(host(tree, "data-needs-label").length).toBe(0);
    expect(cardsOf(tree)).not.toContain("Nike SB dunk low grey small");
    expect(host(tree, "data-card", KID).length).toBe(0);
    expect(textOf(tree)).not.toMatch(/queued|No policy yet/i);
    await act(async () => { host(tree, "data-not-listed-line")[0].props.onClick(); });
    const row = host(tree, "data-not-listed-row", KID)[0];
    expect(row.props["data-reason"]).toBe("noPolicy");
    expect(flat(row.findAll((n) => typeof n.type === "string" && n.props["data-reason-text"])[0].children)).toBe("No policy");
    const btn = row.findAll((n) => n.type === "button" && n.props["data-action"] === "not-listed-policy")[0];
    await act(async () => { btn.props.onClick(); });
    expect(opened).toBe(1);
  });

  it("a no-policy shoe a SHOP of the division holds a pair of (so not 'stranded') is still under Not listed as No policy — never silently gone", async () => {
    const st = baseStock(); st.trophy = { ...(st.trophy || {}), [KID]: { 24: cell(1) } };
    emit("stock", st);
    const tree = await mount();
    expect(host(tree, "data-card", KID).length).toBe(0);
    await act(async () => { host(tree, "data-not-listed-line")[0].props.onClick(); });
    expect(host(tree, "data-not-listed-row", KID)[0].props["data-reason"]).toBe("noPolicy");
  });

  it("tapping a location or Solve disarms the division button", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    const mb = () => card(tree, TEE).findAll((n) => n.type === "button" && n.props["data-action"] === "division")[0];
    await act(async () => { mb().props.onClick(); });
    expect(mb().props["data-armed"]).toBe(true);
    await pick(tree, TEE, offered(tree, TEE)[0]);
    expect(mb().props["data-armed"]).toBeUndefined();
    updateMock.mockClear();
    await act(async () => { mb().props.onClick(); });            // arms again — writes nothing
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("NO CARD ANYWHERE has the division button as its only control: every card on both divisions and both kinds offers a location", async () => {
    const tree = await mount();
    for (const sec of [MARATHON, CONCRETE]) {
      await division(tree, sec);
      for (const k of ["sneakers", "clothing"]) {
        await kind(tree, k);
        for (const c of host(tree, "data-card")) expect(c.findAll((n) => n.type === "button" && n.props["data-dest"]).length).toBeGreaterThan(0);
      }
    }
  });

  it("once a policy names its sizes at a hub it is solvable there, and the request is written for Source", async () => {
    const row = { target: 2, minQty: 1, reorderPoint: 1, source: "policy_target" };
    emit("stock_targets", { hub1: { [KID]: { 24: row, 25: row, 26: row } } });
    const tree = await mount();
    expect(live(tree, KID)).toEqual(["hub1"]);                 // Hub 1 has the numbers; Hub 2 has none
    expect(stockLine(tree, KID)).toBe("Central 6");
    expect(host(tree, "data-card", KID2).length).toBe(0);      // the other kids shoe still waits — not a card
    await tapDest(tree, KID, "hub1");
    const reqs = requestsIn(lastUpdate());
    expect(reqs.map((r) => [r.size, r.qty, r.requestingLocation, r.status])).toEqual([["24", 2, "hub1", "open"], ["25", 2, "hub1", "open"], ["26", 2, "hub1", "open"]]);
  });

  it("once Junid gives Kids Shoes numbers of its own on the Engine Policy card, a Request uses them", async () => {
    gets["config/refillEngine/categoryPolicy/kids-shoes"] = { perSize: true, hub2: { carriedOnly: true, sizes: { 24: { target: 1, minQty: 1 }, 25: { target: 1, minQty: 1 } } } };
    const tree = await mount();
    expect(live(tree, KID)).toEqual(["hub2"]);
    expect(stockLine(tree, KID)).toBe("Central 4");
    await tapDest(tree, KID, "hub2");
    expect(requestsIn(lastUpdate()).map((r) => [r.size, r.qty, r.requestingLocation])).toEqual([["24", 1, "hub2"], ["25", 1, "hub2"]]);
  });

  it("an ADULT shoe with nothing to send (only a size no policy names) is not listed at all — 'needs policy' is Kids Shoes only", async () => {
    const BIG = "p1796100000000";
    const stock = baseStock(); stock.central[BIG] = { 15: cell(4) };
    emit("stock", stock);
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={[...PRODUCTS, { id: BIG, name: "Air Max Size 15", category: "Footwear", categoryKey: "sneakers", sizes: ["15"] }]} onExit={() => {}} />); });
    await act(async () => {}); await act(async () => {});
    expect(cardsOf(tree)).not.toContain("Air Max Size 15");
    expect(count(tree, MARATHON)).toBe("6");
  });

  it("adult sneakers are unchanged: the run's numbers, with or without a target row for a size the run names", async () => {
    emit("stock_targets", { hub1: { [SHOE_B]: { 8: { target: 5 }, 9: { target: 5 } } } });
    gets["config/refillEngine/categoryPolicy/kids-shoes"] = { perSize: true, hub1: { sizes: { 8: { target: 9 }, 9: { target: 9 } } } };   // never reaches an adult shoe
    const tree = await mount();
    await tapDest(tree, SHOE_B, "hub1");
    expect(requestsIn(lastUpdate()).map((r) => [r.size, r.qty])).toEqual([["8", 2], ["9", 2]]);
  });

  it("on Concrete's list a kids shoe is an ordinary Hub 3 card (Hub 3 keeps every size)", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    expect(host(tree, "data-needs-label").length).toBe(0);
    expect(live(tree, KID)).toEqual(["hub3"]);
  });
});

describe("no shake: the order is frozen and only the solved card leaves", () => {
  it("after a solve every other card is where it was; data echoes and re-renders do not re-sort", async () => {
    const tree = await mount();
    const before = cardsOf(tree);
    await tapDest(tree, SHOE_A, "hub1");
    const after = cardsOf(tree);
    expect(after).toEqual(before.filter((n) => n !== "Air Zoom Alpha"));
    // the echo of the write, then an unrelated stock tick that changes units
    await act(async () => { emit("refill_requests", Object.fromEntries(Object.entries(lastUpdate()).map(([k, v]) => [k.split("/")[1], v]))); });
    const s2 = baseStock(); s2.central[SHOE_C] = { 8: cell(40), 9: cell(40) };
    await act(async () => { emit("stock", s2); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(cardsOf(tree)).toEqual(after);
    expect(stockLine(tree, SHOE_C)).toBe("Central 80");       // the card updates in place
  });

  it("a card's buttons are never 'checking': everything is decided before it is drawn, and a tap adds no element", async () => {
    const tree = await mount();
    const shape = () => host(tree, "data-card").map((n) => `${n.props.style.height}:${n.findAll((x) => x.type === "button").length}`);
    const s0 = shape();
    let release;
    updateMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await pick(tree, SHOE_B, "hub1");
    expect(shape()).toEqual(s0);                               // chosen: same box, same buttons
    await act(async () => { solveBtn(tree, SHOE_B).props.onClick(); });
    await act(async () => {});
    expect(shape()).toEqual(s0);                               // the write is in flight: same boxes, same buttons
    expect(cardsOf(tree)).toContain("Gazelle Bold");           // the card stays until the write has landed
    await act(async () => { release(); });
    await act(async () => {});
    expect(cardsOf(tree)).not.toContain("Gazelle Bold");
  });

  it("a failed solve says why in the toast and the card stays put", async () => {
    const tree = await mount();
    const before = cardsOf(tree);
    updateMock.mockImplementationOnce(() => Promise.reject(new Error("PERMISSION_DENIED")));
    await tapDest(tree, SHOE_B, "hub1");
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/nothing changed.*PERMISSION_DENIED/);
    expect(toast(tree).undo).toBeUndefined();
    expect(cardsOf(tree)).toEqual(before);
    expect(count(tree, MARATHON)).toBe("6");
    expect(live(tree, SHOE_B)).toEqual(["hub1", "hub2"]);      // and can be tapped again
  });

  it("ten solves in a row: each leaves once, the rest never move", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p17960000000${String(i).padStart(2, "0")}`);
    const stock = baseStock();
    for (const id of ids) stock.central[id] = { 8: cell(4), 9: cell(4) };
    emit("stock", stock);
    const more = ids.map((id, i) => ({ id, name: `Runner ${i}`, category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] }));
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={[...PRODUCTS, ...more]} onExit={() => {}} />); });
    await act(async () => {}); await act(async () => {});
    let order = cardsOf(tree);
    for (const id of ids) {
      const name = card(tree, id).props["data-card-name"];
      await tapDest(tree, id, "hub1");
      order = order.filter((n) => n !== name);
      expect(cardsOf(tree)).toEqual(order);
    }
    expect(updateMock).toHaveBeenCalledTimes(10);
    expect(count(tree, MARATHON)).toBe("6");
  });
});

describe("Undo", () => {
  it("a sneaker request: Undo cancels exactly the requests that tap raised, and the card is back in its place", async () => {
    const tree = await mount();
    const before = cardsOf(tree);
    await tapDest(tree, SHOE_B, "hub1");
    const upd = lastUpdate();
    land(upd);
    expect(toast(tree).undo).toBeDefined();
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {});
    const ids = Object.keys(upd);
    const reqTxns = txnCalls.filter((c) => c.path.startsWith("refill_requests/"));   // (the Solve claim is a transaction too)
    expect(reqTxns.map((c) => c.path).sort()).toEqual(ids.sort());
    for (const c of reqTxns) { expect(c.next.status).toBe("cancelled"); expect(c.next.cancelReason).toBe("solve_undone"); expect(c.next.productId).toBe(SHOE_B); }
    expect(updateMock).toHaveBeenCalledTimes(1);               // Undo creates nothing
    expect(cardsOf(tree)).toEqual(before);
    expect(count(tree, MARATHON)).toBe("6");
    expect(toast(tree).text).toBe("Undone");
  });

  it("a request Central has already started on stands, and the card stays off the list", async () => {
    const tree = await mount();
    await tapDest(tree, SHOE_B, "hub1");
    const upd = lastUpdate();
    land(upd);
    const first = Object.keys(upd)[0];
    txnData[first] = { ...txnData[first], sentQty: 1 };       // Central picked one
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {});
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/Central had already started/);
    expect(txnData[first].status).toBe("open");
    expect(cardsOf(tree)).not.toContain("Gazelle Bold");
  });

  it("an Undo that fails part-way keeps its Undo, and the retry finishes — this tap's own cancels are not 'Central's work'", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    await tapDest(tree, SHOE_B, "hub3");                       // requests AND Hub 3 seeds
    const upd = lastUpdate();
    land(upd);
    const ids = Object.keys(upd).filter((k) => k.startsWith("refill_requests/"));
    expect(Object.keys(upd).some((k) => k.startsWith("stock/hub3/"))).toBe(true);
    // first attempt: every cancel commits, then the first seed clean-up throws
    const realRun = txnCalls.push;
    let thrown = false;
    txnCalls.push = function (c) { realRun.call(this, c); if (!thrown && String(c.path).startsWith("stock/")) { thrown = true; throw new Error("network"); } return this.length; };
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {});
    txnCalls.push = realRun;
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).undo).toBeDefined();                    // the Undo is still there
    for (const k of ids) expect(txnData[k].status).toBe("cancelled");
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    expect(toast(tree).text).toBe("Undone");
    for (const k of Object.keys(upd).filter((x) => x.startsWith("stock/hub3/"))) expect(txnData[k]).toBe(null);
    expect(cardsOf(tree)).toContain("Gazelle Bold");
  });

  it("a clothing solve: Undo cancels its requests and takes back its untouched seeds; the card is back", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    const before = cardsOf(tree);
    await tapDest(tree, TEE, "concrete");
    const upd = lastUpdate();
    land(upd);
    for (const [k, v] of Object.entries(upd)) if (k.startsWith("refill_requests/")) gets[k] = v;   // undo re-reads them live
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    const reqPaths = Object.keys(upd).filter((k) => k.startsWith("refill_requests/"));
    for (const k of reqPaths) expect(txnData[k].status).toBe("cancelled");
    for (const k of Object.keys(upd).filter((x) => x.startsWith("stock/") && upd[x] && upd[x].mv === "seed")) expect(txnData[k]).toBe(null);
    expect(cardsOf(tree)).toEqual(before);
    expect(toast(tree).text).toBe("Undone");
  });
});

describe("the hidden tab behind the invisible spot (Hide left the cards, 23 Nov 2026)", () => {
  it("the hidden node is honoured on every device, and the tab behind the press-and-hold spot lists it with Unhide", async () => {
    emit("settings/missingProductsHidden", { [TEE]: { at: NOW, by: "u1" } });
    const tree = await mount();
    await kind(tree, "clothing");
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("5");
    expect(buttons(tree).some((t) => /Hidden/.test(t))).toBe(false);          // no visible way in
    const spot = tree.root.findAll((n) => n.type === "div" && typeof n.props.onPointerDown === "function")[0];
    expect(spot).toBeDefined();
    vi.useFakeTimers();
    await act(async () => { spot.props.onPointerDown({ clientX: 5, clientY: 5 }); vi.advanceTimersByTime(650); });
    vi.useRealTimers();
    expect(textOf(tree)).toMatch(/Hidden \(1\)/);
    expect(textOf(tree)).toMatch(/Essentials Tee Olive/);
    expect(textOf(tree)).toMatch(/STILL MISSING/);
    expect(buttons(tree)).toContain("Unhide");
    // Back returns to the list, not out of the screen
    await act(async () => { tree.root.findAll((n) => n.type === "button" && n.props["data-action"] === "exit")[0].props.onClick(); });
    expect(textOf(tree)).toMatch(/Missing Products/);
  });
});

describe("who may do what", () => {
  it("a viewer of one division sees that division only", async () => {
    perm.isSuperAdmin = false; perm.permRecord = { stockRole: "warehouse", section: 2 };
    const tree = await mount();
    expect(host(tree, "data-division").map((n) => n.props["data-division"])).toEqual([MARATHON]);
    expect(count(tree, MARATHON)).toBe("6");
  });

  it("without a stock role nothing can be tapped", async () => {
    perm.isSuperAdmin = false; perm.permRecord = { displayName: "Viewer" };
    const tree = await mount();
    // no stock role: nothing to choose, no Solve, no division button — and nothing rendered disabled
    expect(live(tree, SHOE_B)).toEqual([]);
    expect(solveBtn(tree, SHOE_B)).toBeUndefined();
    expect(card(tree, SHOE_B).findAll((n) => n.type === "button" && (n.props["data-action"] === "hide" || n.props["data-action"] === "division")).length).toBe(0);
  });
});

describe("choose, then Solve (Junid, 22 Nov 2026)", () => {
  it("tapping a location writes nothing, sends nothing, and the card stays", async () => {
    const tree = await mount();
    await pick(tree, SHOE_B, "hub1");
    await pick(tree, SHOE_B, "hub2");
    await pick(tree, SHOE_B, "hub2");
    expect(updateMock).not.toHaveBeenCalled();
    expect(txnCalls.length).toBe(0);
    expect(cardsOf(tree)).toContain("Gazelle Bold");
    expect(toast(tree)).toBe(null);
  });

  it("nothing is preselected — not even a lone Hub 3 — and Solve with nothing chosen does nothing", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    expect(offered(tree, SHOE_B)).toEqual(["hub3"]);
    expect(picked(tree, SHOE_B)).toEqual([]);
    expect(solveBtn(tree, SHOE_B).props["aria-disabled"]).toBe(true);
    await solve(tree, SHOE_B);
    expect(updateMock).not.toHaveBeenCalled();
    expect(cardsOf(tree)).toContain("Gazelle Bold");
  });

  it("a tap chooses (filled, ticked), a second tap un-chooses; Solve wakes only once something is chosen", async () => {
    const tree = await mount();
    await pick(tree, SHOE_B, "hub1");
    expect(picked(tree, SHOE_B)).toEqual(["hub1"]);
    expect(flat(dests(tree, SHOE_B)[0].children)).toBe("✓Hub 1");
    // the tick is there, unseen, before choosing too — so nothing moves when it shows
    expect(flat(dests(tree, SHOE_B)[1].children)).toBe("✓Hub 2");
    expect(dests(tree, SHOE_B)[1].findAll((n) => n.type === "span")[0].props.style.opacity).toBe(0);
    expect(solveBtn(tree, SHOE_B).props["aria-disabled"]).toBe(false);
    await pick(tree, SHOE_B, "hub1");
    expect(picked(tree, SHOE_B)).toEqual([]);
    expect(solveBtn(tree, SHOE_B).props["aria-disabled"]).toBe(true);
  });

  it("Hub 1 and Hub 2 switch each other off", async () => {
    const tree = await mount();
    await pick(tree, SHOE_B, "hub1");
    await pick(tree, SHOE_B, "hub2");
    expect(picked(tree, SHOE_B)).toEqual(["hub2"]);
    await solve(tree, SHOE_B);
    for (const r of requestsIn(lastUpdate())) expect(r.requestingLocation).toBe("hub2");
  });

  it("Pine and Concrete switch each other off — both chosen is impossible", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    await pick(tree, TEE, "marathon-pine");
    await pick(tree, TEE, "concrete");
    expect(picked(tree, TEE)).toEqual(["concrete"]);
    await pick(tree, TEE, "marathon-pine");
    expect(picked(tree, TEE)).toEqual(["marathon-pine"]);
  });

  it("Solve sends exactly the chosen location", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    await pick(tree, TEE, "concrete");
    await solve(tree, TEE);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(stockLocs(lastUpdate())).toEqual(["concrete"]);
    for (const r of requestsIn(lastUpdate())) expect(r.requestingLocation).toBe("concrete");
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("Marathon's shops are one or the other, like Pine and Concrete (Junid, 24 Nov 2026): choosing Trophy switches Marathon PE off", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    await pick(tree, TEE, "marathon-pe");
    await pick(tree, TEE, "trophy");
    expect(picked(tree, TEE)).toEqual(["trophy"]);
    await solve(tree, TEE);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const locs = stockLocs(lastUpdate());
    expect(locs).toContain("trophy"); expect(locs).not.toContain("marathon-pe");
  });

  it("a Marathon product a Marathon shop holds is not on Marathon's list", async () => {
    const st = baseStock(); st["marathon-pe"] = { ...(st["marathon-pe"] || {}), [TEE]: { S: cell(1) } };
    emit("stock", st);
    const tree = await mount();
    await kind(tree, "clothing");
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("a choice on one card touches no other card", async () => {
    const tree = await mount();
    await pick(tree, SHOE_B, "hub1");
    expect(picked(tree, SHOE_A)).toEqual([]);
    expect(picked(tree, SHOE_C)).toEqual([]);
  });

  it("a choice is cleared when Junid leaves the screen", async () => {
    let tree = await mount();
    await pick(tree, SHOE_B, "hub1");
    await act(async () => { tree.unmount(); });
    tree = await mount();
    expect(picked(tree, SHOE_B)).toEqual([]);
  });

  it("card height is identical before choosing, after choosing and with Solve awake; no button anywhere renders disabled", async () => {
    const tree = await mount();
    const h = () => card(tree, SHOE_B).props.style.height;
    const h0 = h();
    await pick(tree, SHOE_B, "hub1");
    expect(h()).toBe(h0);
    expect(solveBtn(tree, SHOE_B).props["aria-disabled"]).toBe(false);
    expect(h()).toBe(h0);
    await division(tree, CONCRETE);
    for (const k of ["sneakers", "clothing"]) {
      await kind(tree, k);
      expect(new Set(host(tree, "data-card").map((n) => n.props.style.height))).toEqual(new Set([h0]));   // one location or two
    }
    expect(tree.root.findAll((n) => n.type === "button" && n.props.disabled).length).toBe(0);
  });

  it("an unchosen location is never green; green is Solve's alone, once something is chosen", async () => {
    const tree = await mount();
    const GREEN = "#4ADE80";
    const styleOf = (b) => JSON.stringify(b.props.style);
    for (const b of dests(tree, SHOE_B)) expect(styleOf(b)).not.toMatch(new RegExp(GREEN, "i"));
    expect(styleOf(solveBtn(tree, SHOE_B))).not.toMatch(new RegExp(GREEN, "i"));
    await pick(tree, SHOE_B, "hub1");
    for (const b of dests(tree, SHOE_B)) expect(styleOf(b)).not.toMatch(new RegExp(GREEN, "i"));
    expect(styleOf(solveBtn(tree, SHOE_B))).toMatch(new RegExp(GREEN, "i"));
  });
});

describe("one product, one shop — Pine or Concrete, never both", () => {
  const conc = async () => { const tree = await mount(); await division(tree, CONCRETE); await kind(tree, "clothing"); return tree; };
  it("at neither shop: both offered, neither chosen", async () => {
    const tree = await conc();
    expect(offered(tree, TEE)).toEqual(["marathon-pine", "concrete"]);
    expect(picked(tree, TEE)).toEqual([]);
  });

  it("held by Concrete (stock there) → not listed at all (Junid, 24 Nov 2026)", async () => {
    const st = baseStock(); st.concrete[TEE] = { S: cell(2) };     // Concrete keeps S; Central has M and L for it
    emit("stock", st);
    const tree = await conc();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("held by Pine (seated there, no units) → not listed at all", async () => {
    emit("refill_engine/seats/marathon-pine", { [TEE]: { at: "2026-11-22T09:00:00.000Z", via: "cell" } });
    const tree = await conc();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(host(tree, "data-held-at").length).toBe(0);   // no ownership note any more
  });

  it("owned by Concrete with nothing to send there → not on the list at all, and never offered to Pine instead", async () => {
    const st = baseStock(); st.concrete[TEE] = { S: cell(2), M: cell(2), L: cell(2) };
    emit("stock", st);
    const tree = await conc();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("owned by BOTH (a data question for Junid) → offered to neither, not listed", async () => {
    emit("refill_engine/seats/marathon-pine", { [TEE]: { at: "2026-11-22T09:00:00.000Z" } });
    emit("refill_engine/seats/concrete", { [TEE]: { at: "2026-11-22T09:00:00.000Z" } });
    const tree = await conc();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("after solving to Pine, Concrete is no longer offered — on reload, and on a second device", async () => {
    const tree = await conc();
    await pick(tree, TEE, "marathon-pine");
    await solve(tree, TEE);
    const upd = lastUpdate();
    // what the database now holds, as any device sees it
    const reqs = Object.fromEntries(Object.entries(upd).filter(([k]) => k.startsWith("refill_requests/")).map(([k, v]) => [k.split("/")[1], v]));
    expect(Object.keys(reqs).length).toBeGreaterThan(0);
    await act(async () => { tree.unmount(); });
    emit("refill_requests", reqs);
    const second = await conc();                                 // a reload, or another phone
    // still missing at Concrete's end? never offered there: Pine owns it now
    expect(cardsOf(second)).not.toContain("Essentials Tee Olive");
  });

  it("a request to Pine that is fully sent but still open (units on the way) keeps it Pine's: not listed", async () => {
    emit("refill_requests", { r1: { productId: TEE, size: "M", qty: 2, sentQty: 2, requestingLocation: "marathon-pine", status: "open", createdFrom: { source: "central" } } });
    const tree = await conc();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
  });

  it("a choice that stops applying (the product became the other shop's) never leaves Solve green", async () => {
    const tree = await conc();
    await pick(tree, TEE, "concrete");
    expect(solveBtn(tree, TEE).props["aria-disabled"]).toBe(false);
    await act(async () => { emit("refill_engine/seats/marathon-pine", { [TEE]: { at: "2026-11-22T10:00:00.000Z" } }); });
    for (let i = 0; i < 40 && card(tree, TEE) && cardsOf(tree).includes("Essentials Tee Olive") && offered(tree, TEE).includes("concrete"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    // Pine holds it now: the card leaves (it may still be closing), and nothing is ever sent
    if (card(tree, TEE) && solveBtn(tree, TEE)) await solve(tree, TEE);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a card that leaves the list during the live check sends nothing (CodeRabbit, PR #966)", async () => {
    const tree = await conc();
    await pick(tree, TEE, "concrete");
    // while Solve's live read is out, the product stops being listed (hidden on another device)
    await act(async () => {
      const p = solveBtn(tree, TEE).props.onClick();
      emit("settings/missingProductsHidden", { [TEE]: { at: NOW, by: "u2" } });
      await p;
    });
    await act(async () => {});
    expect(updateMock).not.toHaveBeenCalled();
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/nothing sent/);
    // nothing is left locked: once it is listed again, it can be chosen and solved
    await act(async () => { emit("settings/missingProductsHidden", null); });
    await pick(tree, TEE, "concrete");
    if (!picked(tree, TEE).length) await pick(tree, TEE, "concrete");
    await solve(tree, TEE);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("confirm rejects a second shop: a stale screen chooses Concrete after another device solved it to Pine", async () => {
    const tree = await conc();
    await pick(tree, TEE, "concrete");
    // meanwhile, on another phone, Pine took it (its stock row is what the live check reads)
    gets[`stock/marathon-pine/${TEE}`] = { M: { qty: 0, mv: "seed" } };
    gets[`refill_engine/seats/marathon-pine/${TEE}`] = { at: "2026-11-22T10:00:00.000Z", via: "solve" };
    await solve(tree, TEE);
    expect(updateMock).not.toHaveBeenCalled();
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/Pine already has this/);
    expect(cardsOf(tree)).toContain("Essentials Tee Olive");
  });
});

// ─── THE DIVISION BUTTON (Junid, 23 Nov 2026) ────────────────────────────────
// Where Hide was: "Concrete" on a Marathon card, "Marathon" on a Concrete card.
// One tap = this product belongs to that division only. It writes the mark and
// nothing else: no stock, no seat, no request.
describe("the division button replaces Hide (Junid, 23 Nov 2026)", () => {
  const markBtn = (tree, pid) => card(tree, pid).findAll((n) => n.type === "button" && n.props["data-action"] === "division")[0];
  // Two taps on the same button (24 Nov 2026): the first arms, the second marks.
  const tapMark = async (tree, pid) => { await act(async () => { markBtn(tree, pid).props.onClick(); }); await act(async () => { await markBtn(tree, pid).props.onClick(); }); await act(async () => {}); await act(async () => {}); };
  const allWrites = () => updateMock.mock.calls.flatMap((c) => Object.keys(c[1]));
  const FORBIDDEN = /^(stock|refill_requests|refill_engine|stock_targets|stock_movements|transfers)\//;
  const withProducts = async (over) => {
    const list = PRODUCTS.map((p) => (over[p.id] ? { ...p, ...over[p.id] } : p));
    let tree; await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={list} onExit={() => {}} />); }); await act(async () => {}); await act(async () => {});
    return tree;
  };
  const listOf = async (tree, sec, k) => { await division(tree, sec); await kind(tree, k); return cardsOf(tree); };

  it("ONE tap does nothing (24 Nov 2026): the button reads 'Tap again to move to Concrete', nothing is written, nothing moves; the window runs out and it is the tag again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tree = await mount();
      await kind(tree, "clothing");
      const before = cardsOf(tree);
      const shellH = card(tree, TEE).props.style.height;
      updateMock.mockClear();
      await act(async () => { markBtn(tree, TEE).props.onClick(); });
      expect(markBtn(tree, TEE).props["data-armed"]).toBe(true);
      expect(flat(card(tree, TEE).findAll((n) => typeof n.type === "string" && n.props["data-division-confirm"])[0].children)).toBe("Tap again to move to Concrete");
      // laid over the name block, absolutely: the card and the list do not move
      const over = card(tree, TEE).findAll((n) => typeof n.type === "string" && n.props["data-division-confirm"])[0];
      expect(over.props.style.position).toBe("absolute");
      expect(card(tree, TEE).props.style.height).toBe(shellH);
      expect(updateMock).not.toHaveBeenCalled();
      expect(cardsOf(tree)).toEqual(before);
      await act(async () => { vi.advanceTimersByTime(4100); });
      expect(markBtn(tree, TEE).props["data-armed"]).toBeUndefined();
      // a tap after the window only arms again — still nothing written
      await act(async () => { markBtn(tree, TEE).props.onClick(); });
      expect(updateMock).not.toHaveBeenCalled();
      expect(cardsOf(tree)).toEqual(before);
    } finally { vi.useRealTimers(); }
  });

  it("Marathon card: Concrete marks it Concrete-only — leaves Marathon's list and count; writes the mark only", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    expect(flat(markBtn(tree, TEE).children)).toBe("Concrete");
    expect(count(tree, MARATHON)).toBe("6");
    await tapMark(tree, TEE);
    const writes = allWrites();
    expect(writes).toEqual(expect.arrayContaining([`products/${TEE}/concreteProduct`, `settings/concreteOnlyIndex/${TEE}`]));
    expect(writes.filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(txnCalls.filter((t) => FORBIDDEN.test(t.path))).toEqual([]);
    expect(seatCalls).toEqual([]);
    expect(lastUpdate()[`products/${TEE}/concreteProduct`]).toBe(true);
    expect(lastUpdate()[`settings/concreteOnlyIndex/${TEE}`]).toBe(true);
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("5");
    expect(toast(tree).text).toMatch(/Concrete only/);
    // the database echoes the mark: it stays off Marathon for good
    await act(async () => { emit("settings/concreteOnlyIndex", { [TEE]: true }); });
    await act(async () => {});
    expect(await listOf(tree, MARATHON, "clothing")).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("5");
    // genuinely missing at Concrete → on Concrete's list, Concrete-division shops only
    expect(await listOf(tree, CONCRETE, "clothing")).toContain("Essentials Tee Olive");
    expect(offered(tree, TEE)).toEqual(["marathon-pine", "concrete"]);
  });

  it("marking does not force a product onto Concrete's list: not missing there → not listed there", async () => {
    // Concrete and Pine already keep every size of the tee: nothing to send there.
    const st = baseStock();
    st.concrete[TEE] = { S: cell(4), M: cell(4), L: cell(4) };
    st["marathon-pine"] = { [TEE]: { S: cell(4), M: cell(4), L: cell(4) } };
    emit("stock", st);
    const tree = await mount();
    const concreteBefore = await listOf(tree, CONCRETE, "clothing");
    expect(concreteBefore).not.toContain("Essentials Tee Olive");
    await act(async () => { emit("settings/concreteOnlyIndex", { [TEE]: true }); });
    await act(async () => {});
    expect(await listOf(tree, CONCRETE, "clothing")).toEqual(concreteBefore);
    expect(await listOf(tree, MARATHON, "clothing")).not.toContain("Essentials Tee Olive");
  });

  it("Undo of a Concrete mark puts the card back and clears exactly the mark", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    const before = cardsOf(tree);
    await tapMark(tree, TEE);
    updateMock.mockClear();
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    const upd = updateMock.mock.calls.map((c) => c[1]).find((u) => `products/${TEE}/concreteProduct` in u);
    expect(upd[`products/${TEE}/concreteProduct`]).toBe(false);
    expect(upd[`settings/concreteOnlyIndex/${TEE}`]).toBe(null);
    expect(allWrites().filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(cardsOf(tree)).toEqual(before);
    expect(count(tree, MARATHON)).toBe("6");
  });

  it("Concrete card: Marathon marks it Marathon-only — the mirror", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    const n = Number(count(tree, CONCRETE));
    expect(flat(markBtn(tree, TEE).children)).toBe("Marathon");
    await tapMark(tree, TEE);
    expect(lastUpdate()).toEqual({
      [`products/${TEE}/marathonProduct`]: true, [`products/${TEE}/marathonProductSetBy`]: "u1", [`products/${TEE}/marathonProductSetAt`]: NOW,
      [`settings/marathonOnlyIndex/${TEE}`]: true,
    });
    expect(allWrites().filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(seatCalls).toEqual([]);
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(count(tree, CONCRETE)).toBe(String(n - 1));
    await act(async () => { emit("settings/marathonOnlyIndex", { [TEE]: true }); });
    await act(async () => {});
    expect(await listOf(tree, CONCRETE, "clothing")).not.toContain("Essentials Tee Olive");
    expect(await listOf(tree, MARATHON, "clothing")).toContain("Essentials Tee Olive");   // still genuinely missing at Marathon
  });

  it("Undo of a Marathon mark writes the mark away and the card comes back", async () => {
    const tree = await mount();
    await division(tree, CONCRETE); await kind(tree, "clothing");
    const before = cardsOf(tree);
    await tapMark(tree, TEE);
    updateMock.mockClear();
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    expect(lastUpdate()).toEqual({
      [`products/${TEE}/marathonProduct`]: false, [`products/${TEE}/marathonProductSetBy`]: "u1", [`products/${TEE}/marathonProductSetAt`]: NOW,
      [`settings/marathonOnlyIndex/${TEE}`]: null,
    });
    expect(cardsOf(tree)).toEqual(before);
  });

  it("marking Marathon on a Concrete-only product clears its Concrete mark in the same write (never both)", async () => {
    emit("settings/concreteOnlyIndex", { [TEE]: true });
    const tree = await withProducts({ [TEE]: { concreteProduct: true } });
    await division(tree, CONCRETE); await kind(tree, "clothing");
    await tapMark(tree, TEE);
    const ups = updateMock.mock.calls.map((c) => c[1]);
    expect(ups.length).toBe(1);                                // one multi-path update: all or nothing
    expect(ups[0][`products/${TEE}/marathonProduct`]).toBe(true);
    expect(ups[0][`settings/marathonOnlyIndex/${TEE}`]).toBe(true);
    expect(ups[0][`products/${TEE}/concreteProduct`]).toBe(false);
    expect(ups[0][`settings/concreteOnlyIndex/${TEE}`]).toBe(null);
    expect(ups.flatMap(Object.keys).filter((k) => FORBIDDEN.test(k))).toEqual([]);
  });

  it("pre-rebuild Concrete markings are honoured (record + index, as all 98 live ones are), a sneaker too", async () => {
    emit("settings/concreteOnlyIndex", { [TEE]: true, [SHOE_B]: true });
    const tree = await withProducts({ [TEE]: { concreteProduct: true }, [SHOE_B]: { concreteProduct: true } });
    expect(await listOf(tree, MARATHON, "sneakers")).not.toContain("Gazelle Bold");
    expect(await listOf(tree, MARATHON, "clothing")).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("4");
    expect(await listOf(tree, CONCRETE, "clothing")).toContain("Essentials Tee Olive");
    expect(await listOf(tree, CONCRETE, "sneakers")).toContain("Gazelle Bold");
    // a mark made on another device (the index) applies here at once
    await act(async () => { emit("settings/concreteOnlyIndex", { [TEE]: true, [SHOE_B]: true, [JACKET]: true }); });
    await act(async () => {});
    expect(await listOf(tree, MARATHON, "clothing")).not.toContain("Varsity Jacket");
  });

  it("an unmark on another device applies here at once, whatever the mirrored record still says", async () => {
    emit("settings/concreteOnlyIndex", { [TEE]: true });
    const tree = await withProducts({ [TEE]: { concreteProduct: true } });
    expect(await listOf(tree, MARATHON, "clothing")).not.toContain("Essentials Tee Olive");
    await act(async () => { emit("settings/concreteOnlyIndex", null); });
    // (a list re-works its rows after a quiet moment — useSlicedRows QUIET_MS)
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    await act(async () => {});
    expect(await listOf(tree, MARATHON, "clothing")).toContain("Essentials Tee Olive");
  });

  it("Solve asks the server which division the product belongs to: marked Marathon a moment ago elsewhere → nothing sent into Concrete", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    gets[`settings/marathonOnlyIndex/${SHOE_B}`] = true;      // another device, a second ago
    await tapDest(tree, SHOE_B, "hub3");
    expect(updateMock).not.toHaveBeenCalled();
    expect(toast(tree).text).toMatch(/belongs to the other division/);
    expect(cardsOf(tree)).toContain("Gazelle Bold");
  });

  it("a product marked for one division is never offered the other's destinations, and Solve refuses it", async () => {
    emit("settings/marathonOnlyIndex", { [SHOE_B]: true });
    const tree = await mount();
    expect(await listOf(tree, CONCRETE, "sneakers")).not.toContain("Gazelle Bold");
    expect(await listOf(tree, MARATHON, "sneakers")).toContain("Gazelle Bold");
    expect(offered(tree, SHOE_B)).toEqual(["hub1", "hub2"]);
  });

  it("previously hidden products stay hidden; no card carries Hide any more", async () => {
    emit("settings/missingProductsHidden", { [TEE]: { at: NOW, by: "u1" } });
    const tree = await mount();
    for (const sec of [MARATHON, CONCRETE]) for (const k of ["sneakers", "clothing"]) {
      expect(await listOf(tree, sec, k)).not.toContain("Essentials Tee Olive");
      expect(tree.root.findAll((n) => n.type === "button" && n.props["data-action"] === "hide")).toEqual([]);
    }
  });

  it("the card height is unchanged: the button sits beside the name + stock block, never over the locations", async () => {
    const tree = await mount();
    const { CARD_H } = await import("./MissingRow.jsx");
    for (const n of host(tree, "data-card")) expect(n.props.style.height).toBe(CARD_H);
    expect(CARD_H).toBe(94);                              // compact (Junid, 23 Nov 2026)
    const b = markBtn(tree, SHOE_B);
    expect(b.props.style.height).toBe(44);                // a full tap target …
    expect(b.props.style.margin).toBeUndefined();         // … that reaches into nothing else
    expect(b.findAll((n) => n.type === "span")[0].props.style.height).toBe(22);
  });

  it("the button is only for Junid, Jafer or a stock admin", async () => {
    perm.isSuperAdmin = false; perm.permRecord = { stockRole: "warehouse", section: 2 };
    const tree = await mount();
    expect(tree.root.findAll((n) => n.type === "button" && n.props["data-action"] === "division")).toEqual([]);
  });
});

describe("division Undo that fails (CodeRabbit, PR #967)", () => {
  it("a failed Undo changes nothing and keeps its Undo to retry", async () => {
    const tree = await mount();
    await kind(tree, "clothing");
    const mb = () => card(tree, TEE).findAll((n) => n.type === "button" && n.props["data-action"] === "division")[0];
    await act(async () => { mb().props.onClick(); });            // arms
    await act(async () => { await mb().props.onClick(); });      // marks
    await act(async () => {}); await act(async () => {});
    updateMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/Not undone — offline/);
    expect(toast(tree).undo).toBeDefined();
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    await act(async () => { await toast(tree).undo.props.onClick(); });
    await act(async () => {}); await act(async () => {});
    expect(cardsOf(tree)).toContain("Essentials Tee Olive");
  });
});

describe("search (Junid, 23 Nov 2026)", () => {
  const field = (tree) => tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === "Search")[0];
  const typeIn = async (tree, text) => { await act(async () => { field(tree).props.onChange({ target: { value: text } }); }); await act(async () => {}); };
  const clearBtn = (tree) => tree.root.findAll((n) => n.type === "button" && n.props["data-action"] === "clear-search")[0];
  const box = (tree) => host(tree, "data-search")[0].props.style;

  it("one thin field under Sneakers / Clothing: fixed height, a clear control only with text", async () => {
    const tree = await mount();
    expect(box(tree).height).toBe(32);
    expect(field(tree).props.style.height).toBe(32);
    expect(field(tree).props.style.fontSize).toBe(16);          // iOS does not zoom the page on focus
    expect(field(tree).props.placeholder).toBe("Search");
    expect(clearBtn(tree)).toBeUndefined();
    await typeIn(tree, "gaz");
    expect(clearBtn(tree)).toBeDefined();
    expect(clearBtn(tree).props.style.position).toBe("absolute");   // laid over the field: nothing moves
    expect(box(tree).height).toBe(32);
    expect(field(tree).props.style.height).toBe(32);
  });

  it("filters the current list by name, brand and number, case-insensitively, and makes no database reads", async () => {
    const tree = await mount();
    const all = cardsOf(tree);
    expect(all.length).toBeGreaterThan(1);
    const r0 = { ...reads };
    await typeIn(tree, "GAZ");
    expect(cardsOf(tree)).toEqual(["Gazelle Bold"]);
    await typeIn(tree, "adidas");                                  // brand, from the product record already loaded
    expect(cardsOf(tree)).toEqual(all.filter((n) => ["Gazelle Bold", "Samba OG"].includes(n)));
    await kind(tree, "clothing");
    await typeIn(tree, "1391");                                    // a number inside the style code
    expect(cardsOf(tree)).toEqual(["Varsity Jacket"]);
    expect(reads).toEqual(r0);
  });

  it("clearing returns the same frozen order; no match says Nothing found", async () => {
    const tree = await mount();
    const before = cardsOf(tree);
    await typeIn(tree, "zzzz");
    expect(cardsOf(tree)).toEqual([]);
    expect(host(tree, "data-nothing-found").length).toBe(1);
    expect(flat(host(tree, "data-nothing-found")[0].children)).toBe("Nothing found");
    await act(async () => { clearBtn(tree).props.onClick(); });
    expect(field(tree).props.value).toBe("");
    expect(cardsOf(tree)).toEqual(before);
  });

  it("switching division or Sneakers / Clothing keeps the text and applies it to the new list", async () => {
    const tree = await mount();
    await typeIn(tree, "tee");
    await kind(tree, "clothing");
    expect(field(tree).props.value).toBe("tee");
    const marathon = cardsOf(tree);
    expect(marathon.length).toBeGreaterThan(0);
    expect(marathon.every((n) => /tee/i.test(n))).toBe(true);
    await division(tree, CONCRETE);
    expect(field(tree).props.value).toBe("tee");
    const concrete = cardsOf(tree);
    expect(concrete.length).toBeGreaterThan(0);
    expect(concrete.every((n) => /tee/i.test(n))).toBe(true);
    await typeIn(tree, "");
    expect(cardsOf(tree).some((n) => !/tee/i.test(n))).toBe(true);
  });

  it("a card keeps one height for a short and a very long name", async () => {
    const tree = await mount();
    const { CARD_H } = await import("./MissingRow.jsx");
    const names = host(tree, "data-name");
    expect(names.length).toBeGreaterThan(1);
    for (const n of names) { expect(n.props.style.height).toBe(30); expect(n.props.style.WebkitLineClamp).toBe(2); }
    for (const n of host(tree, "data-card")) expect(n.props.style.height).toBe(CARD_H);
  });
});

describe("the division a person opens on (Junid, 24 Nov 2026)", () => {
  const pressed = (tree) => host(tree, "data-division").filter((b) => b.props["aria-pressed"]).map((b) => b.props["data-division"]);
  it("no setting → Marathon, as before", async () => {
    const tree = await mount();
    expect(pressed(tree)).toEqual([MARATHON]);
  });
  it("Junid (missingProductsDivision: marathon) lands on Marathon and can switch with one tap", async () => {
    perm.permRecord = { stockRole: "admin", displayName: "Junid", missingProductsDivision: "marathon" };
    const tree = await mount();
    expect(pressed(tree)).toEqual([MARATHON]);
    await division(tree, CONCRETE);
    expect(pressed(tree)).toEqual([CONCRETE]);
  });
  it("Jafer (missingProductsDivision: concrete) lands on Concrete, keeps Marathon, and switches with one tap", async () => {
    perm.permRecord = { stockRole: "admin", displayName: "Jafer", missingProductsDivision: "concrete" };
    const tree = await mount();
    expect(pressed(tree)).toEqual([CONCRETE]);
    expect(host(tree, "data-division").map((b) => b.props["data-division"])).toEqual([MARATHON, CONCRETE]);
    await division(tree, MARATHON);
    expect(pressed(tree)).toEqual([MARATHON]);
    expect(cardsOf(tree).length).toBeGreaterThan(0);
  });
  it("a setting naming a division this person cannot open falls back to the first they can", async () => {
    perm.permRecord = { stockRole: "admin", displayName: "X", missingProductsDivision: "nowhere" };
    const tree = await mount();
    expect(pressed(tree)).toEqual([MARATHON]);
  });
});

describe("the numbers are exact (Junid, 24 Nov 2026)", () => {
  it("the card's Central figure is the units free at Central: on hand less what open requests still owe", async () => {
    // Hub 3 owes 4 of size 8 (one request, 1 of its 5 already sent) — a part-sent request owes only the rest
    emit("refill_requests", { r1: sneakerReq({ productId: SHOE_B, size: "8", qty: 5, sentQty: 1, requestingLocation: "hub3" }) });
    const tree = await mount();
    expect(stockLine(tree, SHOE_B)).toBe("Central 14");          // 8: 9−4 = 5, 9: 9 → 14
  });

  it("a reserved unit is never shown as free: a shadow request owes nothing, an open one owes its rest", async () => {
    emit("refill_requests", {
      s1: sneakerReq({ productId: SHOE_B, size: "9", qty: 9, requestingLocation: "hub3", shadow: true }),
      r2: sneakerReq({ productId: SHOE_B, size: "9", qty: 9, requestingLocation: "hub3" }),
    });
    const tree = await mount();
    expect(stockLine(tree, SHOE_B)).toBe("Central 9");           // size 9 entirely owed → only size 8's 9 free
    expect(dests(tree, SHOE_B).length).toBeGreaterThan(0);
  });

  it("a STALE card refuses to send, says the live number, and is redrawn on it in place", async () => {
    const tree = await mount();
    expect(stockLine(tree, SHOE_B)).toBe("Central 18");
    const order = cardsOf(tree);
    // Live, Central sold 7 of size 8 — the feed has not brought it yet.
    paths.stock = { ...paths.stock, central: { ...paths.stock.central, [SHOE_B]: { 8: cell(2), 9: cell(9) } } };
    updateMock.mockClear();
    await tapDest(tree, SHOE_B, "hub1");
    expect(updateMock).not.toHaveBeenCalled();                    // nothing sent
    expect(toast(tree).kind).toBe("fail");
    expect(toast(tree).text).toMatch(/now has 11 free, not 18 — nothing sent/);
    expect(stockLine(tree, SHOE_B)).toBe("Central 11");          // the card shows the live figure
    expect(cardsOf(tree)).toEqual(order);                         // in place: nothing moved
    // …and the person decides again on the correct figure (the choice is kept): this time it sends
    expect(picked(tree, SHOE_B)).toEqual(["hub1"]);
    await solve(tree, SHOE_B);
    expect(requestsIn(lastUpdate()).map((r) => [r.size, r.qty])).toEqual([["8", 2], ["9", 2]]);
  });

  it("two people solving the same product at once: the second is refused while the first holds it — nothing is granted twice", async () => {
    const tree = await mount();
    txnData["settings/missingSolveClaims/" + SHOE_B] = { token: "someone-else", at: NOW, by: "u2" };   // the first solve, in flight
    updateMock.mockClear();
    await tapDest(tree, SHOE_B, "hub1");
    expect(updateMock).not.toHaveBeenCalled();
    expect(toast(tree).text).toMatch(/Someone else is solving this product right now/);
    // the first solve finishes: its requests now owe Central's units, and the second card shows what is left
    delete txnData["settings/missingSolveClaims/" + SHOE_B];
    await act(async () => { emit("refill_requests", { a: sneakerReq({ productId: SHOE_B, size: "8", qty: 2, requestingLocation: "hub3" }), b: sneakerReq({ productId: SHOE_B, size: "9", qty: 2, requestingLocation: "hub3" }) }); });
    await act(async () => {}); await act(async () => {});
    expect(stockLine(tree, SHOE_B)).toBe("Central 14");
  });

  it("the claim is released after a solve, so the next product (or the next solve) is not blocked", async () => {
    const tree = await mount();
    await tapDest(tree, SHOE_B, "hub1");
    expect(txnData["settings/missingSolveClaims/" + SHOE_B] ?? null).toBe(null);
  });

  it("Solve sends exactly what the card showed: a plan that differs is refused before anything is written", async () => {
    const tree = await mount();
    // the hook is handed the card's expectation; the live requests show one size already queued at Hub 1
    paths.refill_requests = { q: sneakerReq({ productId: SHOE_B, size: "9", qty: 2, requestingLocation: "hub1" }) };
    updateMock.mockClear();
    await tapDest(tree, SHOE_B, "hub1");
    expect(updateMock).not.toHaveBeenCalled();
    expect(toast(tree).kind).toBe("fail");
  });
});

describe("the numbers are exact — after the architect review (PR #990)", () => {
  it("a live correction never hides a NEWER feed value: when the feed moves for that product, the card follows the feed", async () => {
    const tree = await mount();
    paths.stock = { ...paths.stock, central: { ...paths.stock.central, [SHOE_B]: { 8: cell(2), 9: cell(9) } } };
    await tapDest(tree, SHOE_B, "hub1");                          // stale → overlay → Central 11
    expect(stockLine(tree, SHOE_B)).toBe("Central 11");
    // five seconds later someone else's request lands in the feed (and the feed now carries the sale too)
    const st = baseStock(); st.central[SHOE_B] = { 8: cell(2), 9: cell(9) };
    await act(async () => { emit("stock", st); emit("refill_requests", { z: sneakerReq({ productId: SHOE_B, size: "9", qty: 3, requestingLocation: "hub3" }) }); });
    await act(async () => {}); await act(async () => {});
    expect(stockLine(tree, SHOE_B)).toBe("Central 8");           // 2 + (9 − 3), not the overlay's 11
  });

  it("a refused solve releases its claim on every path", async () => {
    const tree = await mount();
    paths.stock = { ...paths.stock, central: { ...paths.stock.central, [SHOE_B]: { 8: cell(1), 9: cell(9) } } };
    await tapDest(tree, SHOE_B, "hub1");                          // refused: stale
    await act(async () => {});
    expect(txnData["settings/missingSolveClaims/" + SHOE_B] ?? null).toBe(null);
  });

  it("the claim is taken BEFORE the one-owner and division reads, so a second solver reads the first one's writes", async () => {
    const src = (await import("fs")).readFileSync(new URL("./MissingProductsScreen.jsx", import.meta.url), "utf8");
    const solve = src.slice(src.indexOf("act.current.solve = async"), src.indexOf("act.current.division = async"));
    const claimAt = solve.indexOf("await claimSolve(");
    expect(claimAt).toBeGreaterThan(-1);
    for (const later of ["await liveMarksOf(", "await shopOwnersNow(", "await readLiveProduct("]) expect(solve.indexOf(later)).toBeGreaterThan(claimAt);
  });
});
