// ─── STOCK HOLD CORE — shipment identity, grouping, gating ───────────────────
// THE BATCH IS THE SHIPMENT: everything fulfilled between one release window
// and the next is ONE physical box, identified by the window at which it is
// released (SA date + wall-clock). These pins are what "at most two shipments
// pend and each is one tap" rests on.

import { describe, it, expect } from "vitest";
import { parseReleaseTimes } from "./releaseWindows";
import {
  holdActive, shipmentIdFor, nextShipmentAfter, shipmentReleaseMs,
  groupShipments, oldestPendingMs, shipmentTitle,
} from "./stockHoldCore";

const WINDOWS = parseReleaseTimes(["06:00", "14:00"]);
const SA = (iso) => Date.parse(iso);   // helpers below pass explicit UTC instants

describe("shipmentIdFor — the window bucketing", () => {
  it("a fulfil between 06:00 and 14:00 SA ships at 14:00 the same day", () => {
    // 10:00 SA = 08:00 UTC
    const s = shipmentIdFor(SA("2026-08-12T08:00:00.000Z"), WINDOWS);
    expect(s.id).toBe("2026-08-12_1400");
    expect(s.label).toBe("14:00");
  });

  it("a fulfil after 14:00 SA ships at 06:00 the NEXT day", () => {
    // 15:30 SA = 13:30 UTC
    const s = shipmentIdFor(SA("2026-08-12T13:30:00.000Z"), WINDOWS);
    expect(s.id).toBe("2026-08-13_0600");
  });

  it("a fulfil before 06:00 SA ships at 06:00 the same day", () => {
    // 05:00 SA = 03:00 UTC
    const s = shipmentIdFor(SA("2026-08-12T03:00:00.000Z"), WINDOWS);
    expect(s.id).toBe("2026-08-12_0600");
  });

  it("two fulfils inside one window share the shipment; across a window they split", () => {
    const a = shipmentIdFor(SA("2026-08-12T05:00:00.000Z"), WINDOWS);  // 07:00 SA
    const b = shipmentIdFor(SA("2026-08-12T09:59:00.000Z"), WINDOWS);  // 11:59 SA
    const c = shipmentIdFor(SA("2026-08-12T12:01:00.000Z"), WINDOWS);  // 14:01 SA
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(b.id);
  });

  it("disabled windows mean no shipment (holding degrades to instant)", () => {
    expect(shipmentIdFor(SA("2026-08-12T08:00:00.000Z"), parseReleaseTimes(false))).toBeNull();
  });

  it("ids are key-safe and lexically time-ordered", () => {
    const a = shipmentIdFor(SA("2026-08-12T08:00:00.000Z"), WINDOWS);
    const b = shipmentIdFor(SA("2026-08-12T13:30:00.000Z"), WINDOWS);
    expect(a.id < b.id).toBe(true);
    expect(a.id).not.toMatch(/[.#$/\[\]\s:]/);
  });

  it("shipmentReleaseMs round-trips the id", () => {
    const s = shipmentIdFor(SA("2026-08-12T08:00:00.000Z"), WINDOWS);
    expect(shipmentReleaseMs(s.id)).toBe(s.releaseMs);
  });
});

describe("nextShipmentAfter — the not-arrived carry", () => {
  it("carries to the window AFTER the departing shipment", () => {
    const ship = { shipmentId: "2026-08-12_1400", releaseMs: shipmentReleaseMs("2026-08-12_1400") };
    // Releasing at 14:20 SA (12:20 UTC): the carry goes to tomorrow 06:00.
    const next = nextShipmentAfter(ship, SA("2026-08-12T12:20:00.000Z"), WINDOWS);
    expect(next.id).toBe("2026-08-13_0600");
  });

  it("an EARLY release (box beat the window) still carries FORWARD, never into itself", () => {
    const ship = { shipmentId: "2026-08-12_1400", releaseMs: shipmentReleaseMs("2026-08-12_1400") };
    // Releasing at 13:00 SA, an hour before the window.
    const next = nextShipmentAfter(ship, SA("2026-08-12T11:00:00.000Z"), WINDOWS);
    expect(next.id).toBe("2026-08-13_0600");
  });
});

describe("holdActive — all four legs must agree", () => {
  const config = { enabled: true };
  it("holds central→hub (cross-building) when switched on", () => {
    expect(holdActive({ config, windows: WINDOWS, from: "central", to: "hub1" })).toBe(true);
    expect(holdActive({ config, windows: WINDOWS, from: "central", to: "hub2" })).toBe(true);
  });
  it("KILL SWITCH: absent or false config restores instant behaviour", () => {
    expect(holdActive({ config: null, windows: WINDOWS, from: "central", to: "hub1" })).toBe(false);
    expect(holdActive({ config: { enabled: false }, windows: WINDOWS, from: "central", to: "hub1" })).toBe(false);
  });
  it("same-building legs never hold (hub2→store is not a box on a truck)", () => {
    expect(holdActive({ config, windows: WINDOWS, from: "hub2", to: "marathon-pe" })).toBe(false);
  });
  it("windows off = nothing to batch around = instant", () => {
    expect(holdActive({ config, windows: parseReleaseTimes(false), from: "central", to: "hub1" })).toBe(false);
  });
});

describe("groupShipments — the release card's rows", () => {
  const held = {
    hub2: {
      rrf_a: { productId: "p1", productName: "B", size: "6", sizeKey: "6", qty: 2, shipmentId: "2026-08-12_1400", windowLabel: "14:00" },
      rrf_b: { productId: "p2", productName: "A", size: "8", sizeKey: "8", qty: 1, shipmentId: "2026-08-12_1400", windowLabel: "14:00" },
      rrf_c: { productId: "p3", productName: "C", size: "9", sizeKey: "9", qty: 3, shipmentId: "2026-08-13_0600", windowLabel: "06:00" },
    },
    hub1: {
      rrf_d: { productId: "p4", productName: "D", size: "7", sizeKey: "7", qty: 1, shipmentId: "2026-08-12_1400", windowLabel: "14:00" },
    },
  };
  const now = SA("2026-08-13T10:00:00.000Z"); // 12:00 SA next day — both windows passed

  it("groups by (shipment, dest), oldest first, with line and unit totals", () => {
    const rows = groupShipments(held, now);
    expect(rows.map((r) => r.key)).toEqual(["2026-08-12_1400|hub1", "2026-08-12_1400|hub2", "2026-08-13_0600|hub2"]);
    const h2 = rows.find((r) => r.key === "2026-08-12_1400|hub2");
    expect(h2.lines).toHaveLength(2);
    expect(h2.units).toBe(3);
  });

  it("the age of the oldest pending shipment is loud and computed from its window", () => {
    const rows = groupShipments(held, now);
    const worst = oldestPendingMs(rows, now);
    // 14:00 SA on the 12th → 12:00 SA on the 13th = 22h overdue
    expect(Math.round(worst / 3600e3)).toBe(22);
  });

  it("the row reads like the spec: window · date · lines · units · hub", () => {
    const rows = groupShipments(held, now);
    const h2 = rows.find((r) => r.key === "2026-08-12_1400|hub2");
    expect(shipmentTitle(h2, (d) => ({ hub1: "Hub 1", hub2: "Hub 2" }[d] || d)))
      .toBe("14:00 shipment · 12 Aug · 2 lines · 3 units · Hub 2");
  });
});
