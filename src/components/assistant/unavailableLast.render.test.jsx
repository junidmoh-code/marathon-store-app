import { describe, it, expect, vi, beforeAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: null, onAuthStateChanged: () => () => {} },
}));
// Every database call is a stub: this test cannot read or write anything.
vi.mock("firebase/database", async (orig) => {
  const real = await orig();
  const stub = {};
  for (const k of Object.keys(real)) stub[k] = typeof real[k] === "function" ? vi.fn(() => ({})) : real[k];
  const off = () => () => {};
  return { ...stub, onValue: off, onChildAdded: off, onChildChanged: off, onChildRemoved: off,
           get: async () => ({ val: () => null, exists: () => false }) };
});
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-mirrored={productId} {...rest} />,
}));

// Node has no DOM; AssistantDesktop only adds key listeners.
beforeAll(() => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null };
});

const { AssistantDesktop } = await import("../../App.jsx");
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");


const { unavailableLast } = await import("./divisionAvailability.js");

// ─── UNAVAILABLE SORTS LAST (Junid, 27 Nov 2026) ─────────────────────────────
// Cards marked UNAVAILABLE used to sit high up the grid among shoes that can
// be sold. Now every product in the badge's own Set sorts after every product
// that is not, each group in the order it already had. Nothing is hidden.
//
// AssistantDesktop (desktop grid + ?view=wall preview) is mounted for real
// from App.jsx with Firebase stubbed — nothing here can reach a database. The
// phone / iPad grid lives inside AssistantView (not mountable), so it is held
// to the same helper by source pins below.

const mk = (id, brand = "Nike") => ({ id, name: `Shoe ${id}`, brand, retailPrice: 500, sizes: ["8"], photoUrl: `https://x/${id}.jpg` });
const A = mk("a"), B = mk("b"), C = mk("c"), D = mk("d"), E = mk("e"), F = mk("f");
const ALL = [A, B, C, D, E, F];

function mount(over = {}) {
  const props = {
    products: ALL, searchResults: ALL, effectiveShop: "concrete", availableShops: [{ id: "concrete" }, { id: "marathon-pine" }],
    onSelectShop: () => {}, shopRegistry: null, search: "", setSearch: () => {}, onLabelFind: null, cart: [],
    onQuickAdd: () => 1, onRemoveOne: () => {}, onAddDisplayPartner: () => {}, onViewPhoto: () => {},
    onSwitchView: () => {}, userEmail: "staff@marathon.internal", mode: "sneaker", setMode: () => {},
    customerName: "", setCustomerName: () => {}, customerPhone: "", setCustomerPhone: () => {},
    marketingOptIn: true, setMarketingOptIn: () => {}, submitting: false, onPlaceOrder: async () => true,
    customerIndex: [], onPickCustomer: () => {}, onAddClothing: () => {}, onPlaceRefill: () => {},
    onOpenTracking: () => {}, trackingPending: 0, hubQty: () => 5, servingHubLabel: "Hub 3",
    sneakerOut: () => false, sneakerOutWhy: () => ({ booked: 0, available: 0, hubLabel: "Hub 3" }),
    sneakerDisplayInfo: () => null, alternativesFor: () => null, deadForOrder: () => false,
    unavailableIds: new Set(), unavailableHintFor: () => "",
    ...over,
  };
  let r;
  act(() => { r = TestRenderer.create(<AssistantDesktop {...props} />); });
  r.props = props;
  return r;
}
const rerender = (r, over) => { r.props = { ...r.props, ...over }; act(() => { r.update(<AssistantDesktop {...r.props} />); }); };
// Card order as product ids, and which cards carry the badge.
const cardIds = (r) => r.root.findAll(n => n.type === "article" && /(^| )ad-card( |$)/.test(n.props?.className || ""))
  .map(art => art.findAll(n => (n.props?.product || n.props?.p)?.id)[0].props).map(pr => (pr.product || pr.p).id);
const badgedIds = (r) => r.root.findAll(n => n.type === "article" && /(^| )ad-card( |$)/.test(n.props?.className || ""))
  .filter(art => art.findAll(n => n.props?.["data-testid"] === "card-unavailable" && typeof n.type === "string").length)
  .map(art => art.findAll(n => (n.props?.product || n.props?.p)?.id)[0].props).map(pr => (pr.product || pr.p).id);
const ids = (list) => list.map(p => p.id);

describe("unavailableLast — the one partition", () => {
  it("puts unavailable after available, keeping relative order in BOTH groups", () => {
    expect(ids(unavailableLast(ALL, new Set(["a", "c", "e"])))).toEqual(["b", "d", "f", "a", "c", "e"]);
    expect(ids(unavailableLast([F, A, E, B], new Set(["f", "b"])))).toEqual(["a", "e", "f", "b"]);
  });
  it("drops nothing and adds nothing", () => {
    const out = unavailableLast(ALL, new Set(["b", "zz"]));
    expect(out).toHaveLength(ALL.length);
    expect(new Set(ids(out))).toEqual(new Set(ids(ALL)));
  });
  it("an empty Set (Marathon PE, Trophy) returns the very same array", () => {
    expect(unavailableLast(ALL, new Set())).toBe(ALL);
    expect(unavailableLast(ALL, null)).toBe(ALL);
    expect(unavailableLast(ALL, new Set(["not-in-list"]))).toBe(ALL);
  });
  it("tolerates a missing list", () => {
    expect(unavailableLast(undefined, new Set(["a"]))).toEqual([]);
  });
});

describe("desktop grid", () => {
  it("draws unavailable cards last, and the badge sits on exactly those", () => {
    const un = new Set(["a", "d"]);
    const r = mount({ unavailableIds: un });
    expect(cardIds(r)).toEqual(["b", "c", "e", "f", "a", "d"]);
    expect(badgedIds(r)).toEqual(["a", "d"]);
  });
  it("search results follow the same rule, in the search's own order", () => {
    const r = mount({ searchResults: [E, A, C, B], unavailableIds: new Set(["e", "c"]) });
    expect(cardIds(r)).toEqual(["a", "b", "e", "c"]);
  });
  it("each store chip uses that store's Set — Pine's answer is not Concrete's", () => {
    const r = mount({ effectiveShop: "concrete", unavailableIds: new Set(["a"]) });
    expect(cardIds(r)).toEqual(["b", "c", "d", "e", "f", "a"]);
    rerender(r, { effectiveShop: "marathon-pine", unavailableIds: new Set(["f", "b"]) });
    expect(cardIds(r)).toEqual(["a", "c", "d", "e", "b", "f"]);
    // Marathon PE / Trophy: AssistantView hands down the empty Set — order untouched.
    rerender(r, { effectiveShop: "marathon-pe", unavailableIds: new Set() });
    expect(cardIds(r)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("stock arriving moves a card back up live, no reload", () => {
    const r = mount({ unavailableIds: new Set(["a", "b"]) });
    expect(cardIds(r)).toEqual(["c", "d", "e", "f", "a", "b"]);
    rerender(r, { unavailableIds: new Set(["b"]) });   // a's stock landed
    expect(cardIds(r)).toEqual(["a", "c", "d", "e", "f", "b"]);
    expect(badgedIds(r)).toEqual(["b"]);
  });
});

describe("the desktop's own brand filter and sort still apply within each group", () => {
  const P = [
    { ...mk("p1", "Nike"), retailPrice: 300 }, { ...mk("p2", "Adidas"), retailPrice: 900 },
    { ...mk("p3", "Nike"), retailPrice: 700 }, { ...mk("p4", "Nike"), retailPrice: 100 },
    { ...mk("p5", "Adidas"), retailPrice: 500 },
  ];
  // Sky desktop: sort lives in the Filter popover (menuitemradio buttons) and
  // the brand filter is the logo chip row (role="group" aria-label="Brand").
  const pickSort = (r, v) => {
    const label = { ph: "Price · high", pl: "Price · low", az: "Name · A–Z", feat: "Featured" }[v];
    // The popover renders through a portal only while open; its items are
    // still the element's children, and each one's onClick is the real setSort.
    const pop = r.root.find(n => typeof n.type === "function" && n.props.label === "Filter and sort" && n.props.anchorRef);
    const items = [].concat(...[].concat(pop.props.children)).filter(Boolean);
    items.find(el => el?.props?.children === label).props.onClick();
  };
  const pickBrand = (r, b) => {
    r.root.find(n => n.type === "button" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].startsWith(`${b} (`)).props.onClick();
  };
  it("price high-to-low: available by price, then unavailable by price", () => {
    const r = mount({ products: P, searchResults: P, unavailableIds: new Set(["p2", "p4"]) });
    act(() => { pickSort(r, "ph"); });
    expect(cardIds(r)).toEqual(["p3", "p5", "p1", "p2", "p4"]);
  });
  it("a brand filter narrows first, then the partition", () => {
    const r = mount({ products: P, searchResults: P, unavailableIds: new Set(["p1"]) });
    act(() => { pickBrand(r, "Nike"); });
    expect(cardIds(r)).toEqual(["p3", "p4", "p1"]);
  });
});

// (No ?view=wall preview on the sky branch: the order view has no wall —
// skyOrderView.render.test.jsx.)

describe("App.jsx wiring (phone / iPad grid and the desktop list)", () => {
  it("the phone photo grid renders the partitioned list, built from the badge's Set", () => {
    // Sky: the phone grid is AssistantPhone, fed the brand-filtered list
    // partitioned on the badge's Set; the badge is drawn from the same Set.
    expect(APP).toContain("const photoGrid = useMemo(() => unavailableLast(phoneShown, unavailableIds), [phoneShown, unavailableIds]);");
    expect(APP).toContain("products={isRefillMode ? [] : photoGrid} showGrid");
    expect(APP).toContain("unavailableIds.has(p.id) ? <span className=\"sky-unavail sky-unavail--inline\" data-testid=\"card-unavailable\"");
  });
  it("the desktop list partitions after its own sort, live on the Set", () => {
    expect(APP).toContain("return unavailableLast(list, unavailableIds);\n  }, [searchResults, catalog, brand, sort, unavailableIds]);");
  });
  it("the desktop is handed the unsorted results and the same Set", () => {
    expect(APP).toContain("products={browse} searchResults={filtered}");
    expect(APP).toContain("unavailableIds={unavailableIds} unavailableHintFor={unavailableHintFor}");
  });
  it("there is exactly one availability Set in the view", () => {
    const view = APP.slice(APP.indexOf("function AssistantView({"));
    expect((view.match(/unavailableProductIds\(/g) || []).length).toBe(1);
  });
});
