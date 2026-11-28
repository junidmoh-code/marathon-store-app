# Duplicate kids' Dunk: plan (dry run, 28 Nov 2026)

Produced by `node scripts/merge-dunk-grey-kids/plan.mjs --out scripts/merge-dunk-grey-kids/out/plan.json`.
Nothing was written. The plan uses the merge's own rule
(`functions/lib/merge-disposition.cjs` `planMerge`), so it cannot disagree
with what the merge would do.

## Per location and size: duplicate qty → original (before → after)

| Location | Size | Duplicate | Original before | Original after | Action |
|---|---|---|---|---|---|
| central | 24 | 3 | 0 | 3 | transfer |
| central | 25 | 3 | 0 | 3 | transfer |
| central | 26 | 4 | 0 | 4 | transfer |
| central | 27 | 5 | 0 | 5 | transfer |
| central | 28 | 4 | 0 | 4 | transfer |
| central | 29 | 3 | 0 | 3 | transfer |
| central | 30 | 4 | 0 | 4 | transfer |
| central | 31 | 4 | 2 | 6 | transfer |
| central | 32 | 5 | 1 | 6 | transfer |
| central | 33 | 5 | 0 | 5 | transfer |
| central | 34 | 5 | 0 | 5 | transfer |
| central | 35 | 5 | 0 | 5 | transfer |
| hub3 | 24–35 | 0 each | — | unchanged | empty cell dropped (no movement) |

Stock never moves between locations: Central's pairs stay at Central.

## Total check

Original 26 + duplicate 50 = **76 before**; original 76 + duplicate 0 = **76 after**. **Unchanged.**
No cell is counted under the original, so nothing would be written off.

## Blocked: step 3 refuses

21 open refill requests name the duplicate (see INVESTIGATION.md). The merge
would delete the Central cells those requests send from. Dealing with them,
whether by re-pointing, cancelling or letting them be sent, is a refill-request
decision, and under CLAUDE.md that decision belongs to Junid. Cancelling through the
Refill Queue's "Out of Stock" is also not neutral: the engine reads a cancel
with no reason as a human refusal (cooldown and learning).

## Step 3 result (28 Nov 2026)

`apply.mjs` ran against live data and **refused**, as it should. Nothing was
written: no stock moved and the duplicate was not merged away.

**Simplest way through, with no request change:** let Central send the 21
requests as they stand. They cover the duplicate's 50 pairs size for size, so
the pairs end up at Hub 1 and Hub 3 under the duplicate. Then run
`node scripts/merge-dunk-grey-kids/apply.mjs --apply`. It re-reads everything
and joins each hub's duplicate cells into the original's cells at that same
hub, keeping the total. It refuses on its own while any request is still open.
