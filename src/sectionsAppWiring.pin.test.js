// Pins the sections wiring inside the App.jsx monolith (its views cannot be
// imported in isolation). The LOGIC is tested where it lives —
// utils/sectionRouting.test.js, utils/orderNumbering.test.js,
// utils/orderCounter.test.js. This file only proves App.jsx CALLS it, at the
// places where a literal used to route a Section 1 record into Section 2.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const between = (a, b) => { const i = APP.indexOf(a); const j = APP.indexOf(b, i); return i > -1 && j > -1 ? APP.slice(i, j) : null; };

describe("order placement", () => {
  // The hub is decided in placedHubFor (main's ONE function, read by the
  // submit-time stock guard AND the write), so the slice starts there.
  const placeOrders = between("const placedHubFor = (item) =>", "await writeOrder(order);");
  const placeRefills = between("const placeRefillRequests = async", "setLastOrders(placed);");

  it("placeOrders: registry hub for non-Section-2 shops, the wall BEFORE the number, the shop's own sequence, the section stamp", () => {
    expect(placeOrders).not.toBeNull();
    expect(placeOrders).toContain("placementHub(sectionNet, effectiveShop, item.product, () => CR_HUB_BY_UNIVERSE[effectiveStoreMode] || \"hub2\")");
    // Sneakers: the allocation's hub goes in too, so a Section 1 line is booked
    // against the hub its tile was gated on (utils/sectionSneakerHubs.js);
    // Marathon PE / Trophy still get the legacy computation, unchanged.
    expect(placeOrders).toContain("sneakerPlacementHub(sectionNet, effectiveShop, item.product, cartAllocation.hubOf.get(item), () => (cartAllocation.hubOf.get(item) || computeHubForItem(item)))");
    expect(placeOrders).toContain("const placedHub = placedHubFor(item);");
    const wall = placeOrders.indexOf("orderPlacementCheck(sectionNet, { hub: placedHub, destShop: effectiveShop })");
    const refuse = placeOrders.indexOf("if (!wall.ok) throw new Error(wall.message);");
    const number = placeOrders.indexOf("await getNextOrderNumber(effectiveShop)");
    expect(wall).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(wall);
    expect(number, "the number must be drawn AFTER the wall refuses").toBeGreaterThan(refuse);
    expect(placeOrders).toContain("section: sectionStamp(sectionNet, effectiveShop),");
    // hand-placed: never the automatic (live-only) gate
    expect(placeOrders).not.toContain("auto: true");
  });

  it("placeRefillRequests: every line is checked before the cart's ONE number is drawn", () => {
    expect(placeRefills).not.toBeNull();
    const wall = placeRefills.indexOf("orderPlacementCheck(sectionNet, { hub: refillHubFor(item), destShop: effectiveShop })");
    const number = placeRefills.indexOf("await getNextRefillNumber(effectiveShop)");
    const write = placeRefills.indexOf("await writeOrder(order);");
    expect(wall).toBeGreaterThan(-1);
    expect(number).toBeGreaterThan(wall);
    expect(write).toBeGreaterThan(number);
    expect(placeRefills).toContain("const placedHub = refillHubFor(item);");
    expect(placeRefills).toContain("section: sectionStamp(sectionNet, effectiveShop),");
  });

  it("the counters are the shared module's — no second copy of either transaction in App.jsx", () => {
    expect(APP).toContain('import { getTodayKey, getNextOrderNumber, getNextRefillNumber } from "./utils/orderCounter";');
    expect(APP).not.toMatch(/ref\(database, "refillCounter"\)/);
    expect(APP).not.toMatch(/ref\(database, "orderCounter"\)/);
  });
});

describe("no Section-2-pointing hub fallback is left where a record's shop can answer", () => {
  it("the literal fallbacks are gone from the warehouse, CR and Source paths", () => {
    expect(APP).not.toContain('(o.placedAtHub || o.hub || "hub2")');
    expect(APP).not.toContain('it.placedAtHub || "hub2"');
    expect(APP).not.toContain('(e.hub || e.placedAtHub || "hub1") === h');
    expect(APP).not.toContain('(o.hub || "hub1") === h');
    expect(APP).not.toContain('HELD_DISPATCH_HUBS.has(order.placedAtHub || order.hub || "hub1")');
  });
  it("exactly ONE copy of the old seven-fold default survives — inside the hash-pinned display-refill block", () => {
    // displayAutoRefillUnchanged.test.js pins setDisplayRefillStatus byte for
    // byte; its insight stamp is the survivor. Any other copy is a regression.
    expect(APP.split('order.placedAtHub || order.hub || "hub1"').length - 1).toBe(1);
  });
  it("hub3 is not a synonym for Pine: the shop decides", () => {
    expect(APP).not.toContain('e.placedAtHub === "hub3")');
    expect(APP).not.toContain('if (o?.placedAtHub === "hub3") return "Pine";');
    expect(APP).toContain('if (!o?.destShop && o?.placedAtHub === "hub3")');
    expect(APP).toContain("const matchesStore = useMemo(() => insightsStoreMatcher(storeFilter), [storeFilter]);");
  });
});

describe("the warehouse hub", () => {
  it("a persisted / deep-linked hub is honoured only through the section gate, and the picker lists only allowed hubs", () => {
    expect(APP).toContain("const selectedHub = hubAllowedForViewer(whNet, canSeeHub, storedHub) ? storedHub : null;");
    expect(APP).toContain("{warehouseHubGroups(whNet, canSeeHub).map((group, gi, groups) => (");
    expect(APP).not.toContain('[["hub1","Hub 1"],["hub2","Hub 2"],["hub3","Hub 3"],["hubC","Hub C"]]');
    // nothing else reads the raw value into the working hub
    expect(APP.split('localStorage.getItem("warehouseHub")').length - 1).toBe(1);
  });
  it("a hub outside the viewer's sections is never persisted, and one already on the device is dropped", () => {
    // every write of the key sits behind the section gate …
    expect(APP.split('localStorage.setItem("warehouseHub"').length - 1).toBe(1);
    const select = between("const selectHub = (hub) => {", "setSelectedHub(hub);");
    expect(select).not.toBeNull();
    expect(select.indexOf("if (!hubAllowedForViewer(whNet, canSeeHub, hub)) return;")).toBeGreaterThan(-1);
    expect(select.indexOf("if (!hubAllowedForViewer(whNet, canSeeHub, hub)) return;"))
      .toBeLessThan(select.indexOf('localStorage.setItem("warehouseHub", hub);'));
    // … and a stored one that fails it is removed, only once /network answered
    expect(APP).toContain("const storedHubFate = storedHubVerdict(whNet, canSeeHub, storedHub, whNetSettled || !!whNetError);");
    const drop = between("const storedHubFate = storedHubVerdict(", "}, [storedHubFate]);");
    expect(drop).toContain('if (storedHubFate !== "drop") return;');
    expect(drop).toContain('localStorage.removeItem("warehouseHub");');
  });
  it("dispatch accepts every registry hub, and the CR tab follows the registry", () => {
    expect(APP).toContain("const VALID_HUBS = stockHubIds(whNet);");
    expect(APP).toContain("const tabDefs = warehouseTabKeys(whNet, selectedHub).map((key) => [key, ...tabMeta[key]]);");
    expect(APP).toContain("shops={shopsOfHub(whNet, selectedHub)}");
  });
});

describe("the order screen's sneaker lane follows the shop's own section", () => {
  // The answers are tested in utils/sectionSneakerHubs.test.js (with the real
  // resolver and allocation). These pins prove the screen ASKS them.
  it("a Section 1 shop's gated hubs come from the registry, one subscription per slot", () => {
    expect(APP).toContain("const sectionHubIds = useMemo(() => sectionSneakerHubs(sectionNet, effectiveShop), [sectionNet, effectiveShop]);");
    expect(APP).toContain("const sectionCellsA = useStockCellsState(sectionHubA);");
    expect(APP).toContain("const sectionCellsB = useStockCellsState(sectionHubB);");
    expect(APP).toContain("() => (sectionHubA ? readyPromisedByCell(orders, sectionHubA, productsById) : {}),");
    expect(APP).toContain("() => (sectionHubB ? readyPromisedByCell(orders, sectionHubB, productsById) : {}),");
  });
  it("the gate, the availability read and the ✕ note read the section hub's own cells and promises", () => {
    expect(APP).toContain("const sneakerCellsOf = (hub) => sectionSneaker[hub]?.state || sneakerCellsState(hub);");
    expect(APP).toContain("const sneakerPromisedOf = (hub) => sectionSneaker[hub]?.promised || sneakerPromisedMap(hub);");
    const ready = between("const sneakerGateReady = (hub) => {", "};");
    expect(ready).toContain("const st = sneakerCellsOf(hub);");
    expect(APP).toContain("cellAvailability({ cells: sneakerCellsOf(hub).cells, promised: sneakerPromisedOf(hub), productId: pid, size });");
    expect(APP).toContain("...cellBlockInfo({ cells: sneakerCellsOf(hub).cells, promised: sneakerPromisedOf(hub), productId: p.id, size: s }),");
  });
  it("the resolver and the cart allocation are handed ONLY this shop's hubs beside the Hub 1 / Hub 2 pair", () => {
    const data = between("const sneakerHubData = () => ({", "\n  });");
    expect(data).not.toBeNull();
    expect(data).toContain('hub1: { cells: hub1CellsState.cells, promised: hub1Promised, ready: sneakerGateReady("hub1") },');
    expect(data).toContain('hub2: { cells: hub2CellsState.cells, promised: hub2ReadyPromised, ready: sneakerGateReady("hub2") },');
    expect(data).toContain("...Object.fromEntries(Object.keys(sectionSneaker).map((h) => [h, {");
    // one hubData for both walks, so the tile and the checkout cannot disagree
    expect(APP.split("hubData: sneakerHubData(),").length - 1).toBe(2);
  });
  it("Marathon PE / Trophy still name the pair; a Section 1 shop names its own list", () => {
    expect(APP).toContain("const sneakerHubsOfShop = onSection2Hubs ? GATED_SNEAKER_HUBS : sectionHubIds;");
  });
  it("the submit guard checks the hub the line is booked against, and nets that hub's promises", () => {
    // the hub the guard re-reads and the hub the order is written with are one call
    expect(APP).toContain("hub: placedHubFor(item), productId: item.product.id, size: item.size, label: item.product.name,");
    expect(APP).toContain("const placedHub = placedHubFor(item);");
    expect(APP).toContain("return !!gatedSneakerHub(item.product, placedHubFor(item));");
    const guard = between("const refusal = await findSubmitShortfall({", "isOnline:");
    expect(guard).toContain("promisedFor: (hub, pid, size) => (sectionSneaker[hub]");
    expect(guard).toContain("? (sectionSneaker[hub].promised[promisedKey(pid, size)] || 0)");
  });
  it("clothing greys out on the product's own back-stock hub", () => {
    expect(APP).toContain("const extraHub = extraClothingHub(sectionNet, effectiveShop, servingHub);");
    expect(APP).toContain('const extraHubCells = useStockCells(extraHub || "__off__");');
    expect(APP).toContain("const clothingHubOf = (pid) => clothingHubFor(sectionNet, effectiveShop, productsById[pid], servingHub);");
    expect(APP).toContain("const hubQty = (pid, size) => availableUnits(clothingCellsOf(pid)?.[pid]?.[decodedCellKey(size)]?.qty);");
  });
});

describe("Source: the sale-driven lanes follow the registry's reactive hubs", () => {
  it("the reactive hub list is the registry's, and a live Section 1 hub tab gets sale rows", () => {
    expect(APP).toContain("const REACTIVE_REFILL_HUBS = useMemo(() => reactiveRefillHubs(srcNet), [srcNet]);");
    expect(APP).not.toMatch(/import \{[^}]*\bREACTIVE_REFILL_HUBS\b[^}]*\} from/);
    expect(APP).toContain("const sectionReactiveHub = sectionTabLoc[tab] && REACTIVE_REFILL_HUBS.includes(sectionTabLoc[tab]) ? sectionTabLoc[tab] : null;");
    expect(APP).toContain('const activeHub = tab === "hub1refill" ? "hub1" : tab === "clothing" ? "hub2" : sectionReactiveHub;');
    expect(APP).toContain("? hubTabContent(sectionReactiveHub)");
  });
});

describe("the TV boards", () => {
  it("the default board is still TvOnlyShell; only ?section=1 mounts the section board", () => {
    expect(APP).toContain("renderTv={() => (tvSectionFromSearch(window.location.search) === 1 ? <SectionTvShell section={1} /> : <TvOnlyShell />)}");
    const hook = between("function useSectionTvOrders(section) {", "\n}\n");
    expect(hook).toContain("tvOrderKeyRanges(tvNetwork, section)");
    expect(hook).toContain("const { registry: tvNetwork } = useNetwork();");
    expect(hook).toContain("keyInOrderRanges(key, ranges)");
    expect(hook).toContain("startAt(r.start), endAt(r.end)");
  });
  it("the order-number gap audit reads the shared sequence only (both copies)", () => {
    expect(APP.split(".filter(o => isSharedSequenceOrderKey(o.id))").length - 1).toBe(2);
  });
});
