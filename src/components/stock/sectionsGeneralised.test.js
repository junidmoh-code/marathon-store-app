// ─── THE HARDCODED LISTS, NOW ASKED OF THE NETWORK REGISTRY ──────────────────
// Missing Sneakers, sneaker sourcing, the tomorrow gate, reactive refill hubs,
// initial distribution, introduce-existing, hub cleanup / display stores,
// arming and the network total each kept a private list of hubs or stores.
// Each now asks the registry. For every one of them:
//   1. on the registry's SEED the answer is exactly the list it replaced —
//      Section 2 behaves as it did (the constants are kept and pinned here);
//   2. Section 1 (Pine, Concrete, Hub 3, Concrete Stockroom) is served by the
//      same code once it is live;
//   3. a location that is NOT live gets nothing automatic.
import { describe, it, expect, beforeEach } from "vitest";
import { normalizeNetwork, SEED_REGISTRY } from "../../utils/networkRegistry";
import { setCurrentNetworkFromRaw, __resetNetworkForTests } from "../../utils/networkStore";
import { REACTIVE_REFILL_HUBS, reactiveRefillHubs, isReactiveRefillHub } from "./reactiveRefillHubs";
import { onHoldRefillPlan } from "./onHoldRefill";
import {
  GATED_SNEAKER_HUBS, gatedSneakerHubs, gatedSneakerHub, sneakerAlternates, resolveSneakerSourcing,
} from "./availabilityCore";
import { CENTRAL_FED_HUBS, centralFedHubs, centralFedRow, orderRowHub } from "./tomorrowGate";
import { DISTRIBUTION_DESTS, distributionDests, suggestInitialDistribution, destLabel } from "./distributionSuggest";
import { MIGRATION_DESTS, effectiveRun, isBufferLike, STANDARD_RUN, HUB2_RUN, destsFrom } from "./introduceExistingCore";
import {
  CLEANUP_HUBS, DISPLAY_STORES, cleanupHubs, isCleanupHub, displayStores, cleanupHubLabel, displayStoreLabel,
} from "./hubCleanupCore";
import { ARMING_HUBS, armingHubsFor, armingSections, bucketTitles, BUCKET_TITLE } from "./armingCore";
import { EXCLUDED_LOCATIONS, excludedLocations, countedLocations } from "./networkTotalsCore";
import { computeMissingFootwear } from "./missingFootwearCore";
import { pickDisplaySourceHub } from "./displayRequestCore";
import { EXCESS_HUB_LOCATIONS, excessHubLocations } from "./excessComputation";
import { isShopLocation, locationLabel } from "./attentionCore";

const S1_LIVE_RAW = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true }, "concrete-stockroom": { live: true } } };
const S1_LIVE = normalizeNetwork(S1_LIVE_RAW);
const HUB3_LIVE = normalizeNetwork({ locations: { "marathon-pine": { live: true }, hub3: { live: true } } });

beforeEach(() => __resetNetworkForTests());

describe("on the seed, every registry answer is the list it replaced", () => {
  it("the constants and the registry agree", () => {
    expect(reactiveRefillHubs(SEED_REGISTRY)).toEqual([...REACTIVE_REFILL_HUBS]);
    expect(gatedSneakerHubs(SEED_REGISTRY)).toEqual(GATED_SNEAKER_HUBS);
    expect(centralFedHubs(SEED_REGISTRY)).toEqual(CENTRAL_FED_HUBS);
    expect(cleanupHubs(SEED_REGISTRY)).toEqual([...CLEANUP_HUBS]);
    expect(displayStores(SEED_REGISTRY)).toEqual([...DISPLAY_STORES]);
    expect(armingHubsFor(SEED_REGISTRY, 2)).toEqual(ARMING_HUBS);
    expect(excessHubLocations(SEED_REGISTRY, { liveOnly: true })).toEqual([...EXCESS_HUB_LOCATIONS]);
    expect(distributionDests(SEED_REGISTRY).slice(0, DISTRIBUTION_DESTS.length)).toEqual(DISTRIBUTION_DESTS);
    // the network total: Pine and Hub 3 stay out (plus the two new, empty Section 1 locations)
    for (const id of EXCLUDED_LOCATIONS) expect(excludedLocations(SEED_REGISTRY)).toContain(id);
    expect(excludedLocations(SEED_REGISTRY)).toEqual(["concrete", "concrete-stockroom", "hub3", "marathon-pine"]);
    expect(MIGRATION_DESTS).toEqual(["marathon-pe", "trophy", "hub2"]);
  });

  it("with no argument they read the CURRENT registry, which is the seed until /network answers", () => {
    expect(reactiveRefillHubs()).toEqual(["hub2"]);
    expect(gatedSneakerHubs()).toEqual(["hub1", "hub2"]);
    expect(isCleanupHub("hub1")).toBe(true);
    expect(isCleanupHub("hub3")).toBe(false);
    setCurrentNetworkFromRaw(S1_LIVE_RAW);
    expect(reactiveRefillHubs()).toEqual(["hub2", "hub3"]);
    expect(isCleanupHub("hub3")).toBe(true);
  });
});

describe("reactive refill hubs — the hub behind a shop's everyday stock, live only", () => {
  it("Section 2: Hub 2, never Hub 1; Section 1: Hub 3 once live, never the Concrete Stockroom by default", () => {
    expect(isReactiveRefillHub("hub2", SEED_REGISTRY)).toBe(true);
    expect(isReactiveRefillHub("hub1", SEED_REGISTRY)).toBe(false);
    expect(isReactiveRefillHub("hub3", SEED_REGISTRY)).toBe(false);          // not live
    expect(reactiveRefillHubs(S1_LIVE)).toEqual(["hub2", "hub3"]);
    expect(isReactiveRefillHub("concrete-stockroom", S1_LIVE)).toBe(false);
    // the shop live but its hub not: nothing reactive is routed to that hub
    expect(reactiveRefillHubs(normalizeNetwork({ locations: { "marathon-pine": { live: true } } }))).toEqual(["hub2"]);
  });

  it("the on-hold planner raises a line for a Hub 2 order exactly as before, and for Hub 3 only once it is live", () => {
    const order = (hub) => ({ id: "7", productId: "p", size: "8", qty: 1, placedAtHub: hub });
    const at = { nowIso: "2026-10-02T10:00:00.000Z", saDate: "2026-10-02" };
    const h2 = onHoldRefillPlan(order("hub2"), at);
    expect(h2).toMatchObject({ ok: true, hub: "hub2", requestId: "onhold_2026-10-02_7", record: { requestingLocation: "hub2", createdFrom: { source: "central", via: "on_hold" } } });
    expect(onHoldRefillPlan(order("hub1"), at)).toEqual({ ok: false, reason: "unroutable_hub_hub1" });
    expect(onHoldRefillPlan(order("hub3"), at)).toEqual({ ok: false, reason: "unroutable_hub_hub3" });   // NOT LIVE
    setCurrentNetworkFromRaw(S1_LIVE_RAW);
    expect(onHoldRefillPlan(order("hub3"), at)).toMatchObject({ ok: true, hub: "hub3", record: { requestingLocation: "hub3" } });
    expect(onHoldRefillPlan(order("hub2"), at)).toEqual(h2);
  });
});

describe("sneaker sourcing — 'the other hub' is another hub IN THE SAME SECTION", () => {
  const shoe = { id: "s1", category: "Footwear", productType: "sneaker", sizes: ["8"] };
  const hub = (qty, ready = true) => ({ ready, cells: qty == null ? {} : { s1: { 8: { qty } } }, promised: {} });

  it("Section 2: Hub 1 ⇄ Hub 2, exactly the four answers it always gave", () => {
    const ask = (tag, hubData) => resolveSneakerSourcing({ product: shoe, taggedHub: tag, size: "8", hubData, network: SEED_REGISTRY });
    expect(ask("hub1", { hub1: hub(2), hub2: hub(5) })).toEqual({ hub: "hub1", available: 2 });   // the tag wins when it can supply
    expect(ask("hub1", { hub1: hub(0), hub2: hub(5) })).toEqual({ hub: "hub2", available: 5 });   // only a zero reroutes
    expect(ask("hub2", { hub1: hub(3), hub2: hub(0) })).toEqual({ hub: "hub1", available: 3 });
    expect(ask("hub1", { hub1: hub(0), hub2: hub(0) })).toEqual({ hub: "hub1", available: 0 });   // both empty → the tag
    expect(ask("hub1", { hub1: hub(0), hub2: hub(5, false) })).toEqual({ hub: "hub1", available: 0 });   // silence is not zero
    expect(ask("hub3", { hub1: hub(4), hub2: hub(4) })).toEqual({ hub: "hub3", available: null });        // not a gated hub
    expect(sneakerAlternates("hub1", SEED_REGISTRY)).toEqual(["hub2"]);
  });

  it("NEVER ACROSS THE WALL: with Hub 3 live and empty, a Hub 3 shoe is not rerouted to Hub 1 or Hub 2 — and a Hub 1 shoe never to Hub 3", () => {
    const all = { hub1: hub(4), hub2: hub(4), hub3: hub(0), "concrete-stockroom": hub(6) };
    expect(sneakerAlternates("hub3", S1_LIVE)).toEqual(["concrete-stockroom"]);
    expect(sneakerAlternates("hub1", S1_LIVE)).toEqual(["hub2"]);
    expect(resolveSneakerSourcing({ product: shoe, taggedHub: "hub3", size: "8", hubData: all, network: S1_LIVE })).toEqual({ hub: "concrete-stockroom", available: 6 });
    // only Hub 3 live in Section 1: no alternate at all — the tag answers, empty
    expect(resolveSneakerSourcing({ product: shoe, taggedHub: "hub3", size: "8", hubData: all, network: HUB3_LIVE })).toEqual({ hub: "hub3", available: 0 });
    expect(resolveSneakerSourcing({ product: shoe, taggedHub: "hub1", size: "8", hubData: { hub1: hub(0), hub2: hub(0), hub3: hub(9) }, network: S1_LIVE })).toEqual({ hub: "hub1", available: 0 });
    // an ordering shop narrows it further: a Pine order can only be picked on Pine's side
    expect(sneakerAlternates("hub1", S1_LIVE, "marathon-pine")).toEqual([]);
  });

  it("NOT LIVE: Hub 3 is ungated — no gate, no reroute, yesterday's behaviour", () => {
    expect(gatedSneakerHub(shoe, "hub3", SEED_REGISTRY)).toBeNull();
    expect(gatedSneakerHub(shoe, "hub2", SEED_REGISTRY)).toBe("hub2");
    expect(gatedSneakerHub(shoe, "hub3", S1_LIVE)).toBe("hub3");
    expect(gatedSneakerHub({ ...shoe, productType: "clothing" }, "hub2", SEED_REGISTRY)).toBeNull();
  });

  it("a display request is sourced only from a hub on the shop's side of the wall", () => {
    const hubData = { hub1: hub(0), hub2: hub(0), hub3: hub(5) };
    expect(pickDisplaySourceHub({ product: { ...shoe, hubs: ["hub1"] }, hubData, store: "trophy", network: S1_LIVE })).toEqual({ hub: null });
    expect(pickDisplaySourceHub({ product: { ...shoe, hubs: ["hub1"] }, hubData: { hub1: hub(0), hub2: hub(3) }, store: "trophy", network: SEED_REGISTRY })).toEqual({ hub: "hub2", units: 3, tagged: false });
    expect(pickDisplaySourceHub({ product: { ...shoe, hubs: ["hub3"] }, hubData, store: "marathon-pine", network: S1_LIVE })).toEqual({ hub: "hub3", units: 5, tagged: true });
    // no store given (an older caller): the list is not narrowed, on the seed Hub 1 + Hub 2 as before
    expect(pickDisplaySourceHub({ product: { ...shoe, hubs: ["hub2"] }, hubData: { hub1: hub(1), hub2: hub(0) }, network: SEED_REGISTRY })).toEqual({ hub: "hub1", units: 1, tagged: false });
  });
});

describe("the tomorrow gate — which rows Central is probed for", () => {
  const shoe = { id: "s1", category: "Footwear", productType: "sneaker" };
  const tee = { id: "t1", productType: "clothing" };
  it("Section 2, verbatim: Hub 1 always; Hub 2 for gated footwear only; Hub 3 / hubC never", () => {
    expect(centralFedRow({ hub: "hub1" }, tee, SEED_REGISTRY)).toBe(true);
    expect(centralFedRow({}, tee, SEED_REGISTRY)).toBe(true);                          // hub defaults to hub1
    expect(centralFedRow({ hub: "hub2" }, shoe, SEED_REGISTRY)).toBe(true);
    expect(centralFedRow({ hub: "hub2" }, tee, SEED_REGISTRY)).toBe(false);
    expect(centralFedRow({ hub: "hub2" }, null, SEED_REGISTRY)).toBe(false);
    expect(centralFedRow({ placedAtHub: "hub3", hub: "hub1" }, shoe, SEED_REGISTRY)).toBe(false);
    expect(centralFedRow({ placedAtHub: "hubC", hub: "hub1" }, shoe, SEED_REGISTRY)).toBe(false);
    // a placedAtHub naming a Hub 1-side hub never overrides `hub`
    expect(orderRowHub({ placedAtHub: "hub1", hub: "hub2" }, SEED_REGISTRY)).toBe("hub2");
    expect(orderRowHub({ placedAtHub: "hub3", hub: "hub1" }, SEED_REGISTRY)).toBe("hub3");
  });
  it("Section 1: a Hub 3 row is probed like a Hub 2 row once Hub 3 is live — and not before", () => {
    expect(centralFedRow({ placedAtHub: "hub3" }, shoe, S1_LIVE)).toBe(true);
    expect(centralFedRow({ placedAtHub: "hub3" }, tee, S1_LIVE)).toBe(false);
    expect(centralFedRow({ placedAtHub: "hub3" }, shoe, SEED_REGISTRY)).toBe(false);
    expect(centralFedRow({ hub: "hub2" }, shoe, S1_LIVE)).toBe(true);
  });
});

describe("initial distribution — destinations from the registry", () => {
  const tee = { id: "t", productType: "clothing", sizes: ["S", "M", "L"] };
  it("the default call is exactly the five destinations and their tables", () => {
    const d = suggestInitialDistribution({ product: tee });
    expect(Object.keys(d.suggestions)).toEqual(DISTRIBUTION_DESTS);
    expect(d.suggestions["marathon-pe"]).toEqual({ S: 0, M: 2, L: 2 });
    expect(d.suggestions.hub2).toEqual({ S: 2, M: 3, L: 3 });
    expect(d.defaultOn).toEqual({ "marathon-pe": true, trophy: true, "marathon-pine": true, hub1: false, hub2: false });
  });
  it("the wizard's list adds Concrete, Hub 3 and the Concrete Stockroom, on their templates; the first five are untouched", () => {
    const dests = distributionDests(SEED_REGISTRY);
    expect(dests).toEqual(["marathon-pe", "trophy", "marathon-pine", "hub1", "hub2", "concrete", "hub3", "concrete-stockroom"]);
    const d = suggestInitialDistribution({ product: tee, dests, network: SEED_REGISTRY });
    const base = suggestInitialDistribution({ product: tee });
    for (const k of DISTRIBUTION_DESTS) {
      expect(d.suggestions[k]).toEqual(base.suggestions[k]);
      expect(d.defaultOn[k]).toBe(base.defaultOn[k]);
    }
    expect(d.suggestions.concrete).toEqual(base.suggestions["marathon-pe"]);            // Concrete follows Marathon PE
    expect(d.suggestions.hub3).toEqual(base.suggestions.hub2);                          // Hub 3 follows Hub 2
    expect(d.suggestions["concrete-stockroom"]).toEqual(base.suggestions.hub2);
    // The seed (7 Oct 2026): Concrete has Solve ON — pre-ticked like any store. A hub is never pre-ticked.
    expect([d.defaultOn.concrete, d.defaultOn.hub3, d.defaultOn["concrete-stockroom"]]).toEqual([true, false, false]);
    // SOLVE OFF: offered, never pre-ticked.
    const OFF = { solve: false, autoRefill: "off" };
    const dark = normalizeNetwork({ locations: { "marathon-pine": OFF, concrete: OFF, hub3: OFF, "concrete-stockroom": OFF } });
    const off = suggestInitialDistribution({ product: tee, dests, network: dark });
    expect([off.defaultOn.concrete, off.defaultOn.hub3, off.defaultOn["concrete-stockroom"]]).toEqual([false, false, false]);
    const live = suggestInitialDistribution({ product: tee, dests, network: S1_LIVE });
    expect([live.defaultOn.concrete, live.defaultOn.hub3, live.defaultOn["concrete-stockroom"]]).toEqual([true, false, false]);
    expect(destLabel("concrete", SEED_REGISTRY)).toBe("Concrete");
    expect(destLabel("marathon-pine", SEED_REGISTRY)).toBe("Pine");                     // the original label is kept
  });
});

describe("introduce existing — the run a location follows", () => {
  const cfg = { defaultRunByStore: { "marathon-pe": { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 0 }, hub2: { S: 3, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 } } };
  it("Section 2 reads what it always read (its own run, else the per-location fallback)", () => {
    expect(effectiveRun(cfg, "marathon-pe", SEED_REGISTRY)).toBe(cfg.defaultRunByStore["marathon-pe"]);
    expect(effectiveRun(cfg, "hub2", SEED_REGISTRY)).toBe(cfg.defaultRunByStore.hub2);
    expect(effectiveRun(cfg, "trophy", SEED_REGISTRY)).toBe(STANDARD_RUN);
    expect(effectiveRun(cfg, "hub1", SEED_REGISTRY)).toBe(STANDARD_RUN);
    expect(effectiveRun({}, "hub2", SEED_REGISTRY)).toBe(HUB2_RUN);
    expect(effectiveRun(null, "hub2")).toBe(HUB2_RUN);
    expect(destsFrom({ routes: { a: "b" } })).toEqual(["a"]);
  });
  it("Section 1 follows its template: Pine and Concrete read Marathon PE's run, Hub 3 and the stockroom Hub 2's", () => {
    expect(effectiveRun(cfg, "marathon-pine", SEED_REGISTRY)).toBe(cfg.defaultRunByStore["marathon-pe"]);
    expect(effectiveRun(cfg, "concrete", SEED_REGISTRY)).toBe(cfg.defaultRunByStore["marathon-pe"]);
    expect(effectiveRun(cfg, "hub3", SEED_REGISTRY)).toBe(cfg.defaultRunByStore.hub2);
    expect(effectiveRun({}, "hub3", SEED_REGISTRY)).toBe(HUB2_RUN);
    expect(effectiveRun({}, "concrete", SEED_REGISTRY)).toBe(STANDARD_RUN);
    // a location with its own run uses its own
    const own = { defaultRunByStore: { ...cfg.defaultRunByStore, concrete: { S: 2, M: 2, L: 2, XL: 2, XXL: 2, XXXL: 2 } } };
    expect(effectiveRun(own, "concrete", SEED_REGISTRY)).toBe(own.defaultRunByStore.concrete);
    expect(["hub2", "hub3", "concrete-stockroom"].map((l) => isBufferLike(l, SEED_REGISTRY))).toEqual([true, true, true]);
    expect(["hub1", "marathon-pe", "trophy", "marathon-pine", "concrete", "central"].map((l) => isBufferLike(l, SEED_REGISTRY))).toEqual([false, false, false, false, false, false]);
  });
});

describe("cleanup hubs, display stores, arming pairs, the network total — held by the live flag", () => {
  it("what switches on when Section 1 goes live", () => {
    expect(cleanupHubs(S1_LIVE)).toEqual(["hub3", "concrete-stockroom", "hub1", "hub2"]);
    expect(displayStores(S1_LIVE)).toEqual(["marathon-pine", "concrete", "marathon-pe", "trophy"]);
    expect(excludedLocations(S1_LIVE)).toEqual([]);
    expect(cleanupHubLabel("hub3", SEED_REGISTRY)).toBe("Hub 3");
    expect(displayStoreLabel("marathon-pe", SEED_REGISTRY)).toBe("Marathon PE");
  });
  it("the network total counts exactly what it counted: every active location except the ones not live", () => {
    const registry = { central: { active: true }, hub1: {}, hub2: {}, hub3: {}, "marathon-pe": {}, trophy: {}, "marathon-pine": {}, studio: { active: false }, in_transit: {} };
    const ids = Object.keys(registry);
    expect(countedLocations(ids, registry, SEED_REGISTRY)).toEqual(["central", "hub1", "hub2", "in_transit", "marathon-pe", "trophy"]);
    expect(countedLocations(ids, registry, HUB3_LIVE)).toEqual(["central", "hub1", "hub2", "hub3", "in_transit", "marathon-pe", "marathon-pine", "trophy"]);
  });
  it("arming compares ONE section's two hubs — never across the wall", () => {
    expect(armingHubsFor(SEED_REGISTRY, 1)).toEqual(["hub3", "concrete-stockroom"]);
    expect(armingSections(SEED_REGISTRY)).toEqual([2, 1]);
    expect(bucketTitles(ARMING_HUBS, SEED_REGISTRY)).toEqual(BUCKET_TITLE);
    expect(bucketTitles(["hub3", "concrete-stockroom"], SEED_REGISTRY)).toEqual({ both_hubs: "Both hubs", hub1_only: "Hub 3", hub2_only: "Concrete Stockroom", nowhere: "Nowhere" });
    // a section with one hub has no pair to compare
    const oneHub = normalizeNetwork({ locations: { "concrete-stockroom": { section: 2 } } });
    expect(armingHubsFor(oneHub, 1)).toBeNull();
    expect(armingSections(oneHub)).toEqual([]);
  });
  it("labels: a location the old maps did not name is named by the registry", () => {
    expect(locationLabel("concrete")).toBe("Concrete");
    expect(locationLabel("concrete-stockroom")).toBe("Concrete Stockroom");
    expect(isShopLocation("concrete")).toBe(true);
    expect(isShopLocation("marathon-pe")).toBe(true);
    expect(isShopLocation("hub3")).toBe(false);
  });
});

describe("Missing Sneakers is one section's list", () => {
  const shoe = (id) => ({ id, name: id, category: "Footwear", productType: "sneaker", sizes: ["8"] });
  const products = [shoe("a"), shoe("b"), shoe("c")];
  const cell = (qty) => ({ qty });
  const allStock = {
    central: { a: { 8: cell(4) }, b: { 8: cell(3) }, c: { 8: cell(2) } },
    hub1: { a: { 8: cell(1) } },          // Section 2 holds a
    hub3: { b: { 8: cell(1) } },          // Section 1 holds b
  };
  it("Section 2 (the default): zero at Hub 1 AND Hub 2 — Hub 3's stock does not hide a Section 2 gap", () => {
    expect(computeMissingFootwear({ allStock, products }).map((c) => c.pid)).toEqual(["b", "c"]);
    expect(computeMissingFootwear({ allStock, products, hubs: ["hub1", "hub2"], central: "central" })).toEqual(computeMissingFootwear({ allStock, products }));
  });
  it("Section 1: zero at Hub 3 AND the Concrete Stockroom — Hub 1's stock does not hide a Section 1 gap", () => {
    const s1 = computeMissingFootwear({ allStock, products, hubs: ["hub3", "concrete-stockroom"] });
    expect(s1.map((c) => c.pid)).toEqual(["a", "c"]);
    expect(s1[0].missingFrom).toEqual(["hub3", "concrete-stockroom"]);
  });
});
