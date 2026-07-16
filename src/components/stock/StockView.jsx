// ─── STOCK VIEW (shell) ───────────────────────────────────────────────────────
// Admin-gated Stock section. Self-contained component tree under components/stock/
// (the App.jsx monolith only gains the role wiring). Tabs route to the per-task
// screens; every write flows through applyMovement(). See design docs.

import React from "react";
import { usePersistedTab, useWide } from "./hooks";
import { usePermissions } from "../PermissionsContext";
import { useLocations } from "./useStock";
import { useSyncStatus } from "./offlineQueue";
import { FONT, BG, BLUE_L, GRAY, GREEN, AMBER, tabOn, tabOff } from "./ui";

import Transfer from "./Transfer";
import Locator from "./Locator";
import Adjust from "./Adjust";
import MovementHistory from "./MovementHistory";
import CountSession from "./CountSession";
import SetQuantity from "./SetQuantity";
import CountedStockReview from "./CountedStockReview";
import StockErrorBoundary from "./StockErrorBoundary";
import MoveExcess from "./MoveExcess";

// Stock rework: Transfer (assistant-style, one-step) + Locator are primary;
// History/Adjust/Count retained. Receiving moved into the admin product-add
// form; the standalone Receive + In-Transit screens are retired. Locator is
// admin-only for now (gated below).
const BASE_TABS = [
  ["transfer",  "Transfer"],
  // "Health" moved to its own home-screen module (HealthView) — owner decision.
  ["locate",    "Where is it"],
  ["setqty",    "Set Qty"],
  ["history",   "History"],
  ["adjust",    "Adjust"],
  ["count",     "Count"],
  ["recount",   "Counted"],      // PERMANENT counted-stock review (admin-only; owner decision 2026-07-16)
  ["excess",    "Move Excess"],  // TEMPORARY bulk hub2→central rebalance (admin-only)
];

// Tabs only an ADMIN sees — they write `adjustment` movements, which the rule layer
// permits for stockRole==admin only. Everything else (transfer/locate/setqty[received,
// opening]/history) is available to warehouse|admin. (Barcodes moved to the home page.)
// Move Excess writes transfer_out (warehouse-permitted at the rule layer) but is a
// bulk tool — deliberately admin-gated in the UI.
const ADMIN_ONLY_TABS = new Set(["adjust", "count", "recount", "excess"]);

// Desktop shell — icons per tool, grouped in the sidebar, plus a one-line
// header per tool. Tool CONTENTS are unchanged (they render in the main pane).
const TAB_ICON = {
  transfer: <path d="M20 7h-9M14 17H5M17 3l3 4-3 4M7 21l-3-4 3-4" />,
  excess:   <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M4 21h16" /></>,
  locate:   <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></>,
  setqty:   <path d="M12 5v14M5 12h14" />,
  history:  <><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></>,
  adjust:   <><path d="M20 7h-9M4 7h3M14 17h6M4 17h6" /><circle cx="9" cy="7" r="2.5" /><circle cx="14" cy="17" r="2.5" /></>,
  count:    <><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>,
  recount:  <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
};
const TAB_META = {
  transfer: ["Transfer", "Move stock between locations."],
  excess:   ["Move Excess", "Bulk hub 2 → central rebalance (admin)."],
  locate:   ["Where is it", "Find any product across every location."],
  setqty:   ["Set Qty", "Set received / opening on-hand."],
  history:  ["History", "The full movement ledger."],
  adjust:   ["Adjust", "Admin stock corrections."],
  count:    ["Count", "Run a stock-take."],
  recount:  ["Counted", "Review & post counted differences."],
};
const TAB_GROUPS = [
  ["Move & find", ["transfer", "locate", "setqty"]],
  ["Audit", ["history", "adjust", "count", "recount", "excess"]],
];

export default function StockView({ products = [], onExit }) {
  const isWide = useWide(1024);
  const { permRecord, isSuperAdmin, hasPermission } = usePermissions();
  const registry = useLocations();
  const { pending, syncing } = useSyncStatus();

  // Snapshot label only; the security rule is the real authority (reads
  // /users/{uid}/stockRole). Super-admin acts as admin for stock purposes.
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const isAdmin = actorRole === "admin";
  // Set-Qty access: warehouse|admin stockRole OR the "stock_add" permission. (Writes
  // still need a stockRole at the rule layer — surfaced as a soft error if missing.)
  const canStock = isAdmin || actorRole === "warehouse" || hasPermission("stock_add");

  // Drop admin-only tabs for non-admins. Filter the tab set first so the
  // default/clamp logic operates on the visible tabs.
  const TABS = isAdmin ? BASE_TABS : BASE_TABS.filter(([k]) => !ADMIN_ONLY_TABS.has(k));

  const [tabRaw, setTab] = usePersistedTab("stock", "transfer");
  // Guard against a stale/unknown persisted tab key rendering blank content.
  const tab = TABS.some(([k]) => k === tabRaw) ? tabRaw : "transfer";

  const shared = { products, registry, actorRole };

  // Active tool content — shared by both layouts.
  const content = (
    <>
      {tab === "transfer" && <Transfer {...shared} />}
      {tab === "excess"   && isAdmin && <MoveExcess {...shared} />}
      {tab === "locate"   && <Locator {...shared} />}
      {tab === "setqty"   && canStock && <SetQuantity {...shared} canStock={canStock} isAdmin={isAdmin} />}
      {tab === "adjust"   && <Adjust {...shared} isAdmin={isAdmin} />}
      {tab === "history"  && <MovementHistory {...shared} />}
      {tab === "count"    && isAdmin && <CountSession {...shared} />}
      {tab === "recount"  && isAdmin && <StockErrorBoundary><CountedStockReview {...shared} /></StockErrorBoundary>}
    </>
  );

  // ── DESKTOP WORKSPACE (≥1024px) — a left rail of tools + a titled main pane.
  //    No aggregate dashboard: staff only see the tool they open. Mobile keeps
  //    the horizontal tab strip below. ──
  if (isWide) {
    const [title, sub] = TAB_META[tab] || ["Stock", ""];
    const navBtn = (k, label) => {
      const on = tab === k;
      return (
        <button key={k} onClick={() => setTab(k)}
          style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left", cursor: "pointer", fontFamily: FONT, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "9px 11px",
                   background: on ? "rgba(74,127,255,.13)" : "transparent", border: on ? "1px solid rgba(74,127,255,.42)" : "1px solid transparent",
                   color: on ? "#9DBCFF" : "rgba(233,238,255,.55)", transition: "background .14s, color .14s" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: .9 }}>{TAB_ICON[k]}</svg>
          <span style={{ flex: 1 }}>{label}</span>
          {k === "recount" && <span style={{ fontSize: 12, color: AMBER }}>⚠</span>}
        </button>
      );
    };
    return (
      <div style={{ height: "100vh", background: "#000", color: "#f3f6ff", fontFamily: FONT, display: "grid", gridTemplateColumns: "230px minmax(0,1fr)", overflow: "hidden" }}>
        {/* RAIL */}
        <aside style={{ background: "rgba(255,255,255,.015)", borderRight: "1px solid rgba(255,255,255,.08)", padding: "22px 13px 16px", display: "flex", flexDirection: "column", gap: 3, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 9px 6px" }}>
            <span style={{ fontSize: 19, fontWeight: 800, fontStyle: "italic", letterSpacing: -.6 }}>marathon</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 5, color: "#4A7FFF" }}>CLUB</span>
          </div>
          <button onClick={onExit} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "rgba(233,238,255,.6)", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT, marginBottom: 8 }}>← Exit</button>
          {TAB_GROUPS.map(([label, keys]) => {
            const items = keys.filter(k => TABS.some(([tk]) => tk === k));
            if (!items.length) return null;
            return (
              <div key={label}>
                <div style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(233,238,255,.3)", padding: "12px 9px 6px", fontWeight: 700 }}>{label}</div>
                {items.map(k => navBtn(k, TABS.find(([tk]) => tk === k)[1]))}
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 11, background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.08)", fontSize: 11.5, color: syncing ? AMBER : "rgba(233,238,255,.55)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: syncing ? AMBER : GREEN, boxShadow: `0 0 8px ${syncing ? AMBER : GREEN}` }} />
            {syncing ? `Syncing ${pending}…` : "All synced · live"}
          </div>
        </aside>

        {/* MAIN */}
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "20px 28px 16px", borderBottom: "1px solid rgba(255,255,255,.08)", background: "radial-gradient(800px 280px at 15% -60%, rgba(74,127,255,.08), transparent)" }}>
            <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -.4 }}>{title}</div>
            <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.55)", marginTop: 3 }}>{sub}</div>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 28px 48px" }}>
            <div style={{ maxWidth: 1120, margin: "0 auto" }}>{content}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ padding: "14px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Exit</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Stock</div>
        <div style={{ fontSize: 11, color: syncing ? AMBER : GRAY, minWidth: 64, textAlign: "right" }}>
          {syncing ? `syncing ${pending}…` : ""}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "6px 12px 12px", WebkitOverflowScrolling: "touch" }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={tab === k ? tabOn : tabOff}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "4px 12px 40px" }}>{content}</div>
    </div>
  );
}
