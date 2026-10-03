# Hub 2 Refill lines tagged "for <shop>" — what physically happened (3 Oct 2026)

**Report (Junid, 3 Oct):** Central's Source › Hub 2 Refill list shows lines
tagged "for Marathon PE" / "for Trophy". Packers read that as "send this box to
that shop", and they do. The rule is that a shop gets stock from Hub 2 only,
and Hub 2 gets it from Central.

## Why the tag existed

The engine raises a Central → Hub 2 request **on a shop's behalf** when the
shop is short of a size that Hub 2 doesn't stock or can't find (the
"pass-through" leg, #641, live 23 Sep). The screen printed the shop's name so
the picker would know why Hub 2 was being asked for a line it doesn't carry.
The shop link (`forDests`) is still needed internally: the engine sizes and
withdraws the leg against those shops' need. It stays in the data and is no
longer shown.

## Facts (live, read 3 Oct ~12:30Z)

Data source: every `/refill_requests` row since 3 Sep was read through the
`createdAt` index. Tagged Hub 2 lines are rows at hub2 with `forDests`. Each
row's own movement is read by id (`rrf_<refillId>`). Every movement of those
products since 23 Sep was read through the `ts` index. Current cells are read
per product.

- **Tagged lines:** 76 since 23 Sep. 62 were fulfilled, 9 are open and 6 were
  cancelled.
- **Deducted / credited:** all 62 fulfilled lines: **Central deducted, Hub 2
  credited.** None of them credited a shop.
- **What happened next,** for each fulfilled line, at the shop and size it
  named:
  - **28 — Hub 2 sent it on** to the shop (a hub2 → shop transfer after the
    leg landed). This is correct.
  - **6 — STRONG evidence the box went to the shop.** The shop sold the unit
    while its own count for that size was 0. The unit was physically on the
    shop floor while the system still held it at Hub 2.
  - **15 — MEDIUM evidence.** After the box was credited to Hub 2, Hub 2
    pressed Out of Stock on the shop's request for it: Hub 2 could not find a
    box the system said it had.
  - **13 — not yet decidable.** There has been no send-on, no refusal and no
    sale yet, mostly 27 Sep – 3 Oct.

The box lists below are for checking against the shelves. A line in the first
two tables most likely sits (or sat) at the shop while Hub 2's count still
includes it.

### Strong — the shop sold a unit it had no stock booked for (6 lines, 7 units)
| fulfilled | shop | product | size | units | evidence | Hub 2 shows now |
|---|---|---|---|---|---|---|
| 2026-09-24 | Marathon PE | Diesel T-Shirt White | XL | 1 | 1 sold at the shop with no stock booked; Hub 2 refused the shop 4×; Hub 2 written off | 0 |
| 2026-09-24 | Marathon PE | Diesel T-Shirt White | S | 1 | 1 sold at the shop with no stock booked; Hub 2 refused the shop 4×; Hub 2 written off | 0 |
| 2026-09-24 | Trophy | Long sleeve plan shirt | M | 1 | 1 sold at the shop with no stock booked; Hub 2 refused the shop 1× | 1 |
| 2026-09-24 | Trophy | Daniel wellington watch silver with black inside | one size | 2 | 2 sold at the shop with no stock booked; Hub 2 refused the shop 4×; Hub 2 written off | 2 |
| 2026-09-25 | Marathon PE | Denim 9398 | L | 1 | 1 sold at the shop with no stock booked | 1 |
| 2026-09-25 | Trophy | Micheal kors watch gold with white inside | one size | 1 | 1 sold at the shop with no stock booked; Hub 2 refused the shop 3× | 1 |

### Medium — Hub 2 later refused the shop's request for it (could not find it) (15 lines, 19 units)
| fulfilled | shop | product | size | units | evidence | Hub 2 shows now |
|---|---|---|---|---|---|---|
| 2026-09-24 | Marathon PE | Saint Michael T-Shirt Black | L | 1 | Hub 2 refused the shop 2× | 1 |
| 2026-09-24 | Trophy | PAGANISM-ETE E8676 | L | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-24 | Trophy | Shuze homme 70713 black and white | M | 2 | Hub 2 refused the shop 1× | 2 |
| 2026-09-24 | Trophy | YOMO STYLISH 4108 WHITE | M | 2 | Hub 2 refused the shop 2× | 2 |
| 2026-09-24 | Trophy | YOMO STYLISH 4306 cream white | XXXL | 1 | Hub 2 refused the shop 3× | 1 |
| 2026-09-24 | Trophy | YOMO STYLISH 3301 BLACK | XXXL | 1 | Hub 2 refused the shop 2× | 1 |
| 2026-09-24 | Trophy | Emporio Armani tracksuit black: H-1022# | XXXL | 1 | Hub 2 refused the shop 3×; Hub 2 written off | 0 |
| 2026-09-24 | Trophy | YOMO STYLISH 4303 | XL | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-25 | Trophy | Calvin Klein bag full black | S | 2 | Hub 2 refused the shop 2× | 2 |
| 2026-09-26 | Trophy | YOMO STYLISH 4306 navy | XXXL | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-26 | Trophy | YOMO STYLISH 3301 BLACK | M | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-26 | Trophy | Sweater hoodie black PAGANISM-ETE E8608#1 | S | 2 | Hub 2 refused the shop 1× | 2 |
| 2026-09-29 | Trophy | Golf t shirt white 4308# | M | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-29 | Trophy | Golf t shirt white 4308# | XL | 1 | Hub 2 refused the shop 1× | 1 |
| 2026-09-29 | Trophy | Golf t shirt white 4308# | XXXL | 1 | Hub 2 refused the shop 1× | 1 |

### Not yet decidable — no send-on, no refusal, no sale yet (13 lines, 21 units)
| fulfilled | shop | product | size | units | Hub 2 shows now |
|---|---|---|---|---|---|
| 2026-09-25 | Marathon PE | Yishanhou 8860 Gray | M | 2 | 2 |
| 2026-09-25 | Marathon PE | Yishanhou 8860 Gray | L | 1 | 1 |
| 2026-09-26 | Trophy | Sweater hoodie black PAGANISM-ETE E8608#1 | M | 2 | 3 |
| 2026-09-26 | Trophy | Sweater hoodie black PAGANISM-ETE E8608#1 | L | 2 | 3 |
| 2026-09-27 | Marathon PE | T-shirt 503 YL-BOILING WHITE | L | 2 | 2 |
| 2026-09-28 | Marathon PE | Yishanhou shot sleeve | M | 2 | 3 |
| 2026-09-28 | Marathon PE | Yishanhou shot sleeve | L | 2 | 3 |
| 2026-09-28 | Marathon PE | T-shirt 503 YL-BOILING WHITE | M | 1 | 1 |
| 2026-10-02 | Marathon PE | Denim Jean Shorts | L | 2 | 3 |
| 2026-10-02 | Marathon PE | Denim Jean Shorts | XXL | 1 | 1 |
| 2026-10-03 | Trophy | Wear fashion 6920 black | XL | 1 | 1 |
| 2026-10-03 | Trophy | Wear fashion 6920 black | XXL | 1 | 1 |
| 2026-10-03 | Marathon PE | Nocta Jacket Brown | M | 2 | 5 |
**Side finding (not changed here).** Many of the shops' own waiting Hub 2
requests for these lines were cancelled `order_lost` several times over. That
is the zombie-leg self-heal (#234): the shop's R-number order node was recycled
before the line was picked, and the engine re-raised it the next hour. It does
not move stock, but it explains the churn on these lines.

## What changed

- Source › Hub 2 Refill (and any hub list, Hub 3 included) shows **no shop
  name** on any line. Every line reads as going to that hub.
- On every line, Fulfil and Out of Stock now sit side by side on one row that
  never wraps.
- The pick-timing gap deferred from #673 is closed (see the PR).
