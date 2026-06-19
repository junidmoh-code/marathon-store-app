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

import Transfer from "./Transfer";
import Locator from "./Locator";
import Adjust from "./Adjust";
import MovementHistory from "./MovementHistory";
import CountSession from "./CountSession";
import SetQuantity from "./SetQuantity";

// Stock rework: Transfer (assistant-style, one-step) + Locator are primary;
// History/Adjust/Count retained. Receiving moved into the admin product-add
// form; the standalone Receive + In-Transit screens are retired. Locator is
// admin-only for now (gated below).
const BASE_TABS = [
  ["transfer",  "Transfer"],
  ["locate",    "Where is it"],
  ["setqty",    "Set Qty"],
  ["history",   "History"],
  ["adjust",    "Adjust"],
  ["count",     "Count"],
];

// Tabs only an ADMIN sees — they write `adjustment` movements, which the rule layer
// permits for stockRole==admin only. Everything else (transfer/locate/setqty[received,
// opening]/history) is available to warehouse|admin. (Barcodes moved to the home page.)
const ADMIN_ONLY_TABS = new Set(["adjust", "count"]);

export default function StockView({ products = [], onExit }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const registry = useLocations();
  const { pending, syncing } = useSyncStatus();

  // Snapshot label only; the security rule is the real authority (reads
  // /users/{uid}/stockRole). Super-admin acts as admin for stock purposes.
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const isAdmin = actorRole === "admin";
  const canStock = isAdmin || actorRole === "warehouse"; // warehouse|admin (the seed counters)

  // Drop admin-only tabs for non-admins. Filter the tab set first so the
  // default/clamp logic operates on the visible tabs.
  const TABS = isAdmin ? BASE_TABS : BASE_TABS.filter(([k]) => !ADMIN_ONLY_TABS.has(k));

  const [tabRaw, setTab] = usePersistedTab("stock", "transfer");
  // Guard against a stale/unknown persisted tab key rendering blank content.
  const tab = TABS.some(([k]) => k === tabRaw) ? tabRaw : "transfer";

  const shared = { products, registry, actorRole };

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

      <div style={{ padding: "4px 12px 40px" }}>
        {tab === "transfer" && <Transfer {...shared} />}
        {tab === "locate"   && <Locator {...shared} />}
        {tab === "setqty"   && canStock && <SetQuantity {...shared} canStock={canStock} isAdmin={isAdmin} />}
        {tab === "adjust"   && <Adjust {...shared} isAdmin={isAdmin} />}
        {tab === "history"  && <MovementHistory {...shared} />}
        {tab === "count"    && isAdmin && <CountSession {...shared} />}
      </div>
    </div>
  );
}
