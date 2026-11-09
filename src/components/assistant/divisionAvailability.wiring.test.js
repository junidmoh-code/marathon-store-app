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

describe("the catalogue", () => {
  it("a shop with its own hubs also lists what those hubs hold", () => {
    const cat = between("const base = useMemo(", "sectionStockedHere]);");
    expect(cat).toContain("servedHubs: onSection2Hubs ? null : backStockHubsOf(sectionNet, effectiveShop),");
    expect(cat).toContain("stockedHere: sectionStockedHere,");
    const stocked = between("const sectionStockedHere = useMemo(", ");\n");
    expect(stocked).toContain("sectionHubA ? stockedAtHubs([sectionCellsA, sectionCellsB].map(hubReadState)) : undefined");
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
  it("asks the size chips' own question, and only once the hub has answered", () => {
    expect(memo).toContain("return { sizes, known: !!hub && sneakerGateReady(hub), sizeOut: (sz) => sneakerOut(p, sz) };");
    expect(memo).toContain("sizes, known: !!lane && hubReadState(lane.state).ready,");
    expect(memo).toContain("sizeOut: (sz) => availableUnits(lane.state.cells?.[p.id]?.[decodedCellKey(sz)]?.qty) <= 0,");
    expect(memo).toContain("if (deadForOrder(p)) return null;");
  });
  it("is drawn on the phone card, the desktop card and both size sheets", () => {
    expect(APP).toContain("const unavail = unavailableIds.has(p.id);");
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
