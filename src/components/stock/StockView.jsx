// ─── STOCK VIEW (shell) ───────────────────────────────────────────────────────
// Admin-gated Stock section. Self-contained component tree under components/stock/
// (the App.jsx monolith only gains the role wiring). Tabs route to the per-task
// screens; every write flows through applyMovement(). See design docs.

import React from "react";
import { usePersistedTab } from "./hooks";
import { usePermissions } from "../PermissionsContext";
import { useLocations } from "./useStock";
import { useSyncStatus } from "./offlineQueue";
import { FONT, BG, BLUE_L, GRAY, GREEN, AMBER, tabOn, tabOff } from "./ui";

import StockGrid from "./StockGrid";
import ReceiveStock from "./ReceiveStock";
import Transfer from "./Transfer";
import InTransit from "./InTransit";
import Adjust from "./Adjust";
import MovementHistory from "./MovementHistory";
import CountSession from "./CountSession";

const TABS = [
  ["grid",      "Stock"],
  ["receive",   "Receive"],
  ["transfer",  "Transfer"],
  ["transit",   "In Transit"],
  ["adjust",    "Adjust"],
  ["history",   "History"],
  ["count",     "Count"],
];

export default function StockView({ products = [], onExit }) {
  const [tab, setTab] = usePersistedTab("stock", "grid");
  const { permRecord, isSuperAdmin } = usePermissions();
  const registry = useLocations();
  const { pending, syncing } = useSyncStatus();

  // Snapshot label only; the security rule is the real authority (reads
  // /users/{uid}/stockRole). Super-admin acts as admin for stock purposes.
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const isAdmin = actorRole === "admin";

  const shared = { products, registry, actorRole };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ padding: "14px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div onClick={onExit} style={{ color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>← Exit</div>
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

      <div style={{ padding: "4px 12px 40px" }}>
        {tab === "grid"     && <StockGrid {...shared} />}
        {tab === "receive"  && <ReceiveStock {...shared} />}
        {tab === "transfer" && <Transfer {...shared} />}
        {tab === "transit"  && <InTransit {...shared} />}
        {tab === "adjust"   && <Adjust {...shared} isAdmin={isAdmin} />}
        {tab === "history"  && <MovementHistory {...shared} />}
        {tab === "count"    && <CountSession {...shared} />}
      </div>
    </div>
  );
}
