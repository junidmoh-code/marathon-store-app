// ─── applyMovement MAINTAINS /stock_provenance — the forward half ──────────────
//
// The backfill materialises the index once; this is what keeps it true afterwards.
// The tests capture the RAW multi-path payload rather than the resulting store,
// because three separate claims are about the payload's shape and not its effect:
//
//   • the provenance leg rides in the SAME update() as the cell and the ledger
//   • it is written with increment(), never a read-modify-write
//   • /stock and stock_movements are byte-identical to before
//
// MUTATION-PROVED; each test names the edit that must break it. Nothing here
// re-implements classifyMovement — the expected counter and location are written out
// by hand for each real movement shape.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
let payloads = [];        // every update() call, verbatim

function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    payloads.push(updates);
    for (const [k, v] of Object.entries(updates)) {
      const full = node.path ? `${node.path}/${k}` : k;
      if (v && typeof v === "object" && "__increment" in v) setPath(full, (Number(getPath(full)) || 0) + v.__increment);
      else setPath(full, v);
    }
  },
  push: () => ({ key: `mv${++pushN}` }),
  // The real increment() returns an opaque server sentinel; this models it as a
  // tagged object so the payload assertions can see the DELTA that was requested.
  increment: (delta) => ({ __increment: delta }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");

const NAVY = "p1786452575638";
const last = () => payloads[payloads.length - 1];
const provKeys = (p) => Object.keys(p).filter((k) => k.startsWith("stock_provenance/"));

// Every source location is seeded with stock. Without this, applyMovement's negative
// floor refuses the movement before any payload is built and the tests below would
// pass or fail for a reason that has nothing to do with provenance.
const SEED_LOCS = ["hub2", "marathon-pe", "trophy", "central"];
const SEED_SIZES = ["M", "L", "XL", "9"];
beforeEach(() => {
  store = {}; pushN = 0; payloads = [];
  for (const loc of SEED_LOCS) {
    for (const size of SEED_SIZES) setPath(stockCellPath(loc, NAVY, size), { qty: 20, v: 1, mv: "seed0", lastType: "received" });
  }
  payloads = [];
});

describe("the provenance leg rides in the same atomic update", () => {
  it("a refill fulfil into a shop increments k on that shop, in ONE update", async () => {
    const res = await applyMovement({
      type: "transfer_out", productId: NAVY, size: "L", qty: 2,
      from: "hub2", to: "marathon-pe", reason: "clothing_cr",
      link: { orderId: "R004-3", refillId: "cr_marathon-pe_" + NAVY },
      movementId: "cr_R004-3_x_g0",
    });
    expect(res.ok).toBe(true);
    // ONE update() call. MUTATION: move the provenance write out into its own
    // update() and this becomes 2 — the divergence this design exists to prevent.
    expect(payloads.length).toBe(1);
    expect(last()["stock_provenance/marathon-pe/" + NAVY + "/k"]).toEqual({ __increment: 2 });
    // …and only that one path. The SOURCE hub is losing units, not gaining history.
    expect(provKeys(last())).toEqual(["stock_provenance/marathon-pe/" + NAVY + "/k"]);
  });

  it("a sale increments s by ONE EVENT, not by quantity", async () => {
    // `s` counts sale events because the predicate only asks "ever sold here". A
    // per-unit count would imply a threshold the predicate does not have.
    // MUTATION: change increment(1) to increment(prov.qty) and this fails.
    await applyMovement({
      type: "sold", productId: NAVY, size: "M", qty: 3,
      from: "trophy", link: { saleId: "s1" }, movementId: "sold:s1:trophy:" + NAVY + ":M",
    });
    expect(last()["stock_provenance/trophy/" + NAVY + "/s"]).toEqual({ __increment: 1 });
  });

  it("an undo increments u on the shop the units LEAVE", async () => {
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "L", qty: 2,
      from: "marathon-pe", to: "hub2", reason: "clothing_cr_undo",
      link: { orderId: "R004-3", refillId: "cr_marathon-pe_" + NAVY },
      movementId: "crundo_R004-3_x_g0",
    });
    expect(last()["stock_provenance/marathon-pe/" + NAVY + "/u"]).toEqual({ __increment: 2 });
    // hub2 gets nothing: crediting the destination of an undo would let a hub start
    // "carrying" a line purely because a mistaken fulfil was reversed through it.
    expect(provKeys(last())).toEqual(["stock_provenance/marathon-pe/" + NAVY + "/u"]);
  });

  it("a receive increments k on the receiving location", async () => {
    await applyMovement({ type: "received", productId: NAVY, size: "M", qty: 12, to: "central", movementId: "r1" });
    expect(last()["stock_provenance/central/" + NAVY + "/k"]).toEqual({ __increment: 12 });
  });
});

describe("movements that prove nothing add NO path", () => {
  it("a customer collection dispatch — the 2026-08-17 shape", async () => {
    // THE test. If this ever writes a provenance path, the husk bug is back: one
    // customer collecting at a shop would again make that shop "carry" the line.
    // MUTATION: classify COLLECTION as STOCKING and this fails.
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "M", qty: 1,
      from: "hub2", to: "marathon-pe", reason: "clothing_order",
      link: { orderId: "018" }, movementId: "disp_018_x",
    });
    expect(provKeys(last())).toEqual([]);
    // The cell and the ledger still land exactly as before.
    expect(last()[`${stockCellPath("marathon-pe", NAVY, "M")}/qty`]).toBe(21);   // 20 seeded + 1
    expect(last()["stock_movements/disp_018_x"]).toBeTruthy();
  });

  it("a null-reason customer dispatch — 3,119 of these exist live", async () => {
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "9", qty: 1,
      from: "hub2", to: "marathon-pe", link: { orderId: "089" }, movementId: "disp_089_x",
    });
    expect(provKeys(last())).toEqual([]);
  });

  it("an adjustment, however positive", async () => {
    await applyMovement({
      type: "adjustment", productId: NAVY, size: "M", qty: 5, to: "marathon-pe",
      reason: "recount: corrected on the spot", movementId: "a1",
    });
    expect(provKeys(last())).toEqual([]);
  });

  it("a customer return", async () => {
    await applyMovement({ type: "return", productId: NAVY, size: "M", qty: 1, to: "trophy", link: { saleId: "s2" }, movementId: "ret1" });
    expect(provKeys(last())).toEqual([]);
  });

  it("the in_transit leg of a hold — 892 of these exist live", async () => {
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "M", qty: 3,
      from: "central", to: "in_transit", reason: "hub2_auto_refill",
      link: { refillId: "r1", holdDest: "hub2" }, movementId: "rrf_r1",
    });
    // in_transit is a holding, not a shelf. MUTATION: empty
    // NON_STOCKING_LOCATIONS and this writes stock_provenance/in_transit/…
    expect(provKeys(last())).toEqual([]);
  });

  it("a dispatch reversal", async () => {
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "M", qty: 1,
      from: "marathon-pe", to: "hub2", reason: "order return (reverses dispatch)",
      link: { orderId: "089", reverses: "disp_089_x" }, movementId: "ret_089_x",
    });
    expect(provKeys(last())).toEqual([]);
  });
});

describe("the contract applyMovement already had is unchanged", () => {
  it("the return shape is untouched", async () => {
    const ok = await applyMovement({ type: "received", productId: NAVY, size: "M", qty: 1, to: "central", movementId: "c1" });
    expect(ok).toEqual({ ok: true, movementId: "c1" });
    const bad = await applyMovement({ type: "received", productId: NAVY, size: "M", qty: 0, to: "central" });
    expect(bad).toEqual({ ok: false, reason: "qty_must_be_positive" });
  });

  it("idempotency still short-circuits — a re-sync cannot double-count", async () => {
    // This is what makes increment() safe: a replayed movement never reaches the
    // payload at all. MUTATION: move the provenance write above the existing-movement
    // check and a re-drained offline queue inflates every counter it touches.
    const m = { type: "received", productId: NAVY, size: "M", qty: 4, to: "central", movementId: "dup1" };
    const first = await applyMovement(m);
    const second = await applyMovement(m);
    expect(first).toEqual({ ok: true, movementId: "dup1" });
    expect(second).toEqual({ ok: true, movementId: "dup1", idempotent: true });
    expect(payloads.length).toBe(1);
    expect(getPath("stock_provenance/central/" + NAVY + "/k")).toBe(4);   // not 8
  });

  it("a refused movement writes NO provenance", async () => {
    // insufficient_stock: the whole update is abandoned, provenance included.
    setPath(stockCellPath("marathon-pe", NAVY, "M"), { qty: 0, v: 1, mv: "m", lastType: "received" });   // override the seed
    const res = await applyMovement({
      type: "transfer_out", productId: NAVY, size: "M", qty: 5,
      from: "marathon-pe", to: "trophy", link: { transferId: "t1" }, movementId: "t1m",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("insufficient_stock");
    expect(payloads.length).toBe(0);
    expect(getPath("stock_provenance/trophy/" + NAVY)).toBe(null);
  });

  it("a two-cell transfer credits ONLY the destination", async () => {
    setPath(stockCellPath("hub2", NAVY, "M"), { qty: 9, v: 2, mv: "m", lastType: "received" });
    setPath(stockCellPath("trophy", NAVY, "M"), { qty: 0, v: 2, mv: "m", lastType: "received" });
    await applyMovement({
      type: "transfer_out", productId: NAVY, size: "M", qty: 3,
      from: "hub2", to: "trophy", link: { transferId: "t2" }, movementId: "t2m",
    });
    expect(provKeys(last())).toEqual(["stock_provenance/trophy/" + NAVY + "/k"]);
    // both cells still written, unchanged behaviour
    expect(last()[`${stockCellPath("hub2", NAVY, "M")}/qty`]).toBe(6);
    expect(last()[`${stockCellPath("trophy", NAVY, "M")}/qty`]).toBe(3);
  });
});

describe("counters accumulate to the shape the engine reads", () => {
  it("replays the real 2026-08-17 sequence and lands on k=4, u=4", async () => {
    // Same eight movements as the classifier test, driven through the REAL writer.
    // The engine's predicate reads k − u > 0, so this must end at zero net.
    // marathon-pe and trophy must start with NOTHING for this replay: the point is
    // that the counters end at k=4/u=4 from the movements alone.
    store.stock_provenance = undefined;

    // 07:58 the customer's parcel — proves nothing
    await applyMovement({ type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "hub2", to: "marathon-pe", reason: "clothing_order", link: { orderId: "018" }, movementId: "disp_018" });
    // 08:05 walked next door — stocks TROPHY
    await applyMovement({ type: "transfer_out", productId: NAVY, size: "M", qty: 1, from: "marathon-pe", to: "trophy", link: { transferId: "tx" }, movementId: "tx_M" });
    // 08:19–20 the engine's own fulfil — 1 + 2 + 1 = 4 units
    for (const [size, qty, id] of [["M", 1, "cr2"], ["L", 2, "cr3"], ["XL", 1, "cr4"]]) {
      await applyMovement({ type: "transfer_out", productId: NAVY, size, qty, from: "hub2", to: "marathon-pe", reason: "clothing_cr", link: { orderId: "R004", refillId: "cr_marathon-pe_" + NAVY }, movementId: id });
    }
    // 08:54 undone — the same 4 units
    for (const [size, qty, id] of [["M", 1, "un2"], ["L", 2, "un3"], ["XL", 1, "un4"]]) {
      await applyMovement({ type: "transfer_out", productId: NAVY, size, qty, from: "marathon-pe", to: "hub2", reason: "clothing_cr_undo", link: { orderId: "R004", refillId: "cr_marathon-pe_" + NAVY }, movementId: id });
    }

    expect(getPath("stock_provenance/marathon-pe/" + NAVY)).toEqual({ k: 4, u: 4 });
    expect(getPath("stock_provenance/trophy/" + NAVY)).toEqual({ k: 1 });
    // The stored record is exactly what the engine's carriesByIndex reads as FALSE
    // at marathon-pe and TRUE at trophy — pinned in provenance-index.test.cjs.
  });
});
