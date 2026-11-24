// ─── WEBSITE ORDERS STAND OUT (Junid, 24 Nov 2026) ───────────────────────────
// One banner for every staff screen a website line appears on — the Display
// Checks strip, a hub's order card, Central's strip in Source — so it reads the
// same everywhere: red, bold, at the top, with how long it has been waiting.
import { useEffect, useState } from "react";
import { webWaiting } from "../../utils/onlineOrders";

export const WEB_RED = "#FF453A";
const AMBER = "#E8A54A";
const LEVEL_COLOUR = { fresh: "#fff", late: AMBER, overdue: "#fff" };

/** Re-renders every half minute so "waiting 12 min" stays true without any read. */
export function useNowTick(everyMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(id); }, [everyMs]);
  return now;
}

/** "waiting 1 h 20 min" as a chip; nothing when the time is unknown. */
export function WebWaitChip({ since, now }) {
  const w = webWaiting(since, now);
  if (!w) return null;
  return (
    <span data-testid="web-wait" data-level={w.level}
          style={{ display: "inline-block", fontWeight: 800, fontSize: 12, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap",
                   background: w.level === "overdue" ? WEB_RED : w.level === "late" ? "rgba(232,165,74,.18)" : "rgba(255,255,255,.1)",
                   color: LEVEL_COLOUR[w.level], border: w.level === "late" ? `1px solid ${AMBER}` : "1px solid transparent" }}>
      {w.text}
    </span>
  );
}

/**
 * One pink for every website order code on every staff screen (Junid, 24 Nov 2026, 21:05): the code is the
 * headline, large, bold, monospace, never wrapped. #FF5CC8 on the dark card and on the banner's red tint is
 * above 6:1, and it is not the banner's red, so the code never blends into the border.
 */
export const WEB_PINK = "#FF5CC8";

export function WebOrderCode({ code, size = 30 }) {
  if (code == null || code === "") return null;
  return (
    <span data-testid="web-order-code"
          style={{ fontFamily: "ui-monospace, Menlo, monospace", fontWeight: 900, fontSize: size, lineHeight: 1.05, letterSpacing: ".06em",
                   color: WEB_PINK, whiteSpace: "nowrap", flex: "0 0 auto" }}>
      {code}
    </span>
  );
}

/**
 * The banner on a hub order card (and anywhere a single line is shown on its own). The red box itself says
 * "website order"; inside it the line's three-letter code is the headline in pink with how long it has been
 * waiting beside it. No other words (Junid, 24 Nov 2026, 21:05). Since Junid's 24 Nov evening brief this is the
 * ONLY place a hub sees a website pick: the separate "pull these first" box repeated the same orders and is
 * gone; the cards themselves lead the queue instead. role="status", not "alert": the wait chip ticks every half
 * minute and an alert region would make a screen reader re-announce every card each tick.
 */
export function WebOrderBanner({ since, orderNumber = null, code = null, children = null }) {
  const now = useNowTick();
  const headline = code || (orderNumber != null ? `#${orderNumber}` : null);
  return (
    <div role="status" aria-label={`Website order ${headline || ""}`.trim()} data-testid="web-order-banner"
         style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 8px", padding: "8px 12px", borderRadius: 10,
                  background: "rgba(255,69,58,.16)", border: `2px solid ${WEB_RED}`, color: "#fff" }}>
      <WebOrderCode code={headline} />
      <WebWaitChip since={since} now={now} />
      {children}
    </div>
  );
}
