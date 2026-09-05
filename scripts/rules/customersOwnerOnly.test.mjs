// ── The rules patch, as a pure function ──────────────────────────────────────
// The emulator suite (customers-rules.test.mjs) proves what the rules DO. This
// one proves what the patch TOUCHES — that it edits three keys and carries the
// other 69 nodes of the live document through byte-for-byte, and that it
// refuses rather than guessing when the live shape is not what it expects.
// Both matter: a patch that is correct and also silently drops /shopify_sync's
// read lock would ship a security regression inside a security fix.
import { describe, it, expect } from "vitest";
import {
  patchCustomersRules, patchOrdersIndex,
  CUSTOMER_RECORD_WRITE, EXPECTED_CUSTOMERS_WRITE,
  EXPECTED_ORDERS_INDEX, NEXT_ORDERS_INDEX,
} from "./customersOwnerOnly.mjs";

const liveish = () => ({
  rules: {
    customers: {
      ".read": "auth != null && (root.child('users').child(auth.uid).exists() || auth.token.email === 'gunidmoh@gmail.com')",
      ".write": EXPECTED_CUSTOMERS_WRITE,
      $customerId: {
        ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
        storeCredit: { $creditId: { remainingAmount: { ".validate": "newData.isNumber()" } } },
      },
    },
    orders: { ".read": "auth != null", ".indexOn": [...EXPECTED_ORDERS_INDEX] },
    shopify_sync: { ".read": false, ".write": false },
    somethingElse: { ".read": true },
  },
});

describe("patchCustomersRules", () => {
  it("moves the grant down and narrows it", () => {
    const out = patchCustomersRules(liveish());
    expect(out.rules.customers[".write"]).toBeUndefined();
    expect(out.rules.customers.$customerId[".write"]).toBe(CUSTOMER_RECORD_WRITE);
  });

  it("changes NOTHING else — the read, the validate, the unrelated nodes", () => {
    const before = liveish();
    const out = patchCustomersRules(before);
    const strip = (r) => {
      const c = JSON.parse(JSON.stringify(r));
      delete c.rules.customers[".write"];
      delete c.rules.customers.$customerId[".write"];
      return c;
    };
    expect(strip(out)).toEqual(strip(liveish()));
    expect(out.rules.shopify_sync).toEqual({ ".read": false, ".write": false });
  });

  it("does not mutate its input", () => {
    const input = liveish();
    patchCustomersRules(input);
    expect(input.rules.customers[".write"]).toBe(EXPECTED_CUSTOMERS_WRITE);
  });

  it("REFUSES when the live .write is not the one it means to replace", () => {
    const doc = liveish();
    doc.rules.customers[".write"] = "auth != null";  // someone already changed it
    expect(() => patchCustomersRules(doc)).toThrow(/not the rule this patch expects/);
  });

  it("REFUSES when $customerId already carries a .write", () => {
    const doc = liveish();
    doc.rules.customers.$customerId[".write"] = "true";
    expect(() => patchCustomersRules(doc)).toThrow(/already has a \.write/);
  });

  it("REFUSES a document with no /customers node at all", () => {
    expect(() => patchCustomersRules({ rules: {} })).toThrow(/no \/customers node/);
  });
});

describe("patchOrdersIndex", () => {
  it("appends customerId and leaves the existing entries in place", () => {
    expect(patchOrdersIndex(liveish()).rules.orders[".indexOn"]).toEqual(NEXT_ORDERS_INDEX);
    expect(NEXT_ORDERS_INDEX.slice(0, 2)).toEqual(EXPECTED_ORDERS_INDEX);
  });

  it("is idempotent — a second run is a no-op, not a refusal", () => {
    const once = patchOrdersIndex(liveish());
    expect(patchOrdersIndex(once).rules.orders[".indexOn"]).toEqual(NEXT_ORDERS_INDEX);
  });

  it("REFUSES an index it does not recognise, rather than overwriting a decision", () => {
    const doc = liveish();
    doc.rules.orders[".indexOn"] = ["destShop"];   // someone dropped one
    expect(() => patchOrdersIndex(doc)).toThrow(/not the array this patch expects/);
  });

  it("touches nothing but the array", () => {
    const out = patchOrdersIndex(liveish());
    expect(out.rules.orders[".read"]).toBe("auth != null");
    expect(out.rules.customers).toEqual(liveish().rules.customers);
  });
});
