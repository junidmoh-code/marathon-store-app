// ─── REFILL HISTORY — END TO END THROUGH THE REAL COMPONENT ───────────────────
// refillHistoryCore.test.js pins the pure row-building. This renders the actual
// view against faked RTDB reads and proves the required behaviour all the way to
// the screen: THE RIGHT ROWS FOR A CHOSEN RANGE, INCLUDING REJECTED ONES, with
// the reason and the person on them.
//
// A pure-core test cannot catch a component that never wires its data through,
// crashes on first render, or filters the rows again on the way out — which is
// exactly the class of bug the sibling wiring test exists for.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// SA 2026-08-07 09:00 = 07:00Z. "Yesterday" is therefore the SA day 2026-08-06,
// i.e. the half-open window [2026-08-05T22:00Z, 2026-08-06T22:00Z).
const NOW = Date.parse("2026-08-07T07:00:00.000Z");

// ── THE MOCK KEEPS THE QUERY, NOT JUST THE PATH ──────────────────────────────
// A mock that throws away orderByChild/startAt/endBefore cannot tell a
// range-scoped read from a whole-node one, so the thing this view exists to
// guarantee — every read is bounded by the selected range — would pass after a
// regression. On a project already billed hundreds of dollars for an unindexed
// whole-node read, that is the assertion worth having. (CodeRabbit, PR #332.)
//
// NOTE the mock deliberately does NOT export `endAt`. The component must use
// `endBefore`, and a mock that offers both would let an inclusive bound slip
// back in unnoticed — the import would simply resolve. (CodeRabbit, PR #333.)
const reads = {};
const readCalls = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  query: (r, ...constraints) => ({ ...r, constraints }),
  orderByChild: (field) => ({ kind: "orderByChild", field }),
  startAt: (value) => ({ kind: "startAt", value }),
  endBefore: (value) => ({ kind: "endBefore", value }),
  get: (r) => { readCalls.push(r); return Promise.resolve({ val: () => reads[r.path] ?? null }); },
}));
const callsTo = (path) => readCalls.filter((r) => r.path === path);
const constraintsOf = (r) => Object.fromEntries((r.constraints || []).map((c) => [c.kind, c.field ?? c.value]));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => NOW, serverNowIso: () => new Date(NOW).toISOString() }));

const { default: RefillHistory } = await import("./RefillHistory.jsx");

const PRODUCTS = [
  { id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null },
  { id: "tee", name: "Essentials tracksuit olive khaki", photoUrl: null },
];

async function render() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
  // one more tick so both promise chains have settled into state
  await act(async () => {});
  const text = textOf(tree.toJSON());
  tree.unmount();
  return text;
}
const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};
const clickRange = async (tree, label) => {
  const btn = tree.root.findAll((n) => n.type === "button" && textOf(n.children) === label)[0];
  await act(async () => { btn.props.onClick(); });
  await act(async () => {});
};

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  readCalls.length = 0;
  reads["refill_requests"] = {
    // IN RANGE, rejected by a human — no cancelReason, with a role and a uid.
    rej: {
      productId: "boot", size: "7", qty: 3, requestingLocation: "hub1", status: "cancelled",
      createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
      rejectedBy: "warehouse", resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
      createdFrom: { source: "central", via: "missing_sneakers" },
    },
    // IN RANGE, withdrawn by the engine with the new reason from Part A.
    wdr: {
      productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "cancelled",
      cancelReason: "already_in_stock",
      createdAt: "2026-08-06T09:00:00.000Z", resolvedAt: "2026-08-06T10:00:00.000Z",
      createdFrom: { engine: true, source: "central" },
    },
    // OUT OF RANGE — five days earlier, both ends.
    old: {
      productId: "boot", size: "9", qty: 1, requestingLocation: "hub1", status: "fulfilled",
      createdAt: "2026-08-01T08:00:00.000Z", resolvedAt: "2026-08-01T09:00:00.000Z",
      createdFrom: { source: "central" },
    },
  };
  reads["stock_movements"] = {
    // a display leaving Hub 1 — the row only the ledger can produce
    "disp_164_2026-08-06T10_00_00_000Z": {
      productId: "boot", size: "8", qty: 1, type: "transfer_out",
      from: "hub1", to: "marathon-pe", ts: "2026-08-06T10:00:00.000Z", link: { orderId: "164" },
    },
  };
});

describe("RefillHistory renders the right rows for a chosen range", () => {
  it("defaults to today and shows nothing from yesterday", async () => {
    const out = await render();
    expect(out).toContain("2026-08-07");
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat");
  });

  it("YESTERDAY shows the rejected row, with its reason and who rejected it", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Yesterday");
    const out = textOf(tree.toJSON());
    tree.unmount();

    expect(out).toContain("2026-08-06");
    // the rejection is present, named as a rejection, with the person
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("Rejected");
    expect(out).toContain("marked not available on the shelf");
    expect(out).toContain("warehouse");
    expect(out).toContain("vWfHqbL");                 // uid prefix
    // the engine withdrawal is present and NOT called a rejection
    expect(out).toContain("Essentials tracksuit olive khaki");
    expect(out).toContain("the destination already held enough");
    // the display movement is present with its true source -> destination
    expect(out).toContain("Display sent out");
    expect(out).toContain("Marathon PE");
    // and the out-of-range row is absent
    expect(out).not.toContain("size 9");
  });

  it("credits the PERSON who fulfilled an engine-raised request, never 'the engine'", async () => {
    // The misattribution this guards: an engine-RAISED request picked by a
    // warehouse staff member rendered "by the engine", crediting a machine for a
    // person's work on the one screen built to answer "who did this".
    reads["refill_requests"] = {
      staffPick: {
        productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "fulfilled",
        createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
        createdFrom: { engine: true, source: "central" },
        resolvedBy: "vWfHqbLEPvRMItXhH0B9NvYW0LG3",
      },
    };
    reads["stock_movements"] = null;
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Yesterday");
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(out).toContain("by staff");
    expect(out).toContain("vWfHqbL");
    expect(out).not.toContain("the engine");
  });

  it("names the engine only for its own self-withdrawal", async () => {
    reads["refill_requests"] = {
      wdr: {
        productId: "tee", size: "M", qty: 2, requestingLocation: "hub2", status: "cancelled",
        cancelReason: "already_in_stock",
        createdAt: "2026-08-06T08:00:00.000Z", resolvedAt: "2026-08-06T12:00:00.000Z",
        createdFrom: { engine: true, source: "central" },
      },
    };
    reads["stock_movements"] = null;
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Yesterday");
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(out).toContain("Withdrawn by");
    expect(out).toContain("the engine");
    expect(out).not.toContain("by staff");
  });

  it("counts each outcome separately in the totals", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Yesterday");
    const out = textOf(tree.toJSON());
    tree.unmount();
    // Rejected: 1 row / 3 units. Withdrawn: 1 row / 2 units. Neither collapses
    // into a single "cancelled" bucket, which is the whole point of the view.
    expect(out).toContain("1Rejected3 units");
    expect(out).toContain("1Withdrawn2 units");
    expect(out).toContain("0Refilled0 units");
  });

  it("LAST 7 DAYS widens to include the older row", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Last 7 days");
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(out).toContain("2026-08-01");
    expect(out).toContain("Refilled");
    expect(out).toContain("size 9");
  });

  // ── BANDWIDTH, ASSERTED RATHER THAN COMMENTED ──────────────────────────────
  it("movements are read DATE-RANGED against the ts index, never as a whole node", async () => {
    await render();
    const mv = callsTo("stock_movements");
    expect(mv).toHaveLength(1);
    const c = constraintsOf(mv[0]);
    expect(c.orderByChild).toBe("ts");
    // today, SA — the half-open window, sent to the server rather than filtered here
    expect(c.startAt).toBe("2026-08-06T22:00:00.000Z");
    expect(c.endBefore).toBe("2026-08-07T22:00:00.000Z");
  });

  // ── THE TEST THAT FAILS IF THE FLAG IS FLIPPED BACK ───────────────────────
  // This is the whole point of the index going live: /refill_requests must be
  // read through a RANGE-SCOPED orderByChild, never as a whole node. Setting
  // REQUESTS_INDEXED back to false makes the component issue one unconstrained
  // get() instead, and every assertion below fails.
  it("requests are read DATE-RANGED against the createdAt/resolvedAt index, NEVER as a whole node", async () => {
    await render();
    const rr = callsTo("refill_requests");
    // TWO queries: a request raised last month and fulfilled yesterday belongs
    // in yesterday's history, and one index cannot answer both ends.
    expect(rr).toHaveLength(2);

    const fields = rr.map((r) => constraintsOf(r).orderByChild).sort();
    expect(fields).toEqual(["createdAt", "resolvedAt"]);

    for (const r of rr) {
      const c = constraintsOf(r);
      // NOT A WHOLE-NODE READ: every query carries an ordering AND both bounds.
      // An unconstrained read is exactly what the fallback did.
      expect(c.orderByChild, "an unordered read of this node is a full download").toBeTruthy();
      // today, SA — the half-open window, sent to the SERVER rather than
      // filtered here
      expect(c.startAt).toBe("2026-08-06T22:00:00.000Z");
      expect(c.endBefore).toBe("2026-08-07T22:00:00.000Z");
    }
    // and nothing read the node without constraints
    expect(rr.filter((r) => (r.constraints ?? []).length === 0)).toEqual([]);
  });

  it("a range change re-queries BOTH nodes, and every query stays bounded", async () => {
    // With the index live the range IS the query, so a new range means a new
    // read — of both nodes. That is correct and cheap: each read is bounded by
    // the window. The old fallback re-read nothing because it had already pulled
    // everything.
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    expect(callsTo("refill_requests")).toHaveLength(2);   // createdAt + resolvedAt
    expect(callsTo("stock_movements")).toHaveLength(1);

    await clickRange(tree, "Yesterday");
    await clickRange(tree, "Last 7 days");
    await clickRange(tree, "This month");
    tree.unmount();

    expect(callsTo("refill_requests").length, "requests re-query per range — that is what the index is for").toBeGreaterThan(2);
    expect(callsTo("stock_movements").length, "movements too").toBeGreaterThan(1);

    // EVERY read of either node, across every range, stayed range-scoped.
    for (const r of [...callsTo("refill_requests"), ...callsTo("stock_movements")]) {
      const c = constraintsOf(r);
      expect(c.orderByChild, `unbounded read of ${r.path}`).toBeTruthy();
      expect(typeof c.startAt).toBe("string");
      expect(typeof c.endBefore).toBe("string");
    }
  });

  it("the end bound is EXCLUSIVE — endBefore, matching the half-open window", async () => {
    // resolveRange documents a half-open window and requestRows/movementRows
    // filter `t < toMs`. An inclusive endAt on the server contradicted that: it
    // fetched the boundary instant (exactly 00:00:00.000 SA of the next day) and
    // relied on the client filter to drop it again. Harmless today, but it makes
    // the server query disagree with its own stated contract — and becomes a real
    // off-by-one the moment someone removes the client filter, reasonably
    // believing the server already bounded the range. (CodeRabbit, PR #333.)
    await render();
    for (const r of readCalls) {
      const kinds = (r.constraints ?? []).map((c) => c.kind);
      expect(kinds, `${r.path} must bound the range exclusively`).toContain("endBefore");
      expect(kinds, `${r.path} must not use an inclusive end bound`).not.toContain("endAt");
    }
    // and the exclusive bound is the START of the next SA day, not 23:59:59
    for (const r of readCalls) {
      expect(constraintsOf(r).endBefore).toBe("2026-08-07T22:00:00.000Z");
    }
  });

  it("no unconstrained read of either node is ever issued", async () => {
    // The single sentence this whole feature's cost story rests on.
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Last 7 days");
    tree.unmount();
    const unbounded = readCalls.filter((r) => (r.constraints ?? []).length === 0);
    expect(unbounded.map((r) => r.path)).toEqual([]);
  });

  // ── ACCESSIBILITY, ASSERTED ────────────────────────────────────────────────
  // This screen is read on a phone standing in a hub. Both of these carry real
  // usability weight there, not just audit compliance.
  it("the custom date labels are ASSOCIATED with their inputs", async () => {
    // Without htmlFor/id a screen reader announces two bare date fields, and
    // tapping the word "From" does nothing — on a phone that label is a target
    // people reach for. (CodeRabbit, PR #332.)
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Custom");
    const labels = tree.root.findAll((n) => n.type === "label");
    const inputs = tree.root.findAll((n) => n.type === "input" && n.props.type === "date");
    expect(labels).toHaveLength(2);
    expect(inputs).toHaveLength(2);
    for (const l of labels) {
      expect(l.props.htmlFor, `label "${textOf(l.props.children)}" must name an input`).toBeTruthy();
      expect(inputs.some((i) => i.props.id === l.props.htmlFor),
        `no input has id="${l.props.htmlFor}"`).toBe(true);
    }
    // and the two pairs are distinct, not both pointing at one field
    expect(new Set(labels.map((l) => l.props.htmlFor)).size).toBe(2);
    tree.unmount();
  });

  it("the range and hub chips report their pressed state", async () => {
    // The chips carry state ONLY in colour; without aria-pressed a screen reader
    // announces every one identically.
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    const pressed = (label) => tree.root.findAll((n) => n.type === "button" && textOf(n.children) === label)[0]?.props["aria-pressed"];
    expect(pressed("Today")).toBe(true);
    expect(pressed("Yesterday")).toBe(false);
    expect(pressed("Hub 1")).toBe(true);
    await clickRange(tree, "Yesterday");
    expect(pressed("Today")).toBe(false);
    expect(pressed("Yesterday")).toBe(true);
    tree.unmount();
  });

  it("the hub filter narrows the list", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<RefillHistory products={PRODUCTS} />); });
    await act(async () => {});
    await clickRange(tree, "Yesterday");
    await clickRange(tree, "Hub 1");                  // toggles Hub 1 OFF, leaving Hub 2
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(out).toContain("Essentials tracksuit olive khaki");   // hub2
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat"); // hub1, now filtered out
  });
});
