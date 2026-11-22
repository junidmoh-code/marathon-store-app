// ─── MISSING PRODUCTS — THE SCREEN (Junid, 22 Nov 2026) ──────────────────────
// Its own destination: one division switch with counts, one list per division
// (sneakers and everything else together, newest upload first), one card
// shape, destinations that follow the list, and a card that leaves once its
// work is queued.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const paths = {};
const gets = {};
const listeners = {};
const emit = (path, value) => { paths[path] = value; for (const cb of listeners[path] || []) cb({ val: () => value }); };
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { (listeners[r.path] ||= []).push(cb); cb({ val: () => paths[r.path] ?? null }); return () => { listeners[r.path] = (listeners[r.path] || []).filter((x) => x !== cb); }; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: (r, fn) => Promise.resolve({ committed: fn(null) !== undefined, snapshot: { val: () => null } }),
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
const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", hub3: "central", "marathon-pe": "hub2", trophy: "hub2", "marathon-pine": "hub3", concrete: "hub3" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: { hub2: { L: 3, M: 3, S: 2 }, "marathon-pe": { L: 2, M: 2, S: 2 }, trophy: { L: 2, M: 2, S: 2 } },
  footwearRunByLocation: { hub1: { 8: 2, 9: 2 }, hub2: { 8: 2, 9: 2 } },
};
// ids are p<upload ms>: the tee is the newest upload, then shoe B, then shoe A.
const TEE = "p1795200000000", SHOE_A = "p1795000000000", SHOE_B = "p1795100000000", TWIN = "p1794000000000", OLD = "legacy-jacket";
const PRODUCTS = [
  { id: SHOE_A, name: "Air Zoom Alpha", brand: "Nike", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/a.jpg" },
  { id: SHOE_B, name: "Gazelle Bold", brand: "Adidas", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/b.jpg" },
  { id: TWIN, name: "Air Zoom Alpha", brand: "Nike", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/twin.jpg" },
  { id: TEE, name: "Essentials Tee Olive", brand: "Fear of God", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"], photoUrl: "https://x/t.jpg" },
  { id: OLD, name: "Varsity Jacket", brand: "Nike", productType: "clothing", categoryKey: "jackets", subcategory: "Jackets & Coats", sizes: ["S", "M", "L"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const SIZES = { S: cell(9), M: cell(9), L: cell(9) };
const baseStock = () => ({
  central: { [SHOE_A]: { 8: cell(9), 9: cell(9) }, [SHOE_B]: { 8: cell(9), 9: cell(9) }, [TEE]: { ...SIZES }, [OLD]: { ...SIZES } },
  hub3: { [TWIN]: { 8: cell(3) } },   // the same-named record already has stock at Hub 3
});
const sneakerReq = (over = {}) => ({ productId: SHOE_A, size: "8", qty: 2, requestingLocation: "hub1", status: "open", requestSource: "solve", createdFrom: { manual: true, source: "central", via: "missing_sneakers" }, ...over });

const mount = async () => { let tree; await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={PRODUCTS} onExit={() => {}} />); }); await act(async () => {}); return tree; };
const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const textOf = (tree) => flat(tree.toJSON());
const host = (tree, attr, value) => tree.root.findAll((n) => typeof n.type === "string" && n.props && (value === undefined ? n.props[attr] !== undefined : n.props[attr] === value));
const cardsOf = (tree) => host(tree, "data-card").map((n) => n.props["data-card-name"]);
const card = (tree, pid) => host(tree, "data-card", pid)[0];
const inCard = (tree, pid, action) => card(tree, pid).findAll((n) => n.type === "button" && n.props["data-action"] === action)[0];
const pills = (tree, pid) => card(tree, pid).findAll((n) => n.type === "button" && n.props.role === "checkbox");
const lit = (tree, pid) => pills(tree, pid).filter((b) => b.props["aria-checked"]).map((b) => b.props["data-dest"]);
const offered = (tree, pid) => pills(tree, pid).map((b) => b.props["data-dest"]);
const tapDest = async (tree, pid, dest) => { await act(async () => { pills(tree, pid).find((b) => b.props["data-dest"] === dest).props.onClick(); }); };
const division = async (tree, sec) => { await act(async () => { host(tree, "data-division", sec)[0].props.onClick(); }); };
const count = (tree, sec) => flat(host(tree, "data-division-count", sec)[0].children);
const tap = async (tree, pid, action) => { await act(async () => { await inCard(tree, pid, action).props.onClick(); }); };
const requestsIn = (upd) => Object.entries(upd).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);
const MARATHON = 2, CONCRETE = 1;

beforeEach(() => {
  updateMock.mockClear(); pushN = 0; seatCalls.length = 0;
  for (const k of Object.keys(gets)) delete gets[k];
  __resetNetworkForTests();
  for (const p of ["settings/missingProductsHidden", "settings/stockHold/held", "stock_targets"]) emit(p, null);
  emit("network", S1_LIVE);
  emit("config/refillEngine", CONFIG);
  emit("refill_requests", null);
  emit("stock", baseStock());
  gets["config/refillEngine/footwearRunByLocation"] = CONFIG.footwearRunByLocation;
  gets["config/refillEngine/policyGroups/footwear-all/policy/hub3"] = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
  perm.permRecord = { stockRole: "admin", displayName: "Junid" }; perm.isSuperAdmin = true;
});

describe("the division switch", () => {
  it("one switch, Marathon and Concrete, each with how many are left; each list shows only its own division", async () => {
    const tree = await mount();
    expect(host(tree, "data-division").map((n) => n.props["data-division"])).toEqual([MARATHON, CONCRETE]);
    // Marathon: both shoes (no unit at Hub 1 or Hub 2) + the tee + the jacket
    expect(count(tree, MARATHON)).toBe("4 missing");
    expect(cardsOf(tree).sort()).toEqual(["Air Zoom Alpha", "Essentials Tee Olive", "Gazelle Bold", "Varsity Jacket"]);
    // Concrete: the same things are missing there too, in their own right
    await division(tree, CONCRETE);
    expect(host(tree, "data-division", CONCRETE)[0].props["aria-selected"]).toBe(true);
    expect(textOf(tree)).toMatch(/missing from Concrete · newest uploads first/);
  });

  it("newest uploads first — sneakers and everything else in ONE list", async () => {
    const tree = await mount();
    expect(cardsOf(tree)).toEqual(["Essentials Tee Olive", "Gazelle Bold", "Air Zoom Alpha", "Varsity Jacket"]);
  });
});

describe("the card", () => {
  it("says why it is here, what Central holds, and has ONE action with a plain line on what it does", async () => {
    const tree = await mount();
    const shoe = flat(card(tree, SHOE_B).children);
    expect(shoe).toMatch(/Never sent out — Central has it, Hub 1 and Hub 2 do not\./);
    expect(shoe).toMatch(/Central holds 18 pairs\./);
    expect(shoe).toMatch(/Asks Central for the policy number of pairs into a hub's refill list\. Nothing moves until Central picks it\./);
    expect(inCard(tree, SHOE_B, "open-request").children.join("")).toBe("Request");
    expect(inCard(tree, SHOE_B, "open-solve")).toBeUndefined();
    const tee = flat(card(tree, TEE).children);
    expect(tee).toMatch(/Never sent out to Marathon — not kept at Hub 2, Marathon PE or Trophy\./);
    expect(tee).toMatch(/Central holds 27 units\./);
    expect(tee).toMatch(/Starts keeping it at the shop you pick\. Central sends the first batch; refills follow by themselves\./);
    expect(inCard(tree, TEE, "open-solve").children.join("")).toBe("Solve");
    expect(inCard(tree, TEE, "open-request")).toBeUndefined();
  });

  it("no button ever reads “Close”: an open panel keeps its own Cancel, and the action's name never changes meaning", async () => {
    const tree = await mount();
    const labels = () => tree.root.findAll((n) => n.type === "button").map((b) => flat(b.children));
    expect(labels()).not.toContain("Close");
    await tap(tree, TEE, "open-solve");
    expect(labels()).not.toContain("Close");
    expect(inCard(tree, TEE, "open-solve")).toBeUndefined();          // the opener is gone while its panel is open…
    expect(inCard(tree, TEE, "confirm-solve")).toBeDefined();         // …the confirm says what it will do
    expect(flat(inCard(tree, TEE, "confirm-solve").children)).toMatch(/^Solve — /);
    await tap(tree, TEE, "close-panel");
    expect(inCard(tree, TEE, "open-solve")).toBeDefined();
  });

  it("the same-name warning stays, with the other record's photo beside it", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);          // Hub 3 holds the twin, so the warning is Concrete's
    const warn = card(tree, SHOE_A).findAll((n) => typeof n.type === "string" && n.props["data-same-name"])[0];
    expect(warn).toBeDefined();
    expect(flat(warn.children)).toMatch(/Same name elsewhere\..*already has stock at Hub 3\. Compare the two photos/);
    const twinPhoto = warn.findAll((n) => typeof n.type !== "string" && n.props && n.props.productId === TWIN);
    expect(twinPhoto.length).toBeGreaterThan(0);
    expect(card(tree, SHOE_B).findAll((n) => typeof n.type === "string" && n.props["data-same-name"]).length).toBe(0);
  });
});

describe("destinations follow the list — sneakers", () => {
  it("Marathon list: only Hub 1 and Hub 2 are offered, and they switch; Hub 3 is never offered", async () => {
    const tree = await mount();
    await tap(tree, SHOE_B, "open-request");
    expect(offered(tree, SHOE_B)).toEqual(["hub1", "hub2"]);
    expect(lit(tree, SHOE_B)).toEqual(["hub1"]);
    await tapDest(tree, SHOE_B, "hub2");
    expect(lit(tree, SHOE_B)).toEqual(["hub2"]);
    await tapDest(tree, SHOE_B, "hub1");
    expect(lit(tree, SHOE_B)).toEqual(["hub1"]);
  });

  it("Concrete list: only Hub 3 is offered, preselected; the payload can only target Hub 3", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    await tap(tree, SHOE_B, "open-request");
    expect(offered(tree, SHOE_B)).toEqual(["hub3"]);
    expect(lit(tree, SHOE_B)).toEqual(["hub3"]);
    expect(flat(card(tree, SHOE_B).children)).toMatch(/Raises this into Source → Hub 3 Refill/);
    expect(flat(card(tree, SHOE_B).children)).toMatch(/6 pieces across 2 sizes/);
    await tap(tree, SHOE_B, "confirm-request");
    const reqs = requestsIn(updateMock.mock.calls[0][1]);
    expect(reqs.length).toBe(2);
    for (const r of reqs) expect(r.requestingLocation).toBe("hub3");
  });
});

describe("destinations follow the list — clothing and everything that is not a sneaker", () => {
  it("Concrete list: only Pine and Concrete are offered; Pine then Concrete gives Concrete only; Concrete then Pine gives Pine only; the payload matches", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    await tap(tree, TEE, "open-solve");
    expect(offered(tree, TEE).sort()).toEqual(["concrete", "marathon-pine"]);
    const start = lit(tree, TEE);
    expect(start.length).toBe(1);
    const other = start[0] === "concrete" ? "marathon-pine" : "concrete";
    await tapDest(tree, TEE, other);
    expect(lit(tree, TEE)).toEqual([other]);
    await tapDest(tree, TEE, start[0]);
    expect(lit(tree, TEE)).toEqual([start[0]]);
    await tapDest(tree, TEE, "marathon-pine");
    if (lit(tree, TEE).length === 0) await tapDest(tree, TEE, "marathon-pine");
    await tapDest(tree, TEE, "concrete");
    expect(lit(tree, TEE)).toEqual(["concrete"]);
    await tap(tree, TEE, "confirm-solve");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = updateMock.mock.calls[0][1];
    const shops = new Set(Object.keys(upd).filter((k) => k.startsWith("stock/")).map((k) => k.split("/")[1]));
    expect(shops.has("concrete")).toBe(true);
    expect(shops.has("marathon-pine")).toBe(false);
    for (const l of shops) expect(["concrete", "hub3"]).toContain(l);
    for (const r of requestsIn(upd)) expect(r.requestingLocation).toBe("concrete");
  });

  it("Marathon list: Marathon PE and Trophy — Pine and Concrete are never offered, and both Marathon shops may be ticked as before", async () => {
    const tree = await mount();
    await tap(tree, TEE, "open-solve");
    expect(offered(tree, TEE).sort()).toEqual(["marathon-pe", "trophy"]);
    for (const d of ["marathon-pe", "trophy"]) if (!lit(tree, TEE).includes(d)) await tapDest(tree, TEE, d);
    expect(lit(tree, TEE).sort()).toEqual(["marathon-pe", "trophy"]);
  });

  it("Move by hand keeps to the list too: no hub and no Marathon shop from the Concrete list", async () => {
    const tree = await mount();
    await division(tree, CONCRETE);
    await tap(tree, TEE, "open-move");
    const dests = card(tree, TEE).findAll((n) => n.type === "button" && n.props["data-move-dest"]).map((b) => b.props["data-move-dest"]);
    expect(dests.sort()).toEqual(["concrete", "marathon-pine"]);
  });
});

describe("after an action the card confirms and leaves — per division", () => {
  it("a Request leaves its own division's list at once, says what was queued, and the other division keeps the card", async () => {
    const tree = await mount();
    await tap(tree, SHOE_B, "open-request");
    await tap(tree, SHOE_B, "confirm-request");
    expect(Object.keys(updateMock.mock.calls[0][1]).every((k) => k.startsWith("refill_requests/"))).toBe(true);
    expect(cardsOf(tree)).not.toContain("Gazelle Bold");
    expect(count(tree, MARATHON)).toBe("3 missing");
    const note = host(tree, "data-just-queued", SHOE_B)[0];
    expect(flat(note.children)).toMatch(/Queued ✓.*Gazelle Bold.*into Hub 1's refill list/);
    await division(tree, CONCRETE);
    expect(cardsOf(tree)).toContain("Gazelle Bold");
  });

  it("survives a reload and shows on every device: the open request alone keeps it off, and “Queued & solved” lists it", async () => {
    emit("refill_requests", { r1: sneakerReq(), r2: sneakerReq({ size: "9" }) });
    const tree = await mount();
    expect(cardsOf(tree)).not.toContain("Air Zoom Alpha");
    expect(count(tree, MARATHON)).toBe("3 missing");
    await act(async () => { host(tree, "data-view", "done")[0].props.onClick(); });
    const waiting = host(tree, "data-waiting", SHOE_A)[0];
    expect(flat(waiting.children)).toMatch(/4 pairs requested into Hub 1 — 8×2 · 9×2/);
    expect(updateMock).not.toHaveBeenCalled();     // looking at it writes nothing
  });

  it("cancel brings it back; a rejection too", async () => {
    emit("refill_requests", { r1: sneakerReq() });
    const tree = await mount();
    expect(cardsOf(tree)).not.toContain("Air Zoom Alpha");
    await act(async () => { emit("refill_requests", { r1: sneakerReq({ status: "cancelled" }) }); });
    expect(cardsOf(tree)).toContain("Air Zoom Alpha");
    expect(count(tree, MARATHON)).toBe("4 missing");
    await act(async () => { emit("refill_requests", { r1: sneakerReq() }); });
    expect(cardsOf(tree)).not.toContain("Air Zoom Alpha");
    await act(async () => { emit("refill_requests", { r1: sneakerReq({ status: "rejected" }) }); });
    expect(cardsOf(tree)).toContain("Air Zoom Alpha");
  });

  it("a Solve leaves Marathon's list on the tap and stays on Concrete's until solved there", async () => {
    const tree = await mount();
    await tap(tree, TEE, "open-solve");
    await tap(tree, TEE, "confirm-solve");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("3 missing");
    await division(tree, CONCRETE);
    expect(cardsOf(tree)).toContain("Essentials Tee Olive");
  });
});

describe("search and filters", () => {
  const type = async (tree, value) => { await act(async () => { tree.root.findAll((n) => n.type === "input" && n.props["aria-label"] === "Search")[0].props.onChange({ target: { value } }); }); };
  const pick = async (tree, label, value) => { await act(async () => { tree.root.findAll((n) => n.type === "select" && n.props["aria-label"] === label)[0].props.onChange({ target: { value } }); }); };
  const options = (tree, label) => tree.root.findAll((n) => n.type === "select" && n.props["aria-label"] === label)[0].findAll((n) => n.type === "option").map((o) => flat(o.children));

  it("search by name or brand; filter by category and by brand; Clear puts it all back", async () => {
    const tree = await mount();
    await type(tree, "gazelle");
    expect(cardsOf(tree)).toEqual(["Gazelle Bold"]);
    await type(tree, "nike");
    expect(cardsOf(tree).sort()).toEqual(["Air Zoom Alpha", "Varsity Jacket"]);
    await type(tree, "");
    expect(options(tree, "Category")).toEqual(["All categories", "Jackets (1)", "Sneakers (2)", "T Shirts (1)"]);
    expect(options(tree, "Brand")).toEqual(["All brands", "Adidas (1)", "Fear of God (1)", "Nike (2)"]);
    await pick(tree, "Category", "Sneakers");
    expect(cardsOf(tree)).toEqual(["Gazelle Bold", "Air Zoom Alpha"]);
    await pick(tree, "Brand", "Nike");
    expect(cardsOf(tree)).toEqual(["Air Zoom Alpha"]);
    expect(textOf(tree)).toMatch(/1 of 4 shown/);
    await act(async () => { tree.root.findAll((n) => n.type === "button" && n.props["data-action"] === "clear-filters")[0].props.onClick(); });
    expect(cardsOf(tree).length).toBe(4);
    expect(count(tree, MARATHON)).toBe("4 missing");   // the switch counts what is LEFT, whatever is filtered
  });
});

describe("Hide and the hidden tab come with it, unchanged", () => {
  it("Hide writes one entry to the hidden node and nothing else; the card leaves; the tab behind the invisible spot lists it with Unhide", async () => {
    const tree = await mount();
    await tap(tree, TEE, "open-hide");
    const noReason = card(tree, TEE).findAll((n) => n.type === "button").find((b) => flat(b.children) === "Hide without a reason");
    await act(async () => { await noReason.props.onClick(); });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1]).toEqual({ [`settings/missingProductsHidden/${TEE}`]: { at: NOW, by: "u1" } });
    await act(async () => { emit("settings/missingProductsHidden", { [TEE]: { at: NOW, by: "u1" } }); });
    expect(cardsOf(tree)).not.toContain("Essentials Tee Olive");
    expect(count(tree, MARATHON)).toBe("3 missing");
    // no visible way in: no button says Hidden until the spot has been held
    expect(tree.root.findAll((n) => n.type === "button").map((b) => flat(b.children)).some((t) => /Hidden/.test(t))).toBe(false);
    const spot = tree.root.findAll((n) => n.type === "div" && typeof n.props.onPointerDown === "function")[0];
    expect(spot).toBeDefined();
    vi.useFakeTimers();
    await act(async () => { spot.props.onPointerDown({ clientX: 5, clientY: 5 }); vi.advanceTimersByTime(650); });
    vi.useRealTimers();
    expect(textOf(tree)).toMatch(/Hidden \(1\)/);
    expect(textOf(tree)).toMatch(/Essentials Tee Olive/);
    expect(textOf(tree)).toMatch(/STILL MISSING/);
    expect(tree.root.findAll((n) => n.type === "button").some((b) => flat(b.children) === "Unhide")).toBe(true);
  });
});

describe("a viewer of one division", () => {
  it("sees that division only — no switch to the other", async () => {
    perm.isSuperAdmin = false; perm.permRecord = { stockRole: "warehouse", section: 2 };
    const tree = await mount();
    expect(host(tree, "data-division").map((n) => n.props["data-division"])).toEqual([MARATHON]);
    expect(count(tree, MARATHON)).toBe("4 missing");
  });
});
