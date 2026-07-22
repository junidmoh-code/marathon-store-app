# RTDB rules — permit qty-0 stock-cell seed / metadata write

**Status:** PROPOSAL. Not deployed. Deploy is a stop-and-ask; holds for the owner's explicit go.
**Deploy mechanism:** direct PUT of `rules-proposed-stock-seed-20260722.json` to `.settings/rules.json` (live rules are managed out-of-repo; the repo `database.rules.json` is stale and is NOT the deploy source).
**Backup / rollback:** `rules-backup-live-before-stock-seed-20260722.json` (fresh live, fetched 2026-07-22). Rollback = re-PUT that file.

---

## Why

Two things depend on writing a stock cell that **isn't a movement**:

1. **CountSession is broken in production (independent of Solve).** When a counter enters a value that equals the current cell (`delta === 0`, including confirming a **true zero**), CountSession calls `setCellState(loc, pid, size, "live")` — a metadata/seed write. The live stock `.validate` requires a movement `lastType` and a changed `mv`, so this write is **rejected**. Effect: no-change and zero-confirmation counts fail with a cryptic *"N counted, N failed"* toast, and such cells can never be marked `live` by counting. **Evidence:** 0 cells with `lastType:"count"` and 0 with `mv:"seed"` exist across all of `/stock` — the write has never once landed.

2. **The "Solve" action (#267)** seeds a qty-0 carriage cell so the refill engine adopts a stranded product. Same `setCellState` primitive, same rejection.

### This is a NEW allowance, not a restore

The stock `.validate` has been **movement-only in every deployed snapshot** (2026-06-19, 2026-07-12, 2026-07-21 all checked). The `lastType` enum has only ever *expanded* (added `opening`, `transfer_in`); `count` was never in it, and there has never been a metadata/seed branch. So `setCellState` has **never** worked under deployed rules — this is a client/rules mismatch, not a regression. Widening the rule is therefore a deliberate new decision, evaluated below as such.

---

## The change — exactly one `.validate`, movement branch untouched

Machine-verified: the only path that differs from live is `rules/stock/$loc/$pid/$size/.validate`, and the **entire existing movement expression is preserved byte-for-byte** as the first OR-branch. Two branches are added.

### BEFORE (live)
```
".validate": "newData.hasChildren(['qty','v','mv','lastType']) && newData.child('qty').isNumber() && newData.child('qty').val() % 1 === 0 && newData.child('v').isNumber() && (!data.exists() ? newData.child('v').val() === 0 : newData.child('v').val() === data.child('v').val() + 1) && newData.child('mv').val() !== data.child('mv').val() && newData.child('lastType').val().matches(/^(received|opening|sold|transfer_in|transfer_out|adjustment|return)$/) && (newData.child('qty').val() >= 0 || newData.child('lastType').val().matches(/^(sold|return|transfer_out|transfer_in)$/))"
```

### AFTER (proposed) — `(MOVEMENT) || (SEED) || (METADATA)`
```
".validate": "(<<the BEFORE expression, verbatim>>) || (!data.exists() && newData.hasChildren(['qty','v','mv','lastType']) && newData.child('qty').isNumber() && newData.child('qty').val() === 0 && newData.child('v').isNumber() && newData.child('v').val() === 0) || (data.exists() && newData.child('qty').val() === data.child('qty').val() && newData.child('v').val() === data.child('v').val() && newData.child('mv').val() === data.child('mv').val() && newData.child('lastType').val() === data.child('lastType').val())"
```

- **SEED branch:** `!data.exists()` (new cell only) AND `qty === 0` AND `v === 0` AND `lastType === 'count'` AND `mv === 'seed'` — pinned to exactly what `setCellState` writes. Creates an empty carriage cell. **Cannot create non-zero stock, and cannot forge a movement-looking `lastType`/`mv`.**
- **METADATA branch:** `data.exists()` (existing cell only) AND `qty`, `v`, `mv`, `lastType` **all unchanged** AND a **valid `state`** present (`untracked|counting|live`). Permits a state/updatedAt/updatedBy write without a movement. **Cannot change quantity, version, or the movement identity, and cannot delete `state`.**

*(Both branches tightened from the first draft per Kimi's review: SEED was pinning only qty/v — now also `lastType`/`mv`; METADATA now requires a valid `state`, closing the "delete state / arbitrary marker" gap so the widening matches the stated scope exactly.)*

`.write` is unchanged (still `stockRole` required). Per-child `.validate`s (qty isNumber, `state` regex, `$other` requires qty) are unchanged and still apply. The full before/after blocks are in `rules-proposed-stock-seed-20260722.json` vs `rules-backup-live-before-stock-seed-20260722.json`.

---

## What a client can do after this that it can't now — the attacker's view

A caller already needs a `stockRole` (the `.write` gate is unchanged; anonymous and non-stock users are still fully blocked). For such a caller, the new powers are:

1. **Create arbitrary qty-0 stock cells** at any `loc/pid/size`. Abuse: seed thousands of empty cells to make the refill engine treat products/locations as **carried**, causing it to raise refill requests / manage assortment it shouldn't. Blast radius is **operational churn**, not inventory fraud — every seeded cell is **qty 0**, so **no phantom stock is created** and no financial/inventory value is fabricated. The SEED branch's `qty===0 && v===0` hard-caps this.
2. **Flip an existing cell's `state`/`updatedAt`/`updatedBy` without a movement.** Abuse: mark a cell `live`/`counting`/`untracked` out of band, or churn `updatedBy`. The METADATA branch forbids touching `qty`/`v`/`mv`/`lastType`, so **on-hand counts and the movement ledger identity cannot be altered** — only the tracking-state metadata.

Neither branch can: set a non-zero quantity, decrement/inflate stock, overwrite an existing cell's qty, or forge a movement type. The movement branch — the only path that changes real quantities — is byte-identical to today. Net: the widening lets a trusted stock user create empty cells and flip tracking metadata; it does not expand any path that moves or fabricates inventory.

---

## Deploy plan (on the owner's explicit go only)
1. Backup already captured: `rules-backup-live-before-stock-seed-20260722.json`.
2. `PUT rules-proposed-stock-seed-20260722.json` → `.settings/rules.json`.
3. Verify live `.validate` now contains all three branches; smoke-test a CountSession zero-confirm and a Solve seed.
4. Rollback if anything is off: re-PUT the backup.

Reviewed by CodeRabbit + Codex + Kimi before any deploy. Rules deploys are stop-and-ask, always.
