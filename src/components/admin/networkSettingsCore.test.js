// What each control on the Network card writes — the smallest path, never the
// whole node — and what it refuses.
import { describe, it, expect } from "vitest";
import { normalizeNetwork } from "../../utils/networkRegistry";
import {
  liveUpdate, categoryHubUpdate, productOverrideUpdate, creditScopeUpdate, seedUpdate, categoryRows,
  POS_FLAGS, posSwitchState, posFlagUpdate, recyclerTillUpdate,
} from "./networkSettingsCore";

const R = normalizeNetwork(null);
const NOW = 1790000000000;

// Apply a multi-path update the way RTDB does, including deleting on null and
// pruning what that leaves empty.
function applyUpdate(tree, updates) {
  const out = JSON.parse(JSON.stringify(tree || {}));
  for (const [path, v] of Object.entries(updates)) {
    const parts = path.split("/");
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    if (v === null) delete node[parts.at(-1)];
    else node[parts.at(-1)] = JSON.parse(JSON.stringify(v));
  }
  const prune = (n) => {
    if (!n || typeof n !== "object") return n;
    for (const k of Object.keys(n)) {
      prune(n[k]);
      if (n[k] && typeof n[k] === "object" && !Object.keys(n[k]).length) delete n[k];
    }
    return n;
  };
  return prune(out);
}

describe("live switch", () => {
  it("writes one location's live flag and the stamp, nothing else", () => {
    const u = liveUpdate(R, "hub3", true, NOW, "owner");
    expect(u).toEqual({ ok: true, updates: { "network/locations/hub3/live": true, "network/updatedAt": NOW, "network/updatedBy": "owner" } });
  });

  it("resolves an alias to the canonical path", () => {
    expect(Object.keys(liveUpdate(R, "pine", true, NOW, "o").updates)[0]).toBe("network/locations/marathon-pine/live");
  });

  it("refuses Central, the retired locations, an unknown id and a non-boolean", () => {
    for (const id of ["central", "studio", "hub9", "in_transit"]) expect(liveUpdate(R, id, false, NOW, "o").ok).toBe(false);
    expect(liveUpdate(R, "hub3", "true", NOW, "o").ok).toBe(false);
  });

  it("flipping one location leaves every other as it was", () => {
    const tree = applyUpdate({}, seedUpdate(null, { concrete: {}, "concrete-stockroom": {} }, NOW, "o").updates);
    const after = normalizeNetwork(applyUpdate(tree, liveUpdate(R, "hub3", true, NOW, "o").updates).network);
    expect(after.locations.hub3.live).toBe(true);
    for (const id of ["marathon-pine", "concrete", "concrete-stockroom"]) expect(after.locations[id].live).toBe(false);
    for (const id of ["marathon-pe", "trophy", "hub1", "hub2"]) expect(after.locations[id].live).toBe(true);
  });
});

describe("Concrete's category mapping", () => {
  it("writes one category under Concrete", () => {
    expect(categoryHubUpdate(R, "hoodies", "concrete-stockroom", NOW, "o").updates["network/backStock/concrete/hoodies"]).toBe("concrete-stockroom");
    expect(categoryHubUpdate(R, "_default", "concrete-stockroom", NOW, "o").ok).toBe(true);
  });

  it("refuses a Section 2 hub, an unknown hub and a key RTDB cannot hold", () => {
    for (const hub of ["hub2", "hub1", "central", "nope", null]) expect(categoryHubUpdate(R, "hoodies", hub, NOW, "o").ok).toBe(false);
    for (const key of ["", "a/b", "a.b", "a#b", "a$b", "a[b", null]) expect(categoryHubUpdate(R, key, "hub3", NOW, "o").ok).toBe(false);
  });

  it("the written value is what the registry then resolves", () => {
    const tree = applyUpdate({}, categoryHubUpdate(R, "hoodies", "concrete-stockroom", NOW, "o").updates);
    const after = normalizeNetwork(tree.network);
    expect(after.backStock.concrete).toEqual({ _default: "hub3", hoodies: "concrete-stockroom" });
    expect(after.backStock["marathon-pe"]).toEqual({ _default: "hub2", sneakers: "hub1" });
  });

  it("lists the default first and marks categories that follow it", () => {
    const reg = normalizeNetwork({ backStock: { concrete: { hoodies: "concrete-stockroom" } } });
    const rows = categoryRows(reg, [{ key: "hoodies", label: "Hoodies" }, { key: "tees", label: "Tees" }, null, {}]);
    expect(rows).toEqual([
      { key: "_default", label: "Every other category", hub: "hub3", isDefault: true },
      { key: "hoodies", label: "Hoodies", hub: "concrete-stockroom", inherits: false },
      { key: "tees", label: "Tees", hub: "hub3", inherits: true },
    ]);
  });
});

describe("product override", () => {
  it("sets and clears one product", () => {
    expect(productOverrideUpdate(R, "p1", "concrete-stockroom", NOW, "o").updates["network/productOverrides/concrete/p1"]).toBe("concrete-stockroom");
    expect(productOverrideUpdate(R, "p1", null, NOW, "o").updates["network/productOverrides/concrete/p1"]).toBe(null);
  });

  it("clearing the last override leaves a node the registry still reads (RTDB deletes the empty parent)", () => {
    let tree = applyUpdate({}, productOverrideUpdate(R, "p1", "concrete-stockroom", NOW, "o").updates);
    tree = applyUpdate(tree, productOverrideUpdate(R, "p1", null, NOW, "o").updates);
    expect(tree.network.productOverrides).toBeUndefined();
    expect(normalizeNetwork(tree.network).productOverrides.concrete).toEqual({});
  });

  it("refuses a bad product id or a hub outside Section 1", () => {
    expect(productOverrideUpdate(R, "", "hub3", NOW, "o").ok).toBe(false);
    expect(productOverrideUpdate(R, "a/b", "hub3", NOW, "o").ok).toBe(false);
    expect(productOverrideUpdate(R, "p1", "hub2", NOW, "o").ok).toBe(false);
  });
});

describe("credit scope", () => {
  it("writes shared or section and refuses anything else", () => {
    expect(creditScopeUpdate("section", NOW, "o").updates["network/creditScope"]).toBe("section");
    expect(creditScopeUpdate("shared", NOW, "o").ok).toBe(true);
    expect(creditScopeUpdate("both", NOW, "o").ok).toBe(false);
  });
});

describe("first-time seed", () => {
  const LIVE_LOCATIONS = { central: {}, hub1: {}, hub2: {}, hub3: {}, "marathon-pe": {}, "marathon-pine": {}, trophy: {}, in_transit: {}, studio: {}, base: {} };

  it("writes the registry and registers ONLY the two new stock locations", () => {
    const { updates } = seedUpdate(null, LIVE_LOCATIONS, NOW, "o");
    const stockLocPaths = Object.keys(updates).filter((p) => p.startsWith("locations/"));
    expect(stockLocPaths.sort()).toEqual(["locations/concrete", "locations/concrete-stockroom"]);
    expect(updates["locations/concrete"]).toEqual({ id: "concrete", label: "Concrete", kind: "store", sellable: true, active: true });
    expect(updates["locations/concrete-stockroom"].kind).toBe("warehouse");
    const after = normalizeNetwork(applyUpdate({}, updates).network);
    expect(after).toEqual(R);
  });

  it("seeds Section 1 not live and Section 2 live", () => {
    const { updates } = seedUpdate(null, LIVE_LOCATIONS, NOW, "o");
    for (const id of ["marathon-pine", "concrete", "hub3", "concrete-stockroom"]) expect(updates[`network/locations/${id}`].live).toBe(false);
    for (const id of ["marathon-pe", "trophy", "hub1", "hub2"]) expect(updates[`network/locations/${id}`].live).toBe(true);
  });

  it("a complete registry needs nothing — a second run writes nothing", () => {
    const stored = applyUpdate({}, seedUpdate(null, LIVE_LOCATIONS, NOW, "o").updates);
    const again = seedUpdate(stored.network, { ...LIVE_LOCATIONS, ...stored.locations }, NOW, "o");
    expect(again.nothingToDo).toBe(true);
    expect(again.updates).toEqual({});
  });

  it("A LIVE FLIP MADE BEFORE SET-UP: the missing sections are filled in and the flip is kept", () => {
    // the owner tapped Hub 3 live and changed the credit scope first — /network exists, with no sections
    const early = { creditScope: "section", locations: { hub3: { live: true } }, updatedAt: 1 };
    const { updates, nothingToDo } = seedUpdate(early, { ...LIVE_LOCATIONS, concrete: {}, "concrete-stockroom": {} }, NOW, "o");
    expect(nothingToDo).toBeUndefined();
    // never touched
    expect("network/creditScope" in updates).toBe(false);
    expect("network/locations/hub3/live" in updates).toBe(false);
    expect("network/locations/hub3" in updates).toBe(false);
    // filled in — what the wall rules read
    expect(updates["network/locations/hub3/section"]).toBe(1);
    expect(updates["network/locations/hub3/type"]).toBe("hub");
    expect(updates["network/locations/hub2"].section).toBe(2);
    expect(updates["network/posStores/pe"]).toEqual({ location: "marathon-pe", section: 2 });
    const stored = applyUpdate({ network: early }, updates).network;
    const after = normalizeNetwork(stored);
    expect(after.locations.hub3.live).toBe(true);
    expect(after.creditScope).toBe("section");
    // every sectioned location now has its section STORED, which is what the rules read
    for (const id of ["marathon-pe", "trophy", "hub1", "hub2", "marathon-pine", "concrete", "hub3", "concrete-stockroom"]) {
      expect(stored.locations[id].section, id).toBe(after.locations[id].section);
    }
  });

  it("registers a missing stock location without touching a complete registry", () => {
    const stored = applyUpdate({}, seedUpdate(null, LIVE_LOCATIONS, NOW, "o").updates);
    const { updates } = seedUpdate(stored.network, { ...LIVE_LOCATIONS, concrete: {} }, NOW, "o");
    expect(Object.keys(updates).sort()).toEqual(["locations/concrete-stockroom", "network/updatedAt", "network/updatedBy"]);
  });

  it("writes no ancestor together with its descendant (RTDB rejects that update)", () => {
    const paths = Object.keys(seedUpdate(null, LIVE_LOCATIONS, NOW, "o").updates);
    for (const a of paths) for (const b of paths) if (a !== b) expect(b.startsWith(`${a}/`), `${a} ⊃ ${b}`).toBe(false);
  });
});

describe("Concrete at the till — the POS switches", () => {
  it("starts with every switch off and no recycler", () => {
    expect(posSwitchState(R, null)).toEqual({
      flags: { cashRecon: false, cashierPriceEdit: false }, recyclerTill: null,
      tills: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }],
    });
  });

  it("each switch writes ONE path under the store's pos record — the path the POS reads", () => {
    for (const f of POS_FLAGS) {
      const u = posFlagUpdate(R, f.key, true, NOW, "o");
      expect(Object.keys(u.updates).sort()).toEqual([`network/locations/concrete/pos/${f.key}`, "network/updatedAt", "network/updatedBy"].sort());
      expect(u.updates[`network/locations/concrete/pos/${f.key}`]).toBe(true);
    }
    expect(recyclerTillUpdate(R, "till-2", NOW, "o").updates["network/locations/concrete/pos/recyclerTill"]).toBe("till-2");
    // "none" is stored as false, never null: a deleted key would fall back to a built-in answer
    expect(recyclerTillUpdate(R, null, NOW, "o").updates["network/locations/concrete/pos/recyclerTill"]).toBe(false);
  });

  it("what is written is what the card then shows, and the location's own record is untouched", () => {
    let tree = applyUpdate({}, seedUpdate(null, { concrete: {}, "concrete-stockroom": {} }, NOW, "o").updates);
    tree = applyUpdate(tree, posFlagUpdate(R, "cashRecon", true, NOW, "o").updates);
    tree = applyUpdate(tree, recyclerTillUpdate(R, "till-1", NOW, "o").updates);
    const after = normalizeNetwork(tree.network);
    expect(posSwitchState(after, tree.network)).toMatchObject({ flags: { cashRecon: true, cashierPriceEdit: false }, recyclerTill: "till-1" });
    expect(after.locations.concrete).toEqual(R.locations.concrete);
    expect(after.locations.concrete.live).toBe(false);
    // turning it off again, and clearing the recycler
    tree = applyUpdate(tree, posFlagUpdate(R, "cashRecon", false, NOW, "o").updates);
    tree = applyUpdate(tree, recyclerTillUpdate(R, null, NOW, "o").updates);
    expect(posSwitchState(normalizeNetwork(tree.network), tree.network)).toMatchObject({ flags: { cashRecon: false }, recyclerTill: null });
    expect(tree.network.locations.concrete.pos.recyclerTill).toBe(false);
  });

  it("refuses an unknown switch, a non-boolean, a till the store does not have, and a non-store", () => {
    expect(posFlagUpdate(R, "live", true, NOW, "o").ok).toBe(false);
    // No Receipt Return is held as its own change: its switch cannot be set from this card
    expect(posFlagUpdate(R, "noSlipReturns", true, NOW, "o").ok).toBe(false);
    expect(posFlagUpdate(R, "cashRecon", "yes", NOW, "o").ok).toBe(false);
    expect(recyclerTillUpdate(R, "till-3", NOW, "o").ok).toBe(false);
    expect(posFlagUpdate(R, "cashRecon", true, NOW, "o", "hub3").ok).toBe(false);
    expect(recyclerTillUpdate(R, "till-1", NOW, "o", "nowhere").ok).toBe(false);
  });

  it("a recycler till the store no longer has is shown as none", () => {
    expect(posSwitchState(R, { locations: { concrete: { pos: { recyclerTill: "till-9" } } } }).recyclerTill).toBe(null);
  });
});
