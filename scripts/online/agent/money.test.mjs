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
