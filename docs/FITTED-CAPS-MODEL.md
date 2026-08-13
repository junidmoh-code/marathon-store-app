# Fitted caps — 2-per-size / 5-per-size model (2026-08-13, report only)

Owner numbers (settled): marathon-pe **2 per size**, hub2 **5 per size**,
reorderPoint 0 both legs; a size declared but stocked NOWHERE resolves an
**explicit 0**. Modelled against live stock with the real resolveTarget under
the seeded map; machine-readable copy at `~/fitted-caps-2-5-model.json`.
Nothing armed, nothing written.

## What exists (96 products, categoryKey "fitted-caps")

| location | units | by size |
|---|---|---|
| marathon-pe | 216 | S 46 · M 87 · L 74 · XL 3 · XXL 3 · (55: 2, 62: 1 — see outliers) |
| hub2 | 28 | S 8 · M 9 · L 11 |
| central | **0** | — |
| trophy | 0 | — |

## Day one under 2/5 rp0 (explicit rows still winning where they exist)

| leg | at target | silent | request | parked | dead-size 0 |
|---|---|---|---|---|---|
| hub2→marathon-pe | 88 | 17 | 1 (1 unit) | 77 (97u) | 325 cells |
| central→hub2 | 3 | 3 | 0 | 177 (501u) | (same 325) |

**Central holds zero fitted caps.** The whole hub2 side (~501 units of
demand) is a supplier buying list, parked — nothing to move internally. The
shop is nearly full already: exactly 1 unit would move day one. Numbers are
identical after the 136-row delete (those rows are all one-size headwear,
none fitted).

79 of the 96 still carry introduce-existing letter rows (hub2 ~3 / PE ~2);
explicit beats the map, so `byRow` cells above keep those numbers until the
owner separately decides to delete them. The map fully governs the 17
row-less products and every un-rowed size on the rest.

## The cm outliers — PARKED for the owner, deliberately not guessed at

| pid | name | declared | live cm cells |
|---|---|---|---|
| p1785568547550 | "Ny fitted caps" | 55–63 (9 sizes) | marathon-pe 55: 1, 62: 1 |
| p1785569166758 | "Ny fitted caps" | 55–63 (9 sizes) | marathon-pe 55: 1 |
| p1784557573947 | "La cap " | ["28"] | marathon-pe 28: **−1** (negative — a count error, not stock) |

Under the map as specified these behave correctly without special-casing:
55/62 hold units → they get 2/5 like any live size (hub2 side parked, Central
empty); 56–61 and 63 are dead → explicit 0; and "La cap"'s −1 clamps to zero
units, so its single declared size resolves 0 — a negative count can never
arm demand. Whether the cm RUNS should exist at all (recode to letters? real
head-size retail?) and what to do with the −1 cell are owner calls; both are
parked here with their pids.
