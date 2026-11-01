# Perfume Solve check — 1 November 2026

**Junid's report:** perfumes solved from Central in the last ~10 days appear at Hub 2 but not at Marathon PE.

**Finding:** PE's leg for each of the nine perfumes **was created and is still open**. The leg was never missing, and no stock went to the wrong place. It has sat unpicked on Hub 2's list since 29 Oct 08:00, and Hub 2 holds 10 of each.

## What happened (Black Opium; the other eight match)

| When (UTC) | What |
|---|---|
| 28 Oct 12:09 | 48 received at Central. |
| 28 Oct 13:00 | The scan asked Central for 10 for **Hub 2**. The perfume category policy arms Hub 2 for every perfume, whether or not Hub 2 has held it. |
| 28 Oct 20:09 | The **Solve** sent first batches **straight from Central** to Concrete and Marathon Pine (both fulfilled 29 Oct). |
| 29 Oct 07:59 | Central sent the 10 to Hub 2. |
| 29 Oct 08:00 | The scan raised **Marathon PE ← Hub 2 for 8** (PE's perfume policy), with Hub 2 Shop Refill card **R001-8**. |
| 29 Oct 19:51 | The PE Solve was pressed. Hub 2 already held the product, so by the 17 Sep rule the shop asks **Hub 2**, not Central. It seeded the PE cell, and the leg already existed. |
| since | R001-8 is "incoming", never picked. **PE has 0.** |

Why the PE batch did not go straight from Central: direct-to-shop applies only to a product Hub 2 has **never** held. For a perfume, the scan has always armed Hub 2 within the hour of Central receiving it, so by the time anyone Solves, Hub 2 holds it. Changing that is routing / request-creation logic, so it is reported here and **not changed**.

Why it is stuck: nothing technical blocks it. The card is live, backed by an open engine lock, and Hub 2 holds the stock. Hub 2's Shop Refill list is sorted **newest first**, and these cards sit at **positions 267–269 of 274** open product cards (367 open lines). Two perfume legs raised on 26 Oct (Rodriguez for Her, Adore) were fulfilled the same day. The perfume cards are workable; they are buried.

**Action:** nothing created and nothing moved; no target or quantity touched. Hub 2 needs to pick these cards: **R001-8 to R001-16** and **R004-12**. D&G King 100ML's leg was lost twice (`order_lost`, 29 and 30 Oct) and re-raised on 31 Oct as R004-12, at position 148.

## Before / after (live 1 Nov 18:44 SAST; unchanged by this PR)

| Product | Shop | Solved (UTC) | Central | Hub 2 (leg: created/fulfilled/units in) | Shop leg (created/open/fulfilled/units in) | Open since | Hub 2 card(s) | Why |
|---|---|---|---|---|---|---|---|---|
| 212 Men Carolina herrera perfume | Marathon PE | 2026-10-29T19:52 | 28 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-16 | created_not_fulfilled |
| Black Opium perfume | Marathon PE | 2026-10-29T19:51 | 30 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-8 | created_not_fulfilled |
| Blue de Chanel perfume | Marathon PE | 2026-10-29T19:51 | 27 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-10 | created_not_fulfilled |
| Dior Sauvage elixir perfume | Marathon PE | 2026-10-29T19:51 | 28 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-15 | created_not_fulfilled |
| Dior Sauvage perfume | Marathon PE | 2026-10-29T19:51 | 28 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-11 | created_not_fulfilled |
| Louis Vuitton pacific chill perfume | Marathon PE | 2026-10-29T19:51 | 28 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-12 | created_not_fulfilled |
| Polo Ralph Lauren deep blue perfume | Marathon PE | 2026-10-29T19:51 | 30 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-13 | created_not_fulfilled |
| Tomford ombreleather perfume | Marathon PE | 2026-10-29T19:51 | 30 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-14 | created_not_fulfilled |
| Versace EROS perfume | Marathon PE | 2026-10-29T19:51 | 30 | 10 (1/1/10) | 0 (1/1/0/0) from hub2 | 2026-10-29T08:00 | R001-9 | created_not_fulfilled |

Columns: Hub 2 (leg created / fulfilled / units in) and Shop leg (created / open / fulfilled / units in).

## The same defect in non-perfume Solves, same window
**None.** 46 non-perfume shop legs Solved in the last 10 days all **arrived**. The stuck legs are the 9 perfumes above.

Re-run: `node scripts/audit/solve-legs-audit.mjs --from-dir <snapshot> --md out.md` (snapshot from `scripts/audit/hub2-audit-dump.mjs`).
