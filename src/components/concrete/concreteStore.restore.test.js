// restoreMarathonListing: only an off the Concrete mark itself caused is undone,
// through a transaction on /shopify_publish (never the Concrete node).
import { describe, it, expect, vi, beforeEach } from "vitest";

let node = null;
const txnPaths = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  update: vi.fn(async () => {}), get: vi.fn(async () => ({ val: () => null })),
  query: (r) => r, orderByChild: () => ({}), equalTo: () => ({}),
  runTransaction: async (r, fn) => { txnPaths.push(r.path); fn(null); const next = fn(node); if (next === undefined) return { committed: false, snapshot: { val: () => node } }; node = next; return { committed: true, snapshot: { val: () => node } }; },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../offline/pendingWrites", () => ({ notePendingUpdate: () => 0 }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1795200000000 }));
const { restoreMarathonListing } = await import("./concreteStore.js");

beforeEach(() => { txnPaths.length = 0; });
describe("restoreMarathonListing", () => {
  it("turns back on a Marathon listing the Concrete mark took off", async () => {
    node = { state: "live", liveState: "off", desiredState: "off", condition: "Excellent — no visible wear", lastOff: { reasonCode: "concrete_only", at: 1, actor: "script:reconcile" } };
    const r = await restoreMarathonListing("p1");
    expect(r).toEqual({ ok: true, restored: true });
    expect(node.desiredState).toBe("on");
    expect(txnPaths).toEqual(["shopify_publish/p1"]);
  });
  it("leaves any other off alone", async () => {
    node = { state: "live", desiredState: "off", condition: "Excellent — no visible wear", lastOff: { reasonCode: "switched_off", at: 1, actor: "u2" } };
    expect(await restoreMarathonListing("p1")).toEqual({ ok: true, restored: false });
    expect(node.desiredState).toBe("off");
  });
  it("a product with no Marathon node stays without one", async () => {
    node = null;
    expect(await restoreMarathonListing("p1")).toEqual({ ok: true, restored: false });
    expect(node).toBeNull();
  });
});
