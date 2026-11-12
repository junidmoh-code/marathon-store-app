// ─── THE ORDER SCREEN ASKS THE QUESTIONS THE DIVISION TESTS ANSWER ───────────
//
// divisionAvailability.test.js and the Marathon snapshot run the real modules
// through orderScreenWorld — a plain-data copy of AssistantView's wiring. These
// pins hold that copy to the screen: if App.jsx stops asking a question this
// way, the copy no longer describes it and this goes red.
// (Source pins, in the manner of src/sectionsAppWiring.pin.test.js: App.jsx is
// one 21k-line component and cannot be mounted with a hub's stock.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
const WORLD = readFileSync(new URL("./__fixtures__/orderScreenWorld.js", import.meta.url), "utf8");
const between = (a, b) => {
  const i = APP.indexOf(a);
  expect(i, `missing: ${a}`).toBeGreaterThan(-1);
  const j = APP.indexOf(b, i);
  expect(j, `missing end: ${b}`).toBeGreaterThan(i);
  return APP.slice(i, j + b.length);
};

describe("which hubs a device reads", () => {
  it("Hub 1 and Hub 2 are subscribed only for a Marathon-division shop", () => {
    expect(APP).toContain('const hub1CellsState = useStockCellsState(!onSection2Hubs ? null : "hub1");');
    expect(APP).toContain('const hub2CellsState = useStockCellsState(!onSection2Hubs ? null : "hub2");');
    expect(APP).toContain("const onSection2Hubs = usesSection2Hubs(sectionNet, effectiveShop);");
  });
  it("every other shop subscribes to its own section's hubs, from the registry", () => {
    expect(APP).toContain("const sectionHubIds = useMemo(() => sectionSneakerHubs(sectionNet, effectiveShop), [sectionNet, effectiveShop]);");
    expect(APP).toContain("const sectionCellsA = useStockCellsState(sectionHubA);");
  });
  it("the order screen never subscribes to Central's stock", () => {
    const view = between("function AssistantView({", "\n// ── ");
    expect(view).not.toMatch(/useStockCells(State)?\(\s*["']central["']/);
    expect(view).not.toMatch(/stock\/central/);
  });
});

describe("a Pine or Concrete item the shop holds", () => {
  it("is read from the shop's own subtree, chosen by the registry", () => {
    expect(APP).toContain("const shopShelf = shopShelfFor(sectionNet, effectiveShop);");
    expect(APP).toContain("const shopShelfState = useStockCellsState(shopShelf);");
    expect(APP).toContain("const clothingCellsOf = (pid) => (shopShelfAnswers(productsById[pid]) ? shopHeld.cells");
    expect(WORLD).toContain("(shelfAnswers(p) ? hubData[shopShelf].cells : stock[clothingHubOf(p)])");
  });
  it("answers the size chips through the one resolver", () => {
    const fn = between("const sneakerSourcing = (p, s) => resolveSneakerSourcing({", "});");
    expect(fn).toContain("shelf: shopShelfLine(p, s),");
    expect(WORLD).toContain("shelf: shopShelfLine(p, s),");
  });
  it("is checked at submit on the shelf it was offered from", () => {
    const fn = between("const stockGuardedLine = (item) => {", "\n  };");
    expect(fn).toContain("if (shopShelfAnswers(item.product)) return true;");
    expect(APP).toContain("hub: placedHubFor(item), productId: item.product.id");
    expect(APP).not.toContain("? { hub: shopShelf } : {}");
    expect(between("const placedHubFor = (item) =>", "computeHubForItem(item))));")).toContain("shopHeldBooking.get(item) ||");
  });
  it("gets no alternatives sheet", () => {
    const fn = between("const computeAlternatives = (product, size) => {", "if (!ordersSettled) return null;");
    expect(fn).toContain("if (shopShelfAnswers(product)) return null;");
    expect(WORLD).toContain("if (shelfAnswers(product)) return null;");
  });
  it("says Unavailable from the shelf, once the shelf has answered", () => {
    const fn = between("const unavailableIds = useMemo(() => {", "deadForOrder]);");
    expect(fn).toContain("return { sizes, known: hubReadState(shopHeld).ready, sizeOut: (sz) => hubQty(p.id, sz) <= 0 };");
  });
});

describe("each TV board reads its own division", () => {
  it("TvWithAutoCollect filters every board, kiosk and in-app, through boardShowsOrder", () => {
    expect(between("function TvWithAutoCollect(", "const orderKey =")).toContain("boardShowsOrder(boardNetwork, section, o)");
    expect(APP).toContain('<TvWithAutoCollect orders={orders} section={2}');
    expect(APP).toContain("section={tvSectionForShop(orderNetwork, myShop)}");
  });
});

describe("Pine and Concrete's shared orders", () => {
  it("the sibling's feed joins three screens and nothing else", () => {
    expect(APP).toContain("const siblingShop = siblingOrderShop(orderNetwork, myShop);");
    expect(APP).toContain("const siblingOrders = useOrders(siblingShop, !!siblingShop);");
    expect(APP.split("orders={sharedOrders}").length - 1).toBe(3);
    expect(APP).toContain("<AssistantView products={products} orders={sharedOrders}");
    expect(APP).toContain("<CustomerView  orders={sharedOrders}");
    expect(APP).toContain("<TvWithAutoCollect orders={sharedOrders} section={tvSectionForShop(orderNetwork, myShop)}");
  });
  it("a disabled feed reads nothing", () => {
    const hook = between("function useOrders(scopeShop = null, enabled = true) {", "return orders;");
    expect(hook).toContain("const authReady = useAuthReady() && enabled;");
    // Both ways down the wire hang off that one value.
    expect(hook).toContain('useMirroredPath("orders", authReady)');
    expect(hook).toContain("if (!authReady || !liveOrders) return undefined;");
    expect(hook).not.toMatch(/useAuthReady\(\)(?! && enabled)/);
  });
});

describe("the catalogue", () => {
  it("a shop with its own hubs also lists what those hubs hold", () => {
    const cat = between("const base = useMemo(", "sectionStockedHere]);");
    expect(cat).toContain("servedHubs: onSection2Hubs ? null : backStockHubsOf(sectionNet, effectiveShop),");
    expect(cat).toContain("stockedHere: sectionStockedHere,");
    expect(APP).toContain("sectionHubA ? heldProductKey([sectionCellsA, sectionCellsB].map(hubReadState)) : null");
    expect(APP).toContain("sectionHeldKey === null ? undefined : stockedHerePredicate(heldPredicate(sectionHeldKey), heldPredicate(shopHeldKey), shopShelfAnswers)");
    expect(WORLD).toContain("division.stockedAtHubs(sectionHubIds.map((h) => hubData[h]))");
  });
});

describe("the ✕ and where a line is placed", () => {
  it("the hub an item is tagged to: the registry for a Section 1 shop, the hub1/hub2 tag for Marathon", () => {
    const fn = between("const computeHubForItem = (item) => {", "\n  };");
    expect(fn).toContain("if (!onSection2Hubs) return placementHub(sectionNet, effectiveShop, item.product, () => null);");
    expect(fn).toContain('return getProductHubs(item.product).find(h => h === "hub1" || h === "hub2") || "hub1";');
    expect(WORLD).toContain("? placementHub(network, shop, p, () => null)");
    expect(WORLD).toContain(': (productHubsOf(p).find((h) => h === "hub1" || h === "hub2") || "hub1"));');
  });
  it("one resolver answers the hub and the count, with the cart's own claims", () => {
    const fn = between("const sneakerSourcing = (p, s) => resolveSneakerSourcing({", "});");
    expect(fn).toContain("product: p, taggedHub: gatedSneakerHub(p, computeHubForItem({ product: p })),");
    expect(fn).toContain("size: s, hubData: sneakerHubData(),");
    expect(fn).toContain("consumedByHub: cartAllocation.consumed.get(`${p?.id}::${s}`) || null,");
    const out = between("const sneakerOut = (p, s) => {", "\n  };");
    expect(out).toContain("return sneakerGateReady(hub) && Number.isFinite(available) && available <= 0;");
    expect(WORLD).toContain("return gateReady(hub) && Number.isFinite(available) && available <= 0;");
  });
  it("an out size cannot be added: the add itself refuses it, whatever the chip did", () => {
    expect(APP).toContain("} else if (size && sneakerOut(p, size)) {");
    expect(APP).toContain("if (pendingSize && !pendingDisplayPartner && sneakerOut(selected, pendingSize)) { setPendingSize(\"\"); return; }");
  });
  it("a sneaker line is placed at the hub the allocation chose, within the shop's own hubs", () => {
    expect(APP).toContain(": sneakerPlacementHub(sectionNet, effectiveShop, item.product, cartAllocation.hubOf.get(item), () => (cartAllocation.hubOf.get(item) || computeHubForItem(item))));");
  });
});

describe("the card-level Unavailable state", () => {
  const memo = between("const unavailableIds = useMemo(() => {", "deadForOrder]);");
  it("is empty for Marathon PE / Trophy and for a shop with no gated hub", () => {
    expect(memo).toContain("if (onSection2Hubs || !sectionHubIds.length) return NO_UNAVAILABLE;");
    expect(APP).toContain("const NO_UNAVAILABLE = new Set();");
  });
  it("asks the hub's question without the cart, and only once the hub has answered", () => {
    expect(memo).toContain("return { sizes, known: !!hub && sneakerGateReady(hub), sizeOut: (sz) => sneakerAvail(p.id, sz, hub) <= 0 };");
    expect(memo).toContain("sizes, known: !!lane && hubReadState(lane.state).ready,");
    expect(memo).toContain("sizeOut: (sz) => hubQty(p.id, sz) <= 0,");
    expect(memo).toContain("if (deadForOrder(p)) return null;");
  });
  it("is drawn on the phone card, the desktop card and both size sheets", () => {
    // Sky cards (feat/sky-wall): the phone card draws it through AssistantPhone's
    // per-card chip slot, the desktop card on the sky card itself.
    expect(APP).toContain(": unavailableIds.has(p.id) ? <span className=\"sky-unavail sky-unavail--inline\" data-testid=\"card-unavailable\">UNAVAILABLE</span>");
    expect(APP).toContain("{unavailableIds?.has(p.id) && <span className=\"sky-unavail\" data-testid=\"card-unavailable\">UNAVAILABLE</span>}");
    expect(APP.split('data-testid="card-unavailable"').length - 1).toBe(2);
    expect(APP).toContain('data-testid="sheet-unavailable"');
    expect(APP).toContain('data-testid="qv-unavailable"');
    expect(APP).toContain("unavailableIds={unavailableIds} unavailableHintFor={unavailableHintFor}");
  });
});

describe("the alternatives sheet", () => {
  const fn = between("const computeAlternatives = (product, size) => {", "\n  };\n");
  it("takes its pool from the catalogue and its availability from the same gate as the ✕", () => {
    expect(fn).toContain("candidates: products,");
    expect(fn).toContain("availabilityKnown: (p) => !!sneakerHubOf(p),");
    expect(fn).toContain("if (!sneakerGateReady(hub)) return false;");
    expect(fn).toContain("return !sneakerOut(p, sz);");
  });
  it("waits for this shop's own hubs — Hub 1 / Hub 2, or the section's", () => {
    expect(APP).toContain("const sneakerHubsOfShop = onSection2Hubs ? GATED_SNEAKER_HUBS : sectionHubIds;");
    expect(fn).toContain("if (!result.rows.length && (hubLoading || !sneakerHubsOfShop.length)) return null;");
  });
});

describe("parity: features that follow the shop's division", () => {
  it("the display slots feed (a whole node, with repair writes) stays off Pine and Concrete devices", () => {
    expect(APP).toContain("useDisplaySlotsState(onSection2Hubs)");
    expect(APP).toContain("GATED_SNEAKER_HUBS.map((h) => [h, displayUnitsByCell(displaySlotsLive, h)])");
  });
  it("each TV board shows its own division's layby pulls", () => {
    expect(APP).toContain("pullOnTvBoard(p, section)");
    expect(APP).toContain("<TvWithAutoCollect orders={orders} section={2}");
    expect(APP).toContain("<TvWithAutoCollect orders={orders} section={section}");
  });
  it("the shop list fills a stale /locations copy from the seed", () => {
    expect(APP).toContain("const allShops = sellableLocations(withSeedGaps(shopRegistry));");
  });
});
