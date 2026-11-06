# Courier Guy rate audit — POS bookings 21 Oct – 5 Nov 2026

Read 6 Nov 2026 from the Courier Guy account (MARDRO, API key `marathon-pos`):
`GET /shipments` (every shipment since 21 Oct), `GET /billing/transactions`
(every charge and reversal) and, for the "with the fix" column, `POST /rates`
(rates book nothing). Order lines from `/online_orders`. No customer names or
addresses are in this file (the repo is public).

## What happened

**Trigger.** Waybill alt ref **TCG200369959T** (VL4G7H, order #1942, five
pairs): booked 2 Nov 12:55 at **R355.68** ECO. We declared **34×46×39 cm,
6.1 kg** (16 kg volumetric). TCG measured **59.1×37×26.7 cm, 4.75 kg** (15 kg)
and at 18:40 reversed the charge and re-charged **R249.60** (base R208 + fuel
R41.60). The estimator laid five shoeboxes out as a 2 × 3 grid and declared
the empty sixth slot: 20% more volume than the boxes, which pushed it from the
11–15 kg ECO band (R247.52 today) into the 16 kg+ band (R352.72).

**Totals (220 bookings, cancelled one excluded).**

| | |
|---|---|
| Bookings by `marathon-pos` | 220 (first on 23 Oct; none 21–22 Oct) + 1 cancelled |
| Our quotes (charged at booking) | R37,703.08 |
| Final invoiced (after TCG re-rating) | R36,426.91 |
| **Over-quoted** (re-rated down) | **R1,735.19 on 26 bookings** |
| Under-quoted (re-rated up) | R459.02 on 10 bookings |
| Overpaid for good (never measured, declared too big) | R65.82 on 1 booking (#1965: 3 garments declared in a 40×30×18 box) |

TCG charges our quote first and refunds the difference only once its hub has
measured the parcel: the R1,735.19 left the prepaid balance and came back
hours to a day later. The billing ledger confirms it: for every one of the 221
shipments, the net of its charges and reversals equals the shipment's final
`rate`. A parcel TCG never measures (36 of them) is billed what we declared.

**Service.** Every booking was already on the cheapest door service TCG quoted
(SDX excluded). Re-quoting all 178 measured parcels found no cheaper service.
The over-quotes came from the size we declared, never from the service.

**Volumetric divisor, confirmed from the account.** It is not 5000 for what
we book. TCG's own re-rating of our parcels: TCG200369959T (ECO)
59.1×37×26.7 → 15 kg = ÷4000; 9DBT3G (ECOR) 58.3×36.8×22.9 → 13 kg = ÷4000;
RG9SJJ (LPF, Durban local) 37.8×29.9×26 → 6 kg = ÷5000. The estimator's 4000
is TCG's ECO/ECOR divisor, not a margin.

**ECO price bands** on the #1942 lane, 6 Nov: ≤5 kg R142.32 · 6–10 kg R204.20 ·
11–15 kg R247.52 · 16 kg+ R352.72 (≤2 kg R129.95 on some lanes). Quotes move
in steps, so the fix only has to put a parcel in the right band.

## The patterns (which rule produced the error)

| Pattern | Bookings | Over-quoted | Under-quoted |
|---|---|---|---|
| clothing declared in a box — shipped in a flat bag | 14 | R996.73 | R0.00 |
| 2 stacked shoeboxes; TCG measured them tighter | 4 | R266.66 | R0.00 |
| 5 pairs declared as a 2×3 grid with one EMPTY slot (+20% volume) | 2 | R214.72 | R0.00 |
| 2 shoeboxes declared stacked; TCG measured one layer (a pair packed without its box) | 3 | R189.40 | R0.00 |
| soft-goods overflow padded +3 cm per bundle | 1 | R62.40 | R0.00 |
| TCG measured smaller than declared | 2 | R5.28 | R0.00 |
| clothing declared in a box | 11 | R0.00 | R0.00 |
| declared = charged | 133 | R0.00 | R0.00 |
| overflow on top | 4 | R0.00 | R0.00 |
| packed in a much bigger carton/flyer than the goods (under-declared) | 2 | R0.00 | R212.16 |
| customer return (locker price by locker size) | 7 | R0.00 | R33.00 |
| not measured by TCG; our declaration billed | 30 | R0.00 | R0.00 |
| overflow on top; TCG measured a bigger parcel | 2 | R0.00 | R126.46 |
| TCG measured bigger than declared (wrapping) | 5 | R0.00 | R87.40 |
1. **Clothing declared in a box, shipped in a flat bag: R996.73.** With no
   footwear the estimator picked the smallest box from the seed box list,
   using a 4 cm thickness per tee. Three tees came out as SMALL 40×30×18,
   six caps and a bag as LARGE 55×40×35 (#1859: R355.68 → R143.52). The
   packers use a flat courier bag; TCG measured those parcels 4.7–13.3 cm thick.
2. **Two stacked shoeboxes that TCG measured smaller: R456.06** (7 bookings).
   34×23×26 is exactly two boxes, at 5.08 kg volumetric, 0.08 kg over the
   ≤5 kg band. Three of these TCG measured as one layer (≈12 cm): a pair
   packed without its box. The stack is the truth for boxed pairs, and most
   two-pair parcels (20 of 29) were charged 6–9 kg, so this stays. The
   reconciliation loop corrects it if TCG keeps measuring them smaller.
3. **Empty stack slot (5 pairs in a 2 × 3 grid): R214.72** (#1847 R364.24 →
   R255.60; #1942 R355.68 → R249.60).
4. **Overflow padding: R62.40.** Soft goods past the fill budget added a
   fixed 3 cm "bundle" per 1.2 kg instead of their own thickness.

Under-quotes (R459.02) are the opposite case: parcels packed in a bigger
carton or flyer than the goods. #1778, two pairs, went in a 59×43×27 carton
(R286.42 → R436.18), and TCG re-rated those up. TCG measures a lone shoebox
about 1.4× its own volume (it travels wrapped), but that rarely changes the
band: 94 of 97 single-pair quotes were already within 5%.

## The fix (store-app #853, 6 Nov 2026)

Dimensions and weight come from the parcel table with **no padding**:

- shoebox 34×23×13 cm, marked **measured**: TCG measured our bare shoeboxes
  at a median of ≈34×23×13. Pairs weigh 1.1 / 1.2 / 1.3 kg by size band
  (TCG weighed single pairs at 1.02–1.3 kg);
- a stack never declares an empty slot: 5 pairs = **34×46×32.5** (the five
  boxes' own volume);
- clothing with no footwear goes in the **flat courier bag** 41×34 cm (TCG's
  median footprint), as thick as the goods (tee 2.2 cm, bottoms 2.5,
  tracksuit 5, first cap 6, each further cap +1, bag 3), from 8 cm up to
  18 cm. A box is used only past 18 cm;
- soft goods that do not fit inside the shoeboxes lie on top at their own
  thickness. The +3 cm bundle is gone;
- divisor ÷4000 (TCG's, above). No safety margin. The only factor left is the
  reconciliation loop's learned calibration, and it only ever shrinks a class.

**With the fix:** every measured booking was re-quoted at today's prices with
the new declaration (178 parcels; the `with fix` column):

| | old declaration | new declaration |
|---|---|---|
| quote within 5% of TCG's final invoice | 148 / 178 | **159 / 178** |
| over-quoted | R1,735.19 | R520.07 |
| under-quoted | R426.02 | R738.82 |
| TCG200369959T | R355.68 (+42.5%) | **R247.52 (−0.8%)** |

The over-quotes left are pattern 2 (two-pair parcels TCG measured smaller).
The under-quotes left are wrapped or over-boxed parcels. TCG re-rates those
up to the same final charge, so the money ends the same; only the quote starts
lower. Prices drifted ≈1% (fuel) between the bookings and the re-quote.

## Columns

`declared` = the parcel we sent (L×W×H cm, kg); `TCG measured` = the hub's
dimensioning (blank when it never measured); `chg kg` = TCG's charged weight;
`over` = our quote − final (positive = over-quoted); `with fix` = the new
declaration and TCG's quote for it on the same service, 6 Nov.

| Date | Waybill | Alt ref | Order | Service | Declared | TCG measured | chg kg | Quoted | Final | Over | New declaration | With fix | Pattern |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-23 | 477ZJD | TCGB55572000TF | #1768 | LPF | 40×30×18 0.85kg | not measured | 4 | R131.04 | R131.04 | +0.00 | 41×34×8.2 0.6kg | R129.95 | clothing declared in a 40×30×18 box |
| 10-23 | 947BHG | TCGB55571999TF | #1770 | ECOR | 34×23×13 1.3kg | 34×22.9×11.9 1.24kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-23 | ZG6N9N | TCGB55571998TF | #1771 | ECO | 34×23×13 1.2kg | 30.8×30.8×11.6 1.2kg | 3 | R224.02 | R224.02 | +0.00 | 34×23×13 1.1kg | R222.82 | declared = charged |
| 10-23 | KMCSKJ | TCG200601787T | #1773 | LPF | 34×23×16 2.65kg | 42.5×25.3×23.1 1.5kg | 5 | R131.04 | R131.04 | +0.00 | 34×23×19 2.55kg | R129.95 | overflow on top |
| 10-23 | FC7X7G | TCGB55571996TF | #1774 | ECOR | 34×23×13 1.3kg | 36.3×31.8×14 1.3kg | 5 | R226.78 | R226.78 | +0.00 | 34×23×13 1.2kg | R225.56 | declared = charged |
| 10-23 | XMJQQT | TCGB55571995TF | #1775 | ECOR | 40×30×8 0.55kg | 39.1×34×10.5 0.55kg | 4 | R146.28 | R146.28 | +0.00 | 41×34×8 0.45kg | R145.06 | declared = charged |
| 10-23 | TZ4HHN | TCGB55571994TF | #1777 | ECO | 34×23×13 1.2kg | 30.4×26.3×12.8 1.02kg | 3 | R224.02 | R224.02 | +0.00 | 34×23×13 1.1kg | R222.82 | declared = charged |
| 10-23 | V9ZLNQ | TCG200601783T | #1778 | ECO | 34×23×26 2.4kg | 59.2×43.3×27 5.45kg | 18 | R286.42 | R436.18 | -149.76 | 34×23×26 2.2kg | R284.70 | packed in a much bigger carton/flyer than the goods (under-declared) |
| 10-23 | LNSPXV | TCGB55571993TF | #1779 | LPF | 40×30×8 0.55kg | 37×40.2×6.7 0.55kg | 2 | R131.04 | R131.04 | +0.00 | 41×34×8 0.45kg | R129.95 | declared = charged |
| 10-23 | H3NZPH |  | #1776 | ECO | 34×23×32 5.65kg | not measured | 7 | R286.42 | R0.00 | — | 34×23×39.2 5.55kg | R284.70 | cancelled (no charge) |
| 10-24 | MCXQ7H | TCGB55571986TF | #1772 | ECO | 34×23×26 2.75kg | 35.7×26.8×13 1.5kg | 4 | R205.92 | R143.52 | +62.40 | 34×23×26 2.55kg | R204.20 | 2 shoeboxes declared stacked; TCG measured one layer (a pair packed without its box) |
| 10-24 | ZKC4DG | TCGB55571985TF | #1782 | ECOR | 34×23×13 1.65kg | 31.5×43×14.7 1.65kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.55kg | R145.06 | declared = charged |
| 10-24 | 8QDHFL | TCGB55571983TF | #1785 | LPF | 34×23×26 2.6kg | 40.8×33.1×15.6 2.6kg | 4 | R131.04 | R131.04 | +0.00 | 34×23×26 2.4kg | R129.95 | declared = charged |
| 10-24 | JZPLJQ | TCGB55571984TF | #1784 | LPF | 34×23×13 1.2kg | 35.7×34.1×12.7 1.2kg | 3 | R131.04 | R131.04 | +0.00 | 34×23×13 1.1kg | R129.95 | declared = charged |
| 10-24 | HX89SG | TCGB55571982TF | #1787 | ECO | 34×23×13 1.4kg | 41.1×33.4×16.5 1.4kg | 6 | R224.02 | R286.42 | -62.40 | 34×23×13 1.3kg | R222.82 | packed in a much bigger carton/flyer than the goods (under-declared) |
| 10-24 | HP7MZM | TCGB55571981TF | #1788 | ECOR | 34×23×13 1.3kg | 29.3×38.8×12.4 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-24 | TBPRJC | TCGB55571980TF | #1789 | ECO | 34×23×13 1.3kg | 35.7×22×12.9 1.3kg | 3 | R224.02 | R224.02 | +0.00 | 34×23×13 1.2kg | R222.82 | declared = charged |
| 10-24 | TJM34F | TCGB55571979TF | #1791 | ECOR | 34×23×13 1.2kg | 34.7×35.1×11.8 1.2kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 10-24 | J44G4T | TCGB55571978TF | #1792 | LPF | 34×23×13 1.3kg | 38.1×33.4×14.5 1.3kg | 4 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | declared = charged |
| 10-24 | WQZS7P | TCGB55571977TF | #1790 | ECOR | 45×35×25 1.5kg | 41.6×34.5×15.3 1.5kg | 6 | R210.88 | R210.88 | +0.00 | 41×34×11.2 1.1kg | R145.06 | clothing declared in a 45×35×25 box |
| 10-24 | GBNRGL | TCGB55330666TF | #1793 | ECOR | 34×23×13 1.4kg | 38.3×33.9×12.7 1.4kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.3kg | R145.06 | declared = charged |
| 10-24 | TJT6PF | TCGB55571975TF | #1783 | ECOR | 40×30×8 1.15kg | 40.2×35.3×9.4 1.15kg | 4 | R226.78 | R226.78 | +0.00 | 41×34×8 1.05kg | R225.56 | declared = charged |
| 10-26 | BJS7CV | TCG177111357T | RETURN-1692 | L2DM - ECO | 35×25×13 1.5kg | 35×25×13 1.5kg | 3 | R130.90 | R130.90 | +0.00 | — | — | customer return (locker price by locker size) |
| 10-26 | TZQ79S | TCGB55571973TF | #1781 | ECOR | 34×23×13 1.7kg | not measured | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.7kg | R145.06 | not measured by TCG; our declaration billed |
| 10-26 | BSBWKL | TCGB55571972TF | #1799 | ECO | 34×23×13 1.65kg | 30.4×27.1×13.1 1.14kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.55kg | R142.32 | declared = charged |
| 10-26 | NRZ3NN | TCGB55571971TF | #1801 | ECOR | 34×23×13 1.3kg | 39.9×30.7×12.5 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-26 | LMK4NQ | TCGB55571970TF | #1769 | ECO | 34×23×13 0.95kg | 36.5×25.5×15 1.3kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 0.95kg | R142.32 | declared = charged |
| 10-26 | 6KGQVC | TCGB55571969TF | #1804 | ECOR | 34×23×13 1.3kg | 35×27.3×13.4 1.09kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-26 | S34R6H | TCGB55571968TF | #1795 | ECOR | 34×23×13 1.3kg | 34.1×25.6×14.5 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-26 | 9XKMDR | TCG200601766T | #1805 | ECOR | 34×23×26 2.5kg | 37.1×31.2×24.3 2.2kg | 8 | R210.88 | R210.88 | +0.00 | 34×23×26 2.3kg | R209.12 | declared = charged |
| 10-26 | FJ6C44 | TCG200601765T | #1807 | ECOR | 34×23×26 2.5kg | not measured | 6 | R291.38 | R291.38 | +0.00 | 34×23×26 2.3kg | R289.62 | not measured by TCG; our declaration billed |
| 10-26 | CQSKB3 | TCG200601764T | #1808 | ECO | 34×23×26 4.55kg | 34.5×32.1×25.4 3.52kg | 8 | R205.92 | R205.92 | +0.00 | 34×23×26 4.35kg | R204.20 | declared = charged |
| 10-26 | BB9WHQ | TCGB55571967TF | #1810 | ECOR | 34×23×13 1.2kg | 35.7×30.5×12.2 1.2kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 10-26 | WRJX7L | TCGB55571966TF | #1809 | ECOR | 34×23×13 1.2kg | 38.6×27.5×12.3 1.2kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 10-26 | 44DZKS | TCGB55571964TF | #1812 | ECOR | 40×30×8 0.55kg | 33.9×32.6×8.1 0.55kg | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 0.45kg | R145.06 | declared = charged |
| 10-26 | BRG3VK | TCGB55571963TF | #1803 | ECOR | 34×23×13 1.3kg | 37.5×28.7×12.8 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-26 | 6T67GF | TCG200601767T | #1802 | ECOR | 34×23×39 3.6kg | 35.8×36.1×22.9 2.5kg | 8 | R210.88 | R210.88 | +0.00 | 34×23×39 3.3kg | R209.12 | declared = charged |
| 10-26 | XH7RBH | TCGB55571962TF | #1786 | ECOR | 40×30×18 1.5kg | 42.1×35.4×8 1.5kg | 3 | R210.88 | R146.28 | +64.60 | 41×34×8 1.25kg | R145.06 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-26 | WRPMBH | TCG200601762T | #1780 | ECOR | 34×23×26 2.4kg | 33×31.7×11.9 1.72kg | 4 | R210.88 | R146.28 | +64.60 | 34×23×26 2.2kg | R209.12 | 2 shoeboxes declared stacked; TCG measured one layer (a pair packed without its box) |
| 10-26 | R6ZNWK | TCGB55571961TF | #1796 | ECO | 40×30×8 0.55kg | not measured | 3 | R143.52 | R143.52 | +0.00 | 41×34×8 0.45kg | R142.32 | not measured by TCG; our declaration billed |
| 10-26 | 8NBMSC | TCGB55571960TF | #1800 | LPP | 45×35×25 2.65kg | not measured | 8 | R150.70 | R150.70 | +0.00 | 41×34×11.6 2.25kg | R149.44 | clothing declared in a 45×35×25 box |
| 10-26 | VR7TGR | TCGB55571959TF | #1811 | ECO | 34×23×13 1.2kg | 37.3×30.2×12.8 1.2kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 10-26 | Z7W4ZK | TCGB55571958TF | #1813 | ECOR | 34×23×13 1.2kg | 34.9×27.1×12.7 1.2kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 10-27 | 7VB6GR | TCGB55571957TF | #1814 | ECOR | 34×23×13 1.3kg | not measured | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | not measured by TCG; our declaration billed |
| 10-27 | DSPF8F | TCGB55571965TF | #1816 | ECO | 34×23×13 1.3kg | 34×26×15 1.1kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-27 | FM347H | TCG200601609T | #1822 | ECO | 34×23×19 3.7kg | 35.8×28.2×25.8 4.2kg | 7 | R143.52 | R205.92 | -62.40 | 34×23×20.2 3.6kg | R142.32 | overflow on top; TCG measured a bigger parcel |
| 10-27 | DTBQJ4 | TCGB55571954TF | #1797 | ECO | 34×23×13 1.3kg | 35.1×24.8×14.4 1.3kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-27 | NFV6KV | TCGB55571953TF | #1794 | ECOR | 34×23×13 1.3kg | 36.9×33×12.8 1.05kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-27 | VSXMJR | TCGB55571952TF | #1817 | LPF | 40×30×18 2.3kg | not measured | 4 | R131.04 | R131.04 | +0.00 | 41×34×10 2.05kg | R129.95 | clothing declared in a 40×30×18 box |
| 10-27 | V7XZ8B | TCGB55571951TF | #1819 | ECO | 40×30×18 1.9kg | 39.5×32×12 1.24kg | 4 | R286.42 | R224.02 | +62.40 | 41×34×8.8 1.65kg | R222.82 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-27 | 4DJLQG | TCGB55571950TF | #1824 | ECOR | 34×23×13 1.3kg | 38.6×31.6×13.6 1.18kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-27 | CQMT67 | TCG196473042T | 1789-EX return | L2DL - ECO | 34×23×26 2.6kg | 34×23×26 2.6kg | 6 | R193.60 | R193.60 | +0.00 | — | — | customer return (locker price by locker size) |
| 10-27 | KSTH9D | TCGB55571949TF | #1825 | LPF | 34×23×13 1.4kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.3kg | R129.95 | not measured by TCG; our declaration billed |
| 10-27 | X6FBJS | TCGB55571948TF | #1826 | ECO | 34×23×13 1.2kg | not measured | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | not measured by TCG; our declaration billed |
| 10-27 | RG9SJJ | TCG200601608T | #1828 | LPF | 34×23×26 2.5kg | 37.8×29.9×26 1.9kg | 6 | R131.04 | R149.04 | -18.00 | 34×23×26 2.3kg | R129.95 | TCG measured bigger than declared (wrapping) |
| 10-27 | WD93ZQ | TCG200601607T | #1830 | ECO | 34×23×26 2.8kg | 37.9×31×24.9 1.95kg | 8 | R205.92 | R205.92 | +0.00 | 34×23×26 2.6kg | R204.20 | declared = charged |
| 10-27 | 7MMRZR | TCGB55571947TF | #1820 | LPF | 40×30×8 0.95kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 41×34×8 0.85kg | R129.95 | not measured by TCG; our declaration billed |
| 10-27 | LVKSPC | TCGB55571946TF | #1823 | ECOR | 40×30×8 0.55kg | 39.4×35.4×7.7 0.55kg | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 0.45kg | R145.06 | declared = charged |
| 10-27 | FS68JP | TCGB55571945TF | #1831 | ECO | 45×35×25 2.85kg | 43×34.5×8.5 1.3kg | 4 | R205.92 | R143.52 | +62.40 | 41×34×13.2 2.45kg | R142.32 | clothing declared in a 45×35×25 box — shipped in a flat bag |
| 10-27 | XPKLSN | TCGB55571944TF | #1806 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 10-27 | 4K7NDV | TCGB55571942TF | #1833 | ECO | 34×23×13 1.3kg | 40.2×29.6×12.7 1.3kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-28 | Q74K8K | TCG200601454T | #1818 | ECO | 34×23×29 3kg | 35.8×21.3×29.1 2.4kg | 6 | R205.92 | R205.92 | +0.00 | 34×23×29 2.8kg | R204.20 | overflow on top |
| 10-28 | PSXD9B | TCGB55571940TF | #1834 | ECO | 34×23×13 1.2kg | 30.5×37.5×15 1.2kg | 5 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 10-28 | 6BVNGG | TCG200601450T | #1835 | ECO | 34×23×39 3.7kg | 40.3×32.9×23.7 3.1kg | 8 | R205.92 | R205.92 | +0.00 | 34×23×39 3.4kg | R204.20 | declared = charged |
| 10-28 | M4Q3KQ | TCG200601447T | #1829 | ECO | 34×23×26 2.7kg | 35×26×27 1.96kg | 7 | R205.92 | R205.92 | +0.00 | 34×23×26 2.5kg | R204.20 | declared = charged |
| 10-28 | C4KJWP | TCGB55571939TF | #1837 | ECOR | 34×23×13 1.3kg | 35.8×24.4×12.8 1.3kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-28 | RJ64JS | TCG200601453T | #1840 | LPF | 34×23×26 2.6kg | 37.6×29.9×24.9 1.4kg | 6 | R131.04 | R149.04 | -18.00 | 34×23×26 2.4kg | R129.95 | TCG measured bigger than declared (wrapping) |
| 10-28 | PHR9GC | TCGB55571938TF | #1841 | ECO | 34×23×13 1.2kg | 38×33.1×11.8 1.3kg | 4 | R224.02 | R224.02 | +0.00 | 34×23×13 1.1kg | R222.82 | declared = charged |
| 10-28 | FBKSNP | TCG200601448T | #1838 | ECO | 34×23×26 4.25kg | 35.9×33×25 3.85kg | 8 | R205.92 | R205.92 | +0.00 | 34×23×26 4.15kg | R204.20 | declared = charged |
| 10-28 | K6WXLK | TCG200601451T | #1843 | ECOR | 34×23×26 2.6kg | 32.9×26.5×26.7 1.9kg | 6 | R210.88 | R210.88 | +0.00 | 34×23×26 2.4kg | R209.12 | declared = charged |
| 10-28 | DMSZC7 | TCGB55571937TF | #1844 | ECO | 34×23×13 1.3kg | 34.2×21.3×13.9 1.08kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-28 | GBN3QJ | TCG200601449T | #1846 | ECOR | 34×23×26 2.4kg | 36.2×25.3×22.5 1.6kg | 6 | R210.88 | R210.88 | +0.00 | 34×23×26 2.2kg | R209.12 | declared = charged |
| 10-28 | XMPTDP | TCG200601444T | #1845 | ECO | 34×23×39 4kg | 35.7×32.9×39.9 2.8kg | 12 | R205.92 | R249.60 | -43.68 | 34×23×39 3.7kg | R204.20 | TCG measured bigger than declared (wrapping) |
| 10-28 | 9DBT3G | TCG200601442T | #1847 | ECOR | 34×46×39 6.1kg | 58.3×36.8×22.9 4.2kg | 13 | R364.24 | R255.60 | +108.64 | 34×46×32.5 5.6kg | R253.47 | 5 pairs declared as a 2×3 grid with one EMPTY slot (+20% volume) |
| 10-28 | NK3MBF | TCGB55571941TF | #1849 | ECOR | 34×23×13 1.4kg | 35.6×22.4×12.6 1.36kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.3kg | R145.06 | declared = charged |
| 10-28 | W96CHJ | TCGB55571936TF | #1836 | ECO | 40×30×8 0.55kg | 36.4×34.4×7.3 0.55kg | 3 | R143.52 | R143.52 | +0.00 | 41×34×8 0.45kg | R142.32 | declared = charged |
| 10-28 | 7GDLTH | TCGB55571935TF | #1839 | ECOR | 34×23×13 1.2kg | 37.7×30.1×14.3 1.04kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 10-29 | FPZJCB | TCGB55571933TF | #1850 | ECO | 34×23×13 1.4kg | 34.4×23.5×12.5 1.4kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.3kg | R142.32 | declared = charged |
| 10-29 | CCBNDV | TCGB55571932TF | #1851 | ECOR | 34×23×13 1.3kg | 26×34×15.5 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-29 | PQ9QSM | TCGB55571931TF | #1852 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 10-29 | 9S4HVQ | TCGB55571930TF | #1854 | ECO | 40×30×18 1.7kg | 34.5×42×12.5 1.4kg | 5 | R205.92 | R143.52 | +62.40 | 41×34×8 1.45kg | R142.32 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-29 | CK3384 | TCGB55571929TF | #1857 | LPF | 34×23×13 1.3kg | not measured | 2 | R211.54 | R211.54 | +0.00 | 34×23×13 1.2kg | R210.45 | not measured by TCG; our declaration billed |
| 10-29 | BB7PDJ | TCGB55571928TF | #1858 | ECOR | 34×23×13 1.3kg | 35×26×14.5 1.3kg | 4 | R226.78 | R226.78 | +0.00 | 34×23×13 1.2kg | R225.56 | declared = charged |
| 10-29 | BHHK8K | TCGB55571927TF | #1861 | ECO | 34×23×13 1.3kg | 33.5×23.2×13.4 1.3kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-29 | 9NMW4W | TCGB55571925TF | #1848 | ECOR | 34×23×13 2.4kg | 33.9×20.4×14.1 1.86kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 2.3kg | R145.06 | declared = charged |
| 10-29 | 4CBKSF | TCGB55571924TF | #1863 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 10-29 | VN6SXF | TCGB55571923TF | #1865 | ECOR | 34×23×13 1.4kg | 35.4×20.9×13 1.4kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.3kg | R145.06 | declared = charged |
| 10-29 | GFJBLD | TCGB55571922TF | #1867 | ECO | 34×23×13 1.3kg | 37.5×32.4×12.7 1.25kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 10-29 | XGNWSH | TCGB55571921TF | #1870 | ECOR | 40×30×8 0.55kg | 39.6×32.2×7.5 0.55kg | 3 | R143.52 | R146.28 | -2.76 | 41×34×8 0.45kg | R145.06 | TCG measured bigger than declared (wrapping) |
| 10-29 | HLFQQT | TCGB55571920TF | #1871 | ECO | 34×23×13 1.2kg | 34.3×31.5×14.2 1.2kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 10-29 | 3NQPJD | TCGB55571919TF | #1832 | ECO | 35×23×14 0.35kg | 38.9×34.9×9.5 0.35kg | 4 | R143.52 | R143.52 | +0.00 | 41×34×8 0.2kg | R142.32 | clothing declared in a 35×23×14 box |
| 10-29 | 7X8NPF | TCGB55571918TF | #1853 | LPF | 40×30×8 0.55kg | 41.2×36.4×5.6 0.55kg | 2 | R131.04 | R131.04 | +0.00 | 41×34×8 0.45kg | R129.95 | declared = charged |
| 10-29 | PXTZ6W | TCGB55571917TF | #1855 | ECOR | 40×30×18 1.7kg | 39.9×35.1×15.1 1.7kg | 6 | R210.88 | R210.88 | +0.00 | 41×34×8 1.45kg | R145.06 | clothing declared in a 40×30×18 box |
| 10-29 | 7WNLPQ | TCGB55571916TF | #1860 | ECOR | 40×30×18 1.5kg | 41.3×36.8×6.1 1.5kg | 3 | R210.88 | R146.28 | +64.60 | 41×34×8 1.25kg | R145.06 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-29 | H9PXGJ | TCGB55571915TF | #1868 | ECOR | 40×30×8 0.55kg | 39.8×37×5.2 0.55kg | 2 | R146.28 | R143.64 | +2.64 | 41×34×8 0.45kg | R145.06 | TCG measured smaller than declared |
| 10-29 | FTFJM7 | TCGB55571914TF | #1869 | ECOR | 40×30×8 0.95kg | 36×43.2×8.7 0.95kg | 4 | R146.28 | R146.28 | +0.00 | 41×34×8 0.85kg | R145.06 | declared = charged |
| 10-29 | 39PPFL | TCGB55571926TF | #1859 | ECO | 55×40×35 2.05kg | 37.5×32.3×15.4 2.05kg | 5 | R355.68 | R143.52 | +212.16 | 41×34×14 1.45kg | R142.32 | clothing declared in a 55×40×35 box — shipped in a flat bag |
| 10-29 | Q3DGFV | TCGB55571913TF | #1862 | ECOR | 40×30×8 1.15kg | 41.9×36.9×7.4 1.15kg | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 1.05kg | R145.06 | declared = charged |
| 10-30 | HH8KLQ | TCGB55571910TF | #1872 | ECOR | 34×23×13 1.7kg | 42.1×29.8×11.7 1.3kg | 4 | R226.78 | R226.78 | +0.00 | 34×23×13 1.6kg | R225.56 | declared = charged |
| 10-30 | PCKTKT | TCGB55571909TF | #1873 | ECOR | 34×23×13 1.8kg | 34.2×24.8×16.4 1.96kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.7kg | R145.06 | declared = charged |
| 10-30 | JZWDKR | TCGB55571908TF | #1874 | ECOR | 34×23×13 1.3kg | 36.8×25.1×13.5 1.26kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-30 | KTDCMC | TCGB55571907TF | #1875 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 10-30 | 8SJQ8C | TCGB55571904TF | #1878 | ECOR | 34×23×26 2.6kg | 39.4×26×23.4 1.94kg | 6 | R210.88 | R210.88 | +0.00 | 34×23×26 2.4kg | R209.12 | declared = charged |
| 10-30 | RJSK3J | TCGB55571903TF | #1879 | LPF | 34×23×13 1.3kg | 38.4×32.7×12.5 1.3kg | 3 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | declared = charged |
| 10-30 | 4HSW6K | TCGB55571902TF | #1885 | ECOR | 34×23×26 2.4kg | 32.8×25.5×24.5 1.64kg | 6 | R210.88 | R210.88 | +0.00 | 34×23×26 2.2kg | R209.12 | declared = charged |
| 10-30 | SSGPBW | TCGB55571801TF | #1880 | ECOR | 34×23×13 2.1kg | 44.3×34.2×11.8 1.74kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 2kg | R145.06 | declared = charged |
| 10-30 | NWSRCV | TCGB55571802TF | #1881 | ECOR | 34×23×13 1.3kg | 36.4×22.8×12.4 1.3kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-30 | GVBVZC | TCGB55571803TF | #1887 | ECOR | 34×23×13 1.3kg | 34.5×30.7×12.3 1.2kg | 4 | R226.78 | R226.78 | +0.00 | 34×23×13 1.2kg | R225.56 | declared = charged |
| 10-30 | CV3437 | TCGB55571804TF | #1888 | ECO | 34×23×13 1.4kg | 33.4×21.6×13.6 1.4kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.3kg | R142.32 | declared = charged |
| 10-30 | J49DPD | TCGB55571805TF | #1890 | ECOR | 34×23×13 1.3kg | 33.2×27.7×14.7 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 10-30 | H9S8HH | TCGB55571806TF | #1891 | ECO | 34×23×13 1.4kg | 34.9×22.6×13.2 1.4kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.3kg | R142.32 | declared = charged |
| 10-30 | C8DL9C | TCGB55571807TF | #1892 | ECO | 34×23×13 1.2kg | 38.3×29.7×12.6 1.2kg | 4 | R224.02 | R224.02 | +0.00 | 34×23×13 1.1kg | R222.82 | declared = charged |
| 10-30 | VQDWFF | TCGB55571808TF | #1883 | ECOR | 40×30×8 1.15kg | 42.1×36.1×9.1 1.15kg | 4 | R146.28 | R146.28 | +0.00 | 41×34×8 1.05kg | R145.06 | declared = charged |
| 10-30 | WDKW8S | TCGB55571809TF | #1889 | ECO | 40×30×18 1.5kg | 42.6×31.9×5.7 1.02kg | 2 | R286.42 | R211.54 | +74.88 | 41×34×8 1.25kg | R222.82 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-30 | FC89MX | TCGB55571810TF | #1893 | ECO | 40×30×18 2.1kg | 41.6×29.5×10.4 1.08kg | 4 | R205.92 | R143.52 | +62.40 | 41×34×9.4 1.85kg | R142.32 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 10-30 | TKGFWG |  | 1793-EX return | L2DM - ECO | 34×23×13 1.3kg | not measured | 3 | R130.90 | R130.90 | +0.00 | — | — | customer return (locker price by locker size) |
| 10-30 | 7G7MWH | TCGB55571811TF | #1864 | ECO | 34×23×13 1.2kg | 33.1×30.6×11.9 1.2kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 10-30 | VGBM9D | TCGB55571813TF | #1895 | ECOR | 35×23×14 0.35kg | 37.7×27.6×5.4 0.35kg | 2 | R146.28 | R143.64 | +2.64 | 41×34×8 0.2kg | R145.06 | clothing declared in a 35×23×14 box — shipped in a flat bag |
| 10-30 | 3ZB4MJ | TCG199873119T | 1744-EX return | L2DM - ECO | 34×23×13 1.3kg | 34×23×13 1.3kg | 3 | R130.90 | R130.90 | +0.00 | — | — | customer return (locker price by locker size) |
| 10-30 | 6777NC | TCG196202617T | 1846-EX return | L2DM - ECO | 34×23×13 1.2kg | 34×23×13 1.2kg | 3 | R130.90 | R130.90 | +0.00 | — | — | customer return (locker price by locker size) |
| 11-01 | C8LZT3 | TCGB55571814TF | #1911 | ECOR | 40×30×8 0.5kg | 37×29.8×13.8 0.5kg | 4 | R226.78 | R226.78 | +0.00 | 41×34×8 0.4kg | R225.56 | declared = charged |
| 11-01 | 8ZDDWC | TCGB55571815TF | #1910 | ECO | 45×35×25 2kg | 41.9×34×12.4 1.5kg | 5 | R205.92 | R143.52 | +62.40 | 41×34×13.2 1.6kg | R142.32 | clothing declared in a 45×35×25 box — shipped in a flat bag |
| 11-01 | 8D3Q9C | TCGB55571816TF | #1909 | ECOR | 35×23×14 0.35kg | 36.9×33.8×9.2 0.35kg | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 0.2kg | R145.06 | clothing declared in a 35×23×14 box |
| 11-01 | ZS6FZG | TCGB55571817TF | #1856 | ECOR | 40×30×8 0.55kg | 42.2×35.3×8.7 0.55kg | 4 | R226.78 | R226.78 | +0.00 | 41×34×8 0.45kg | R225.56 | declared = charged |
| 11-01 | JZJBGM | TCGB55571819TF | #1789-EX | ECO | 34×23×26 2.6kg | 41.9×34×11.3 1.7kg | 5 | R286.42 | R224.02 | +62.40 | 34×23×26 2.4kg | R284.70 | 2 shoeboxes declared stacked; TCG measured one layer (a pair packed without its box) |
| 11-01 | SGWJVR | TCGB55571820TF | #1876 | ECO | 34×23×16 2.8kg | 36.4×24.6×19.5 2.58kg | 5 | R143.52 | R143.52 | +0.00 | 34×23×15.2 2.7kg | R142.32 | overflow on top |
| 11-01 | KG83TQ | TCGB55571823TF | #1877 | ECOR | 34×23×13 2.1kg | 39.8×30.4×13.8 1.6kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 2kg | R145.06 | declared = charged |
| 11-01 | Z469QF | TCGB55571824TF | #1894 | ECOR | 34×23×26 2.6kg | 39.8×31.3×24.7 2.2kg | 8 | R210.88 | R210.88 | +0.00 | 34×23×26 2.4kg | R209.12 | declared = charged |
| 11-01 | N8JDRP | TCGB55571825TF | #1897 | ECOR | 34×23×13 1.3kg | 38.9×31.5×11.9 1.05kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-01 | B3Q8JH | TCGB55571826TF | #1906 | ECO | 34×23×13 1.3kg | 33.5×29.7×13.4 1.3kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-01 | 69FN6J | TCGB55571827TF | #1907 | LPF | 34×23×13 0.8kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 0.8kg | R129.95 | not measured by TCG; our declaration billed |
| 11-01 | FSX9GR | TCGB55571812TF | #1898 | ECOR | 34×23×13 1.3kg | 33.9×25.8×12.8 1.3kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-01 | TVHL3Q | TCGB55571828TF | #1900 | LPF | 34×23×26 2.5kg | not measured | 4 | R131.04 | R131.04 | +0.00 | 34×23×26 2.3kg | R129.95 | not measured by TCG; our declaration billed |
| 11-01 | 8QQJXK | TCGB55571830TF | #1902 | ECO | 34×23×26 2.5kg | 40.1×32.3×23.8 1.45kg | 8 | R286.42 | R205.92 | +80.50 | 34×23×26 2.3kg | R204.20 | 2 stacked shoeboxes; TCG measured them tighter |
| 11-01 | JVF8SM | TCGB55571833TF | #1903 | ECO | 34×23×29 3.1kg | 34×21.1×24.7 1.8kg | 5 | R205.92 | R143.52 | +62.40 | 34×23×29 2.9kg | R204.20 | soft-goods overflow padded +3 cm per bundle |
| 11-01 | GJK9HP | TCGB55571834TF | #1904 | ECOR | 34×23×13 1.3kg | 37.6×24×12.3 1.3kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-01 | FVCDCD | TCGB55571835TF | #1908 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 11-01 | 9KMPHD | TCGB55571837TF | #1912 | ECOR | 34×23×26 2.6kg | 40.8×31.6×24.7 2.2kg | 8 | R210.88 | R210.88 | +0.00 | 34×23×26 2.4kg | R209.12 | declared = charged |
| 11-01 | 4LZZGS | TCGB55571838TF | #1913 | LPF | 34×23×13 1.2kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.1kg | R129.95 | not measured by TCG; our declaration billed |
| 11-01 | F4HHRL | TCGB55571839TF | #1917 | ECO | 34×23×13 1.6kg | 38×31.1×12.8 1.05kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.5kg | R142.32 | declared = charged |
| 11-01 | 9FLLQF | TCGB55571843TF | #1919 | ECO | 34×23×13 1.2kg | 31.7×37.5×12 1.2kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 11-01 | 44VMQG | TCGB55571842TF | #1920 | ECOR | 34×23×39 4kg | 30.9×25.7×37.1 2.96kg | 8 | R210.88 | R210.88 | +0.00 | 34×23×39 3.7kg | R209.12 | declared = charged |
| 11-01 | MT6VJF | TCGB55571844TF | #1921 | ECO | 34×23×13 1.4kg | 38.6×31.6×13 1.4kg | 4 | R224.02 | R224.02 | +0.00 | 34×23×13 1.3kg | R222.82 | declared = charged |
| 11-01 | 83RNCR | TCGB55571845TF | #1924 | ECO | 34×23×13 1.3kg | 37.4×32×14.1 1.3kg | 5 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-01 | XRDT8V | TCGB55571846TF | #1915 | ECO | 40×30×18 1.6kg | 42.8×35×12.4 1.5kg | 5 | R286.42 | R224.02 | +62.40 | 41×34×8 1.35kg | R222.82 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 11-01 | JSQZ8B | TCGB55571847TF | #1916 | LPF | 40×30×8 0.5kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 41×34×8 0.4kg | R129.95 | not measured by TCG; our declaration billed |
| 11-01 | S7JJBQ | TCGB55571849TF | #1918 | ECO | 40×30×8 0.55kg | 43.2×34.7×8.4 0.55kg | 4 | R224.02 | R224.02 | +0.00 | 41×34×8 0.45kg | R222.82 | declared = charged |
| 11-01 | FZCLRL | TCGB55571850TF | #1901 | ECOR | 34×23×13 1.2kg | 38.1×33.1×13.1 1.2kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 11-01 | JJWTQK | TCGB55571848TF | #1815 | ECOR | 34×23×13 1.2kg | not measured | 3 | R226.78 | R226.78 | +0.00 | 34×23×13 1.1kg | R225.56 | not measured by TCG; our declaration billed |
| 11-01 | RDNGWL | TCGB55571851TF | #1923 | ECOR | 40×30×8 1.15kg | 41.4×35.3×7.8 1.15kg | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 1.05kg | R145.06 | declared = charged |
| 11-01 | F93PPS | TCGB55571852TF | #1922 | ECOR | 45×35×25 2.6kg | 39×33.7×13.3 1.7kg | 5 | R210.88 | R146.28 | +64.60 | 41×34×17 2.2kg | R209.12 | clothing declared in a 45×35×25 box — shipped in a flat bag |
| 11-02 | 34JFJD | TCGB55571853TF | #1896 | ECOR | 34×23×13 1.3kg | 35.2×32.8×13.3 1.1kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-02 | WBRHMR | TCGB55571855TF | #1899 | ECOR | 34×23×13 2.25kg | 30.2×23.8×14.2 1.52kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 2.15kg | R145.06 | declared = charged |
| 11-02 | B9CCX8 | TCGB55571856TF | #1926 | ECO | 34×23×13 1.2kg | 36.6×32.3×14.4 1.2kg | 5 | R224.02 | R224.02 | +0.00 | 34×23×13 1.1kg | R222.82 | declared = charged |
| 11-02 | TL6NTN | TCGB55571857TF | #1928 | ECO | 34×23×13 1.3kg | 38.9×30.1×12.5 1.3kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-02 | JBDWLD | TCGB55571858TF | #1929 | ECO | 34×23×13 0.6kg | 34.1×31.3×14.6 0.6kg | 4 | R143.52 | R143.52 | +0.00 | 34×23×13 0.6kg | R142.32 | declared = charged |
| 11-02 | B7NQ6Q | TCGB55571859TF | #1930 | ECOR | 34×23×13 1.3kg | 38.8×28.5×13.8 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-02 | PH4GFT | TCGB55571860TF | #1933 | ECO | 34×23×26 2.5kg | 33.3×21.9×25.5 2kg | 5 | R205.92 | R143.52 | +62.40 | 34×23×26 2.3kg | R204.20 | 2 stacked shoeboxes; TCG measured them tighter |
| 11-02 | XRWCJS | TCGB55571862TF | #1937 | LPF | 34×23×13 1.3kg | 39.9×31.5×13.1 1.3kg | 3 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | declared = charged |
| 11-02 | TTR6GF | TCGB55571863TF | #1938 | ECO | 34×23×26 2.5kg | 36.8×34.1×23.9 2.1kg | 8 | R205.92 | R205.92 | +0.00 | 34×23×26 2.3kg | R204.20 | declared = charged |
| 11-02 | RSXTLC | TCGB55571865TF | #1939 | ECOR | 34×23×13 1.3kg | 35×25.2×13.9 1.3kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-02 | QFX9PG | TCGB55571866TF | #1940 | LPF | 40×30×8 0.35kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 41×34×8 0.25kg | R129.95 | not measured by TCG; our declaration billed |
| 11-02 | 9JKPJV | TCGB55571867TF | #1941 | ECO | 34×23×13 1.3kg | 39.8×30.2×13.3 1.65kg | 4 | R224.02 | R224.02 | +0.00 | 34×23×13 1.2kg | R222.82 | declared = charged |
| 11-02 | VL4G7H | TCG200369959T | #1942 | ECO | 34×46×39 6.1kg | 59.1×37×26.7 4.75kg | 15 | R355.68 | R249.60 | +106.08 | 34×46×32.5 5.6kg | R247.52 | 5 pairs declared as a 2×3 grid with one EMPTY slot (+20% volume) |
| 11-02 | VS4XJH | TCGB55571869TF | #1943 | ECOR | 34×23×13 1.75kg | 35.1×26.6×14.3 1.22kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.65kg | R145.06 | declared = charged |
| 11-02 | MQ4SJR | TCGB55571870TF | #1936 | ECO | 40×30×8 0.95kg | 44.3×35.2×5.4 0.95kg | 3 | R224.02 | R224.02 | +0.00 | 41×34×8 0.85kg | R222.82 | declared = charged |
| 11-02 | VM7JBJ | TCG200291334T | 1869-EX return | L2DM - ECO | 40×30×8 1.15kg | 60×41×19 1.15kg | 12 | R97.90 | R130.90 | -33.00 | — | — | customer return (locker price by locker size) |
| 11-03 | KWSSVK | TCGB55571872TF | #1886 | ECOR | 35×23×14 0.35kg | 40.2×35.7×9 0.35kg | 4 | R146.28 | R146.28 | +0.00 | 41×34×8 0.2kg | R145.06 | clothing declared in a 35×23×14 box |
| 11-03 | BD9NTC | TCGB55571874TF | #1934 | ECOR | 34×23×26 2.5kg | 37×30×26 1.88kg | 8 | R205.92 | R210.88 | -4.96 | 34×23×26 2.3kg | R209.12 | TCG measured bigger than declared (wrapping) |
| 11-03 | 69SDSF | TCGB55571875TF | #1949 | ECOR | 34×23×13 1.2kg | 36.3×32.9×12.8 1.2kg | 4 | R226.78 | R226.78 | +0.00 | 34×23×13 1.1kg | R225.56 | declared = charged |
| 11-03 | JDMC9C | TCGB55571876TF | #1950 | ECO | 34×23×13 1.2kg | 32.5×26×12.4 1.2kg | 3 | R143.52 | R143.52 | +0.00 | 34×23×13 1.1kg | R142.32 | declared = charged |
| 11-03 | FJHM33 | TCGB55571877TF | #1952 | ECOR | 34×23×13 1.2kg | 38.2×31.3×13.1 1.1kg | 4 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 11-03 | 8DTX3R | TCGB55571878TF | #1953 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 11-03 | 6CGNPG | TCGB55571879TF | #1925 | ECO | 34×23×39 3.6kg | 34.7×20.1×34.5 3.56kg | 7 | R205.92 | R205.92 | +0.00 | 34×23×39 3.3kg | R204.20 | declared = charged |
| 11-03 | RD9ZNN | TCGB55571882TF | #1945 | ECOR | 34×23×13 1.7kg | 37.5×26.1×10.8 1.7kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.6kg | R145.06 | declared = charged |
| 11-03 | PGFQ7Q | TCGB55571883TF | #1946 | LPF | 34×23×13 0.7kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 0.7kg | R129.95 | not measured by TCG; our declaration billed |
| 11-03 | 4NLHHC | TCGB55571884TF | #1954 | ECO | 34×23×13 2.1kg | 39.2×31.9×13.8 1.65kg | 5 | R224.02 | R224.02 | +0.00 | 34×23×13 2kg | R222.82 | declared = charged |
| 11-03 | CLDNGM | TCGB55571885TF | #1956 | ECOR | 34×23×13 1.3kg | 33.7×26.9×12.8 1.3kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-03 | 9TK3ZS | TCGB55571886TF | #1957 | LPF | 34×23×13 1.3kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.2kg | R129.95 | not measured by TCG; our declaration billed |
| 11-03 | NJXKFN | TCGB55571887TF | #1962 | ECOR | 34×23×13 1.3kg | 38.7×31×13.6 1.3kg | 5 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-03 | N3B4CS | TCGB55571890TF | #1963 | ECO | 40×30×8 0.55kg | 34×19.6×14.9 0.55kg | 3 | R143.52 | R143.52 | +0.00 | 41×34×8 0.45kg | R142.32 | declared = charged |
| 11-03 | 4RZKRJ | TCGB55571891TF | #1965 | ECOR | 40×30×18 2.1kg | not measured | 6 | R291.38 | R291.38 | +0.00 | 41×34×9.4 1.85kg | R225.56 | clothing declared in a 40×30×18 box |
| 11-03 | F336PK | TCGB55571892TF | #1966 | ECOR | 40×30×8 0.55kg | 43.2×36.7×4.7 0.55kg | 2 | R146.28 | R143.64 | +2.64 | 41×34×8 0.45kg | R145.06 | TCG measured smaller than declared |
| 11-03 | WS34VL | TCGB55571893TF | #1967 | ECOR | 34×23×13 1.2kg | not measured | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.1kg | R145.06 | not measured by TCG; our declaration billed |
| 11-03 | DH7RGD | TCGB55571895TF | #1968 | LPF | 34×23×26 2.6kg | not measured | 4 | R131.04 | R131.04 | +0.00 | 34×23×26 2.4kg | R129.95 | not measured by TCG; our declaration billed |
| 11-03 | KCQ9SQ | TCGB55571896TF | #1970 | ECO | 34×23×13 1.3kg | 38.7×32.9×14 1.3kg | 5 | R143.52 | R143.52 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-03 | JNGZ4S | TCGB55571897TF | #1971 | LPF | 34×23×13 1.4kg | not measured | 2 | R131.04 | R131.04 | +0.00 | 34×23×13 1.3kg | R129.95 | not measured by TCG; our declaration billed |
| 11-03 | K78R7K | TCGB55571898TF | #1935 | ECO | 35×23×14 0.35kg | 41.2×27.5×11.9 0.35kg | 4 | R143.52 | R143.52 | +0.00 | 41×34×8 0.2kg | R142.32 | clothing declared in a 35×23×14 box |
| 11-03 | QD8MRK | TCGB55571899TF | #1947 | ECOR | 40×30×8 1.15kg | 38.6×29.6×12.3 2.02kg | 4 | R146.28 | R146.28 | +0.00 | 41×34×8 1.05kg | R145.06 | declared = charged |
| 11-03 | 7Q89VW | TCGB55571900TF | #1948 | ECO | 40×30×8 1.15kg | 36.6×40.2×10.9 1.15kg | 5 | R143.52 | R143.52 | +0.00 | 41×34×8 1.05kg | R142.32 | declared = charged |
| 11-03 | VCHSZR | TCGB55571700TF | #1951 | ECOR | 40×30×8 0.55kg | not measured | 3 | R146.28 | R146.28 | +0.00 | 41×34×8 0.45kg | R145.06 | not measured by TCG; our declaration billed |
| 11-03 | 3BKGRQ | TCGB55571699TF | #1961 | ECOR | 40×30×18 0.85kg | 37.6×31.8×12.3 0.85kg | 4 | R210.88 | R146.28 | +64.60 | 41×34×8.2 0.6kg | R145.06 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 11-03 | 4QCXTM | TCGB55571691TF | #1964 | LPF | 34×23×26 3.2kg | 41.2×30.7×15.5 1.55kg | 4 | R131.04 | R131.04 | +0.00 | 34×23×26 3kg | R129.95 | declared = charged |
| 11-03 | 8JN9PK | TCGB55571697TF | #1972 | ECOR | 34×23×13 1.3kg | 31×28×12.8 1.08kg | 3 | R146.28 | R146.28 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-03 | FV6X7Q | TCG197412014T | 1942 return | L2DL - ECO | 34×46×39 6.1kg | not measured | 16 | R193.60 | R193.60 | +0.00 | — | — | customer return (locker price by locker size) |
| 11-03 | QMGQ4G | TCGB55571695TF | #1973 | ECO | 34×23×26 2.4kg | 41.1×32.2×25.7 1.85kg | 9 | R205.92 | R205.92 | +0.00 | 34×23×26 2.2kg | R204.20 | declared = charged |
| 11-05 | KT799D | TCGB55571687TF | #2001 | ECO | 40×30×8 0.55kg | 39.6×28.9×11.8 0.55kg | 4 | R142.32 | R142.32 | +0.00 | 41×34×8 0.45kg | R142.32 | declared = charged |
| 11-05 | 3DZ9QV |  | #1882 | LPP | 45×35×25 1.6kg | not measured | 8 | R149.44 | R149.44 | +0.00 | 41×34×12.4 1.2kg | R149.44 | clothing declared in a 45×35×25 box |
| 11-05 | 97B39B | TCGB55571685TF | #1988 | ECO | 40×30×8 0.55kg | 38.3×33.7×9.5 0.55kg | 4 | R142.32 | R142.32 | +0.00 | 41×34×8 0.45kg | R142.32 | declared = charged |
| 11-05 | CTBLLV | TCGB55571684TF | #1980 | ECO | 40×30×8 1.15kg | 38×27.4×9.2 1.1kg | 3 | R222.82 | R222.82 | +0.00 | 41×34×8 1.05kg | R222.82 | declared = charged |
| 11-05 | XVDQGS | TCGB55571683TF | #1905 | ECO | 40×30×18 1.5kg | 39.6×31.1×6.3 1.5kg | 2 | R204.20 | R129.95 | +74.25 | 41×34×8 1.25kg | R142.32 | clothing declared in a 40×30×18 box — shipped in a flat bag |
| 11-05 | CRJQVD | TCGB55571681TF | #1975 | ECO | 40×30×8 0.35kg | 38.9×29.4×13.3 0.35kg | 4 | R142.32 | R142.32 | +0.00 | 41×34×8 0.25kg | R142.32 | declared = charged |
| 11-05 | ZSLPZS | TCGB55571682TF | #1976 | ECO | 34×23×13 1.4kg | 31.7×26.8×12.9 1.82kg | 3 | R142.32 | R142.32 | +0.00 | 34×23×13 1.3kg | R142.32 | declared = charged |
| 11-05 | JKWX8N | TCGB55571680TF | #1979 | ECO | 34×23×13 1.3kg | 32.9×39×12.9 1.35kg | 5 | R142.32 | R142.32 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-05 | LBF46M | TCGB55571679TF | #1978 | ECOR | 34×23×13 1.2kg | 33.9×24.3×12 1.2kg | 3 | R145.06 | R145.06 | +0.00 | 34×23×13 1.1kg | R145.06 | declared = charged |
| 11-05 | JDGR4P | TCGB55571678TF | #1983 | ECO | 34×23×13 1.3kg | 31×25.1×13.1 1.3kg | 3 | R142.32 | R142.32 | +0.00 | 34×23×13 1.2kg | R142.32 | declared = charged |
| 11-05 | XRTXBW | TCGB55571677TF | #1986 | ECOR | 34×23×13 0.6kg | 32.4×20×14.4 0.6kg | 3 | R145.06 | R145.06 | +0.00 | 34×23×13 0.6kg | R145.06 | declared = charged |
| 11-05 | DLNBDN | TCGB55571675TF | #1987 | ECO | 34×23×26 2.4kg | 34.3×21.7×23.5 1.8kg | 5 | R204.20 | R142.32 | +61.88 | 34×23×26 2.2kg | R204.20 | 2 stacked shoeboxes; TCG measured them tighter |
| 11-05 | 7HMPXF | TCGB55571673TF | #1958 | ECO | 34×23×26 3.15kg | 34×17×22.7 1.6kg | 4 | R204.20 | R142.32 | +61.88 | 34×23×26 2.95kg | R204.20 | 2 stacked shoeboxes; TCG measured them tighter |
| 11-05 | PVFMNC | TCGB55571672TF | #1993 | ECOR | 34×23×13 1.6kg | 32.8×39.5×12 1.25kg | 4 | R145.06 | R145.06 | +0.00 | 34×23×13 1.5kg | R145.06 | declared = charged |
| 11-05 | WWFKXG | TCGB55571671TF | #1996 | ECOR | 34×23×13 1.2kg | 31.6×37.5×12.6 1.2kg | 4 | R225.56 | R225.56 | +0.00 | 34×23×13 1.1kg | R225.56 | declared = charged |
| 11-05 | C84Q6N | TCGB55571670TF | #1991 | ECOR | 34×23×16 3.2kg | 38.9×27.1×22 2.2kg | 6 | R145.06 | R209.12 | -64.06 | 34×23×18 3.1kg | R145.06 | overflow on top; TCG measured a bigger parcel |
| 11-05 | 9BTHCG | TCGB55571669TF | #1994 | ECOR | 34×23×13 1.3kg | not measured | 3 | R145.06 | R145.06 | +0.00 | 34×23×13 1.2kg | R145.06 | not measured by TCG; our declaration billed |
| 11-05 | DRHMWQ | TCGB55571668TF | #1990 | ECO | 34×23×29 2.9kg | 38.7×32.6×26.5 2.35kg | 9 | R204.20 | R204.20 | +0.00 | 34×23×29 2.7kg | R204.20 | overflow on top |
| 11-05 | PKW6TL | TCGB55571666TF | #1997 | ECOR | 34×23×13 1.7kg | 34.5×24.4×12.5 1.7kg | 3 | R145.06 | R145.06 | +0.00 | 34×23×13 1.6kg | R145.06 | declared = charged |
| 11-05 | LJ4H4N | TCGB55571665TF | #1999 | LPF | 34×23×13 1.4kg | not measured | 2 | R129.95 | R129.95 | +0.00 | 34×23×13 1.3kg | R129.95 | not measured by TCG; our declaration billed |
| 11-05 | 98LLFM | TCGB55571664TF | #1995 | LPF | 40×30×8 1.15kg | not measured | 2 | R129.95 | R129.95 | +0.00 | 41×34×8 1.05kg | R129.95 | not measured by TCG; our declaration billed |
| 11-05 | 9PTSRS | TCGB55571663TF | #1998 | ECOR | 34×23×13 1.3kg | 31.7×38.5×12.9 1.3kg | 4 | R225.56 | R225.56 | +0.00 | 34×23×13 1.2kg | R225.56 | declared = charged |
| 11-05 | 7R7ZZS | TCGB55571662TF | #2000 | ECOR | 34×23×13 1.3kg | 38.4×32×12.1 1.3kg | 4 | R145.06 | R145.06 | +0.00 | 34×23×13 1.2kg | R145.06 | declared = charged |
| 11-05 | GPLJZN | TCGB55571661TF | #2005 | ECOR | 34×23×13 1.2kg | 31.7×38.8×10.7 1.2kg | 4 | R225.56 | R225.56 | +0.00 | 34×23×13 1.1kg | R225.56 | declared = charged |
| 11-05 | SK8W6M | TCGB55571660TF | #1984 | ECOR | 40×30×8 0.95kg | not measured | 3 | R145.06 | R145.06 | +0.00 | 41×34×8 0.85kg | R145.06 | not measured by TCG; our declaration billed |
