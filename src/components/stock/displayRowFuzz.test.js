// ─── DISPLAY ROWS — property fuzz ────────────────────────────────────────────
//
// The question the owner asked to be answered at the end of this job: CAN ANY
// PATH STILL OPEN A SECOND OPEN ROW FOR ONE PRODUCT AT ONE STORE?
//
// A hand-written fixture cannot answer that — it can only show that the paths
// somebody thought of behave. So every writer that can touch the ledger is
// modelled here as a plan builder over a simulated RTDB, driven by a seeded
// random walk, and the invariant is checked after EVERY step:
//
//     at most one OPEN row per (store, product) — unless a `keepOpen` add
//     deliberately made a second one, which is the Duplicate Displays tab's
//     own "the size on the wall is not listed" and is the one operation whose
//     entire purpose is to create the state the operator is about to resolve.
//
// The simulator applies a multi-path update the way RTDB does: a flat map of
// path → value, deepest write last, with `null` deleting. That is what makes
// "one atomic write" testable rather than asserted.
//
// It also DIFFERENTIALLY TESTS THE MIRROR: the server's close decision
// (functions/displayRows/lib.cjs — a separate copy, because functions/ cannot
// import from src/) is run over the same worlds as the client's, and the two
// must agree about which rows an event closes. A drift between the two copies
// is then a red test rather than a display record that closes in the app and
// not at the till.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import {
  sendPlan, openRowPlan, closeRowPlan, openRowsFor, rowPath, allRows, rowIsOpen,
} from "./displayRowCore";
import { stockSizeKey } from "../../utils/sizeKey";

const require_ = createRequire(import.meta.url);
const srv = require_("../../../functions/displayRows/lib.cjs");

// ── A tiny deterministic RNG, so a failure is reproducible from its seed ──
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// ── The RTDB multi-path update, applied the way RTDB applies it ──────────────
// Each key is a full path; the value replaces everything at that path. `null`
// deletes. Real RTDB also removes a node whose last child is deleted; nothing
// here writes a last-child delete, and the simulator implements the removal
// anyway so a future write that does cannot pass here and fail live.
function applyUpdate(root, updates) {
  const next = structuredClone(root);
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.split("/");
    const leaf = parts.pop();
    let node = next;
    for (const p of parts) {
      if (node[p] == null || typeof node[p] !== "object") node[p] = {};
      node = node[p];
    }
    if (value === null || value === undefined) {
      delete node[leaf];
      // RTDB deletes a node that has no children left. An empty object (and an
      // empty array) is not a value RTDB can hold.
      let cur = next, chain = [];
      for (const p of parts) { chain.push([cur, p]); cur = cur[p]; }
      for (let i = chain.length - 1; i >= 0; i--) {
        const [parent, key] = chain[i];
        if (parent[key] && typeof parent[key] === "object" && Object.keys(parent[key]).length === 0) delete parent[key];
        else break;
      }
    } else {
      node[leaf] = structuredClone(value);
    }
  }
  return next;
}

const STORES = ["marathon-pe", "trophy"];
const PRODUCTS = ["p1", "p2"];
const SIZES = ["7", "8", "9.5", "10", "11"];
const HUBS = ["hub1", "hub2"];

// The ledger lives under settings/displayRows/... in the simulated root, so the
// paths the plan builders emit are used verbatim — no translation layer that
// could quietly paper over a wrong path.
const rowsOf = (root) => (root.settings && root.settings.displayRows) || {};

function openRowCounts(root) {
  const counts = new Map();
  for (const r of allRows(rowsOf(root))) {
    if (!rowIsOpen(r)) continue;
    const k = `${r.store}::${r.productId}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

describe("no path opens a second open row for one product at one store", () => {
  for (const seed of [1, 7, 42, 99, 1234, 20260908]) {
    it(`holds over a random walk (seed ${seed})`, () => {
      const rand = rng(seed);
      const pick = (a) => a[Math.floor(rand() * a.length)];
      let root = {};
      let clock = Date.parse("2026-09-01T00:00:00.000Z");
      const deliberateDuplicates = new Set();

      for (let step = 0; step < 400; step++) {
        clock += 1 + Math.floor(rand() * 5000);
        const at = new Date(clock).toISOString();
        const store = pick(STORES);
        const productId = pick(PRODUCTS);
        const size = pick(SIZES);
        const rows = rowsOf(root);
        const rowId = `r${clock}_${step}`;
        const op = rand();

        if (op < 0.40) {
          // THE SEND — the warehouse operator picked a size and confirmed.
          const plan = sendPlan({
            rows, store, productId, productName: "Shoe", size, bookedHub: pick(HUBS),
            rowId, at, by: "op", orderId: `o${step}`,
            orderPatch: { [`orders/o${step}/displayRefillStatus`]: "refilled" },
          });
          expect(plan.ok).toBe(true);
          root = applyUpdate(root, plan.updates);
          // The request was cleared by the SAME write.
          expect(root.orders[`o${step}`].displayRefillStatus).toBe("refilled");
          // A SEND IS A NORMAL WRITER, so it must leave the wall clean and the
          // allowance is withdrawn. Without this the invariant stayed permanently
          // relaxed for that key once ONE keepOpen add had touched it, so a send
          // that later regressed and stopped closing the previous row would have
          // gone unnoticed for the rest of the walk. (CodeRabbit.)
          deliberateDuplicates.delete(`${store}::${productId}`);
        } else if (op < 0.60) {
          // THE WALL WALK — "ON THE WALL", pick the size, register.
          const plan = openRowPlan({ rows, store, productId, size, bookedHub: pick(HUBS), rowId, at, via: "wall_walk" });
          expect(plan.ok).toBe(true);
          root = applyUpdate(root, plan.updates);
          // Also a normal writer: a wall walk REPLACES what the record says.
          deliberateDuplicates.delete(`${store}::${productId}`);
        } else if (op < 0.68) {
          // THE DELIBERATE SECOND ROW — the Duplicate tab's "the size on the
          // wall is not listed", which exists to create the state a human then
          // resolves. The only operation allowed to break the invariant.
          const plan = openRowPlan({ rows, store, productId, size, bookedHub: pick(HUBS), rowId, at, keepOpen: true });
          expect(plan.ok).toBe(true);
          root = applyUpdate(root, plan.updates);
          if (openRowsFor(rowsOf(root), store, productId).length > 1) deliberateDuplicates.add(`${store}::${productId}`);
        } else if (op < 0.84) {
          // A MANUAL CLOSE — the Duplicate tab's per-size tap.
          const open = openRowsFor(rows, store, productId);
          if (!open.length) continue;
          const target = open[Math.floor(rand() * open.length)];
          const plan = closeRowPlan({ row: target, at, reason: pick(["corrected", "returned", "cancelled"]) });
          expect(plan.ok).toBe(true);
          root = applyUpdate(root, plan.updates);
          if (openRowsFor(rowsOf(root), store, productId).length <= 1) deliberateDuplicates.delete(`${store}::${productId}`);
        } else {
          // THE TILL — a sale, decided by the SERVER's own copy of the rule.
          const byRow = ((rows[store] || {})[productId]) || {};
          const sizeKey = stockSizeKey(size);
          // ── THE SALE INSTANT IS IN THE PAST, AND THAT IS THE POINT ─────────
          // Passing `at` was not enough: the walk's clock only moves forward,
          // so every row already predated it and the exclusion branch was never
          // taken. Mutation-checked and confirmed vacuous — patching
          // rowPredatesSale to `return true` left every test green, which is
          // the precise shape of a test that looks like coverage and is not.
          // (Adversarial review.)
          //
          // A real sale is delivered LATE, so the instant it carries is older
          // than "now". Rewinding it makes rows opened in between genuinely
          // post-sale, which is the case the filter exists for.
          const saleAt = new Date(clock - Math.floor(rand() * 20000)).toISOString();
          const closes = srv.decideCloses(byRow, sizeKey, 1, saleAt);
          // THE PROPERTY, asserted rather than assumed: nothing the sale closes
          // may have been registered after it.
          for (const { row: r } of closes) {
            expect(String(r.openedAt) <= saleAt,
              `seed ${seed} step ${step}: closed a row opened at ${r.openedAt}, after a sale at ${saleAt}`).toBe(true);
          }
          let updates = {};
          for (const { rowId: rid } of closes) {
            Object.assign(updates, srv.closeUpdates(rowPath(store, productId, rid), {
              at, reason: "sold", via: "pos_sale", movementId: `m${step}`,
            }));
          }
          root = applyUpdate(root, updates);
          if (openRowsFor(rowsOf(root), store, productId).length <= 1) deliberateDuplicates.delete(`${store}::${productId}`);
        }

        // ── THE INVARIANT, after every single step ──────────────────────────
        for (const [k, n] of openRowCounts(root)) {
          if (n > 1) {
            expect(deliberateDuplicates.has(k),
              `seed ${seed} step ${step}: ${n} open rows at ${k} with no deliberate add behind it`).toBe(true);
          }
        }
      }

      // Nothing was ever DELETED — a closed row keeps its history.
      for (const r of allRows(rowsOf(root))) {
        expect(["open", "closed"]).toContain(r.status);
        if (r.status === "closed") {
          expect(r.closedAt).toBeTruthy();
          expect(r.closedReason).toBeTruthy();
          expect(Object.keys(r.events || {}).length).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe("the server's copy of the rules agrees with the client's", () => {
  // Differential, over a shared corpus — the mirror is a second implementation
  // and a second implementation drifts unless something watches it.
  it("stockSizeKey is byte-identical", () => {
    const corpus = ["9", "9.5", " 8", "", "Free Size", "M", "XL", "10.5", "3", "ONE_SIZE",
                    "7#", "a/b", "[9]", "$5", "  ", "9,5", "12"];
    for (const s of corpus) expect(srv.stockSizeKey(s)).toBe(stockSizeKey(s));
    for (const n of [9, 9.5, 10]) expect(srv.stockSizeKey(n)).toBe(stockSizeKey(n));
    expect(srv.stockSizeKey(null)).toBe(stockSizeKey(null));
    expect(srv.stockSizeKey(undefined)).toBe(stockSizeKey(undefined));
  });

  it("rowIsOpen is the same predicate", () => {
    const cases = [
      null, {}, { status: "open" }, { status: "open", sizeKey: "9" }, { status: "open", sizeKey: "_" },
      { status: "open", sizeKey: "" }, { status: "closed", sizeKey: "9" }, { sizeKey: "9" },
      { status: "OPEN", sizeKey: "9" },
    ];
    for (const c of cases) expect(srv.rowIsOpen(c)).toBe(rowIsOpen(c));
  });

  it("a sale closes the OLDEST matching row, and only as many as it moved", () => {
    const byRow = {
      b: { status: "open", sizeKey: "9", openedAt: "2026-09-02T00:00:00.000Z" },
      a: { status: "open", sizeKey: "9", openedAt: "2026-09-01T00:00:00.000Z" },
      c: { status: "open", sizeKey: "10", openedAt: "2026-09-01T00:00:00.000Z" },
      d: { status: "closed", sizeKey: "9", openedAt: "2026-08-01T00:00:00.000Z" },
    };
    expect(srv.decideCloses(byRow, "9", 1).map((x) => x.rowId)).toEqual(["a"]);
    expect(srv.decideCloses(byRow, "9", 2).map((x) => x.rowId)).toEqual(["a", "b"]);
    expect(srv.decideCloses(byRow, "9", 5).map((x) => x.rowId)).toEqual(["a", "b"]);
    expect(srv.decideCloses(byRow, "11", 1)).toEqual([]);
    expect(srv.decideCloses(null, "9", 1)).toEqual([]);
  });
});
