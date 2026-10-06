// The registry's contract: aliases resolve, the wall holds, the seed keeps
// Section 2 where it is and Section 1 not live, and a damaged /network node
// can never make either of those untrue.
import { describe, it, expect } from "vitest";
import * as registryApi from "./networkRegistry";
import {
  normalizeNetwork, resolveLocationId, sectionOf, isLive, listLocations, storesOf, hubsOf, tillsFor,
  wallCheck, wallAllows, wallMessage, backStockFor, backStockHubsOf, storesServedBy, autoRouteAllowed,
  creditSpendableAt, issuingStamp, seedPayload, locationName, SEED_REGISTRY,
} from "./networkRegistry";

// What real RTDB does to a written value: empty arrays and empty objects are
// deleted, and so is any key holding null.
function rtdbRoundTrip(v) {
  if (Array.isArray(v)) {
    const out = v.map(rtdbRoundTrip).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      const c = rtdbRoundTrip(v[k]);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v === null ? undefined : v;
}

const SEED = normalizeNetwork(null);

describe("the model", () => {
  it("puts every location in the section the owner named", () => {
    expect(listLocations(SEED, { section: 1 }).map((l) => l.id)).toEqual(["marathon-pine", "concrete", "hub3", "concrete-stockroom"]);
    expect(listLocations(SEED, { section: 2 }).map((l) => l.id)).toEqual(["marathon-pe", "trophy", "hub1", "hub2"]);
    expect(sectionOf(SEED, "central")).toBe(null);
    expect(listLocations(SEED, { type: "central" }).map((l) => l.id)).toEqual(["central"]);
  });

  it("ships Section 2 live and every Section 1 location NOT live", () => {
    for (const id of ["marathon-pe", "trophy", "hub1", "hub2", "central"]) expect(isLive(SEED, id), id).toBe(true);
    for (const id of ["marathon-pine", "concrete", "hub3", "concrete-stockroom"]) expect(isLive(SEED, id), id).toBe(false);
  });

  it("gives Concrete two tills and keeps the tills the POS has today", () => {
    expect(tillsFor(SEED, "concrete").map((t) => t.tillId)).toEqual(["till-1", "till-2"]);
    expect(tillsFor(SEED, "pe").map((t) => t.tillId)).toEqual(["till-1", "till-2", "till-3"]);
    expect(tillsFor(SEED, "trophy").map((t) => t.tillId)).toEqual(["till-1", "till-2"]);
    expect(tillsFor(SEED, "pine").map((t) => t.tillId)).toEqual(["till-1"]);
    expect(tillsFor(SEED, "hub2")).toEqual([]);
  });

  it("lists stores and hubs separately, in sort order", () => {
    expect(storesOf(SEED).map((l) => l.id)).toEqual(["marathon-pine", "concrete", "marathon-pe", "trophy"]);
    expect(hubsOf(SEED).map((l) => l.id)).toEqual(["hub3", "concrete-stockroom", "hub1", "hub2"]);
    expect(storesOf(SEED, { liveOnly: true }).map((l) => l.id)).toEqual(["marathon-pe", "trophy"]);
  });
});

describe("aliases", () => {
  it("resolves every legacy spelling to the canonical id", () => {
    const cases = {
      pe: "marathon-pe", PE: "marathon-pe", "Marathon PE": "marathon-pe", Marathon: "marathon-pe", marathon: "marathon-pe", "marathon-pe": "marathon-pe",
      trophy: "trophy", Trophy: "trophy",
      pine: "marathon-pine", Pine: "marathon-pine", "Marathon Pine": "marathon-pine",
      hub1: "hub1", "Hub 1": "hub1", "Hub 2": "hub2", "hub 3": "hub3",
      Concrete: "concrete", "Concrete Stockroom": "concrete-stockroom",
      central: "central", Central: "central", in_transit: "in_transit",
    };
    for (const [alias, id] of Object.entries(cases)) expect(resolveLocationId(SEED, alias), alias).toBe(id);
  });

  it("is strict: an unknown name is null, never a guess", () => {
    for (const bad of ["", null, undefined, "hub4", "marathon-", "hubC", 7, {}]) expect(resolveLocationId(SEED, bad)).toBe(null);
  });

  it("never lets an alias from the node shadow another location's id", () => {
    const R = normalizeNetwork({ locations: { hub3: { aliases: ["hub2", "trophy", "North Hub"] } } });
    expect(resolveLocationId(R, "hub2")).toBe("hub2");
    expect(resolveLocationId(R, "trophy")).toBe("trophy");
    expect(resolveLocationId(R, "north hub")).toBe("hub3");
  });

  it("keeps the retired Central-building locations as themselves", () => {
    expect(resolveLocationId(SEED, "studio")).toBe("studio");
    expect(wallAllows(SEED, "base", "hub3")).toBe(true);
    expect(isLive(SEED, "studio")).toBe(false);
  });
});

describe("the wall", () => {
  const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
  const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];

  it("refuses every direct pair across the sections, both ways", () => {
    for (const a of S1) for (const b of S2) {
      expect(wallCheck(SEED, a, b), `${a}→${b}`).toEqual({ ok: false, reason: "cross_section" });
      expect(wallCheck(SEED, b, a), `${b}→${a}`).toEqual({ ok: false, reason: "cross_section" });
    }
  });

  it("allows every pair inside a section, and Central with anything", () => {
    for (const set of [S1, S2]) for (const a of set) for (const b of set) expect(wallAllows(SEED, a, b)).toBe(true);
    for (const x of [...S1, ...S2]) {
      expect(wallAllows(SEED, "central", x)).toBe(true);
      expect(wallAllows(SEED, x, "central")).toBe(true);
    }
  });

  it("judges aliases the same as ids", () => {
    expect(wallAllows(SEED, "Hub 2", "pine")).toBe(false);
    expect(wallAllows(SEED, "Marathon", "Trophy")).toBe(true);
  });

  it("passes a single-location write and refuses an unknown or in-transit side", () => {
    expect(wallCheck(SEED, "hub2", null).ok).toBe(true);
    expect(wallCheck(SEED, null, "hub3").ok).toBe(true);
    expect(wallCheck(SEED, "hub2", "hub9")).toEqual({ ok: false, reason: "unknown_location" });
    expect(wallCheck(SEED, "in_transit", "hub3")).toEqual({ ok: false, reason: "transit_needs_real_endpoints" });
  });

  it("says what to do when it refuses", () => {
    expect(wallMessage(SEED, "hub2", "hub3")).toBe("Hub 2 and Hub 3 are in different sections. Send the stock back to Central first.");
    expect(wallMessage(SEED, "hub2", "trophy")).toBe(null);
  });

  it("cannot be opened by the node: a location's section moves it, it does not join both", () => {
    const R = normalizeNetwork({ locations: { hub3: { section: 2 } } });
    expect(wallAllows(R, "hub3", "hub2")).toBe(true);
    expect(wallAllows(R, "hub3", "marathon-pine")).toBe(false);
    // and Pine's mapping to a hub now in the other section is dropped, not honoured
    expect(backStockFor(R, "marathon-pine", "hoodies")).toBe(null);
  });
});

describe("back stock", () => {
  it("keeps Marathon PE and Trophy on Hub 1 for sneakers and Hub 2 for everything else", () => {
    for (const s of ["marathon-pe", "trophy"]) {
      expect(backStockFor(SEED, s, "sneakers")).toBe("hub1");
      for (const c of ["hoodies", "t-shirts", "slides", "perfume", null, undefined, ""]) expect(backStockFor(SEED, s, c)).toBe("hub2");
    }
  });

  it("sends every Pine and Concrete category to Hub 3 by default", () => {
    for (const s of ["marathon-pine", "concrete"]) for (const c of ["sneakers", "hoodies", null]) expect(backStockFor(SEED, s, c)).toBe("hub3");
  });

  it("flips one Concrete category to the stockroom, and one product over the category", () => {
    const R = normalizeNetwork({
      backStock: { concrete: { hoodies: "concrete-stockroom" } },
      productOverrides: { concrete: { p1: "concrete-stockroom", p2: "hub3" } },
    });
    expect(backStockFor(R, "concrete", "hoodies")).toBe("concrete-stockroom");
    expect(backStockFor(R, "concrete", "t-shirts")).toBe("hub3");
    expect(backStockFor(R, "concrete", "t-shirts", "p1")).toBe("concrete-stockroom");
    expect(backStockFor(R, "concrete", "hoodies", "p2")).toBe("hub3");
    expect(backStockHubsOf(R, "concrete")).toEqual(["concrete-stockroom", "hub3"]);
    expect(storesServedBy(R, "concrete-stockroom")).toEqual(["concrete"]);
    expect(storesServedBy(R, "hub3")).toEqual(["concrete", "marathon-pine"]);
  });

  it("refuses the stockroom for Pine: it serves only Concrete", () => {
    const R = normalizeNetwork({ backStock: { "marathon-pine": { _default: "concrete-stockroom", hoodies: "concrete-stockroom" } } });
    expect(backStockFor(R, "marathon-pine", "hoodies")).toBe("hub3");
    expect(backStockFor(R, "marathon-pine", "x")).toBe("hub3");
  });

  it("refuses a cross-section hub in the node and falls back to the seed", () => {
    const R = normalizeNetwork({
      backStock: { concrete: { hoodies: "hub2" }, "marathon-pe": { _default: "hub3", sneakers: "hub3" } },
      productOverrides: { trophy: { p1: "hub3" } },
    });
    expect(backStockFor(R, "concrete", "hoodies")).toBe("hub3");
    expect(backStockFor(R, "marathon-pe", "hoodies")).toBe("hub2");
    expect(backStockFor(R, "marathon-pe", "sneakers")).toBe("hub1");
    expect(backStockFor(R, "trophy", "hoodies", "p1")).toBe("hub2");
  });

  it("has no back stock for a hub or for Central", () => {
    expect(backStockFor(SEED, "hub2", "hoodies")).toBe(null);
    expect(backStockFor(SEED, "central", "hoodies")).toBe(null);
  });
});

describe("live and automatic routing", () => {
  it("routes automatically only between live locations on the same side of the wall", () => {
    expect(autoRouteAllowed(SEED, "hub2", "trophy")).toBe(true);
    expect(autoRouteAllowed(SEED, "central", "hub1")).toBe(true);
    expect(autoRouteAllowed(SEED, "central", "hub3")).toBe(false);
    expect(autoRouteAllowed(SEED, "hub3", "marathon-pine")).toBe(false);
    const R = normalizeNetwork({ locations: { hub3: { live: true }, "marathon-pine": { live: true } } });
    expect(autoRouteAllowed(R, "hub3", "marathon-pine")).toBe(true);
    expect(autoRouteAllowed(R, "hub3", "concrete")).toBe(false);
    expect(autoRouteAllowed(R, "hub3", "hub2")).toBe(false);
  });

  it("flips one location without touching another", () => {
    const R = normalizeNetwork({ locations: { hub3: { live: true } } });
    expect(isLive(R, "hub3")).toBe(true);
    expect(isLive(R, "concrete")).toBe(false);
    expect(isLive(R, "hub2")).toBe(true);
  });

  it("can switch a Section 2 location off, and only an explicit boolean counts", () => {
    expect(isLive(normalizeNetwork({ locations: { hub2: { live: false } } }), "hub2")).toBe(false);
    for (const junk of ["true", 1, null, {}]) {
      expect(isLive(normalizeNetwork({ locations: { hub3: { live: junk } } }), "hub3")).toBe(false);
      expect(isLive(normalizeNetwork({ locations: { hub2: { live: junk } } }), "hub2")).toBe(true);
    }
  });

  it("never treats a location the seed does not know as live unless told", () => {
    const R = normalizeNetwork({ locations: { hub4: { type: "hub", section: 1, name: "Hub 4" }, junk: { name: "x" } } });
    expect(isLive(R, "hub4")).toBe(false);
    expect(R.locations.junk).toBeUndefined();
  });
});

describe("a damaged node", () => {
  it("resolves to the seed for null, junk and partial values", () => {
    for (const raw of [null, undefined, 7, "x", [], {}, { locations: 3 }, { locations: { hub2: null } }, { backStock: [] }]) {
      const R = normalizeNetwork(raw);
      expect(R.locations).toEqual(SEED.locations);
      expect(R.backStock).toEqual(SEED.backStock);
      expect(R.creditScope).toBe("shared");
    }
    expect(SEED_REGISTRY).toEqual(SEED);
  });

  it("cannot have a store's type or section removed", () => {
    const R = normalizeNetwork({ locations: { "marathon-pe": { type: "nonsense", section: 9 }, hub2: { section: null } } });
    expect(R.locations["marathon-pe"].type).toBe("store");
    expect(sectionOf(R, "marathon-pe")).toBe(2);
    expect(sectionOf(R, "hub2")).toBe(2);
    expect(wallAllows(R, "hub2", "hub3")).toBe(false);
  });

  it("survives what RTDB does to the seed: empty arrays vanish, arrays may come back as objects", () => {
    const stored = rtdbRoundTrip(seedPayload());
    expect(normalizeNetwork(stored)).toEqual(SEED);
    // hubs carry no tills key at all in the stored shape
    expect("tills" in stored.locations.hub2).toBe(false);
    // RTDB hands a sparse array back as an object with integer keys
    const objTills = { ...stored, locations: { ...stored.locations, concrete: { ...stored.locations.concrete, tills: { 0: { tillId: "till-1", name: "Till 1" }, 1: { tillId: "till-2", name: "Till 2" } } } } };
    expect(tillsFor(normalizeNetwork(objTills), "concrete")).toHaveLength(2);
    // a store whose tills were all deleted keeps the seed's, never zero
    const noTills = { ...stored, locations: { ...stored.locations, concrete: { ...stored.locations.concrete, tills: undefined } } };
    expect(tillsFor(normalizeNetwork(noTills), "concrete")).toHaveLength(2);
  });
});

describe("credit scope", () => {
  const section = normalizeNetwork({ creditScope: "section" });

  it("defaults to shared, and shared spends anywhere", () => {
    expect(SEED.creditScope).toBe("shared");
    expect(normalizeNetwork({ creditScope: "nonsense" }).creditScope).toBe("shared");
    expect(creditSpendableAt(SEED, { issuingStore: "marathon-pine", section: 1 }, "trophy")).toBe(true);
  });

  it("under section scope, spends only where it was issued", () => {
    const c = issuingStamp(section, "pine");
    expect(c).toEqual({ issuingStore: "marathon-pine", section: 1 });
    expect(creditSpendableAt(section, c, "concrete")).toBe(true);
    expect(creditSpendableAt(section, c, "pine")).toBe(true);
    expect(creditSpendableAt(section, c, "pe")).toBe(false);
    expect(creditSpendableAt(section, issuingStamp(section, "trophy"), "pe")).toBe(true);
    expect(creditSpendableAt(section, issuingStamp(section, "trophy"), "concrete")).toBe(false);
  });

  it("uses the stamped section even if the store later changes section", () => {
    expect(creditSpendableAt(section, { issuingStore: "marathon-pine", section: 2 }, "pe")).toBe(true);
  });

  it("derives the section from the store when only the store was stamped", () => {
    expect(creditSpendableAt(section, { storeId: "pine" }, "pe")).toBe(false);
    expect(creditSpendableAt(section, { storeId: "pine" }, "concrete")).toBe(true);
  });

  it("leaves a historic record with no stamp spendable everywhere, under both scopes", () => {
    for (const rec of [{}, null, { storeId: null }, { storeId: "mobile-unknown" }]) {
      expect(creditSpendableAt(section, rec, "pe")).toBe(true);
      expect(creditSpendableAt(section, rec, "concrete")).toBe(true);
    }
  });

  it("stamps only stores", () => {
    expect(issuingStamp(SEED, "hub2")).toBe(null);
    expect(issuingStamp(SEED, "nowhere")).toBe(null);
  });
});

describe("names", () => {
  it("names a location from any spelling, and falls back to what it was given", () => {
    expect(locationName(SEED, "pe")).toBe("Marathon PE");
    expect(locationName(SEED, "in_transit")).toBe("In Transit");
    expect(locationName(SEED, "hubC")).toBe("hubC");
  });
});

describe("policy template", () => {
  const { policyKeyFor } = registryApi;
  const runs = { "marathon-pe": { M: 2 }, trophy: { M: 3 }, hub2: { M: 4 }, hub1: { 9: 2 } };

  it("a location with its own numbers uses its own — Section 2 is untouched", () => {
    for (const loc of ["marathon-pe", "trophy", "hub2", "hub1"]) expect(policyKeyFor(SEED, runs, loc)).toBe(loc);
  });

  it("Pine and Concrete follow Marathon PE; Hub 3 and the stockroom follow Hub 2", () => {
    expect(policyKeyFor(SEED, runs, "marathon-pine")).toBe("marathon-pe");
    expect(policyKeyFor(SEED, runs, "concrete")).toBe("marathon-pe");
    expect(policyKeyFor(SEED, runs, "hub3")).toBe("hub2");
    expect(policyKeyFor(SEED, runs, "concrete-stockroom")).toBe("hub2");
  });

  it("a store-specific policy, once it exists, wins over the template", () => {
    expect(policyKeyFor(SEED, { ...runs, concrete: { M: 1 } }, "concrete")).toBe("concrete");
  });

  it("falls back to the location itself when the template has nothing either", () => {
    expect(policyKeyFor(SEED, {}, "hub3")).toBe("hub3");
    expect(policyKeyFor(SEED, null, "marathon-pe")).toBe("marathon-pe");
  });
});

describe("numbering", () => {
  const { numberPrefixFor } = registryApi;
  it("Pine and Concrete have their own sequences; Marathon PE and Trophy keep the shared one", () => {
    expect(numberPrefixFor(SEED, "pine")).toBe("P");
    expect(numberPrefixFor(SEED, "concrete")).toBe("C");
    expect(numberPrefixFor(SEED, "pe")).toBe(null);
    expect(numberPrefixFor(SEED, "trophy")).toBe(null);
    expect(numberPrefixFor(SEED, "hub3")).toBe(null);
  });
  it("refuses a prefix that is not 1–3 capitals", () => {
    expect(numberPrefixFor(normalizeNetwork({ locations: { concrete: { numberPrefix: "c-1" } } }), "concrete")).toBe("C");
  });
});

describe("section access", () => {
  const { sectionsFor, canSeeLocation } = registryApi;
  it("the owner and an all-sections admin see both", () => {
    expect(sectionsFor(SEED, { sections: { 1: true } }, { isOwner: true })).toEqual([1, 2]);
    expect(sectionsFor(SEED, { allSections: true, sections: { 2: true } })).toEqual([1, 2]);
  });
  it("an explicit map is exactly that, including nothing at all", () => {
    expect(sectionsFor(SEED, { sections: { 1: true } })).toEqual([1]);
    expect(sectionsFor(SEED, { sections: { 2: true, 1: false } })).toEqual([2]);
    expect(sectionsFor(SEED, { sections: { 1: false } })).toEqual([]);
  });
  it("reads the map as the database hands it back — an ARRAY for small integer keys", () => {
    // what the JS SDK returns for { "1": true }, { "2": true } and { "1": true, "2": true }
    expect(sectionsFor(SEED, { sections: [null, true] })).toEqual([1]);
    expect(sectionsFor(SEED, { sections: [null, null, true] })).toEqual([2]);
    expect(sectionsFor(SEED, { sections: [null, true, true] })).toEqual([1, 2]);
    expect(sectionsFor(SEED, { sections: [null, false] })).toEqual([]);
    // and it outranks the shop lock, as the map does
    expect(sectionsFor(SEED, { sections: [null, true], destShop: "trophy" })).toEqual([1]);
  });

  it("a device's section, then the existing shop lock, decide when there is no map", () => {
    expect(sectionsFor(SEED, {}, { deviceSection: 1 })).toEqual([1]);
    expect(sectionsFor(SEED, { section: 2 })).toEqual([2]);
    expect(sectionsFor(SEED, { destShop: "marathon-pine" })).toEqual([1]);
    expect(sectionsFor(SEED, { destShop: "trophy" })).toEqual([2]);
  });
  it("an account that predates sections is not locked out", () => {
    expect(sectionsFor(SEED, {})).toEqual([1, 2]);
    expect(sectionsFor(SEED, null)).toEqual([1, 2]);
  });
  it("Central is visible to every section; the other section's locations are not", () => {
    expect(canSeeLocation(SEED, [2], "central")).toBe(true);
    expect(canSeeLocation(SEED, [2], "hub2")).toBe(true);
    expect(canSeeLocation(SEED, [2], "hub3")).toBe(false);
    expect(canSeeLocation(SEED, [1], "Concrete Stockroom")).toBe(true);
    expect(canSeeLocation(SEED, [], "central")).toBe(true);
    expect(canSeeLocation(SEED, [1, 2], "nowhere")).toBe(false);
  });
});
