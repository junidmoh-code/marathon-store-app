// ─── ONE HUB VOCABULARY, BOTH ENDS ───────────────────────────────────────────
// The server builds a notification's link (functions/lib/push-hubs.cjs) and
// this app decides whether to open it (src/push/pushHubs.js). If the two ever
// disagree about what a hub is, the link silently drops its hub and lands the
// reader on whichever hub they last used. So the two modules are RUN against
// each other here, over the built-in registry and over registries that differ
// from it — not compared as text.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { SEED_REGISTRY, normalizeNetwork } from "../utils/networkRegistry";
import * as client from "./pushHubs";
import { hubLabel as configLabel } from "./pushConfig";
import { applyPushDeepLink } from "./deepLink";
import { setCurrentNetworkFromRaw, __resetNetworkForTests } from "../utils/networkStore";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/push-hubs.cjs");
const serverPush = require("../../functions/lib/order-push.cjs");

const REGISTRIES = {
  seed: SEED_REGISTRY,
  none: null,
  "one more hub": normalizeNetwork({ locations: { hub4: { name: "Hub 4", type: "hub", section: 2, sort: 30 } } }),
  "a renamed hub": normalizeNetwork({ locations: { hub2: { name: "Hub Two" } } }),
  "a stored mapping to the removed Stockroom": normalizeNetwork({ backStock: { concrete: { clothing: "concrete-stockroom" } } }),
  "Hub 1 given clothing": normalizeNetwork({ backStock: { trophy: { clothing: "hub1" } } }),
};
const IDS = ["hub1", "hub2", "hub3", "hub4", "hubC", "concrete-stockroom", "central", "marathon-pe", "trophy",
  "marathon-pine", "concrete", "pe", "nonsense", "", null, undefined];

describe("the client and the server agree, registry by registry", () => {
  for (const [name, R] of Object.entries(REGISTRIES)) {
    it(name, () => {
      expect(client.pushHubsOf(R)).toEqual(server.pushHubsOf(R));
      expect(client.warehouseHubsOf(R)).toEqual(server.warehouseHubsOf(R));
      for (const id of IDS) {
        expect(client.isCrHub(R, id), `isCrHub ${id}`).toBe(server.isCrHub(R, id));
        expect(client.hubSectionOf(R, id), `hubSectionOf ${id}`).toBe(server.hubSectionOf(R, id));
        expect(client.hubLabel(R, id), `hubLabel ${id}`).toBe(server.hubLabel(R, id));
      }
    });
  }
  it("the legacy queue is the same one string on both ends", () => {
    expect([...client.LEGACY_WAREHOUSE_HUBS]).toEqual([...server.LEGACY_WAREHOUSE_HUBS]);
    expect([...client.LEGACY_WAREHOUSE_HUBS]).toEqual(["hubC"]);
  });
});

describe("what the registry says, on the built-in network", () => {
  it("every hub is a push hub; hubC is linkable and never assignable", () => {
    expect([...client.pushHubsOf(SEED_REGISTRY)].sort()).toEqual(["hub1", "hub2", "hub3"]);
    expect(client.warehouseHubsOf(SEED_REGISTRY)).toContain("hubC");
    expect(client.pushHubsOf(SEED_REGISTRY)).not.toContain("hubC");
  });
  it("CR tab: Hub 2 and Hub 3 as before; Hub 1, hubC and the removed Stockroom not", () => {
    expect(["hub1", "hub2", "hub3", "hubC", "concrete-stockroom"].map((h) => client.isCrHub(SEED_REGISTRY, h)))
      .toEqual([false, true, true, false, false]);
    // A hub stops being sneakers-only the moment the registry gives it anything else.
    expect(client.isCrHub(REGISTRIES["Hub 1 given clothing"], "hub1")).toBe(true);
  });
  it("the labels are the words the typed map held", () => {
    const was = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central",
      "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine" };
    for (const [id, words] of Object.entries(was)) expect(configLabel(id), id).toBe(words);
    expect(configLabel("concrete-stockroom")).toBe("concrete-stockroom");   // removed 8 Oct 2026: unknown, shown as its id
  });
});

describe("EVERY LINK THE SERVER CAN BUILD IS ONE THIS APP OPENS, and no other hub is", () => {
  const io = (search) => {
    const store = new Map();
    return {
      store,
      io: {
        nowMs: 1,
        window: { location: { search, href: `https://x.test/${search}`, pathname: "/", hash: "" }, history: { replaceState() {} } },
        localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      },
    };
  };

  it("on the built-in registry", () => {
    __resetNetworkForTests();
    for (const hub of IDS.filter((h) => typeof h === "string" && h)) {
      const link = serverPush.orderLink({ orderId: "005", createdAt: "2026-09-06T07:07:41.633Z", hub, tab: "queue" }, 1);
      const f = io(`?push=order&hub=${encodeURIComponent(hub)}&tab=queue`);
      const applied = applyPushDeepLink(f.io);
      if (link === "/") {
        expect(applied.hub, `${hub} must be refused by the client too`).toBe(null);
        expect(f.store.has("warehouseHub")).toBe(false);
      } else {
        expect(applied.hub, hub).toBe(hub);
        expect(f.store.get("warehouseHub")).toBe(hub);
      }
    }
  });

  it("a hub that exists only in the LIVE registry opens once the registry is in; before that it is dropped", () => {
    __resetNetworkForTests();
    const raw = { locations: { hub4: { name: "Hub 4", type: "hub", section: 2, sort: 30 } } };
    expect(applyPushDeepLink(io("?push=order&hub=hub4&tab=queue").io).hub).toBe(null);
    setCurrentNetworkFromRaw(raw);
    expect(applyPushDeepLink(io("?push=order&hub=hub4&tab=queue").io).hub).toBe("hub4");
    expect(serverPush.orderLink({ orderId: "1", createdAt: "x", hub: "hub4", tab: "queue" }, 2, normalizeNetwork(raw)))
      .toBe("/?push=order&hub=hub4&tab=queue");
    __resetNetworkForTests();
  });

  it("Hub 3 opens; the removed Stockroom, a store, Central or an alias never sets a warehouse hub", () => {
    __resetNetworkForTests();
    expect(applyPushDeepLink(io("?push=order&hub=hub3&tab=clothing").io))
      .toEqual({ role: "warehouse", hub: "hub3", tab: "clothing", order: null });
    for (const notAHub of ["concrete-stockroom", "marathon-pe", "concrete", "central", "Hub 2", "hub 2", "pe", "in_transit"]) {
      const f = io(`?push=order&hub=${encodeURIComponent(notAHub)}&tab=queue`);
      expect(applyPushDeepLink(f.io).hub, notAHub).toBe(null);
      expect(f.store.has("warehouseHub")).toBe(false);
    }
  });
});
