// ─── HUB 3 IN HUB COUNT & DISPLAYS — the hub → shops map, and no lists ───────
// (Junid, 7 Nov 2026.) The shops a display can stand on are the shops its hub
// FEEDS, read from the network registry's backStock map — the map Solve and
// Missing Products route by (storesServedBy). Nothing in the register path may
// keep a list of its own; the source pin below fails if one comes back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cleanupHubs, isCleanupHub, displayStores, displayStoresForHub, displayHubsForStore,
} from "./hubCleanupCore";
import { SEED_REGISTRY, storesServedBy, backStockHubsOf, sectionOf } from "../../utils/networkRegistry";
import { planMerge } from "./mergeDisposition";
import { findUnregisteredDisplays } from "./displayRecordCleanup";
import { arrivalTrust } from "./stockTrust";

const here = dirname(fileURLToPath(import.meta.url));

describe("the live mapping (seed — /network holds no node)", () => {
  it("Hub 1 and Hub 2 → Marathon PE, Trophy; Hub 3 → Marathon Pine, Concrete", () => {
    expect(displayStoresForHub("hub1")).toEqual(["marathon-pe", "trophy"]);
    expect(displayStoresForHub("hub2")).toEqual(["marathon-pe", "trophy"]);
    expect(displayStoresForHub("hub3")).toEqual(["marathon-pine", "concrete"]);
  });
  it("is the registry's own backStock answer, not a copy of it", () => {
    for (const hub of cleanupHubs(SEED_REGISTRY)) {
      expect([...displayStoresForHub(hub, SEED_REGISTRY)].sort()).toEqual(storesServedBy(SEED_REGISTRY, hub));
    }
    for (const store of displayStores(SEED_REGISTRY)) {
      expect([...displayHubsForStore(store, SEED_REGISTRY)].sort()).toEqual(backStockHubsOf(SEED_REGISTRY, store));
    }
  });
  it("never crosses the section wall", () => {
    for (const hub of cleanupHubs(SEED_REGISTRY)) {
      for (const s of displayStoresForHub(hub, SEED_REGISTRY)) expect(sectionOf(SEED_REGISTRY, s)).toBe(sectionOf(SEED_REGISTRY, hub));
    }
  });
  it("the shops' hubs: PE/Trophy ← Hub 1, Hub 2; Pine/Concrete ← Hub 3", () => {
    expect(displayHubsForStore("marathon-pe")).toEqual(["hub1", "hub2"]);
    expect(displayHubsForStore("trophy")).toEqual(["hub1", "hub2"]);
    expect(displayHubsForStore("marathon-pine")).toEqual(["hub3"]);
    expect(displayHubsForStore("concrete")).toEqual(["hub3"]);
  });
  it("a non-hub feeds nothing", () => {
    for (const id of ["central", "marathon-pe", "concrete-stockroom", "nope", null]) expect(displayStoresForHub(id)).toEqual([]);
  });
  it("the card's tabs: Hub 1, Hub 2, Hub 3", () => {
    expect(cleanupHubs()).toEqual(["hub1", "hub2", "hub3"]);
    expect(isCleanupHub("hub3")).toBe(true);
  });
});

// ── THE PIN: no hub's shops are written down anywhere in the register path ──
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
const REGISTER_PATH = ["HubCleanup.jsx", "HubCleanupCard.jsx", "hubCleanupCore.js", "hubCleanupStore.js", "displaySlots.js"];
const STORE_LITERAL = /["'`](marathon-pe|trophy|marathon-pine|pine|concrete)["'`]/;
const HUB_LITERAL = /["'`](hub1|hub2|hub3)["'`]/;

describe("no hub's shops are hardcoded in the register path", () => {
  for (const f of REGISTER_PATH) {
    it(`${f} names no shop id in code`, () => {
      const lines = strip(readFileSync(join(here, f), "utf8")).split("\n");
      expect(lines.filter((l) => STORE_LITERAL.test(l))).toEqual([]);
    });
  }
  it("the only hub id in code is the Hub 3 count-mode toggle (#858)", () => {
    for (const f of REGISTER_PATH) {
      const lines = strip(readFileSync(join(here, f), "utf8")).split("\n").filter((l) => HUB_LITERAL.test(l));
      expect(lines.map((l) => l.trim())).toEqual(f === "HubCleanup.jsx" ? ['{hub === "hub3" && canAdjust && ('] : []);
    }
  });
  it("the shop step asks displayStoresForHub(hub) — no other list feeds it", () => {
    const src = strip(readFileSync(join(here, "HubCleanup.jsx"), "utf8"));
    expect(src).toContain("{displayStoresForHub(hub).map((s) => (");
    expect(src).not.toMatch(/displayStores\(\)/);
    expect(src).not.toMatch(/DISPLAY_STORES|CLEANUP_HUBS/);
  });
});

// ── LEFTOVERS MERGE — counted location → remove, uncounted → transfer ───────
// The rule keys on the location's own count record; Hub 3's is shaped exactly
// like Hub 1's, so the same plan falls out with no hub named.
describe("the leftovers merge rule applies to Hub 3 cells", () => {
  const loserCells = { hub3: { 7: { qty: 2 }, 8: { qty: 1 } }, "marathon-pine": { 7: { qty: 1 } } };
  it("a Hub 3 size counted under the survivor is removed; the rest moves across", () => {
    const plan = planMerge({
      loserId: "pL", survivorId: "pS", loserCells,
      countedByLoc: { hub3: new Set(["pS::7"]) },
    });
    const h3 = plan.find((p) => p.loc === "hub3");
    expect(h3.remove).toEqual([{ sizeKey: "7", qty: 2 }]);
    expect(h3.transfer).toEqual([{ sizeKey: "8", qty: 1 }]);
    expect(plan.find((p) => p.loc === "marathon-pine").transfer).toEqual([{ sizeKey: "7", qty: 1 }]);
  });
  it("Hub 3 not counted → everything transfers, exactly like an uncounted Hub 1", () => {
    const h3 = planMerge({ loserId: "pL", survivorId: "pS", loserCells, countedByLoc: {} }).find((p) => p.loc === "hub3");
    const h1 = planMerge({ loserId: "pL", survivorId: "pS", loserCells: { hub1: loserCells.hub3 }, countedByLoc: {} })[0];
    expect(h3.transfer).toEqual(h1.transfer);
    expect(h3.remove).toEqual([]);
  });
});

// ── DISPLAY RECORDS — Pine's slots are Hub 3's, registerable there ──────────
describe("a Pine slot booked at hub3 is judged against Hub 3's register", () => {
  const slots = { "marathon-pine": { p9: { productId: "p9", productName: "Court Cage", size: "7", sizeKey: "7", bookedHub: "hub3", at: "2026-11-02T00:00:00Z", source: "display_refill" } } };
  it("with Hub 3's register in hand it is registerable", () => {
    const out = findUnregisteredDisplays({ slots, registerByHub: { hub3: {} }, hubs: ["hub3"], productsById: {} });
    expect(out).toHaveLength(1);
    expect(out[0].registerable).toBe(true);
  });
  it("and once registered at that size it is not listed", () => {
    const out = findUnregisteredDisplays({ slots, registerByHub: { hub3: { p9__7: { qty: 1 } } }, hubs: ["hub3"], productsById: {} });
    expect(out).toEqual([]);
  });
});

// ── TRUST — a registration never vouches for a Hub 3 cell ──────────────────
// Hub 3's Auto-refill is "solved": the engine reads trusted cells only. The
// registration's movement is a plain `received` with no refill/order link, so
// it never stamps trust (functions/test/hub3-display-baseline.test.cjs pins
// what that means for the scan).
describe("a registration movement carries no trust", () => {
  it("received with no link → arrivalTrust is null", () => {
    expect(arrivalTrust({ type: "received", to: "hub3", productId: "p", size: "7", qty: 1, reason: "display_registration" })).toBe(null);
  });
});
