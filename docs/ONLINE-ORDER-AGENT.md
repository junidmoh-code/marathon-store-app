# Website-order agent (Junid, 14 Nov 2026)

Runs on the Mac mini every 15 minutes, 08:00–18:15 SAST (`com.marathon.orderagent`,
`scripts/online/order-agent.mjs --commit`). Kill switch: `/config/onlineOrders/orderAgentOff = true`.

## What the POS card shows (Junid's final decision, 14 Nov 2026)
- **Red** only when (a) an item is genuinely unavailable (a place rejected it or could not find it, or it is not
  anywhere), or (b) the customer owes us money (a dearer pick's difference unpaid). A few plain words:
  "Item unavailable — Jamie offering alternatives", "R100 difference unpaid".
- **Clock**: exchanges waiting for the customer's return, in their own section at the bottom.
- **Green**: everything else — ready to pack, waiting for items, released or on its way from a hub or shop, and
  orders where we owe the customer a balance (settled digitally afterwards on Junid's command). Green rows whose
  items are still on the way show a small "X of Y here".
- The agent stamps every open order it checks at `online_orders/{id}/agent` (`at`, `group`, `reason`, `detail`,
  `actions`, `note`); the card's "Order agent · last run" line reads it.

## What the agent does for a red order (scripts/online/orderAgent/judge.mjs)
1. **Settled**: Shopify's refund record for the line (≥30 min old, so Jamie's own reconcile goes first) →
   the line is closed through the Settings path (`escalationOverride: resolved`).
2. **Customer owes an answer**: after 4 h of silence Jamie follows up (once a SAST day); after 24 h Jamie
   applies Junid's rules (alternatives first, never a refund of its own).
3. **Difference unpaid**: Jamie sends / resends the payment link (once a day).
4. **A place could not produce it** and another place on the line's route has a free unit → re-pick there
   (`online_orders/{id}/agentRepicks`, applied by the poller: `scripts/shopify/onlineOrders/agentRepick.mjs`),
   keeping the line's item (a swapped line too). The place that failed is skipped unless stock reached it since;
   a walk-in sale that took the held unit is not a failure of the place.
   **Still at a place**: a web push to that place's assigned staff after 2 trading hours (hubs and, once
   their staff are switched on, the shops), Junid in the Jamie app after 4 (one case per order per day).
   **On its way** (released, not yet confirmed at PE): red, no action — today the till confirms a unit only
   at the Pack.
5. **Genuinely unavailable** (nowhere on the route, nothing at Central) → Jamie offers alternatives now.

Trading hours are each location's own: by default Mon–Sat 09:00–18:00, Sun 09:00–14:00; Concrete Mon–Fri
09:00–17:00, Sat 09:00–16:00, Sun 09:00–14:00 (SAST). Shop staff are nudged through the Order Alerts card's
"Website picks (shops)" group (rule line to paste: docs/ORDER-AGENT-RULES.md).

Hand-offs to Jamie are rows in Jamie's SQLite `jamie_chase_requests` (`scripts/online/orderAgent/chaseQueue.mjs`;
consumer `marathon-dm-agent/src/jimmy/chaseRequests.js`). Every action is logged with its evidence at
`online_order_agent/log/{day}`; `online_order_agent/lastRun` holds the last run's counts. At the first run
from 18:00 the day's summary (turned green, shipped, chased, still red and why) goes to Junid in the Jamie app.

**Never**: a stock or refill request created, changed or cancelled; a policy value; a stock movement
(stock deducts only at the Pack).
