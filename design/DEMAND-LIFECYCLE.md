# Demand Lifecycle — the complete state map

Every possible state a unit of demand can be in, derived from the shipped
engine (`functions/lib/refill-engine.cjs`, v9 + 2026-07-13 hardening). One
guarantee governs everything below: **demand can wait, but it can never
vanish** — every state is visible somewhere, and every wait has a defined,
automatic exit.

The engine re-derives ALL of this from scratch every 15 minutes (stateless):
`demand = target − on-hand − inbound` per (location, product, size).

---

## State 0 — Not yet demand (no target)

A cell with no target computes no demand. Every such cell with stock is
surfaced somewhere — none are silent:

| State | Where it shows | Exit |
|---|---|---|
| Genuinely NEW (Central only, never circulated) | Decision Queue → introduction wizard | human sets targets (+ optional initial distribution) → managed |
| Untargeted stocked size under a managed product (numeric sizes, or a NEW size arriving after introduction — incl. new sizes landing at Central, surfaced on the Hub 2 card) | Decision Queue → "Set targets" | human sets targets → managed |
| Assortment leftover (targets exist at another location) | Decision Queue → include / transfer / exclude | human decision |
| Unintroduced (zero targets anywhere, circulating) | Health → Introduce Existing (one-tap migration) | standard run applied → managed |
| Postponed (snooze until date · until stock moves · keep) | suppressed, recorded in decisions | timer lapse / any stock movement resurfaces it |
| Excluded (explicit target 0) | never demand; all stock counts as excess | human raises the target |

## Path A — the happy path

```
Demand detected (deficit > 0)
   ↓  source has stock (net of ALL reservations)
REQUEST CREATED  — qty = min(deficit, free source units, max per request)
   ↓  store legs → R### card in Warehouse → Clothing
   ↓  hub legs   → request in Source → Hub 2 Refill
OPEN (reserved: no duplicate can ever be created for this cell)
   ↓  warehouse transfers (full or partial; counted or uncounted-override)
FULFILLED → CLOSED   (partial remainder = fresh demand next scan)
```

While OPEN, a request is continuously reconciled every scan:

| Event while open | Result |
|---|---|
| Stock arrives by another path (manual transfer, return, adjustment) and the need is gone | **self-reversal**: withdrawn, card deleted, no cooldown |
| Source sells out | withdrawn (`awaiting_upstream`), no cooldown → parks passively; re-creates the moment the source restocks |
| Network stock hits zero | withdrawn (`unfillable`) → supplier reorder list |
| Targets/stock/reservations change | **auto-resized** to the exact current need (in-flight picks are never touched) |
| Warehouse rejects it | → Path D |
| Open > 48h untouched | flagged **Stuck Refills** in Health (visibility; stays open) |
| Crashed scan left a half-created lock | self-heals within the hour; demand re-proposes the same scan |

## Path B — source empty, chain flowing

```
Demand detected
   ↓  source empty, BUT its own upstream has stock
   ↓  (and the source has a buffer target, and its leg isn't rejection-parked)
AWAITING PREVIOUS TRANSFER   (Health card — visibility, not work)
   ↓  upstream leg created THIS scan (the cascade: Central → Hub 2 first)
   ↓  source physically receives
QUEUE CREATED automatically next scan → Path A
```
No downstream request ever exists before its upstream leg is fulfilled, and
nobody re-creates anything by hand.

## Path C — chain empty

```
Demand detected
   ↓  source empty AND nothing upstream of it
WAITING FOR SUPPLIER   (Health card; three labelled flavors:)
   • upstream chain empty → reorder or return stranded stock via Move Excess
   • upstream leg blocked (recently rejected / confirmed-out)
   • source has NO buffer target for this size → config gap, set one
   ↓  supplier stock arrives at Central (or excess returns)
Path B → Path A automatically
```
Zero stock anywhere in the whole network is the extreme case: it goes to the
**Missing Sizes reorder list** — pure purchasing signal, never a queue card —
and returns to the flow the moment inventory appears anywhere.

## Path D — human rejection (the "no" memory)

```
OPEN request → warehouse rejects ("not physically here")
   ↓
WAITING FOR STOCK   (24h cooldown; visible in Health)
   ↓  EITHER stock physically ARRIVES at the location that said no
   ↓         (any inbound ledger movement with a positive resulting balance —
   ↓          bookkeeping fixes don't count) → reopens within 15 minutes
   ↓  OR the 24h cooldown lapses (and stock exists) → one re-ask
QUEUE REOPENS automatically
```
Escalation: rejected at BOTH supply levels within 14 days = **CONFIRMED OUT** —
the shelves beat the database; no requests anywhere; sits on the reorder list.
A fresh arrival at either denying level un-confirms it immediately.

## Path E — deferred by pacing (never lost)

```
Demand detected → request computed → circuit breaker / scan time budget hit
   ↓
DEFERRED (counted in the run record)
   ↓  next scan, 15 minutes later
QUEUE CREATED
```

## The inverse flow — excess (demand's mirror)

Above-target stock follows the same philosophy in reverse: engine recommends
(Move Excess: deficit-covering units → Hub 2, true surplus → Central,
destination-first batching), warehouse executes manually. Store surplus that
the network needs is never routed to Central (Cortez rule); Hub 2's held
surplus flows onward automatically via normal refill legs.

## Terminal states

Every request ends in exactly one of: **fulfilled** (full/partial, ledger-
linked), or **cancelled** with a recorded reason (`rejected by human`,
`no_longer_needed`, `unfillable`, `awaiting_upstream`) and `resolvedAt`.
History is never deleted — the request record plus the movements ledger
reconstruct every decision after the fact.

## The invariants (what "can't happen")

- No duplicate request per (location, product, size) — ever (lock-enforced).
- No request the source cannot physically fill at creation time.
- Combined asks never exceed the source's on-hand (reservation-threaded).
- No card deleted or resized under a picker's hands (in-flight guards +
  conditional transactions).
- No demand silently dropped: every non-queue state above has a Health surface
  and an automatic exit.
