// ─── DISPLAY CHECKS — CHECK CARD (PR 5, read-only) ───────────────────────────
// One card in the Today feed. Three visual states driven by the check's data,
// matching the design (§10):
//   • OUTSTANDING (open)   — full colour, a blue "Check Display" action.
//   • WAITING (held)       — greyscale, "Waiting on stock" chip, NO action.
//   • COMPLETED (day node) — dimmed to ~45%, the action swapped for a result tag
//                            (blue "Confirmed", grey "No Stock", amber override).
// A `repeatOf` check carries a thin amber left border + a "Repeat" chip — amber,
// a signal, not a punishment (§8.9).
//
// NO COLOUR field: colour lives in the product name (Phase 0), so the sub-line is
// size only. NO PIN: confirmation (PR 7) stamps the logged-in user; this card's
// action just OPENS that flow. In PR 5 no `onOpen` is passed, so the button is
// inert/disabled — PR 7 wires the handler and the confirm sheet.

import { FONT, MONO, BLUE, BLUE_SOFT, AMBER, INK, PANEL, META } from "./tokens";
import { formatSaTime, isNoStock, isOnlinePick } from "./feedModel";
import { PACKER_INSTRUCTION } from "../../utils/onlineOrders";

// WEBSITE ORDER PICK (kind "online_pick", docs/ONLINE-ORDERS.md): same card,
// but it says so — a green WEB-#### badge and the packer instruction — and its
// action reads as a pick, not a display check. Green is this module's one
// non-palette colour on purpose: it must never be mistaken for a check.
const WEB_GREEN = "#4ACA7A";
export function OnlineBadge({ record }) {
  return (
    <span style={{ ...META, fontSize: 10.5, letterSpacing: "0.12em", color: WEB_GREEN, fontWeight: 700,
                   background: "rgba(74,202,122,.12)", border: "1px solid rgba(74,202,122,.45)", borderRadius: 999,
                   padding: "3px 9px", display: "inline-block", whiteSpace: "nowrap" }}>
      WEBSITE · {record.orderNumber != null ? `#${record.orderNumber}` : (record.ref || "—")}{Number(record.qty) > 1 ? ` · ×${Number(record.qty)}` : ""}
    </span>
  );
}

// Escalation round 2 (docs/ONLINE-ORDERS.md § Escalation): the shop already
// answered "Not found" once, Hub 2 and Central could not cover it, and the
// item is asked of the shop again. Red, loud, impossible to skim past.
export function CheckProperlyBanner() {
  return (
    <div role="alert" style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 800, letterSpacing: "0.04em", color: "#FF6B6B",
                               background: "rgba(255,107,107,.14)", border: "2px solid #FF6B6B", borderRadius: 10, padding: "8px 10px" }}>
      CHECK PROPERLY — website order
    </div>
  );
}

const IMG = 96; // 1:1 product image, feed spec

function Chip({ label, color, bg, border }) {
  return (
    <span style={{ ...META, fontSize: 10, letterSpacing: "0.14em", color,
                   background: bg, border: `1px solid ${border}`, borderRadius: 999,
                   padding: "3px 9px", display: "inline-block", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// The result tag on a completed card. no_stock overridden by a manager reads amber.
function ResultTag({ record }) {
  if (isOnlinePick(record)) {
    const who = (record.completedBy && (record.completedBy.name || record.completedBy.uid)) || "—";
    const handed = record.result === "handed";
    return (
      <div style={{ ...META, fontSize: 11, color: handed ? WEB_GREEN : AMBER, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{handed ? "✓ HANDED TO PACKER" : "✗ NOT FOUND"}</span>
        <span style={{ color: "rgba(233,238,255,.4)" }}>· {String(who).toUpperCase()} · {formatSaTime(record.completedAt)}</span>
      </div>
    );
  }
  const noStock = isNoStock(record);
  const overridden = noStock && record.resultOverridden === true;
  const who = (record.completedBy && (record.completedBy.name || record.completedBy.uid)) || "—";
  const when = formatSaTime(record.completedAt);
  const color = overridden ? AMBER : noStock ? "rgba(233,238,255,.55)" : BLUE_SOFT;
  const label = overridden ? "NO STOCK · OVERRIDDEN" : noStock ? "NO STOCK" : "CONFIRMED";
  return (
    <div style={{ ...META, fontSize: 11, color, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span>{noStock ? "✗" : "✓"} {label}</span>
      <span style={{ color: "rgba(233,238,255,.4)" }}>· {String(who).toUpperCase()} · {when}</span>
    </div>
  );
}

export default function CheckCard({ check, variant, onOpen }) {
  // variant: "outstanding" | "waiting" | "completed"
  const held = variant === "waiting";
  const completed = variant === "completed";
  const isRepeat = !!check.repeatOf;
  const online = isOnlinePick(check);

  const name = check.productName || "Unknown";
  const size = check.size && check.size !== "_" ? String(check.size) : null;
  const saleCount = Number(check.saleCount) || 1;
  const soldAt = formatSaTime(check.lastSoldAt || check.firstSoldAt || check.createdAt);

  return (
    <div style={{
      ...PANEL,
      padding: 12,
      display: "flex",
      flexDirection: "column",
      gap: 10,
      opacity: completed ? 0.45 : 1,
      filter: held ? "grayscale(1)" : "none",
      borderLeft: isRepeat ? `3px solid ${AMBER}` : PANEL.border,
    }}>
      {/* Image + chips row */}
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ width: IMG, height: IMG, flexShrink: 0, borderRadius: 12, overflow: "hidden",
                      background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.06)",
                      display: "flex", alignItems: "center", justifyContent: "center" }}>
          {check.photoUrl
            ? <img src={check.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ ...META, fontSize: 9, color: "rgba(233,238,255,.3)" }}>NO IMAGE</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {online && <OnlineBadge record={check} />}
            {isRepeat && <Chip label="REPEAT" color={AMBER} bg="rgba(232,165,74,.12)" border="rgba(232,165,74,.4)" />}
            {held && <Chip label="WAITING ON STOCK" color="rgba(233,238,255,.5)" bg="rgba(255,255,255,.04)" border="rgba(255,255,255,.1)" />}
          </div>
          <div style={{ fontFamily: FONT, fontSize: 15.5, fontWeight: 680, color: INK, lineHeight: 1.25,
                        overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
          </div>
          <div style={{ ...META, fontSize: 11, color: "rgba(233,238,255,.5)", display: "flex", gap: 10, flexWrap: "wrap" }}>
            {size && <span style={{ fontFamily: MONO }}>{size}</span>}
            {!online && soldAt && <span>SOLD {soldAt}</span>}
            {!online && saleCount > 1 && <span style={{ color: BLUE_SOFT }}>×{saleCount}</span>}
          </div>
          {online && !completed && check.checkProperly === true && <CheckProperlyBanner />}
          {online && !completed && (
            <div style={{ fontFamily: FONT, fontSize: 13, fontWeight: 650, color: WEB_GREEN }}>{PACKER_INSTRUCTION}</div>
          )}
        </div>
      </div>

      {/* Action / result footer */}
      {completed
        ? <ResultTag record={check} />
        : held
          ? null /* held cards have no action — nothing to do until stock lands */
          : (
            <button
              type="button"
              disabled={!onOpen}
              onClick={onOpen ? () => onOpen(check) : undefined}
              style={{
                fontFamily: FONT, fontSize: 14.5, fontWeight: 700, width: "100%",
                padding: "12px 14px", borderRadius: 12, minHeight: 48,
                cursor: onOpen ? "pointer" : "default",
                color: onOpen ? (online ? "#04140a" : "#04102e") : "rgba(233,238,255,.4)",
                background: onOpen ? (online ? WEB_GREEN : BLUE) : "rgba(74,127,255,.10)",
                border: onOpen ? "none" : "1px solid rgba(74,127,255,.2)",
              }}
            >
              {online ? "Pick for website order" : "Check Display"}
            </button>
          )}
    </div>
  );
}
