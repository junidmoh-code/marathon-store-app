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
  storedHubVerdict, warehouseTabKeys, sourceTabKeys,
} from "./sectionRouting";
import { SEED_REGISTRY, normalizeNetwork, canSeeLocation, sectionOf, wallAllows } from "./networkRegistry";

const NET = SEED_REGISTRY;
const see = (sections) => (loc) => canSeeLocation(NET, sections, loc);
const SNEAKER = { id: "s1", categoryKey: "sneakers" };
const TEE = { id: "t1", categoryKey: "tshirts" };
// A stored node still naming the removed Concrete Stockroom (8 Oct 2026):
// every such mapping is ignored — Concrete's back stock is Hub 3.
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
    for (const h of ["hub1", "hub3", "hubC", undefined]) expect(dispatchHoldMs(h)).toBe(0);
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
  it("Concrete → Hub 3, always — a stored mapping to the removed Stockroom is ignored", () => {
    expect(placementHub(NET, "concrete", SNEAKER, () => "hub1")).toBe("hub3");
    expect(placementHub(FLIPPED, "concrete", SNEAKER, () => "hub1")).toBe("hub3");
    expect(placementHub(FLIPPED, "concrete", TEE, () => "hub2")).toBe("hub3");
    expect(placementHub(FLIPPED, "concrete", { id: "t9", categoryKey: "tshirts" }, () => "hub2")).toBe("hub3");
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
  it("Hub 3 sends to Pine and Concrete; the removed Stockroom sends to no one", () => {
    expect(shopsOfHub(NET, "hub3")).toEqual(["marathon-pine", "concrete"]);
    expect(shopsOfHub(NET, "concrete-stockroom")).toEqual([]);
    expect(shopsOfHub(NET, "hubC")).toEqual([]);
  });
});

describe("hub lists come from the registry", () => {
  it("stock hubs and CR hubs", () => {
    expect(stockHubIds(NET).sort()).toEqual(["hub1", "hub2", "hub3"]);
    // was [hub2, hub3]: every hub that is not sneakers-only. Hub 1 never.
    expect(crHubIds(NET).sort()).toEqual(["hub2", "hub3"]);
    expect(crHubIds(FLIPPED)).not.toContain("hub1");
  });
  it("labels, including the retired trial hub", () => {
    expect(hubLabel(NET, "hub1")).toBe("Hub 1");
    expect(hubLabel(NET, "hub3")).toBe("Hub 3");
    expect(hubLabel(NET, "hubC")).toBe("Hub C");
    expect(hubLabel(NET, "hub9")).toBe("hub9");
  });
});

describe("the warehouse hub picker and the persisted hub", () => {
  const ids = (groups) => groups.map((g) => [g.section, g.items.map((i) => i.id)]);
  it("the owner sees exactly Hub 1, Hub 2, Hub 3 — no Hub C on the picker (owner, 8 Oct 2026)", () => {
    expect(ids(warehouseHubGroups(NET, see([1, 2])))).toEqual([
      [2, ["hub1", "hub2"]],
      [1, ["hub3"]],
    ]);
  });
  it("a Section 2 account is offered Hub 1 and Hub 2 — Hub C stays usable but is not listed", () => {
    expect(ids(warehouseHubGroups(NET, see([2])))).toEqual([[2, ["hub1", "hub2"]]]);
    expect(hubAllowedForViewer(NET, see([2]), "hubC")).toBe(true);   // a device already on Hub C keeps it
  });
  it("a Section 1 account is offered Hub 3 — not fully live, still workable by hand", () => {
    const groups = warehouseHubGroups(NET, see([1]));
    expect(ids(groups)).toEqual([[1, ["hub3"]]]);
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
    expect(hubAllowedForViewer(NET, s1, "concrete-stockroom")).toBe(false);   // removed 8 Oct 2026
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
  it("a stored hub the viewer may not work as is dropped — but only once /network has answered", () => {
    const s1 = see([1]); const s2 = see([2]);
    expect(storedHubVerdict(NET, s2, null, true)).toBe("none");
    expect(storedHubVerdict(NET, s2, "", true)).toBe("none");
    // allowed: kept, answered or not
    for (const answered of [true, false]) {
      expect(storedHubVerdict(NET, s2, "hub2", answered)).toBe("keep");
      expect(storedHubVerdict(NET, s2, "hubC", answered)).toBe("keep");
      expect(storedHubVerdict(NET, s1, "hub3", answered)).toBe("keep");
    }
    // the other section's hub, and things that are not hubs
    for (const [canSee, hub] of [[s2, "hub3"], [s2, "concrete-stockroom"], [s1, "hub1"], [s1, "hubC"], [s2, "marathon-pe"], [s2, "hub9"], [s2, "../../evil"]]) {
      expect(storedHubVerdict(NET, canSee, hub, true)).toBe("drop");
      expect(storedHubVerdict(NET, canSee, hub, false)).toBe("wait");
    }
    // a hub that exists only in the live node: unknown to the seed (wait), a
    // real hub once /network is in hand (keep)
    const live = normalizeNetwork({ locations: { hub9: { type: "hub", section: 2, live: true, name: "Hub 9" } } });
    expect(storedHubVerdict(NET, s2, "hub9", false)).toBe("wait");
    expect(storedHubVerdict(live, (loc) => canSeeLocation(live, [2], loc), "hub9", true)).toBe("keep");
  });
  it("the warehouse tabs each hub has", () => {
    const all = ["queue", "clothing", "refills", "layby"];
    expect(warehouseTabKeys(NET, "hub1")).toEqual(["queue", "refills", "layby"]);       // sneakers-only: no CR Orders
    expect(warehouseTabKeys(NET, "hub2")).toEqual(all);
    expect(warehouseTabKeys(NET, "hub3")).toEqual(all);
    expect(warehouseTabKeys(NET, "concrete-stockroom")).toEqual([]);                     // removed 8 Oct 2026
    expect(warehouseTabKeys(NET, TRIAL_HUB)).toEqual(["queue"]);
    for (const bad of ["marathon-pe", "central", "hub9", "Hub 3", "", null, undefined]) expect(warehouseTabKeys(NET, bad)).toEqual([]);
    // "CR Orders" is exactly the CR hubs
    for (const h of [...stockHubIds(NET), TRIAL_HUB]) {
      expect(warehouseTabKeys(NET, h).includes("clothing")).toBe(crHubIds(NET).includes(h));
    }
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
  });
  it("hub and shop on opposite sides are refused, both ways, with words a person can act on", () => {
    for (const [hub, destShop] of [["hub1", "marathon-pine"], ["hub2", "concrete"], ["hubC", "concrete"], ["hub3", "trophy"]]) {
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
  it("NOTHING AUTOMATIC is raised to or from a location whose Auto-refill is off", () => {
    const off = (ids) => normalizeNetwork({ locations: Object.fromEntries(ids.map((id) => [id, { solve: true, autoRefill: "off" }])) });
    const dark = off(["marathon-pine", "concrete", "hub3"]);
    expect(orderPlacementCheck(dark, { hub: "hub3", destShop: "marathon-pine", auto: true })).toMatchObject({ ok: false, reason: "not_live" });
    expect(orderPlacementCheck(dark, { hub: "hub3", destShop: "concrete", auto: true })).toMatchObject({ ok: false, reason: "not_live" });
    // Section 2 is live: automatic orders are raised as they always were.
    expect(orderPlacementCheck(dark, { hub: "hub2", destShop: "trophy", auto: true }).ok).toBe(true);
    // The seed (7 Oct 2026): Section 1 is Auto-refill "solved" — on, so the engine's legs are open.
    expect(orderPlacementCheck(NET, { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(true);
    // Solve ON alone does not open an AUTOMATIC leg…
    expect(orderPlacementCheck(off(["marathon-pine"]), { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(false);
    // …and a legacy live:true still does (migrated to on + all), only when BOTH ends are on.
    const half = normalizeNetwork({ locations: { "marathon-pine": { live: true }, hub3: { solve: true, autoRefill: "off" } } });
    expect(orderPlacementCheck(half, { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(false);
    const both = normalizeNetwork({ locations: { "marathon-pine": { live: true }, hub3: { live: true } } });
    expect(orderPlacementCheck(both, { hub: "hub3", destShop: "marathon-pine", auto: true }).ok).toBe(true);
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
  it("sourceTabKeys: every key the registry yields, for a link that cannot know the viewer", () => {
    expect(sourceTabKeys(NET)).toEqual(keys(sourceTabsFor(NET, see([1, 2]))));
    expect(sourceTabKeys(NET)).not.toContain("loc:concrete-stockroom");
    expect(sourceTabKeys(NET)).not.toContain("loc:hub9");
  });
  it("both sections: Section 2's, then Section 1's hubs and shops, then history", () => {
    expect(keys(sourceTabsFor(NET, see([1, 2])))).toEqual([
      "hub1refill", "clothing", "trophy", "marathonpe",
      "loc:hub3", "loc:marathon-pine", "loc:concrete", "refillhistory",
    ]);
  });
  it("a Section 1 account sees only Section 1's lanes", () => {
    expect(keys(sourceTabsFor(NET, see([1])))).toEqual(["loc:hub3", "loc:marathon-pine", "loc:concrete", "refillhistory"]);
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
