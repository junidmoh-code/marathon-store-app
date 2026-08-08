// ─── THE WIRING, NOT THE HELPER ───────────────────────────────────────────────
// This test exists because the exact bug it pins ALREADY SHIPPED ONCE inside this
// PR's own history: the call to partitionSatisfied was missing its third
// argument, so the lock index never reached it and every engine-locked request
// became eligible for the "already covered" split.
//
// Why that is severe rather than cosmetic: the engine deliberately refuses to
// withdraw a locked request on raw quantity, because `needGone` nets the cell
// against the approved TARGET. qty 2, target 3, cell 2 is still one unit of real
// work. With the lock index missing, the card left the queue, the engine would
// never withdraw it (target unmet), the deficit loop would never re-raise it
// (its live lock counts as inbound), and the on-screen note promised a
// withdrawal that would never come. The hub sits under target forever with
// nobody able to see the work.
//
// refillSatisfied.test.js pins the pure function and passed the whole time that
// bug was live — a pure-unit test cannot see a missing argument at the call
// site. Only rendering the component can. (Sonnet review, PR #332.)
//
// react-test-renderer runs effects under act() with no DOM — the same approach
// and the same approved devDependency as UserManagement.gate.test.jsx.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ── the module boundary, faked ────────────────────────────────────────────────
// Each RTDB path returns its own fixture, so the test controls exactly what the
// component sees: an open request, the destination's cells, and the LOCK INDEX.
const paths = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve({ val: () => null })),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "warehouse" }, isSuperAdmin: false }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn() }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-07T10:00:00.000Z", serverNowMs: () => Date.parse("2026-08-07T10:00:00.000Z") }));

const { default: Hub2RefillQueue } = await import("./Hub2RefillQueue.jsx");

// One open request for hub1: asks for 2, and the cell holds exactly 2.
const REQUEST = {
  r1: {
    productId: "boot", size: "7", qty: 2, requestingLocation: "hub1",
    status: "open", createdAt: "2026-08-06T20:50:00.000Z",
    createdFrom: { engine: true, source: "central" },
  },
};
const PRODUCTS = [{ id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null }];

// Flatten the render tree to plain visible text. JSX splits an interpolated
// heading into separate string children ("1", " request", " already covered by
// stock at ", "Hub 1"), so asserting against raw JSON would miss a sentence that
// is plainly on screen. Join the leaves and read what a person would read.
const textOf = (node) => {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
};

function renderQueue() {
  let tree;
  act(() => { tree = TestRenderer.create(<Hub2RefillQueue products={PRODUCTS} dest="hub1" />); });
  const text = textOf(tree.toJSON());
  tree.unmount();
  return text;
}

beforeEach(() => {
  for (const k of Object.keys(paths)) delete paths[k];
  paths["refill_requests"] = REQUEST;
  paths["stock/central"] = { boot: { 7: { qty: 5 } } };
  paths["stock/hub1"] = { boot: { 7: { qty: 2 } } };      // the cell already holds the full ask
  paths["stock_exceptions/latest"] = null;
});

describe("Hub2RefillQueue passes the engine lock index into the covered split", () => {
  it("UNLOCKED and covered → the card leaves the queue into the covered note", () => {
    paths["refill_engine/open"] = null;                   // no lock
    const out = renderQueue();
    expect(out).toContain("already covered by stock at Hub 1");
    expect(out).not.toContain("Transfer 2 units to Hub 1");
  });

  it("LOCKED → the card STAYS as actionable work, and is never called covered", () => {
    // Identical stock and identical request. The ONLY difference is the lock.
    // If lockedIds does not reach partitionSatisfied this assertion fails, which
    // is precisely the regression that shipped once.
    paths["refill_engine/open"] = { hub1: { boot: { 7: { refillId: "r1", qty: 2, source: "central" } } } };
    const out = renderQueue();
    expect(out).not.toContain("already covered by stock at Hub 1");
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("ready to fulfil");
  });

  it("a lock for a DIFFERENT request does not protect this one", () => {
    // The exclusion must key on the refillId, not merely on "some lock exists at
    // this cell" — otherwise any lock anywhere would freeze the whole feature.
    paths["refill_engine/open"] = { hub1: { boot: { 8: { refillId: "other", qty: 1 } } } };
    const out = renderQueue();
    expect(out).toContain("already covered by stock at Hub 1");
  });

  it("the covered note promises NO withdrawal deadline", () => {
    // The scan is `every 15 minutes from 07:00 to 19:00` SAST — it does not run
    // overnight. The Timberland requests that prompted this whole feature were
    // raised at 20:50, so a "within 15 minutes" promise would have been false
    // for the very case it was written for. (CodeRabbit, PR #332.)
    paths["refill_engine/open"] = null;
    const out = renderQueue();
    expect(out).toContain("already covered by stock at Hub 1");
    expect(out).not.toContain("15 minutes");
    expect(out).toContain("when it next runs");
  });

  it("a still-short cell keeps its card whether locked or not", () => {
    paths["stock/hub1"] = { boot: { 7: { qty: 1 } } };     // asked 2, only 1 there
    for (const lock of [null, { hub1: { boot: { 7: { refillId: "r1", qty: 2 } } } }]) {
      paths["refill_engine/open"] = lock;
      const out = renderQueue();
      expect(out).not.toContain("already covered by stock at Hub 1");
      expect(out).toContain("ready to fulfil");
    }
  });
});

describe("the lineFilter prop (Hub 2 SNEAKERS / CLOTHING toggle, 2026-08-08)", () => {
  const SHOE_PRODUCT = { id: "boot", name: "Timberland Premium 6-Inch Wheat", category: "Footwear", photoUrl: null };
  const renderWith = (lineFilter) => {
    let tree;
    act(() => { tree = TestRenderer.create(<Hub2RefillQueue products={[SHOE_PRODUCT]} dest="hub1" lineFilter={lineFilter} />); });
    const text = textOf(tree.toJSON());
    tree.unmount();
    return text;
  };

  it("a filter that keeps the line shows the card exactly as before", () => {
    paths["stock/hub1"] = { boot: { 7: { qty: 0 } } };     // short → actionable
    paths["refill_engine/open"] = null;
    const out = renderWith((product, size) => product?.category === "Footwear" && /^\d/.test(String(size)));
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
  });

  it("a filter that excludes the line hides its card from the queue", () => {
    paths["stock/hub1"] = { boot: { 7: { qty: 0 } } };
    paths["refill_engine/open"] = null;
    const out = renderWith(() => false);
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat");
  });

  it("no filter = everything, byte-for-byte the old behaviour", () => {
    paths["stock/hub1"] = { boot: { 7: { qty: 0 } } };
    paths["refill_engine/open"] = null;
    const out = renderWith(null);
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
  });
});
