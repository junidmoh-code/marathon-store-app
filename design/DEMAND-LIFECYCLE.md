# Refill Engine — Demand Lifecycle (Production Specification)

> Owner-authored specification, 2026-07-14. This is the canonical description
> of the engine's behavior — for warehouse training, operations questions
> ("why is this sitting in Waiting for Supplier?"), and future debugging.
> Engine-level precision notes are in the appendix.

## Core Principle

**Demand can wait, but it can never disappear.**

Every demand state is visible somewhere in the system, and every waiting state
has a defined automatic exit.

The refill engine is stateless. Every 15 minutes it recomputes demand from
current inventory, targets, reservations, movements, and supply-chain state.

## Path A — Normal Refill

```
Demand detected
  ↓ Source has available stock
Request created (quantity = exact deficit, limited by available
                 source stock and reservations)
  ↓ Warehouse Queue
  ↓ Warehouse fulfils
Request closes
```

**Continuous reconciliation while open** — an open request automatically
updates itself if reality changes:

- Manual transfer satisfies demand → request withdraws.
- Inventory changes → request auto-resizes.
- Source sells out → request withdraws; demand parks (Waiting for
  Supplier / Awaiting Previous Transfer) and re-creates on restock.
- Request becomes stale → automatically reconciled.
- Stuck for excessive time → flagged for investigation.

## Path B — Cascading Supply Chain

```
Store needs stock
  ↓ Hub 2 empty
  ↓ Central has stock
Awaiting Previous Transfer
  ↓ Central → Hub 2 request
  ↓ Hub 2 receives stock
Store request automatically appears
  ↓ Warehouse fulfils
Closed
```

**No downstream request is ever created before its upstream transfer exists.**

## Path C — Supplier Chain Empty

```
Demand detected
  ↓ No stock anywhere upstream
Waiting for Supplier
  ↓ Supplier delivers → Central receives
Cascade resumes automatically
  ↓ Warehouse Queue
Closed
```

If stock exists nowhere in the network, the size also appears in the
**Reorder List**.

## Path D — Rejection Memory

```
Warehouse rejects
  ↓
Waiting for Stock
  ↓ Stock arrives
Request automatically reopens (within one scan)
```

Rules:

- Single rejection → 24-hour cooldown.
- Double rejection (both supply levels) → Confirmed Out (14-day cooldown).
- Any genuine stock arrival immediately removes the cooldown.

**Warehouse decisions are never forgotten, but they never permanently block
demand.**

## Path E — Engine Pacing

```
Demand calculated
  ↓ Deferred by circuit breaker
Automatically proposed during a later scan
  ↓ Warehouse Queue
```

Demand is delayed, never lost.

## Pre-Demand States

Demand cannot be calculated until the engine knows the intended stock level.
Untargeted inventory therefore appears in the **Decision Queue**:

- Brand-new supplier product.
- New size introduced to an existing product (including sizes arriving at
  Central — surfaced at the Hub 2 buffer).
- Existing product awaiting migration.
- Assortment decision.
- Explicit exclusion.
- Deferred decision (always resurfaces — by timer or by stock movement).

Once targets exist, the engine manages that inventory forever.

## Operational Guarantees

Every demand must always exist in exactly one visible state:

Warehouse Queue · Source → Hub 2 Queue · Waiting for Previous Transfer ·
Waiting for Supplier · Waiting for Stock · Decision Queue · Reorder List ·
Closed.

**There is no hidden state.**

## Engine Invariants

The following must always remain true:

1. No duplicate requests.
2. No duplicate reservations.
3. No zombie requests.
4. No oversized requests.
5. No incorrect assortment routing.
6. No queue/request mismatches.
7. No source over-allocation.
8. No request larger than the current mathematical deficit.
9. No request larger than currently available source inventory.
10. No request modified while actively being fulfilled.
11. No silent demand loss.

## Warehouse Philosophy

The refill engine exists to **create** work — not perform it.

> The engine calculates.
> The engine recommends.
> The warehouse validates.
> The warehouse executes.

Every recommendation is mathematically derived from live inventory, targets,
reservations, movements, and supply-chain rules. **The warehouse always has
the final operational decision.**

---

## Appendix — engine-level precision notes

(Implementation reference: `functions/lib/refill-engine.cjs`.)

- **Arrival lift (Path D):** an "arrival" is any inbound ledger movement at
  the location that rejected, timestamped after the rejection, whose
  resulting balance is positive — bookkeeping corrections (negative-to-zero
  fixes) and arrivals swallowed by oversell holes do not count.
- **Waiting for Supplier has three labelled flavors:** upstream chain empty
  (reorder / return excess); upstream leg blocked (recently rejected or
  confirmed-out); source has no buffer target for the size (config gap — set
  one in the Decision Queue).
- **Reservation threading:** free source units = on-hand − all open-request
  reservations − same-scan allocations, evaluated in deterministic order, so
  sibling requests and resizes can never jointly over-promise a source.
- **In-flight protection:** a card whose fulfilment has locked its split, or
  whose order has a ledger movement linked to it, is never withdrawn or
  resized; the scan's writes are conditional transactions that re-read live
  state (a stale plan can never clobber a concurrent fulfilment).
- **Self-healing:** pending locks orphaned by a crashed scan are removed
  after one hour and the demand re-proposes the same scan; deferred work
  (circuit breaker / apply time budget) re-proposes next scan; everything is
  re-derivable because the engine never trusts its own prior output.
- **Excess is demand's mirror:** Move Excess recommends a deficit-first split
  (network needs → Hub 2, never Central — the Cortez rule; true surplus →
  Central), destination-first batching, warehouse executes manually. Hub 2's
  held surplus flows onward automatically via normal refill legs.
