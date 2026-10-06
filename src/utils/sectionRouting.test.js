// Which hub, for which shop. Three promises, each tested on the registry seed:
//   1. Marathon PE / Trophy (and records with no shop) get the OLD literal.
//   2. Pine / Concrete get their own section's hub from the registry.
//   3. Nothing automatic is raised for a location that is not live.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  shopOfRecord, keepsLegacyHub, fallbackHub, hubOfRecord, placementHub, servingHubFor,
  usesSection2Hubs, stockHubIds, crHubIds, hubLabel, warehouseHubGroups, hubAllowedForViewer,
  shopGroups, shopsOfHub, orderIsAtHub, orderPlacementCheck, sectionStamp, sectionOfRecord,
  dispatchHoldMs, sourceTabsFor, insightsStoreOptions, insightsBucketKey, insightsStoreMatcher, TRIAL_HUB,
} from "./sectionRouting";
import { SEED_REGISTRY, normalizeNetwork, canSeeLocation, sectionOf, wallAllows } from "./networkRegistry";

const NET = SEED_REGISTRY;
const see = (sections) => (loc) => canSeeLocation(NET, sections, loc);
const SNEAKER = { id: "s1", categoryKey: "sneakers" };
const TEE = { id: "t1", categoryKey: "tshirts" };
// The owner flips Concrete's sneakers, and one tee, to the Concrete Stockroom.
const FLIPPED = normalizeNetwork({
  backStock: { concrete: { sneakers: "concrete-stockroom" } },
  productOverrides: { concrete: { t9: "concrete-stockroom" } },
});

describe("Section 2 keeps the old literal — every fallback, every shop", () => {
  it.each(["marathon-pe", "trophy", null, undefined, ""])("shop %s → the literal the call site always used", (shop) => {
    expect(keepsLegacyHub(NET, shop)).toBe(true);
    expect(fallbackHub(NET, shop, "hub1")).toBe("hub1");
    expect(fallbackHub(NET, shop, "hub2")).toBe("hub2");
    expect(fallbackHub(NET, shop, "hub1", TEE)).toBe("hub1");   // never re-derived from the registry
  });
  it("hubOfRecord: stamped hub wins; a hub-less PE / Trophy / shop-less record gets the literal", () => {
    expect(hubOfRecord(NET, { placedAtHub: "hub2", hub: "hub1", destShop: "trophy" }, "hub1")).toBe("hub2");
    expect(hubOfRecord(NET, { hub: "hub2" }, "hub1")).toBe("hub2");
    expect(hubOfRecord(NET, { destShop: "marathon-pe" }, "hub1")).toBe("hub1");
    expect(hubOfRecord(NET, { destShop: "trophy" }, "hub2")).toBe("hub2");
    expect(hubOfRecord(NET, {}, "hub1")).toBe("hub1");
    expect(hubOfRecord(NET, null, "hub1")).toBe("hub1");
  });
  it("placementHub runs the legacy computation, untouched, and never the registry", () => {
    let calls = 0;
    const legacy = () => { calls += 1; return "hub1-from-allocation"; };
    expect(placementHub(NET, "marathon-pe", SNEAKER, legacy)).toBe("hub1-from-allocation");
    expect(placementHub(NET, "trophy", TEE, legacy)).toBe("hub1-from-allocation");
    expect(placementHub(FLIPPED, "trophy", TEE, legacy)).toBe("hub1-from-allocation");
    expect(calls).toBe(3);
  });
  it("serving hub, section-2 subscriptions, queue membership", () => {
    expect(servingHubFor(NET, "marathon-pe", "hub2")).toBe("hub2");
    expect(usesSection2Hubs(NET, "marathon-pe")).toBe(true);
    expect(usesSection2Hubs(NET, "trophy")).toBe(true);
    // the old orderInHub: (o.hub || "hub1") === h for hub1/hub2
    expect(orderIsAtHub(NET, { hub: "hub2" }, "hub2")).toBe(true);
    expect(orderIsAtHub(NET, { hub: "hub2" }, "hub1")).toBe(false);
    expect(orderIsAtHub(NET, {}, "hub1")).toBe(true);
    expect(orderIsAtHub(NET, { destShop: "trophy" }, "hub1")).toBe(true);
    expect(orderIsAtHub(NET, { hub: "hub1", placedAtHub: "hubC" }, TRIAL_HUB)).toBe(true);   // hubC by placedAtHub, as before
    expect(orderIsAtHub(NET, { hub: "hub1" }, TRIAL_HUB)).toBe(false);
  });
  it("the dispatch hold is Hub 2's alone, six minutes", () => {
    expect(dispatchHoldMs("hub2")).toBe(360000);
    for (const h of ["hub1", "hub3", "concrete-stockroom", "hubC", undefined]) expect(dispatchHoldMs(h)).toBe(0);
  });
  it("Hub 2's CR pills are Marathon PE and Trophy, in that order", () => {
    expect(shopsOfHub(NET, "hub2")).toEqual(["marathon-pe", "trophy"]);
  });
});

describe("Section 1 resolves through its own shop — never into Section 2", () => {
  it("Pine → Hub 3 for everything", () => {
    expect(keepsLegacyHub(NET, "marathon-pine")).toBe(false);
    expect(fallbackHub(NET, "marathon-pine", "hub1")).toBe("hub3");
    expect(fallbackHub(NET, "marathon-pine", "hub2", SNEAKER)).toBe("hub3");
    expect(placementHub(NET, "marathon-pine", SNEAKER, () => "hub1")).toBe("hub3");
    expect(servingHubFor(NET, "marathon-pine", "hub2")).toBe("hub3");
    expect(usesSection2Hubs(NET, "marathon-pine")).toBe(false);
  });
  it("Concrete → Hub 3 by default; the Stockroom for a flipped category or product", () => {
    expect(placementHub(NET, "concrete", SNEAKER, () => "hub1")).toBe("hub3");
    expect(placementHub(FLIPPED, "concrete", SNEAKER, () => "hub1")).toBe("concrete-stockroom");
    expect(placementHub(FLIPPED, "concrete", TEE, () => "hub2")).toBe("hub3");
    expect(placementHub(FLIPPED, "concrete", { id: "t9", categoryKey: "tshirts" }, () => "hub2")).toBe("concrete-stockroom");
    // Pine is not served by the Stockroom, whatever Concrete does.
    expect(placementHub(FLIPPED, "marathon-pine", SNEAKER, () => "hub1")).toBe("hub3");
    expect(usesSection2Hubs(NET, "concrete")).toBe(false);
  });
  it("a legacy Pine order (placedStore only, no destShop) is still Pine's", () => {
    expect(shopOfRecord({ placedStore: "pine" })).toBe("marathon-pine");
    expect(hubOfRecord(NET, { placedStore: "pine" }, "hub1")).toBe("hub3");
  });
  it("a hub-less Section 1 order is on NO Section 2 queue", () => {
    for (const shop of ["marathon-pine", "concrete"]) {
      expect(orderIsAtHub(NET, { destShop: shop }, "hub1")).toBe(false);
      expect(orderIsAtHub(NET, { destShop: shop }, "hub2")).toBe(false);
    }
    expect(orderIsAtHub(NET, { destShop: "concrete", placedAtHub: "concrete-stockroom" }, "concrete-stockroom")).toBe(true);
    expect(orderIsAtHub(NET, { destShop: "concrete", placedAtHub: "hub3" }, "hub3")).toBe(true);
  });
  it("a shop the registry does not know gets NO hub — not Hub 1, not Hub 2", () => {
    expect(fallbackHub(NET, "kloof", "hub1")).toBe(null);
    expect(placementHub(NET, "kloof", SNEAKER, () => "hub1")).toBe(null);
    expect(servingHubFor(NET, "kloof", "hub2")).toBe(null);
    expect(usesSection2Hubs(NET, "kloof")).toBe(false);
  });
  it("whatever hub a Section 1 shop is given is on its own side of the wall", () => {
    for (const net of [NET, FLIPPED]) {
      for (const shop of ["marathon-pine", "concrete"]) {
        for (const product of [SNEAKER, TEE, { id: "t9", categoryKey: "tshirts" }, null]) {
          const hub = placementHub(net, shop, product, () => "hub1");
          expect(sectionOf(net, hub)).toBe(1);
          expect(wallAllows(net, hub, shop)).toBe(true);
        }
      }
    }
  });
  it("Hub 3 sends to Pine and Concrete; the Stockroom only to Concrete", () => {
    expect(shopsOfHub(NET, "hub3")).toEqual(["marathon-pine", "concrete"]);
    expect(shopsOfHub(NET, "concrete-stockroom")).toEqual(["concrete"]);
    expect(shopsOfHub(NET, "hubC")).toEqual([]);
  });
});

describe("hub lists come from the registry", () => {
  it("stock hubs and CR hubs", () => {
    expect(stockHubIds(NET).sort()).toEqual(["concrete-stockroom", "hub1", "hub2", "hub3"]);
    // was [hub2, hub3]: every hub that is not sneakers-only. Hub 1 never.
    expect(crHubIds(NET).sort()).toEqual(["concrete-stockroom", "hub2", "hub3"]);
    expect(crHubIds(FLIPPED)).not.toContain("hub1");
  });
  it("labels, including the retired trial hub", () => {
    expect(hubLabel(NET, "hub1")).toBe("Hub 1");
    expect(hubLabel(NET, "hub3")).toBe("Hub 3");
    expect(hubLabel(NET, "concrete-stockroom")).toBe("Concrete Stockroom");
    expect(hubLabel(NET, "hubC")).toBe("Hub C");
    expect(hubLabel(NET, "hub9")).toBe("hub9");
  });
});

describe("the warehouse hub picker and the persisted hub", () => {
  const ids = (groups) => groups.map((g) => [g.section, g.items.map((i) => i.id)]);
  it("the owner sees both sections, Section 2 first with Hub C where it was", () => {
    expect(ids(warehouseHubGroups(NET, see([1, 2])))).toEqual([
      [2, ["hub1", "hub2", "hubC"]],
      [1, ["hub3", "concrete-stockroom"]],
    ]);
  });
  it("a Section 2 account is offered exactly today's Section 2 hubs", () => {
    expect(ids(warehouseHubGroups(NET, see([2])))).toEqual([[2, ["hub1", "hub2", "hubC"]]]);
  });
  it("a Section 1 account is offered Hub 3 and the Concrete Stockroom — not live, still workable by hand", () => {
    const groups = warehouseHubGroups(NET, see([1]));
    expect(ids(groups)).toEqual([[1, ["hub3", "concrete-stockroom"]]]);
    expect(groups[0].items.every((i) => i.live === false)).toBe(true);
  });
  it("localStorage.warehouseHub / a push deep link is honoured only inside the viewer's sections", () => {
    const s1 = see([1]); const s2 = see([2]);
    expect(hubAllowedForViewer(NET, s2, "hub1")).toBe(true);
    expect(hubAllowedForViewer(NET, s2, "hub2")).toBe(true);
    expect(hubAllowedForViewer(NET, s2, "hubC")).toBe(true);
    expect(hubAllowedForViewer(NET, s2, "hub3")).toBe(false);
    expect(hubAllowedForViewer(NET, s2, "concrete-stockroom")).toBe(false);
    expect(hubAllowedForViewer(NET, s1, "hub3")).toBe(true);
    expect(hubAllowedForViewer(NET, s1, "concrete-stockroom")).toBe(true);
    expect(hubAllowedForViewer(NET, s1, "hub1")).toBe(false);
    expect(hubAllowedForViewer(NET, s1, "hubC")).toBe(false);
  });
  it("…and never for something that is not a hub", () => {
    const all = see([1, 2]);
    for (const bad of ["central", "marathon-pe", "Hub 3", "hub9", "", null, undefined, "__proto__"]) {
      expect(hubAllowedForViewer(NET, all, bad)).toBe(false);
    }
    expect(hubAllowedForViewer(NET, see([]), "hub1")).toBe(false);
    expect(hubAllowedForViewer(NET, null, "hub1")).toBe(false);
  });
  it("shops grouped by section for the viewer", () => {
    expect(shopGroups(NET, see([1, 2])).map((g) => [g.section, g.items.map((i) => i.id)])).toEqual([
      [2, ["marathon-pe", "trophy"]], [1, ["marathon-pine", "concrete"]],
    ]);
    expect(shopGroups(NET, see([1])).map((g) => g.section)).toEqual([1]);
  });
});

describe("order placement and the wall", () => {
  it("Section 2 orders place exactly as before", () => {
    for (const shop of ["marathon-pe", "trophy"]) {
      for (const hub of ["hub1", "hub2", "hubC"]) {
        expect(orderPlacementCheck(NET, { hub, destShop: shop }).ok).toBe(true);
      }
    }
  });
  it("a hand-placed order for a NON-LIVE shop is allowed inside its section", () => {
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "marathon-pine" }).ok).toBe(true);
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "concrete" }).ok).toBe(true);
    expect(orderPlacementCheck(NET, { hub: "concrete-stockroom", destShop: "concrete" }).ok).toBe(true);
  });
  it("hub and shop on opposite sides are refused, both ways, with words a person can act on", () => {
    for (const [hub, destShop] of [["hub1", "marathon-pine"], ["hub2", "concrete"], ["hubC", "concrete"], ["hub3", "trophy"], ["concrete-stockroom", "marathon-pe"]]) {
      const r = orderPlacementCheck(NET, { hub, destShop });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("cross_section");
      expect(r.message).toMatch(/different sections/);
    }
  });
  it("no hub, an unknown hub, an unknown shop: refused", () => {
    expect(orderPlacementCheck(NET, { hub: null, destShop: "concrete" })).toMatchObject({ ok: false, reason: "no_hub" });
    expect(orderPlacementCheck(NET, { hub: "hub9", destShop: "concrete" })).toMatchObject({ ok: false, reason: "unknown_location" });
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "kloof" })).toMatchObject({ ok: false, reason: "unknown_shop" });
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "hub2" })).toMatchObject({ ok: false, reason: "unknown_shop" });
  });
  it("NOTHING AUTOMATIC is raised to or from a location that is not live", () => {
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "marathon-pine", auto: true })).toMatchObject({ ok: false, reason: "not_live" });
    expect(orderPlacementCheck(NET, { hub: "concrete-stockroom", destShop: "concrete", auto: true })).toMatchObject({ ok: false, reason: "not_live" });
    // Section 2 is live: automatic orders are raised as they always were.
    expect(orderPlacementCheck(NET, { hub: "hub2", destShop: "trophy", auto: true }).ok).toBe(true);
    // The owner marks Pine and Hub 3 live: automatic is allowed from that moment.
    const live = normalizeNetwork({ locations: { "marathon-pine": { live: true }, hub3: { live: true } } });
    expect(orderPlacementCheck(live, { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(true);
    // …but only when BOTH ends are.
    const half = normalizeNetwork({ locations: { "marathon-pine": { live: true } } });
    expect(orderPlacementCheck(half, { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(false);
  });
});

describe("section on the record", () => {
  it("the stamp for a new order", () => {
    expect(sectionStamp(NET, "marathon-pe")).toBe(2);
    expect(sectionStamp(NET, "trophy")).toBe(2);
    expect(sectionStamp(NET, "marathon-pine")).toBe(1);
    expect(sectionStamp(NET, "concrete")).toBe(1);
    expect(sectionStamp(NET, "kloof")).toBe(null);
    expect(sectionStamp(NET, "hub2")).toBe(null);
  });
  it("a reader takes the stamp, and derives it from the shop when there is none", () => {
    expect(sectionOfRecord(NET, { section: 1, destShop: "concrete" })).toBe(1);
    expect(sectionOfRecord(NET, { destShop: "trophy" })).toBe(2);
    expect(sectionOfRecord(NET, { destShop: "marathon-pine" })).toBe(1);
    expect(sectionOfRecord(NET, { placedStore: "pine" })).toBe(1);
    expect(sectionOfRecord(NET, { section: "junk", destShop: "trophy" })).toBe(2);
    expect(sectionOfRecord(NET, {})).toBe(null);
  });
});

describe("Source tabs", () => {
  const keys = (tabs) => tabs.map((t) => t.key);
  it("the four Section 2 tabs keep their keys, labels, locations and order — the same as App.jsx's SOURCE_TABS", () => {
    const tabs = sourceTabsFor(NET, see([2]));
    expect(tabs.map((t) => [t.key, t.label])).toEqual([
      ["hub1refill", "Hub 1 Refill"], ["clothing", "Hub 2 Refill"], ["trophy", "Trophy"], ["marathonpe", "Marathon"], ["refillhistory", "Refill History"],
    ]);
    expect(tabs.slice(0, 4).map((t) => t.loc)).toEqual(["hub1", "hub2", "trophy", "marathon-pe"]);
    const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain('const SOURCE_SHOP_TABS = [["trophy","Trophy","trophy"],["marathonpe","Marathon","marathon-pe"]];');
    expect(APP).toContain('const SOURCE_TABS = [["hub1refill","Hub 1 Refill"],["clothing","Hub 2 Refill"],...SOURCE_SHOP_TABS');
  });
  it("both sections: Section 2's, then Section 1's hubs and shops, then history", () => {
    expect(keys(sourceTabsFor(NET, see([1, 2])))).toEqual([
      "hub1refill", "clothing", "trophy", "marathonpe",
      "loc:hub3", "loc:concrete-stockroom", "loc:marathon-pine", "loc:concrete", "refillhistory",
    ]);
  });
  it("a Section 1 account sees only Section 1's lanes", () => {
    expect(keys(sourceTabsFor(NET, see([1])))).toEqual(["loc:hub3", "loc:concrete-stockroom", "loc:marathon-pine", "loc:concrete", "refillhistory"]);
  });
});

describe("Insights store filter", () => {
  it("options: the three old values in the old order, then Concrete; narrowed by section", () => {
    expect(insightsStoreOptions(NET, see([1, 2]))).toEqual([
      ["all", "All"], ["marathon-pe", "Marathon PE"], ["trophy", "Trophy"], ["pine", "Marathon Pine"], ["concrete", "Concrete"],
    ]);
    expect(insightsStoreOptions(NET, see([2]), (s) => ({ "marathon-pine": "Pine" }[s] || s)).map((o) => o[0])).toEqual(["all", "marathon-pe", "trophy"]);
  });
  it("the filter reads the rollup's own buckets", () => {
    expect(insightsBucketKey("marathon-pe")).toBe("pe");
    expect(insightsBucketKey("pine")).toBe("pine");
    expect(insightsBucketKey("concrete")).toBe("concrete");
    const pe = insightsStoreMatcher("marathon-pe"); const pine = insightsStoreMatcher("pine"); const con = insightsStoreMatcher("concrete");
    // Section 2, as before
    expect(pe({ destShop: "marathon-pe", placedAtHub: "hub1" })).toBe(true);
    expect(pe({ placedAtHub: "hub2" })).toBe(true);                     // untagged central history
    expect(pe({ placedAtHub: "hub3" })).toBe(false);
    expect(insightsStoreMatcher("trophy")({ destShop: "trophy" })).toBe(true);
    // Hub 3 no longer means Pine once the event names a shop
    expect(pine({ destShop: "concrete", placedAtHub: "hub3" })).toBe(false);
    expect(con({ destShop: "concrete", placedAtHub: "hub3" })).toBe(true);
    expect(pine({ destShop: "marathon-pine", placedAtHub: "hub3" })).toBe(true);
    expect(pine({ placedAtHub: "hub3" })).toBe(true);                   // untagged Pine history
    expect(insightsStoreMatcher("all")(null)).toBe(true);
    expect(pe(null)).toBe(false);
  });
});
