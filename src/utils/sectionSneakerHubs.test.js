// A Section 1 shop's sneaker hubs. The App.jsx wiring that feeds these answers
// into the order screen is pinned in src/sectionsAppWiring.pin.test.js; this
// file tests the answers, and — through the real resolver and the real cart
// allocation — what the screen does with them.
import { describe, it, expect, afterEach } from "vitest";
import { normalizeNetwork, SEED_REGISTRY } from "./networkRegistry";
import { setCurrentNetworkFromRaw, __resetNetworkForTests } from "./networkStore";
import {
  sectionSneakerHubs, sneakerPlacementHub, clothingHubFor, extraClothingHub, SECTION_SNEAKER_HUB_SLOTS,
} from "./sectionSneakerHubs";
import {
  gatedSneakerHub, resolveSneakerSourcing, allocateSneakerCart, GATED_SNEAKER_HUBS,
} from "../components/stock/availabilityCore";

// Section 1 counted in and switched on by the owner.
const LIVE_RAW = {
  locations: {
    "marathon-pine": { live: true }, concrete: { live: true },
    hub3: { live: true }, "concrete-stockroom": { live: true },
  },
};
const LIVE = normalizeNetwork(LIVE_RAW);
// Hub 3 live, the Stockroom not yet.
const HUB3_ONLY = normalizeNetwork({ locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } });
// Concrete's sneakers flipped to the Stockroom on the Network card.
const FLIPPED_RAW = { ...LIVE_RAW, backStock: { concrete: { sneakers: "concrete-stockroom", tshirts: "concrete-stockroom" } } };
const FLIPPED = normalizeNetwork(FLIPPED_RAW);

const SHOE = { id: "s1", name: "Shoe", category: "Footwear", productType: "sneaker", categoryKey: "sneakers" };
const TEE = { id: "t1", name: "Tee", category: "Clothing", productType: "clothing", categoryKey: "tshirts" };
const cells = (qtyBySize) => ({ s1: Object.fromEntries(Object.entries(qtyBySize).map(([k, q]) => [k, { qty: q }])) });
const hub = (qtyBySize, ready = true) => ({ cells: cells(qtyBySize), promised: {}, ready });

// The hubData the order screen builds: the Hub 1 / Hub 2 pair is always
// present (never ready on a Section 1 device, which does not subscribe to
// them), and the shop's own section hubs are added.
function screenHubData(network, shop, stock) {
  const s2 = sectionSneakerHubs(network, shop).length === 0 && network.locations[shop]?.section === 2;
  const out = {
    hub1: s2 ? stock.hub1 : { cells: {}, promised: {}, ready: false },
    hub2: s2 ? stock.hub2 : { cells: {}, promised: {}, ready: false },
  };
  for (const h of sectionSneakerHubs(network, shop)) out[h] = stock[h];
  return out;
}

afterEach(() => __resetNetworkForTests());

describe("sectionSneakerHubs", () => {
  it("answers NOTHING for Marathon PE and Trophy, live or not — they keep the screen's own pair", () => {
    for (const net of [SEED_REGISTRY, LIVE, FLIPPED]) {
      expect(sectionSneakerHubs(net, "marathon-pe")).toEqual([]);
      expect(sectionSneakerHubs(net, "trophy")).toEqual([]);
    }
    expect(GATED_SNEAKER_HUBS).toEqual(["hub1", "hub2"]);
  });
  it("on the built-in registry Section 1 is not live, so Pine and Concrete have no gated hub", () => {
    expect(sectionSneakerHubs(SEED_REGISTRY, "marathon-pine")).toEqual([]);
    expect(sectionSneakerHubs(SEED_REGISTRY, "concrete")).toEqual([]);
  });
  it("live: Pine → Hub 3 only; Concrete → Hub 3 and its Stockroom", () => {
    expect(sectionSneakerHubs(LIVE, "marathon-pine")).toEqual(["hub3"]);
    expect(sectionSneakerHubs(LIVE, "concrete")).toEqual(["hub3", "concrete-stockroom"]);
    // any spelling of the shop
    expect(sectionSneakerHubs(LIVE, "pine")).toEqual(["hub3"]);
  });
  it("a hub that is not live is left out; a Section 2 hub is never in the list", () => {
    expect(sectionSneakerHubs(HUB3_ONLY, "concrete")).toEqual(["hub3"]);
    for (const shop of ["marathon-pine", "concrete"]) {
      expect(sectionSneakerHubs(LIVE, shop)).not.toContain("hub1");
      expect(sectionSneakerHubs(LIVE, shop)).not.toContain("hub2");
    }
  });
  it("an unknown shop, a hub, Central and nothing at all get no hubs", () => {
    for (const x of ["nowhere", "hub3", "central", null, undefined, ""]) expect(sectionSneakerHubs(LIVE, x)).toEqual([]);
  });
  it("never returns more hubs than the screen has subscriptions for", () => {
    const wide = normalizeNetwork({ locations: {
      ...LIVE_RAW.locations,
      hub9: { type: "hub", section: 1, live: true, name: "Hub 9", sort: 14 },
      hub8: { type: "hub", section: 1, live: true, name: "Hub 8", sort: 15 },
    } });
    expect(sectionSneakerHubs(wide, "concrete")).toHaveLength(SECTION_SNEAKER_HUB_SLOTS);
    expect(sectionSneakerHubs(wide, "concrete")).toEqual(["hub3", "concrete-stockroom"]);
  });
});

describe("sneakerPlacementHub", () => {
  it("Marathon PE / Trophy: the legacy computation, whatever else is passed", () => {
    for (const net of [SEED_REGISTRY, LIVE]) {
      expect(sneakerPlacementHub(net, "marathon-pe", SHOE, "hub3", () => "hub1")).toBe("hub1");
      expect(sneakerPlacementHub(net, "trophy", SHOE, undefined, () => "hub2")).toBe("hub2");
    }
  });
  it("not live: the back-stock hub, exactly what placementHub answered before", () => {
    expect(sneakerPlacementHub(SEED_REGISTRY, "marathon-pine", SHOE, undefined, () => "hub1")).toBe("hub3");
    expect(sneakerPlacementHub(SEED_REGISTRY, "concrete", SHOE, undefined, () => "hub1")).toBe("hub3");
    // an allocation naming a hub that is not gated for the shop is not followed
    expect(sneakerPlacementHub(SEED_REGISTRY, "concrete", SHOE, "concrete-stockroom", () => "hub1")).toBe("hub3");
  });
  it("live: the allocation's hub when it is one of the shop's own", () => {
    expect(sneakerPlacementHub(LIVE, "concrete", SHOE, "concrete-stockroom", () => "hub1")).toBe("concrete-stockroom");
    expect(sneakerPlacementHub(LIVE, "concrete", SHOE, "hub3", () => "hub1")).toBe("hub3");
    expect(sneakerPlacementHub(LIVE, "concrete", SHOE, undefined, () => "hub1")).toBe("hub3");
  });
  it("NEVER a hub across the wall, and never the Stockroom for Pine", () => {
    for (const bad of ["hub1", "hub2", "hubC", "concrete-stockroom", "nowhere"]) {
      expect(sneakerPlacementHub(LIVE, "marathon-pine", SHOE, bad, () => "hub1")).toBe("hub3");
    }
    for (const bad of ["hub1", "hub2", "hubC"]) {
      expect(sneakerPlacementHub(LIVE, "concrete", SHOE, bad, () => "hub1")).toBe("hub3");
    }
  });
  it("a flipped category books an unallocated line at the Stockroom; an unknown shop gets no hub", () => {
    expect(sneakerPlacementHub(FLIPPED, "concrete", SHOE, undefined, () => "hub1")).toBe("concrete-stockroom");
    expect(sneakerPlacementHub(LIVE, "nowhere", SHOE, "hub3", () => "hub1")).toBe(null);
  });
});

describe("the order screen's sneaker lane for a Section 1 shop (real resolver, real allocation)", () => {
  const tagged = (net, shop, p) => gatedSneakerHub(p, sneakerPlacementHub(net, shop, p, undefined, () => null), net);

  it("not live: no gate at all — the rule does not answer, so no ✕ and no reroute", () => {
    setCurrentNetworkFromRaw(null);
    expect(tagged(SEED_REGISTRY, "marathon-pine", SHOE)).toBe(null);
    const r = resolveSneakerSourcing({ product: SHOE, taggedHub: null, size: "8", hubData: screenHubData(SEED_REGISTRY, "marathon-pine", {}) });
    expect(r.available).toBe(null);
  });

  it("live, Pine: gated on Hub 3's own cell", () => {
    setCurrentNetworkFromRaw(LIVE_RAW);
    const stock = { hub3: hub({ 8: 2, 9: 0 }), "concrete-stockroom": hub({ 9: 5 }) };
    const data = screenHubData(LIVE, "marathon-pine", stock);
    expect(Object.keys(data).sort()).toEqual(["hub1", "hub2", "hub3"]);
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: tagged(LIVE, "marathon-pine", SHOE), size: "8", hubData: data }))
      .toEqual({ hub: "hub3", available: 2 });
    // Hub 3 has no 9s. The Stockroom does — and is not Pine's: a true ✕ at Hub 3.
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: "hub3", size: "9", hubData: data }))
      .toEqual({ hub: "hub3", available: 0 });
  });

  it("live, Concrete: a size Hub 3 is out of is served by the Stockroom", () => {
    setCurrentNetworkFromRaw(LIVE_RAW);
    const data = screenHubData(LIVE, "concrete", { hub3: hub({ 8: 1, 9: 0 }), "concrete-stockroom": hub({ 9: 5 }) });
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: "hub3", size: "9", hubData: data }))
      .toEqual({ hub: "concrete-stockroom", available: 5 });
    // the tag still wins whenever it can supply
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: "hub3", size: "8", hubData: data }))
      .toEqual({ hub: "hub3", available: 1 });
  });

  it("live, Concrete: a cart spills from Hub 3 to the Stockroom and nowhere else", () => {
    setCurrentNetworkFromRaw(LIVE_RAW);
    const data = screenHubData(LIVE, "concrete", { hub3: hub({ 8: 1 }), "concrete-stockroom": hub({ 8: 1 }) });
    const lines = [1, 2, 3].map(() => ({ product: SHOE, size: "8" }));
    const { hubOf } = allocateSneakerCart({ lines, hubData: data, taggedHubFor: (p) => tagged(LIVE, "concrete", p) });
    expect(lines.map((l) => hubOf.get(l))).toEqual(["hub3", "concrete-stockroom", "hub3"]);
    expect(lines.map((l) => sneakerPlacementHub(LIVE, "concrete", SHOE, hubOf.get(l), () => "hub1")))
      .toEqual(["hub3", "concrete-stockroom", "hub3"]);
  });

  it("live, Pine: a cart never leaves Hub 3 — not to the Stockroom, not across the wall", () => {
    setCurrentNetworkFromRaw(LIVE_RAW);
    // Hub 1 and Hub 2 are full and READY here on purpose: even if a Section 1
    // device were streaming them, the wall keeps them out of the candidates.
    const data = {
      ...screenHubData(LIVE, "marathon-pine", { hub3: hub({ 8: 1 }) }),
      hub1: hub({ 8: 9 }), hub2: hub({ 8: 9 }), "concrete-stockroom": hub({ 8: 9 }),
    };
    delete data["concrete-stockroom"];   // the screen never adds a hub that does not serve the shop
    const lines = [1, 2].map(() => ({ product: SHOE, size: "8" }));
    const { hubOf } = allocateSneakerCart({ lines, hubData: data, taggedHubFor: (p) => tagged(LIVE, "marathon-pine", p) });
    expect(lines.map((l) => hubOf.get(l))).toEqual(["hub3", "hub3"]);
  });

  it("Marathon PE under the SAME live registry: Hub 1 ⇄ Hub 2 exactly as before, never Hub 3", () => {
    setCurrentNetworkFromRaw(LIVE_RAW);
    const stock = { hub1: hub({ 8: 0 }), hub2: hub({ 8: 3 }), hub3: hub({ 8: 9 }) };
    const data = screenHubData(LIVE, "marathon-pe", stock);
    expect(Object.keys(data).sort()).toEqual(["hub1", "hub2"]);
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: "hub1", size: "8", hubData: data }))
      .toEqual({ hub: "hub2", available: 3 });
    // and with Hub 3's data forced in, the wall still refuses it
    expect(resolveSneakerSourcing({ product: SHOE, taggedHub: "hub1", size: "8", hubData: { hub1: hub({ 8: 0 }), hub2: hub({ 8: 0 }), hub3: hub({ 8: 9 }) } }))
      .toEqual({ hub: "hub1", available: 0 });
  });
});

describe("clothing grey-out: the product's own back-stock hub", () => {
  it("Marathon PE / Trophy: the serving hub, always, and no second subscription", () => {
    for (const net of [SEED_REGISTRY, LIVE, FLIPPED]) {
      for (const shop of ["marathon-pe", "trophy"]) {
        expect(clothingHubFor(net, shop, TEE, "hub2")).toBe("hub2");
        expect(clothingHubFor(net, shop, SHOE, "hub2")).toBe("hub2");
        expect(extraClothingHub(net, shop, "hub2")).toBe(null);
      }
    }
  });
  it("Pine, and Concrete before any flip: Hub 3 and nothing else", () => {
    for (const shop of ["marathon-pine", "concrete"]) {
      expect(clothingHubFor(SEED_REGISTRY, shop, TEE, "hub3")).toBe("hub3");
      expect(extraClothingHub(SEED_REGISTRY, shop, "hub3")).toBe(null);
    }
  });
  it("Concrete with T-shirts flipped: T-shirts read the Stockroom, everything else Hub 3", () => {
    expect(extraClothingHub(FLIPPED, "concrete", "hub3")).toBe("concrete-stockroom");
    expect(clothingHubFor(FLIPPED, "concrete", TEE, "hub3")).toBe("concrete-stockroom");
    expect(clothingHubFor(FLIPPED, "concrete", { id: "h1", categoryKey: "hoodies" }, "hub3")).toBe("hub3");
    // Pine is untouched by Concrete's flip
    expect(extraClothingHub(FLIPPED, "marathon-pine", "hub3")).toBe(null);
    expect(clothingHubFor(FLIPPED, "marathon-pine", TEE, "hub3")).toBe("hub3");
  });
  it("a single flipped PRODUCT is followed too", () => {
    const one = normalizeNetwork({ productOverrides: { concrete: { t1: "concrete-stockroom" } } });
    expect(extraClothingHub(one, "concrete", "hub3")).toBe("concrete-stockroom");
    expect(clothingHubFor(one, "concrete", TEE, "hub3")).toBe("concrete-stockroom");
    expect(clothingHubFor(one, "concrete", { ...TEE, id: "t2" }, "hub3")).toBe("hub3");
  });
  it("no product in hand, or a shop the registry does not know: the serving hub", () => {
    expect(clothingHubFor(FLIPPED, "concrete", undefined, "hub3")).toBe("hub3");
    expect(clothingHubFor(FLIPPED, "nowhere", TEE, "__off__")).toBe("__off__");
    expect(extraClothingHub(FLIPPED, "nowhere", "__off__")).toBe(null);
  });
});
