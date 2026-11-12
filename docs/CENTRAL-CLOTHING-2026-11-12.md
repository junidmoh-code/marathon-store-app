# Pine/Concrete clothing from Central; Hub 3 sneakers only — 12 Nov 2026

Junid's prompt of 12 Nov 2026 (authorised for Hub 3, Pine and Concrete only).
Hub 1, Hub 2, Marathon PE and Trophy are pinned unchanged
(`functions/test/marathon-unchanged.pin.test.cjs`,
`src/components/stock/marathonSolveUnchanged.test.js`).

## The model

| Where | What | Keep | From |
|---|---|---|---|
| Pine, Concrete | everything that is not footwear | 2 per size, 5 per design with no size; any shortfall, single pieces included | Central |
| Concrete | perfume | none (never kept there) | — |
| Hub 3 | footwear (seated products, every declared size) | 2 per size, ask at 1 | Central |
| Hub 3 | anything that is not footwear | none, never seated, never Solved | — |

Footwear is the engine's division test (`isDivisionFootwear`: category
"Footwear", or one of the eight footwear category keys). On the 12 Nov
snapshot it agrees with the catalogue rule (`productIsFootwear` + the legacy
category) on every Hub 3 product: 0 disagreements.

## Census (snapshot 2026-11-12 08:51 UTC, `scripts/audit/hub3-clothing-census.mjs`)

- Hub 3 non-footwear: **360 cells above zero, 147 products, 727 units**; 49
  cells at zero (33 products, 8 of them with no product record); **0 negative**.
- Categories: tracksuits 223 u, soccer jerseys 174, t-shirts 133, golf
  t-shirts 54, "Clothing" 42, pants 35, shorts 31, hoodies 26, ladies
  tracksuits 9. Perfumes at Hub 3: 13 products, all at zero. Visors: 4, at zero.
- Hub 3 non-footwear seats: 166 (147 by stock, 19 by a zero cell). **None
  carries an owning shop** — the Pine-or-Concrete chooser was never used.
- Open Hub 3 non-footwear requests: 0. Open Concrete/Pine non-footwear requests
  sourced from Hub 3: 0. Engine locks naming either: 0.
- On the Hub 3-owned path today (asking Hub 3 for at least one size): Concrete
  48 products, Pine 51.
- Explicit `/stock_targets` rows: Hub 3 non-footwear 28 (5 above zero —
  overridden by the new rule, left in place); Concrete 5 rows at the retired
  from-Hub 3 keep (1 per size, ask at 0 — one product, the Adidas Bafana
  Bafana green jersey), edited in place to 2 by the transfer script.
- Hub 3 clothing cells carrying a trust stamp: 12 of 360. Seated shop shelves
  are read raw, so the moved quantities count at Concrete as they are; trust
  is not stamped by the move.

## The transfer (`scripts/hub3-clothing-to-concrete.mjs`)

Dry run on live data: **727 units, 360 cells, 147 products → Concrete**. By the
shops each product is seated at today (no seat ever named an owner): Concrete
only 30 products / 178 units, both shops 18 / 108, **Pine only 33 / 206**,
neither 66 / 235. Perfumes moved: 0. Negative cells: 0. Zero cells removed: 49.
Seated at Concrete: 147. Hub 3 non-footwear seats switched off: 166. Requests
withdrawn: 0.

One `transfer_in` movement per cell (`h3cl_20261112_<pid>_<sizeKey>`, reason
`hub3_clothing_to_concrete`) through `applyMovementAdmin`; negatives would be
`adjustment` up to zero (`h3cc_…`, reason `hub3_clothing_cleanup`). Every
non-footwear Hub 3 cell then at exactly zero is removed, and a verify pass
re-reads `/stock/hub3` until it holds footwear only. Backup in
`~/marathon-rollbacks/hub3-clothing-before-20261112-<ms>.json`; the run record
at `/settings/hub3ClothingTransfer/20261112`.

## First scan (dry run, `scripts/audit/central-clothing-dry-run.mjs`)

After the transfer, under the live caps: **Concrete 84 lines / 121 units / 35
products, all from Central**; Pine 0 (Pine is paused for its count —
`pausedLocations/marathon-pine`); Hub 3 2 sneaker lines. No Hub 3 non-footwear
line, no shop line from Hub 3. Well under the 500 division ceiling.

## STOP — the Hub 3 sneaker keep 3 → 2 changes a Marathon request

With the new engine, the new division key and the transfer, the Marathon
slice of the plan is **byte-for-byte unchanged**. Lowering the footwear-all
group's Hub 3 leg from 3 to 2 is not: Hub 3's open locks shrink to the new
keep (about 144 resized 3 → 2), and the Central pairs that frees can be asked
for by Hub 2. On the snapshot that is one new Hub 2 line — Air Jordan 4 Retro
Black Cat, size 9, 1 pair (Central 3, Hub 2 holding 1, Hub 3's lock for 3).
The same thing will recur whenever Hub 3 and Hub 2 want the same scarce
Central pair.

That is a change to a Marathon-division request, so the leg is **held at 3**
for Junid. Until it is flipped the Concrete Division Policy card shows the
Hub 3 sneaker sizes as `wrong_number` (Junid's 2 against 3 armed) — that is
the card telling the truth about the held step. To flip it:

    node scripts/apply-central-clothing-policy.mjs --apply --hub3-leg
