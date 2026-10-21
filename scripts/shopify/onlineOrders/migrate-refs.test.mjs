import { describe, it, expect } from "vitest";
import { migrateRefs } from "./migrate-refs.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";

const seq = (s) => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; const d = [...s].map((c) => (A.indexOf(c) + 0.5) / 24); let i = 0; return () => d[i++ % d.length]; };
const world = () => ({
  online_orders: {
    18960504520853: { ref: "WEB-1768", orderNumber: 1768, status: "new",
      lines: [{ pid: "CAP", sizeKey: "_", qty: 1, source: { status: "display", entryKey: "displayChecks_active/marathon-pe/online__18960504520853__0" } }] },
    18960491249813: { ref: "WEB-1767", orderNumber: 1767, status: "cancelled", lines: [] },
    18960000000001: { ref: "WEB-1769", orderNumber: 1769, status: "picking",
      lines: [{ pid: "SNK", sizeKey: "8", qty: 1, source: { status: "pick", locationId: "hub1", entryKey: "online_picks/18960000000001_0" } }] },
    1: { ref: "ABC", status: "new", lines: [] },
  },
  online_reservations: { CAP: { _: { 18960504520853: { qty: 1, ref: "WEB-1768" } } } },
  displayChecks_active: { "marathon-pe": { online__18960504520853__0: { kind: "online_pick", ref: "WEB-1768", status: "open" } } },
});

describe("migrate WEB-#### → code", () => {
  it("dry run changes nothing", async () => {
    const f = fakeDb(world());
    const out = await migrateRefs(f.db, { log: () => {} });
    expect(out.map((o) => o.from).sort()).toEqual(["WEB-1768", "WEB-1769"]);
    expect(f.read("online_orders/18960504520853/ref")).toBe("WEB-1768");
  });

  it("--commit recodes the OPEN order everywhere its ref was copied; cancelled and coded orders are left", async () => {
    const f = fakeDb(world());
    const out = await migrateRefs(f.db, { commit: true, now: 1, rand: seq("KQZBCD"), log: () => {} });
    expect(out.map((o) => [o.from, o.to])).toEqual([["WEB-1768", "KQZ"], ["WEB-1769", "BCD"]]); // "new" before "picking"
    expect(f.read("online_orders/18960504520853")).toMatchObject({ ref: "KQZ", orderNumber: 1768, refMigratedFrom: "WEB-1768" });
    expect(f.read("online_reservations/CAP/_/18960504520853/ref")).toBe("KQZ");
    expect(f.read("displayChecks_active/marathon-pe/online__18960504520853__0/ref")).toBe("KQZ");
    expect(f.read("online_order_refs/KQZ")).toEqual({ orderId: "18960504520853", at: 1 });
    // A hub line still linked to the retired /online_picks feed is unlinked.
    expect(f.read("online_orders/18960000000001/lines/0/source/entryKey") == null).toBe(true);
    expect(f.read("online_orders/18960491249813/ref")).toBe("WEB-1767");
    // Idempotent.
    expect(await migrateRefs(f.db, { commit: true, log: () => {} })).toEqual([]);
  });
});
