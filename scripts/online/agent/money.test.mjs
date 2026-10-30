// refundCreate needs @idempotent at API 2026-04+ (live error in Jimmy, 27 Oct 2026). All fakes: no Shopify call leaves.
import { describe, it, expect } from "vitest";
import { refundLine, refundKey } from "./money.mjs";
import { API_VERSION } from "../../shopify/client.mjs";

const ORDER = "gid://shopify/Order/18970741637269";
const LINE = "gid://shopify/LineItem/555";
function fake() {
  const calls = [];
  const graphql = async (q, v, opts) => {
    calls.push({ q, v, opts });
    if (/suggestedRefund/.test(q)) return { order: { id: v.id, suggestedRefund: { amountSet: { shopMoney: { amount: "599.0", currencyCode: "ZAR" } }, suggestedTransactions: [{ gateway: "Payfast", kind: "REFUND", amountSet: { shopMoney: { amount: "599.0" } }, parentTransaction: { id: "gid://shopify/OrderTransaction/1" } }] } } };
    if (/refundCreate/.test(q)) {
      if (!/refundCreate\([^)]*\)\s*@idempotent\(key: \$key\)/.test(q) || !v.key) throw new Error('GraphQL errors: [{"message":"The @idempotent directive is required for this mutation but was not provided."}]');
      return { refundCreate: { refund: { id: "gid://shopify/Refund/9" }, userErrors: [] } };
    }
    throw new Error(`unexpected ${q.slice(0, 40)}`);
  };
  return { calls, graphql };
}

describe("refundLine @idempotent (API 2026-04+)", () => {
  it("the app is on a version that requires it", () => {
    expect(API_VERSION >= "2026-04").toBe(true);
  });
  it("sends refundCreate with @idempotent and a stable key; the amount is unchanged", async () => {
    const f = fake();
    const r = await refundLine(f.graphql, { orderGid: ORDER, lineItemId: LINE, quantity: 1, amountCents: 59900 });
    expect(r).toEqual({ ok: true, id: "gid://shopify/Refund/9", amountCents: 59900 });
    const m = f.calls.find((c) => /refundCreate/.test(c.q));
    expect(m.q).toMatch(/mutation \(\$input: RefundInput!, \$key: String!\)/);
    expect(m.v.key).toBe("refund-line-18970741637269-555-q1-59900");
    expect(m.v.input.transactions).toEqual([{ orderId: ORDER, gateway: "Payfast", kind: "REFUND", amount: "599.00", parentId: "gid://shopify/OrderTransaction/1" }]);
    expect(m.opts).toEqual({ mutation: true });
  });
  it("the same refund twice has the same key (one refund on Shopify); another amount or line has another", async () => {
    const a = refundKey({ orderGid: ORDER, lineItemId: LINE, quantity: 1, cents: 59900 });
    expect(refundKey({ orderGid: ORDER, lineItemId: LINE, quantity: 1, cents: 59900 })).toBe(a);
    expect(refundKey({ orderGid: ORDER, lineItemId: LINE, quantity: 1, cents: 50000 })).not.toBe(a);
    expect(refundKey({ orderGid: ORDER, lineItemId: "gid://shopify/LineItem/556", quantity: 1, cents: 59900 })).not.toBe(a);
  });
  it("a caller's own key is used as given", async () => {
    const f = fake();
    await refundLine(f.graphql, { orderGid: ORDER, lineItemId: LINE, quantity: 1, amountCents: 10000, idempotencyKey: "slot-42" });
    expect(f.calls.find((c) => /refundCreate/.test(c.q)).v.key).toBe("slot-42");
  });
});

// Spec review of PR #807: one Shopify line item can be split over several app
// lines (poll.mjs routeLines). A content-only key (order, line item, qty,
// cents) is then the SAME for two different refunds, and Shopify would replay
// the first instead of paying the second. money() keys each refund by its slot.
describe("money() keys each refund by its own slot", () => {
  it("two app lines on ONE Shopify line item get two different keys, so both are paid", async () => {
    const { fakeDb, increment } = await import("../../shopify/onlineOrders/fakeDb.testutil.mjs");
    const { money } = await import("./run.mjs");
    const NOW = Date.parse("2026-10-22T10:00:00Z");
    const piece = (lineId) => ({ lineId, shopifyLineItemId: "gid://shopify/LineItem/2", pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee", unitPriceCents: 59900, source: { status: "unavailable" } });
    const f = fakeDb({ online_orders: { 9001: { ref: "LEV", orderNumber: 1801, shopifyGid: ORDER, shopifyName: "#1801", customer: { name: "T", email: "t@example.com" }, totals: { currency: "ZAR" }, lines: [piece("l0"), piece("l1")] } } });
    const g = fake();
    const ctx = {
      db: f.db, increment, get: async (p) => f.read(p), now: NOW, log: () => {}, summary: { credits: 0, refunds: 0, junid: 0 },
      mailer: async () => {}, notifyJunid: async () => {}, scopes: async () => new Set(["write_orders"]), graphql: g.graphql,
    };
    const order = f.read("online_orders/9001");
    const a = await money(ctx, "9001", order, 0, f.read("online_orders/9001/lines/0"), "refund", 59900, "test");
    const b = await money(ctx, "9001", order, 1, f.read("online_orders/9001/lines/1"), "refund", 59900, "test");
    expect(a.state).toBe("done");
    expect(b.state).toBe("done");
    const keys = g.calls.filter((c) => /refundCreate/.test(c.q)).map((c) => c.v.key);
    expect(keys).toEqual([`refund-slot-9001-0-${NOW}`, `refund-slot-9001-1-${NOW}`]);
    // A resume of the same slot never calls Shopify again (one refund per slot).
    await money(ctx, "9001", order, 0, f.read("online_orders/9001/lines/0"), "refund", 59900, "test");
    expect(g.calls.filter((c) => /refundCreate/.test(c.q))).toHaveLength(2);
  });
});
