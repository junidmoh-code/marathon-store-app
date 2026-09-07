// ─── PROPERTY FUZZ — the invariants that keep this screen from destroying stock
//
// Stage 5 of the review pipeline could not run (the second-brain reviewer was
// killed three times by system memory pressure), so this is the documented
// substitute: a property fuzz of the thing under test, over randomly generated
// registers and shop floors, asserting the rules that MUST hold for every input
// rather than the handful a hand-written fixture happens to cover.
//
// The stakes, restated because they shape every property below: retiring a row
// RAISES a hub cell's expected-on-shelf. Retiring a ghost fixes a false
// discrepancy; retiring a REAL display makes the next count expect a pair that
// is out at a shop, not find it, and post a negative adjustment that destroys a
// unit which exists. So every property here is a bound on OVER-offering. Under-
// offering is safe and is not asserted against.
import { describe, it, expect } from "vitest";
import {
  classifyDisplayRecords, findUnregisteredDisplays, retirePlan,
  ACTIONABLE_CLASSES, CLEANUP_CLASSES,
} from "./displayRecordCleanup";

// Deterministic PRNG so a failure is reproducible from its seed alone.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const SIZES = ["3", "4", "5", "5_5", "6", "7", "8", "9", "10", "11"];
const STORES = ["marathon-pe", "trophy", "marathon-pine"];
const HUBS = ["hub1", "hub2"];
const PIDS = ["p1", "p2", "p3", "p4"];

/** One random world: a register for each hub, a slots node, and a catalogue. */
function world(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;

  const registers = { hub1: {}, hub2: {} };
  for (const pid of PIDS) {
    for (const hub of HUBS) {
      // 0-2 rows per product per hub, at random sizes
      const n = Math.floor(r() * 2.4);
      for (let i = 0; i < n; i++) {
        const size = pick(SIZES);
        const qty = 1 + Math.floor(r() * 3);
        const retiredAlready = Math.floor(r() * 2);     // drives bumps > qty
        registers[hub][`${pid}__${size}`] = {
          qty, bumps: qty + retiredAlready,
          at: `2026-08-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T10:00:00.000Z`,
        };
      }
    }
  }

  const slots = {};
  for (const store of STORES) {
    slots[store] = {};
    for (const pid of PIDS) {
      if (chance(0.45)) continue;                       // no record at this store
      const cleared = chance(0.3);
      const size = pick(SIZES);
      slots[store][pid] = cleared
        ? { size: null, sizeKey: null, prevSize: size, bookedHub: pick(HUBS), source: "display_sold", at: "2026-09-01T08:00:00.000Z" }
        : { size, sizeKey: size, bookedHub: pick(HUBS), source: chance(0.5) ? "display_refill" : "registration", at: "2026-09-01T08:00:00.000Z" };
    }
  }

  const productsById = new Map();
  for (const pid of PIDS) if (chance(0.85)) productsById.set(pid, { id: pid, name: `Shoe ${pid}` });
  return { registers, slots, productsById };
}

const liveSlotsFor = (slots, pid, hub) =>
  Object.values(slots).map((b) => b[pid]).filter((s) => s && s.sizeKey && s.bookedHub === hub);
const tombsFor = (slots, pid) =>
  Object.values(slots).map((b) => b[pid]).filter((s) => s && s.sizeKey == null);

describe("property fuzz — classifyDisplayRecords never over-offers", () => {
  const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

  it("every actionable row has contradicting evidence, and retireQty is bounded by it", () => {
    for (const seed of SEEDS) {
      const { registers, slots, productsById } = world(seed);
      for (const hub of HUBS) {
        const { byClass } = classifyDisplayRecords({ register: registers[hub], slots, hub, productsById, catalogueComplete: true });
        for (const cls of CLEANUP_CLASSES) {
          for (const row of byClass[cls]) {
            const ctx = `seed ${seed} hub ${hub} ${row.key} cls ${cls}`;
            // Universal bounds
            expect(row.retireQty, ctx).toBeLessThanOrEqual(row.qty);
            expect(row.retireQty, ctx).toBeGreaterThanOrEqual(0);
            if (!ACTIONABLE_CLASSES.has(cls)) continue;

            const live = liveSlotsFor(slots, row.productId, hub);
            const tombs = tombsFor(slots, row.productId);
            const sameSize = live.filter((s) => s.sizeKey === row.sizeKey);

            if (cls === "gone") {
              // Only when the catalogue genuinely has no record for it.
              expect(productsById.has(row.productId), ctx).toBe(false);
              continue;
            }
            // A row is NEVER actionable without a shop record contradicting it.
            expect(live.length + tombs.length, ctx).toBeGreaterThan(0);

            if (cls === "over") {
              expect(sameSize.length, ctx).toBeGreaterThan(0);
              expect(row.retireQty, ctx).toBeLessThanOrEqual(row.qty - sameSize.length);
            }
            if (cls === "replaced") {
              expect(sameSize.length, ctx).toBe(0);       // a matching floor would make it matched/over
              expect(live.length, ctx).toBeGreaterThan(0);
              expect(row.retireQty, ctx).toBeLessThanOrEqual(live.length);
            }
            if (cls === "sold") {
              expect(live.length, ctx).toBe(0);           // nothing on any floor at this hub
              expect(tombs.length, ctx).toBeGreaterThan(0);
              expect(row.retireQty, ctx).toBeLessThanOrEqual(tombs.length);
            }
            // Actionable means there is something to do.
            expect(row.retireQty, ctx).toBeGreaterThan(0);
          }
        }
        // matched / unverified are never offered, whatever the world looks like
        for (const cls of ["matched", "unverified"]) {
          expect(ACTIONABLE_CLASSES.has(cls)).toBe(false);
        }
      }
    }
  });

  it("THE WALK CONVERGES: repeated retires never take a row below the units the evidence cannot explain", () => {
    // The failure this closes for good: evidence with no memory re-offers
    // itself every load and walks a row to zero, taking displays that are
    // genuinely standing at untracked shops.
    for (const seed of SEEDS) {
      const { registers, slots, productsById } = world(seed);
      for (const hub of HUBS) {
        const register = JSON.parse(JSON.stringify(registers[hub]));
        let guard = 0;
        for (;;) {
          if (++guard > 40) throw new Error(`did not converge: seed ${seed} hub ${hub}`);
          const { byClass } = classifyDisplayRecords({ register, slots, hub, productsById, catalogueComplete: true });
          const next = [...ACTIONABLE_CLASSES].filter((c) => c !== "gone").flatMap((c) => byClass[c])[0];
          if (!next) break;
          const plan = retirePlan(next, hub);
          const row = register[next.key];
          // Apply exactly what removeDisplayFact would: qty down, bumps held.
          expect(plan.times).toBeGreaterThan(0);
          expect(plan.expectQty).toBe(Number(row.qty));
          row.bumps = Math.max(Number(row.bumps) || 0, Number(row.qty) || 0);
          row.qty = Math.max(0, Number(row.qty) - plan.times);
        }
        // Every surviving row is now either explained by a floor, or has no
        // evidence at all. Nothing is left that the screen would still offer.
        const after = classifyDisplayRecords({ register, slots, hub, productsById, catalogueComplete: true });
        expect([...ACTIONABLE_CLASSES].filter((c) => c !== "gone").flatMap((c) => after.byClass[c]), `seed ${seed} hub ${hub}`).toHaveLength(0);

        // AND THE BOUND THAT MATTERS: for every product, the units retired at
        // this hub never exceed the shop records that could justify them.
        for (const pid of PIDS) {
          const live = liveSlotsFor(slots, pid, hub).length;
          const tombs = tombsFor(slots, pid).length;
          let retired = 0;
          for (const [k, r] of Object.entries(register)) {
            if (!k.startsWith(`${pid}__`)) continue;
            const orig = registers[hub][k];
            retired += Math.max(0, (Number(orig.qty) || 0) - (Number(r.qty) || 0));
          }
          if (!productsById.has(pid)) continue;           // "gone" may retire the lot, by design
          expect(retired, `seed ${seed} hub ${hub} ${pid} retired ${retired} vs evidence ${live + tombs}`)
            .toBeLessThanOrEqual(live + tombs);
        }
      }
    }
  });

  it("a plan for a row the classifier will not act on moves NOTHING", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { registers, slots, productsById } = world(seed);
      for (const hub of HUBS) {
        const { byClass } = classifyDisplayRecords({ register: registers[hub], slots, hub, productsById, catalogueComplete: true });
        for (const cls of ["over", "unverified", "matched"]) {
          for (const row of byClass[cls]) {
            expect(retirePlan(row, hub).times, `seed ${seed} ${cls} ${row.key}`).toBe(0);
          }
        }
      }
    }
  });

  it("a world with NO shop records offers nothing at all", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const { registers, productsById } = world(seed);
      for (const hub of HUBS) {
        const r = classifyDisplayRecords({ register: registers[hub], slots: {}, hub, productsById, catalogueComplete: true });
        // Only "gone" can fire without a floor, and only for a missing product.
        for (const cls of ["replaced", "sold"]) expect(r.byClass[cls], `seed ${seed}`).toHaveLength(0);
        for (const row of r.byClass.gone) expect(productsById.has(row.productId)).toBe(false);
      }
    }
  });

  it("an unanswered catalogue offers nothing at all", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const { registers, slots } = world(seed);
      for (const hub of HUBS) {
        const r = classifyDisplayRecords({ register: registers[hub], slots, hub, productsById: new Map(), catalogueComplete: false });
        expect(r.byClass.gone, `seed ${seed}`).toHaveLength(0);
      }
    }
  });

  it("classification is total, disjoint and lossless — every live row lands in exactly one class", () => {
    for (const seed of SEEDS) {
      const { registers, slots, productsById } = world(seed);
      for (const hub of HUBS) {
        const live = Object.entries(registers[hub]).filter(([k, v]) => (Number(v.qty) || 0) > 0 && !k.endsWith("___"));
        const r = classifyDisplayRecords({ register: registers[hub], slots, hub, productsById, catalogueComplete: true });
        const seen = CLEANUP_CLASSES.flatMap((c) => r.byClass[c].map((x) => x.key));
        expect(seen.length, `seed ${seed} hub ${hub}`).toBe(live.length);
        expect(new Set(seen).size, `seed ${seed} hub ${hub}`).toBe(live.length);   // no row in two classes
      }
    }
  });
});

describe("property fuzz — findUnregisteredDisplays never invents work", () => {
  it("every reported floor is live, and every REGISTERABLE one truly has no row", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { registers, slots, productsById } = world(seed);
      const rows = findUnregisteredDisplays({ slots, registerByHub: registers, productsById });
      for (const row of rows) {
        const ctx = `seed ${seed} ${row.store}/${row.productId}`;
        const slot = slots[row.store][row.productId];
        expect(slot.sizeKey, ctx).toBe(row.sizeKey);            // it is the live floor it claims
        expect(slot.sizeKey, ctx).not.toBeNull();
        if (!row.registerable) continue;
        // Registerable means: this hub keeps a register, and it has NO row for
        // this product at ANY size. Registering when a row exists at another
        // size would claim a second display for one physical pair.
        const reg = registers[row.bookedHub];
        expect(reg, ctx).toBeTruthy();
        const anyRow = Object.keys(reg).some((k) => k.startsWith(`${row.productId}__`) && (Number(reg[k].qty) || 0) > 0);
        expect(anyRow, ctx).toBe(false);
      }
      // Nothing that IS registered at its own size may be reported.
      for (const [store, byPid] of Object.entries(slots)) {
        for (const [pid, s] of Object.entries(byPid)) {
          if (!s.sizeKey) continue;
          const reg = registers[s.bookedHub];
          if (reg && (Number(reg[`${pid}__${s.sizeKey}`]?.qty) || 0) > 0) {
            expect(rows.find((x) => x.store === store && x.productId === pid), `seed ${seed} ${store}/${pid}`).toBeUndefined();
          }
        }
      }
    }
  });

  it("THE TWO TABS NEVER OFFER THE SAME PAIR: a floor is registerable only if no row claims it", () => {
    // The bug this whole thread began with is one physical pair carrying two
    // display facts. If Not Registered could register a floor whose product
    // already has a row, that is precisely how a second fact gets minted.
    for (let seed = 1; seed <= 400; seed++) {
      const { registers, slots, productsById } = world(seed);
      const unreg = findUnregisteredDisplays({ slots, registerByHub: registers, productsById });
      for (const row of unreg.filter((x) => x.registerable)) {
        // Only the floor's OWN hub: a product can legitimately have a display
        // at hub1 that nothing registers and a separate, properly registered
        // one at hub2. Those are two pairs, not one pair counted twice.
        const hub = row.bookedHub;
        const { byClass } = classifyDisplayRecords({ register: registers[hub], slots, hub, productsById, catalogueComplete: true });
        const touching = CLEANUP_CLASSES.flatMap((c) => byClass[c]).filter((x) => x.productId === row.productId);
        expect(touching, `seed ${seed} ${row.productId} in both tabs at ${hub}`).toHaveLength(0);
      }
    }
  });
});
