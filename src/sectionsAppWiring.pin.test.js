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
    expect(placeOrders).toContain("placementHub(sectionNet, effectiveShop, item.product, () => (cartAllocation.hubOf.get(item) || computeHubForItem(item)))");
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
  it("dispatch accepts every registry hub, and the CR tab follows the registry", () => {
    expect(APP).toContain("const VALID_HUBS = stockHubIds(whNet);");
    expect(APP).toContain(": crHubsNow().includes(selectedHub)");
    expect(APP).toContain("shops={shopsOfHub(whNet, selectedHub)}");
  });
});

describe("the TV boards", () => {
  it("the default board is still TvOnlyShell; only ?section=1 mounts the section board", () => {
    expect(APP).toContain("renderTv={() => (tvSectionFromSearch(window.location.search) === 1 ? <SectionTvShell section={1} /> : <TvOnlyShell />)}");
    const hook = between("function useSectionTvOrders(section) {", "\n}\n");
    expect(hook).toContain("tvOrderKeyRanges(currentNetwork(), section)");
    expect(hook).toContain("keyInOrderRanges(key, ranges)");
    expect(hook).toContain("startAt(r.start), endAt(r.end)");
  });
  it("the order-number gap audit reads the shared sequence only (both copies)", () => {
    expect(APP.split(".filter(o => isSharedSequenceOrderKey(o.id))").length - 1).toBe(2);
  });
});
