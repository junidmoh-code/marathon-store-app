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

/** The banner on a hub order card (and anywhere a single line is shown on its own). */
export function WebOrderBanner({ since, orderNumber = null, children = null }) {
  const now = useNowTick();
  return (
    <div role="alert" data-testid="web-order-banner"
         style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "0 0 8px", padding: "7px 10px", borderRadius: 9,
                  background: "rgba(255,69,58,.16)", border: `2px solid ${WEB_RED}`, color: "#fff" }}>
      <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: ".06em", color: WEB_RED }}>WEBSITE ORDER{orderNumber != null ? ` #${orderNumber}` : ""}</span>
      <span style={{ fontWeight: 700, fontSize: 12 }}>pull this first</span>
      <span style={{ marginLeft: "auto" }}><WebWaitChip since={since} now={now} /></span>
      {children}
    </div>
  );
}

/**
 * The top of a hub's queue: every website pick still to be pulled, longest-waiting first, in one red block.
 * The cards themselves (with Mark as Sent / Out of Stock) are just below, website picks first.
 *   orders  the hub's incoming website picks: [{ id, productName, size, createdAt }]
 */
export function HubWebPicksSummary({ orders }) {
  const now = useNowTick();
  const list = [...(orders || [])].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (!list.length) return null;
  return (
    <div data-testid="hub-web-summary" role="alert" style={{ margin: "0 0 12px", borderRadius: 12, border: `2px solid ${WEB_RED}`, background: "rgba(255,69,58,.08)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: WEB_RED, color: "#fff" }}>
        <span style={{ fontWeight: 900, fontSize: 13, letterSpacing: ".08em" }}>WEBSITE ORDERS — PULL THESE FIRST</span>
        <span style={{ marginLeft: "auto", background: "#fff", color: WEB_RED, fontWeight: 900, fontSize: 13, borderRadius: 999, padding: "1px 9px" }}>{list.length}</span>
      </div>
      {list.map((o) => (
        <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderTop: "1px solid rgba(255,69,58,.25)", color: "#fff" }}>
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontWeight: 900, fontSize: 14, color: WEB_RED, minWidth: 40 }}>{o.id}</span>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.productName}{o.size ? ` — Size ${o.size}` : ""}</span>
          <WebWaitChip since={o.createdAt} now={now} />
        </div>
      ))}
    </div>
  );
}
