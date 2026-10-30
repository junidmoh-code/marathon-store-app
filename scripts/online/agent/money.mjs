// ── Store credit and refunds on Shopify ─────────────────────────────────────
// Each needs an Admin API scope the app may not have been granted:
//   store credit  write_store_credit_account_transactions
//   refund        write_orders
// The scopes are READ from the token at run time (currentAppInstallation), so
// the moment Junid approves them the API path is used — no code change. Until
// then the action is emailed to Junid with the exact order and amount.
//
// A MUTATION IS NEVER RETRIED. The client throws on a 5xx for a mutation (it
// may have applied); the caller records the slot as failed and tells Junid.

export const CREDIT_SCOPE = "write_store_credit_account_transactions";
export const REFUND_SCOPE = "write_orders";

export async function grantedScopes(graphql) {
  const d = await graphql(`{ currentAppInstallation { accessScopes { handle } } }`);
  return new Set((d.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
}

const money = (cents) => (Number(cents) / 100).toFixed(2);

/** → { ok: true, id } | { ok: false, error } */
export async function issueStoreCredit(graphql, { orderGid, amountCents, currency = "ZAR" }) {
  const o = await graphql(`query ($id: ID!) { order(id: $id) { id customer { id } } }`, { id: orderGid });
  const customerId = o.order?.customer?.id;
  if (!customerId) return { ok: false, error: "the Shopify order has no customer account to credit" };
  const d = await graphql(
    `mutation ($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction { id amount { amount currencyCode } }
        userErrors { field message }
      }
    }`,
    { id: customerId, creditInput: { creditAmount: { amount: money(amountCents), currencyCode: currency } } },
    { mutation: true },
  );
  const errs = d.storeCreditAccountCredit?.userErrors ?? [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  return { ok: true, id: d.storeCreditAccountCredit?.storeCreditAccountTransaction?.id ?? null };
}

/**
 * The idempotency key of one line refund. API 2026-04+ (this app is on 2026-07)
 * REQUIRES @idempotent on refundCreate (Shopify changelog "Making idempotency
 * mandatory for inventory adjustments and refund mutations"; without it the
 * call fails: "The @idempotent directive is required for this mutation but was
 * not provided."). Stable for the same order, line, quantity and amount, so a
 * repeat of the same refund is the same refund on Shopify, never a second one.
 */
export const refundKey = ({ orderGid, lineItemId, quantity, cents }) =>
  `refund-line-${String(orderGid).split("/").pop()}-${String(lineItemId).split("/").pop()}-q${quantity}-${cents}`;

/**
 * The key the customer agent passes (run.mjs money()): ONE refund per money
 * slot. The slot is the app line (one Shopify line item can be split over
 * several app lines, poll.mjs routeLines, each owed its own refund) and the
 * moment it was claimed, so it is the same on any retry of that slot and never
 * the same for two different refunds — and it does not depend on the amount
 * Shopify suggests, which changes once a refund has gone through.
 */
export const slotRefundKey = ({ orderId, lineIndex, claimedAt }) => `refund-slot-${orderId}-${lineIndex}-${claimedAt}`;

/**
 * Refund ONE line through the order's own gateway (Payfast, via Shopify). The
 * amount is the smaller of what we owe and what Shopify suggests for that
 * line — never more than either. → { ok: true, id, amountCents } | { ok: false, error }
 */
export async function refundLine(graphql, { orderGid, lineItemId, quantity, amountCents, idempotencyKey = null }) {
  const s = await graphql(
    `query ($id: ID!, $items: [RefundLineItemInput!]) {
      order(id: $id) {
        id
        suggestedRefund(refundLineItems: $items) {
          amountSet { shopMoney { amount currencyCode } }
          suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } }
        }
      }
    }`,
    { id: orderGid, items: [{ lineItemId, quantity }] },
  );
  const sr = s.order?.suggestedRefund;
  const tx = sr?.suggestedTransactions?.[0];
  if (!tx?.parentTransaction?.id) return { ok: false, error: "Shopify suggests no refundable payment for this line" };
  const suggested = Math.round(Number(sr.amountSet?.shopMoney?.amount) * 100);
  const pay = Math.min(amountCents, suggested);
  if (!(pay > 0)) return { ok: false, error: "nothing refundable on this line" };
  const d = await graphql(
    `mutation ($input: RefundInput!, $key: String!) {
      refundCreate(input: $input) @idempotent(key: $key) { refund { id } userErrors { field message } }
    }`,
    { key: idempotencyKey || refundKey({ orderGid, lineItemId, quantity, cents: pay }), input: {
      orderId: orderGid,
      notify: true,
      refundLineItems: [{ lineItemId, quantity, restockType: "NO_RESTOCK" }],
      transactions: [{ orderId: orderGid, gateway: tx.gateway, kind: "REFUND", amount: money(pay), parentId: tx.parentTransaction.id }],
    } },
    { mutation: true },
  );
  const errs = d.refundCreate?.userErrors ?? [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  return { ok: true, id: d.refundCreate?.refund?.id ?? null, amountCents: pay };
}
