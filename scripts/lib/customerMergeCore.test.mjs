// Tests for the customer phone-merge core. Every test here is PURE — the core
// module imports nothing from firebase (asserted below), and the merge is
// simulated by applying the plan's update map to a plain JS tree. NOTHING in
// this suite can write to live data.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  formatClass, canonicalSA, collapseGroups, classifyGroup, nameNorm,
  pickSurvivor, creditBalance, totalCreditAcross, buildMergePlan,
  applyUpdates, readTreePath,
} from "./customerMergeCore.mjs";

// ── fixture: one SAFE pair with money on both sides ─────────────────────────
const S = "0619467420";   // survivor (POS-created, most sales)
const L = "27619467420";  // loser (order-flow twin)
const CANON = "+27619467420";

function fixtureTree() {
  return {
    customers: {
      [S]: {
        name: "Musa", phone: "0619467420", code: "C-1200", orderCount: 1,
        firstOrderAt: "2026-07-21T09:00:00.000Z", lastOrderAt: "2026-07-21T09:00:00.000Z",
        storeCredit: { credA: { remainingAmount: 5000, issuedAt: 1755000000000 } },
        laybyHoldings: { saleS1: { balanceRemaining: 20000, dueDate: "2026-09-01", storeId: "pe", updatedAt: 1755000000000 } },
      },
      [L]: {
        name: "", phone: "+27619467420", code: "C-1300", orderCount: 3, optedIn: true,
        firstOrderAt: "2026-06-01T08:00:00.000Z", lastOrderAt: "2026-08-01T08:00:00.000Z",
        storeCredit: { credB: { remainingAmount: 2500, issuedAt: 1754000000000 } },
        laybyHoldings: { saleL1: { balanceRemaining: 15000, dueDate: "2026-08-20", storeId: "pe", updatedAt: 1754000000000 } },
      },
      "0700000001": { name: "Unrelated", phone: "0700000001", storeCredit: { credZ: { remainingAmount: 1000 } } },
    },
    pos: {
      creditLedger: {
        [S]: { balance: 5000, txns: { t1: { txnId: "t1", amount: 5000, source: "refund" } } },
        [L]: { balance: 2500, accountType: "customer", txns: { t2: { txnId: "t2", amount: 2500, source: "manual" } } },
      },
      storeCredits: {
        credA: { creditId: "credA", customerId: S, remainingAmount: 5000 },
        credB: { creditId: "credB", customerId: L, remainingAmount: 2500 },
      },
      sales: {
        saleS1: { customerId: S, total: 20000 },
        saleL1: { customerId: L, total: 15000 },
        saleL2: { customerId: L, total: 9900 },
      },
      audit: {
        store_credit_issued: { [L]: { evt1: { amount: 2500, at: "2026-08-01" } } },
      },
    },
    customer_index: { sales: { [S]: { saleS1: { amount: 20000 } }, [L]: { saleL1: { amount: 15000 }, saleL2: { amount: 9900 } } } },
    laybys: {
      saleL1: { laybyId: "saleL1", invoiceNo: "L-00118", saleId: "saleL1", customerName: "", customerPhone: L, balanceRemaining: 15000, status: "storedAtHub" },
      saleS1: { laybyId: "saleS1", invoiceNo: "L-00222", saleId: "saleS1", customerName: "Musa", customerPhone: S, balanceRemaining: 20000, status: "storedAtHub" },
    },
    laybyPulls: { pull1: { laybyId: "saleL1", invoiceNo: "L-00118", customerPhone: L, status: "requested" } },
    orders: { ord1: { customerId: L, customerPhone: "+27619467420", status: "pending" } },
  };
}

function planFromTree(tree, overrides = {}) {
  const cust = tree.customers;
  return buildMergePlan({
    canonical: CANON, survivorKey: S, loserKey: L,
    survivor: cust[S], loser: cust[L],
    survivorLedger: tree.pos.creditLedger[S], loserLedger: tree.pos.creditLedger[L],
    survivorIndex: tree.customer_index.sales[S], loserIndex: tree.customer_index.sales[L],
    loserSaleOwners: { saleL1: L, saleL2: L },
    loserCreditOwners: { credB: L },
    laybys: tree.laybys, laybyPulls: tree.laybyPulls, orders: tree.orders,
    loserAudit: { issued: tree.pos.audit.store_credit_issued[L], removed: {}, onAccount: {}, onAccountConfig: {} },
    classification: "SAFE", nowIso: "2026-08-13T20:00:00.000Z",
    mergeId: "batch1_" + L, batchId: "batch1",
    ...overrides,
  });
}

// ── canonical identity ──────────────────────────────────────────────────────
describe("canonicalSA / collapseGroups", () => {
  it("all three live dialects of one number resolve to ONE canonical", () => {
    expect(canonicalSA("0813995333")).toBe("+27813995333");
    expect(canonicalSA("27813995333")).toBe("+27813995333");
    expect(canonicalSA("+27813995333")).toBe("+27813995333");
    expect(canonicalSA("813995333")).toBe("+27813995333");
  });
  it("refuses to canonicalise junk, truncated and foreign numbers", () => {
    for (const bad of ["unknown", "", "81399533", "2771845", "+26651463", "1", "07123456789"]) {
      expect(canonicalSA(bad)).toBe(null);
    }
  });
  it("groups records across key dialects and leaves junk ungrouped", () => {
    const { groups, unmergeable } = collapseGroups({
      "0813995333": {}, "27813995333": {}, "813995333": {},
      "0700000001": {}, "1": {}, "unknown": {},
    });
    expect(groups.size).toBe(1);
    expect(groups.get("+27813995333")).toHaveLength(3);
    expect(unmergeable.map((u) => u.key).sort()).toEqual(["1", "unknown"]);
  });
});

// ── SAFE / REVIEW classification ────────────────────────────────────────────
describe("classifyGroup", () => {
  const g = (...names) => names.map((n, i) => ({ key: String(i), rec: { name: n } }));
  it("same normalised name (case/space) → SAFE", () => {
    expect(classifyGroup(g("Beverley ", "beverley")).classification).toBe("SAFE");
  });
  it("nameless records never contradict a named one → SAFE", () => {
    expect(classifyGroup(g("Musa", "", undefined)).classification).toBe("SAFE");
  });
  it("materially different names → REVIEW, never merged", () => {
    expect(classifyGroup(g("Thulani", "Nobuhle2")).classification).toBe("REVIEW");
  });
  it("a subset/prefix name is still REVIEW — 'probably same' is not 'beyond doubt'", () => {
    const r = classifyGroup(g("Njabulo", "Njabulo umlazi"));
    expect(r.classification).toBe("REVIEW");
    expect(r.tag).toBe("name-subset");
  });
  it("typo-distance names are REVIEW (Duncan / duncn)", () => {
    expect(classifyGroup(g("Duncan", "duncn")).classification).toBe("REVIEW");
  });
});

// ── survivor rule ───────────────────────────────────────────────────────────
describe("pickSurvivor — most sale history wins", () => {
  it("POS sale count beats everything else", () => {
    const members = [
      { key: "A", rec: { name: "x", orderCount: 50 } },
      { key: "B", rec: { name: "", orderCount: 0 } },
    ];
    expect(pickSurvivor(members, { A: 1, B: 4 }).survivor.key).toBe("B");
  });
  it("orderCount breaks a posSales tie; deterministic regardless of input order", () => {
    const a = { key: "A", rec: { orderCount: 3 } };
    const b = { key: "B", rec: { orderCount: 7 } };
    expect(pickSurvivor([a, b], {}).survivor.key).toBe("B");
    expect(pickSurvivor([b, a], {}).survivor.key).toBe("B");
  });
});

// ── the merge itself, simulated end-to-end ──────────────────────────────────
describe("buildMergePlan — money invariants", () => {
  it("total store credit across the whole base is IDENTICAL before and after", () => {
    const tree = fixtureTree();
    const before = totalCreditAcross(tree.customers);
    const plan = planFromTree(tree);
    expect(plan.refusals).toBeUndefined();
    const after = applyUpdates(tree, plan.updates);
    const afterTotal = totalCreditAcross(after.customers);
    expect(afterTotal.total).toBe(before.total);       // R75.00, to the cent
    expect(afterTotal.credits).toBe(before.credits);   // record count conserved
  });

  it("credits MOVE verbatim — same creditId, same remainingAmount, never summed", () => {
    const tree = fixtureTree();
    const plan = planFromTree(tree);
    const after = applyUpdates(tree, plan.updates);
    expect(readTreePath(after, `customers/${S}/storeCredit/credB`)).toEqual({ remainingAmount: 2500, issuedAt: 1754000000000 });
    expect(readTreePath(after, `customers/${S}/storeCredit/credA/remainingAmount`)).toBe(5000); // untouched
    expect(readTreePath(after, `customers/${L}/storeCredit`)).toBe(null);
    // no path in the plan writes an increased remainingAmount anywhere
    for (const [path, value] of Object.entries(plan.updates)) {
      if (path.endsWith("/remainingAmount")) throw new Error(`plan writes a bare remainingAmount at ${path}: ${value}`);
    }
  });

  it("canonical credit record re-points to the survivor", () => {
    const after = applyUpdates(fixtureTree(), planFromTree(fixtureTree()).updates);
    expect(readTreePath(after, "pos/storeCredits/credB/customerId")).toBe(S);
  });

  it("ledger folds by exact sum and moves txns; grand total conserved", () => {
    const tree = fixtureTree();
    const after = applyUpdates(tree, planFromTree(tree).updates);
    expect(readTreePath(after, `pos/creditLedger/${S}/balance`)).toBe(7500);
    expect(readTreePath(after, `pos/creditLedger/${L}`)).toBe(null);
    expect(readTreePath(after, `pos/creditLedger/${S}/txns/t2/amount`)).toBe(2500);
    const mergeTxn = readTreePath(after, `pos/creditLedger/${S}/txns/merge_batch1_${L}`);
    expect(mergeTxn.amount).toBe(0);
    expect(mergeTxn.source).toBe("migration");
  });
});

describe("buildMergePlan — laybys and sale history", () => {
  it("an open layby follows the survivor and stays findable by its invoice number", () => {
    const tree = fixtureTree();
    const after = applyUpdates(tree, planFromTree(tree).updates);
    expect(readTreePath(after, "laybys/saleL1/customerPhone")).toBe(S);
    expect(readTreePath(after, "laybys/saleL1/invoiceNo")).toBe("L-00118"); // unchanged
    expect(readTreePath(after, "laybys/saleL1/balanceRemaining")).toBe(15000);
    expect(readTreePath(after, "laybyPulls/pull1/customerPhone")).toBe(S);
    expect(readTreePath(after, `customers/${S}/laybyHoldings/saleL1/balanceRemaining`)).toBe(15000);
    expect(readTreePath(after, `customers/${L}/laybyHoldings`)).toBe(null);
    // the sale record the instalment flow reads is re-pointed too
    expect(readTreePath(after, "pos/sales/saleL1/customerId")).toBe(S);
  });

  it("sale-history index pointers move and pos/sales.customerId is rewritten", () => {
    const tree = fixtureTree();
    const after = applyUpdates(tree, planFromTree(tree).updates);
    expect(readTreePath(after, `customer_index/sales/${S}/saleL1/amount`)).toBe(15000);
    expect(readTreePath(after, `customer_index/sales/${S}/saleL2/amount`)).toBe(9900);
    expect(readTreePath(after, `customer_index/sales/${L}`)).toBe(null);
    expect(readTreePath(after, "pos/sales/saleL2/customerId")).toBe(S);
    expect(readTreePath(after, "orders/ord1/customerId")).toBe(S);
  });

  it("audit events move to the survivor's subtree verbatim", () => {
    const after = applyUpdates(fixtureTree(), planFromTree(fixtureTree()).updates);
    expect(readTreePath(after, `pos/audit/store_credit_issued/${S}/evt1/amount`)).toBe(2500);
    expect(readTreePath(after, `pos/audit/store_credit_issued/${L}`)).toBe(null);
  });
});

describe("buildMergePlan — refusals", () => {
  it("a REVIEW group is NEVER merged", () => {
    const plan = planFromTree(fixtureTree(), { classification: "REVIEW" });
    expect(plan.refusals).toBeDefined();
    expect(plan.updates).toBeUndefined();
  });
  it("legacy number-shaped store credit refuses the group", () => {
    const tree = fixtureTree();
    tree.customers[L].storeCredit = 2500; // scalar, cannot move as a record
    const plan = planFromTree(tree);
    expect(plan.refusals.some((r) => r.why.includes("LEGACY"))).toBe(true);
  });
  it("creditId collision under the survivor refuses the group", () => {
    const tree = fixtureTree();
    tree.customers[S].storeCredit.credB = { remainingAmount: 1 };
    expect(planFromTree(tree).refusals.some((r) => r.why.includes("collision"))).toBe(true);
  });
  it("a canonical credit owned by someone else refuses the group", () => {
    const plan = planFromTree(fixtureTree(), { loserCreditOwners: { credB: "0999999999" } });
    expect(plan.refusals.some((r) => r.why.includes("expected loser"))).toBe(true);
  });
  it("accountType conflict refuses the group", () => {
    const tree = fixtureTree();
    tree.pos.creditLedger[S].accountType = "staff";
    expect(planFromTree(tree).refusals.some((r) => r.why.includes("accountType"))).toBe(true);
  });
  it("an already-merged loser refuses (idempotence)", () => {
    const tree = fixtureTree();
    tree.customers[L].mergedInto = S;
    expect(planFromTree(tree).refusals.some((r) => r.why.includes("already merged"))).toBe(true);
  });
});

describe("buildMergePlan — loser preservation and recoverability", () => {
  it("the loser is tombstoned, not deleted: identity fields survive", () => {
    const after = applyUpdates(fixtureTree(), planFromTree(fixtureTree()).updates);
    const loser = readTreePath(after, `customers/${L}`);
    expect(loser.mergedInto).toBe(S);
    expect(loser.code).toBe("C-1300");
    expect(loser.phone).toBe("+27619467420");
  });

  it("restoring preState over the merged tree reproduces the original tree EXACTLY", () => {
    const tree = fixtureTree();
    const plan = planFromTree(tree);
    const merged = applyUpdates(tree, plan.updates);
    const restored = applyUpdates(merged, plan.preState);
    // Deep-equal on every top-level node the merge could have touched.
    expect(restored.customers).toEqual(tree.customers);
    expect(restored.pos).toEqual(tree.pos);
    expect(restored.customer_index).toEqual(tree.customer_index);
    expect(restored.laybys).toEqual(tree.laybys);
    expect(restored.laybyPulls).toEqual(tree.laybyPulls);
    expect(restored.orders).toEqual(tree.orders);
    // and the bookkeeping rows are gone again
    expect(readTreePath(restored, `customer_merges/batch1_${L}`)).toBe(null);
  });

  it("survivor bookkeeping folds: name kept, optedIn inherited, orderCount summed", () => {
    const after = applyUpdates(fixtureTree(), planFromTree(fixtureTree()).updates);
    const s = readTreePath(after, `customers/${S}`);
    expect(s.name).toBe("Musa");                 // survivor identity never overwritten
    expect(s.optedIn).toBe(true);                // inherited from loser
    expect(s.orderCount).toBe(4);                // 1 + 3
    expect(s.firstOrderAt).toBe("2026-06-01T08:00:00.000Z");
    expect(s.lastOrderAt).toBe("2026-08-01T08:00:00.000Z");
  });
});

// ── the no-live-writes pin ──────────────────────────────────────────────────
describe("purity pins", () => {
  it("the core module imports NOTHING from firebase — tests cannot touch live data", () => {
    const src = readFileSync(new URL("./customerMergeCore.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/firebase/i);
    expect(src).not.toMatch(/https?:\/\//);
  });
  it("creditBalance treats the POS create-default 0 as empty and flags positive legacy scalars", () => {
    expect(creditBalance({ storeCredit: 0 }).total).toBe(0);
    expect(creditBalance({ storeCredit: 2500 }).legacyNumber).toBe(2500);
    expect(creditBalance({ storeCredit: { c1: { remainingAmount: 100 }, c2: { remainingAmount: "bad" } } }).bad).toEqual(["c2"]);
  });
  it("nameNorm folds case, punctuation and unicode", () => {
    expect(nameNorm(" Beverley ")).toBe(nameNorm("beverley"));
    expect(nameNorm("Thabo's")).toBe(nameNorm("thabo s"));
  });
  it("formatClass labels every census dialect", () => {
    expect(formatClass("0813995333")).toBe("local-0");
    expect(formatClass("27813995333")).toBe("intl-27");
    expect(formatClass("813995333")).toBe("bare-9");
    expect(formatClass("+27813995333")).toBe("plus27-e164");
    expect(formatClass("+2771845")).toBe("plus27-malformed");
    expect(formatClass("+26651463")).toBe("plus-foreign");
    expect(formatClass("unknown")).toBe("unknown-sentinel");
  });
});
