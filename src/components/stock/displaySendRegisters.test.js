// A Display Refill send registers the display, at every store, so the sale that
// follows closes it (Junid, 9 Nov 2026, his 24 Sep spec).
//
// The row comes from the client's real sendPlan and goes into the real decisions
// of closeDisplayRowOnSale (functions/displayRows/lib.cjs), so a change to either
// side is seen here. Those functions cannot import src/; this side can require them.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendPlan, displayRowHubs, rowPath } from "./displayRowCore";
import { SEED_REGISTRY, normalizeNetwork } from "../../utils/networkRegistry";

const require = createRequire(import.meta.url);
const lib = require("../../../functions/displayRows/lib.cjs");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, "../../App.jsx"), "utf8");

const SENT = "2026-11-09T09:00:00.000Z";
const SALE = "2026-11-09T12:00:00.000Z";
const NOW = Date.parse(SALE) + 30_000;

// What Send writes, as the trigger would read it back.
function sentRow(store, bookedHub, productId = "p1", size = "9") {
  const plan = sendPlan({ rows: {}, store, productId, productName: "Shoe", size, bookedHub, rowId: "r1", at: SENT, by: "u1", orderId: "042", requestedAt: SENT });
  expect(plan.ok).toBe(true);
  return plan.updates[rowPath(store, productId, "r1")];
}
const soldAt = (from) => ({ type: "sold", from, productId: "p1", size: "9", qty: 1, ts: SALE });

describe("the send opens a row for that shop and size", () => {
  it.each([["concrete", "hub3"], ["marathon-pine", "hub3"], ["marathon-pe", "hub1"], ["trophy", "hub2"]])("%s, from %s", (store, hub) => {
    const row = sentRow(store, hub);
    expect(row).toMatchObject({ status: "open", store, productId: "p1", sizeKey: "9", bookedHub: hub, openedVia: "send", requestOrderId: "042" });
    expect(lib.rowIsOpen(row)).toBe(true);
  });
});

describe("a sent display closes on sale", () => {
  it("Concrete: the Hub 3 sale that empties the size closes the row sent to Concrete", () => {
    const row = sentRow("concrete", "hub3");
    const hit = lib.classifyMovement(soldAt("hub3"), SEED_REGISTRY);
    expect(hit).toMatchObject({ kind: "sold_hub", hub: "hub3" });
    expect(lib.displayStoresForHub(SEED_REGISTRY, "hub3")).toContain("concrete");
    const { closable, hubless, postSale, unknownAge } = lib.splitByHub(
      lib.decideCloses({ r1: row }, hit.sizeKey, Number.MAX_SAFE_INTEGER), "hub3", SALE);
    expect(closable.map((c) => c.rowId)).toEqual(["r1"]);
    expect([hubless.length, postSale.length, unknownAge.length]).toEqual([0, 0, 0]);
    expect(lib.resolveHubSale({ openRowsByStore: { concrete: closable }, cellQty: 0, movementTs: SALE, nowMs: NOW }))
      .toMatchObject({ ok: true, store: "concrete", rowId: "r1" });
  });
  it("Concrete: a sale off Concrete's own shelf closes the row too", () => {
    const hit = lib.classifyMovement(soldAt("concrete"), SEED_REGISTRY);
    expect(hit).toMatchObject({ kind: "sold", store: "concrete" });
    expect(lib.decideCloses({ r1: sentRow("concrete", "hub3") }, hit.sizeKey, 1, SALE).map((c) => c.rowId)).toEqual(["r1"]);
  });
  it("Marathon PE: the till's sale off the shop closes the row", () => {
    const hit = lib.classifyMovement(soldAt("marathon-pe"), SEED_REGISTRY);
    expect(hit).toMatchObject({ kind: "sold", store: "marathon-pe" });
    expect(lib.decideCloses({ r1: sentRow("marathon-pe", "hub1") }, hit.sizeKey, 1, SALE).map((c) => c.rowId)).toEqual(["r1"]);
  });
  it("Marathon PE: the Hub 1 sale that empties the size closes the row sent to Marathon PE", () => {
    const row = sentRow("marathon-pe", "hub1");
    const hit = lib.classifyMovement(soldAt("hub1"), SEED_REGISTRY);
    const { closable } = lib.splitByHub(lib.decideCloses({ r1: row }, hit.sizeKey, Number.MAX_SAFE_INTEGER), "hub1", SALE);
    expect(lib.resolveHubSale({ openRowsByStore: { "marathon-pe": closable }, cellQty: 0, movementTs: SALE, nowMs: NOW }))
      .toMatchObject({ ok: true, store: "marathon-pe", rowId: "r1" });
  });
  it("the size must match: a different size sold closes nothing", () => {
    const hit = lib.classifyMovement({ ...soldAt("concrete"), size: "10" }, SEED_REGISTRY);
    expect(lib.decideCloses({ r1: sentRow("concrete", "hub3") }, hit.sizeKey, 1, SALE)).toEqual([]);
  });
  it("a hub sale that leaves stock in the size stays refused, as it is at Hub 1 and Hub 2", () => {
    const row = sentRow("concrete", "hub3");
    const { closable } = lib.splitByHub(lib.decideCloses({ r1: row }, "9", Number.MAX_SAFE_INTEGER), "hub3", SALE);
    expect(lib.resolveHubSale({ openRowsByStore: { concrete: closable }, cellQty: 2, movementTs: SALE, nowMs: NOW }).ok).toBe(false);
  });
});

describe("which sends open a row", () => {
  it("Hub 1, Hub 2 and Hub 3 in service; the Marathon pair whatever the registry says", () => {
    expect(displayRowHubs(SEED_REGISTRY).sort()).toEqual(["hub1", "hub2", "hub3"]);
    const off = normalizeNetwork({ locations: { hub3: { solve: false } } });
    expect(displayRowHubs(off)).toContain("hub1");
    expect(displayRowHubs(off)).toContain("hub2");
    expect(displayRowHubs(off)).not.toContain("hub3");
  });
  it("Send asks that list, for the row and for the booked hub", () => {
    const i = APP.indexOf("  const setDisplayRefillStatus = async");
    const fn = APP.slice(i, APP.indexOf("  const undoDisplayRefill = async", i));
    expect(fn).toContain("const rowHubs = displayRowHubs(whNet);");
    expect(fn).toContain(".find((h) => rowHubs.includes(h)) || selectedHub || null;");
    expect(fn).toContain("&& rowHubs.includes(rowHub);");
    expect(fn).not.toContain("GATED_SNEAKER_HUBS");
  });
});
