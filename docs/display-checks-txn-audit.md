# Display Checks — cold-cache transaction audit

## Headline finding (why the shared primitive exists) — and its honest limit
**Site #4 — the wake sweep's held→open flip — was an unlatched resurrection site, missed by every
prior PR because it was never in-diff.** Bump (#1) and completion (#6) each got the `firstRun` latch
when a reviewer happened to be looking at *that* file; the wake flip carried the identical
`cur === null ? preRead` shape the whole time and no one saw it, because the fix always landed
somewhere else. That is the copy-paste latch-**omission** this refactor eliminates: with one shared
`guardedMutate` primitive, the null-handling is correct in one place and every present and future
two-path write inherits it — no "sixth site outside the diff" to miss.

**But the primitive is not the whole story, and claiming it is would be the overclaim.** The `firstRun`
latch closes the **retry-path** resurrection (a null delivered to a *later* callback). It does **not**
close the **cold-cache single-round-trip delete race**: in a Cloud Function the first callback runs on
`null`, the write is sent with expected-hash = `hash(null)`, and if the record was deleted after
`preRead` and the server value is also null, the hashes match and the server **commits `mutate(preRead)`
on the first callback** — no re-invocation, the latch never runs, the record is resurrected. (Kimi
review, PR #254.)

**So the honest "why the primitive exists" has three clauses:**
1. The primitive closes the copy-paste latch-**omission** (every mutate site is provably latched — GUARD 1, `assertLatchAbortsOnAuthoritativeNull`).
2. The **never-delete-an-active-record invariant** closes the cold-both-null race the latch cannot — the sole deleter (prior-day tombstone reaping) can't touch a record a mutation is actively holding, and sweeps don't overlap. This is the load-bearing fact for the entire class of unreachables.
3. **The invariant is only safe as long as every future delete is checked against it** — and that is the clause with no guard until now. GUARD 2 (`assertNeverDeletesActiveRecord`) + the stop condition below give it one.

## STOP CONDITION for PR 11 (roster-lock) and PR 12 (marks) — and any PR adding a delete
The never-delete invariant is now load-bearing for the safety of **every** guardedMutate site. Any PR
that adds a delete to an active-record path — roster-lock cleanup, marks, retention/TTL, a "cancel
check" action, a backfill script — **MUST, in its own diff, do one of:**
- **(a)** route the delete through `reapTombstone`'s completed-only path (never delete a `held`/`open`
  record), **or**
- **(b)** if it must delete an active record, re-verify the cold-both-null unreachability at **every**
  `guardedMutate` site against the new delete, and add the reasoning to this doc.

Either way it **MUST** extend `assertNeverDeletesActiveRecord` to cover the new delete path. A PR that
adds an active-record delete without doing (a) or (b) **does not merge** — it silently re-opens the
resurrection at every guardedMutate site, outside its own diff, which is exactly how this class
recurred six times.

---



Every RTDB `.transaction()` across the four live displayChecks Cloud Functions, its cold-cache
first-run handling, and whether an **authoritative null** (a genuinely-deleted record reaching a
*later* transaction callback) can resurrect a record. Audited at `origin/main` = `6561d01`
(onClothingSale-00005-cug, wakeHeldChecks-00002-fac, completeDisplayCheck-00001-lor — all LIVE).

## The class this audit is hunting
Six times the same shape shipped or nearly shipped: `cur === null ? fallback : mutate`. In a Cloud
Function the RTDB client has no local cache, so a transaction's **first** callback runs against
`null`; returning `undefined` there aborts before the server round-trip (silent write loss), so the
fix forces the round-trip with `cur === null ? preRead`. The trap: on a **later** callback the server
value can be authoritatively `null` (the record was genuinely deleted/reaped), and the same branch
then substitutes the stale `preRead` and **resurrects** it. The correct guard is a `firstRun` latch:
`preRead` rescues only the *first* callback; any later `null` aborts.

## The full set (6 transactions)

| # | Call site | file:line | Kind | Cold-null handling | Auth-null (later callback) | Verdict |
|---|-----------|-----------|------|--------------------|----------------------------|---------|
| 1 | `bumpCheck` flip | onClothingSale.js:98 | mutate-existing | `firstRun` latch → `preRead` on first run only | **aborts** (latch flips) | ✅ CORRECT (latched, PR-A) |
| 2 | idempotency lease claim | onClothingSale.js:156 | **create/claim-on-absent** | `processedClaimDecision(null)` → returns a claim object (writes the lease) | writes the claim (creates the lease) | ✅ CORRECT — write-on-null *by design*; nothing to resurrect |
| 3 | create path | onClothingSale.js:218 | **create-on-absent** | `cur===null‖completed ? check` → writes a *fresh* check | writes the fresh check (a create) | ✅ CORRECT — write-on-null *by design*; new checkId, not a resurrection |
| 4 | `applyInPlace` (held→open flip / stock_seen / re_held) | wakeHeldChecks.js:79 | mutate-existing | `cur === null ? preRead` — **NO latch** | **would resurrect** `preRead` (held) — but see reachability below | ⚠️ **EXPOSED SHAPE** (unlatched); exploit **not currently reachable** |
| 5 | `reapTombstone` (delete-if-stale) | wakeHeldChecks.js:119 | conditional delete | `cur === null ? preRead`; returns `null`(delete) / `undefined`(abort) | returns `null` → deletes an already-null slot = harmless no-op | ✅ SAFE — a delete txn can't resurrect (never returns a record) |
| 6 | `completeDisplayCheck` flip | completeCheck.js:150 | mutate-existing | `firstRun` latch → `preRead` on first run only | **aborts** (latch flips) | ✅ CORRECT (latched, Codex fix #249) |

## Two findings that matter

### Finding A — `applyInPlace` (site #4) carries the exposed shape, unlatched
It is the only mutate-existing transaction still using the bare `cur === null ? preRead` without a
`firstRun` latch — the exact copy-paste the other two mutate sites (#1, #6) were fixed to remove.

**Reachability: NOT currently reachable.** `applyInPlace` is only ever called for `status === "held"`
records (wakeHeldChecks.js:155 gates it). A held record's slot can go authoritatively `null` only if
something *deletes* it — and the module's **only** deleter is `reapTombstone`, which deletes only
`isStaleTombstone` records (`status === "completed"` + prior SA day). A held record is never
completed (`completeDisplayCheck` is open-only) → never reaped → never deleted. So the authoritative
`null` that would trip the resurrection cannot occur today.

**Why it still matters:** it is instance-seven-in-waiting. The exploit is one code change away — the
day any path deletes a held/open record (a manual cleanup, a "cancel check" feature, a future reaper
tweak), site #4 becomes a live resurrection bug, and it will be *outside that change's diff* — exactly
how the previous six recurred. The latch costs nothing and closes it now.

### Finding B — the create/claim sites (#2, #3) cannot use an auth-null-ABORT primitive
Sites #2 and #3 **must write on an authoritative null** — that null *is* "the slot is empty, create
the record." They are not resurrection risks (site #2 creates a lease; site #3 writes a *fresh*
checkId — neither resurrects a prior record). If they were routed through a primitive whose rule is
"authoritative null → abort," creation would break and behavior would change.

**This changes the JOB 2 plan as written** ("migrate … the create path" onto the same wrapper). The
shared primitive has to distinguish two shapes:
- **mutate-existing / guarded** (sites #1, #4, #5, #6): cold-null → `preRead`; later-null → **abort**.
- **create-on-absent** (sites #2, #3): cold-null → `preRead`-or-nothing; later-null → **write the
  create value** (never abort).

## Recommended primitive shape (for your sign-off before I build)
One wrapper, two explicit modes so a caller physically cannot pick the wrong null-handling:

- `guardedMutate({ ref, preRead, mutate })` — `mutate(nonNullCurrent) → next`. Wrapper owns: cold-null
  → `mutate(preRead)`; **later-null → abort** (closes the retry-path resurrection; NOT the cold-both-null
  case — see the honest-scope note in the headline). Sites **#1, #4, #6** migrate here (identical
  behavior on every reachable path; #4 *gains* the latch — closing the copy-paste omission). Site **#5**
  (reap) fits too with `mutate` returning `null` to delete.
- `guardedCreate({ ref, preRead, decide })` or keep #2/#3 on their own tiny helper — the write-on-null
  shape, kept **separate** from the abort-on-null shape. This is the honest split: they are a
  different, safe-by-design pattern, not the bug this session removes.

The reusable assertion `assertLatchAbortsOnAuthoritativeNull(txn)` applies to the **guardedMutate**
sites (#1, #4, #5, #6). It does **not** apply to the create/claim sites (they *should* write on null),
which is itself the proof they're a different shape. It pins the retry-path abort; the never-delete
invariant (GUARD 2) — not this assertion — covers the cold-both-null case.

## Verdict for the stop condition
No transaction is **reachably** exposed today (sites #1, #6 latched; #4 unlatched but its exploit is
unreachable; #5 is a delete; #2, #3 write-on-null by design). **But** two things change the plan and
warrant your eyes before centralizing: (A) site #4 is unlatched and is the next-instance-in-waiting,
and (B) the create/claim sites can't share an abort-on-null primitive. Hence: **stop, show, confirm
the two-mode split, then build.**

## Resolution (built to the signed-off shape)
`functions/displayChecks/guardedTransaction.cjs` — `guardedMutate` (cold-cache latch + authoritative-
null abort) and `guardedCreate` (write-on-null by design). All six sites migrated:
- **guardedMutate:** #1 bumpCheck, #4 wake flip (now latched — Finding A closed), #5 reap
  (mutation returns `null` to delete), #6 completion flip.
- **guardedCreate:** #2 lease claim, #3 create path.

Two reusable guards (functions/test/helpers/guarded-txn.cjs):
- **GUARD 1 — `assertLatchAbortsOnAuthoritativeNull`** applied to all four guardedMutate sites with
  their real mutations (#6 via the exported `completionFlipMutation`, not a copy). Scoped honestly to
  the retry-path abort; the fake models the RTDB wire (datastale re-invocation), and an explicit
  LIMITATION test demonstrates the cold-both-null commit the latch cannot stop. The mode split is
  enforced both directions (mutate-in-create fails GUARD 1; create-in-mutate fails to create).
- **GUARD 2 — `assertNeverDeletesActiveRecord`** applied to the live deleter (the wake sweep), proving
  it reaps only completed tombstones and never deletes a held/open record. This is the guard for the
  load-bearing invariant; see the PR-11/12 stop condition above.

**Behaviour-identical: every pre-existing test passes unchanged** (functions 178/178; no expected
output altered).
