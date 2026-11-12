// ─── STOCK VIEW (shell) ───────────────────────────────────────────────────────
// Admin-gated Stock section. Self-contained component tree under components/stock/
// (the App.jsx monolith only gains the role wiring). Tabs route to the per-task
// screens; every write flows through applyMovement(). See design docs.
//
// Layout (Junid 12 Nov, Stock redesign): ONE layout at every width. The shell
// header's pill already says STOCK and its grid button goes back, so there is
// no in-page Exit, title or wordmark. The tools are ONE horizontally scrolling
// row of single-line pills — the selected one solid navy, scrolled into view —
// and the open tool renders below it. Presentation only: the tab set, its
// admin gate and every tool are exactly as before.

import React from "react";
import { usePersistedTab } from "./hooks";
import { useScrollRow } from "./useScrollRow";
import { usePermissions } from "../PermissionsContext";
import { useLocations } from "./useStock";
import { useSyncStatus } from "./offlineQueue";
import { FONT } from "./ui";

import Transfer from "./Transfer";
import Locator from "./Locator";
import Adjust from "./Adjust";
import MovementHistory from "./MovementHistory";
import CountSession from "./CountSession";
import SetQuantity from "./SetQuantity";
import CountedStockReview from "./CountedStockReview";
import StockErrorBoundary from "./StockErrorBoundary";
import MoveExcess from "./MoveExcess";
import InTransit from "./InTransit";
import DuplicatesTab from "./DuplicatesTab";
import DisplayRecordsTab from "./DisplayRecordsTab";

// Stock rework: Transfer (assistant-style) + Locator are primary;
// History/Adjust/Count retained. Receiving moved into the admin product-add
// form. In Transit returned 2026-07-19 (transit lanes for cross-building sends
// from Central — see transitLanes.js); same-building transfers stay one-step.
// Locator is admin-only for now (gated below).
const BASE_TABS = [
  ["transfer",  "Transfer"],
  ["intransit", "In Transit"],
  // "Health" moved to its own home-screen module (HealthView) — owner decision.
  ["locate",    "Where is it"],
  ["setqty",    "Set Qty"],
  ["history",   "History"],
  ["adjust",    "Adjust"],
  ["count",     "Count"],
  ["recount",   "Counted"],      // PERMANENT counted-stock review (admin-only; owner decision 2026-07-16)
  ["excess",    "Move Excess"],  // TEMPORARY bulk hub2→central rebalance (admin-only)
  ["duplicates","Duplicates"],   // side-by-side twin records + a recommended survivor (admin-only)
  // DUPLICATE DISPLAYS and UNREGISTERED DISPLAYS USED TO BE HERE. They moved
  // into the Display Registration card (owner correction, 2026-09-08), beside
  // its Hub 1 and Hub 2 tabs — that card is where an operator looks for
  // anything about a display wall, and the Stock console is not. Display
  // Records stays: it is about the hub REGISTER, which is stock-console work.
  ["displayrecs","Display Records"],  // a hub REGISTER row the shop floor contradicts (admin-only)
];

// Tabs only an ADMIN sees — they write `adjustment` movements, which the rule layer
// permits for stockRole==admin only. Everything else (transfer/locate/setqty[received,
// opening]/history) is available to warehouse|admin. (Barcodes moved to the home page.)
// Move Excess writes transfer_out (warehouse-permitted at the rule layer) but is a
// bulk tool — deliberately admin-gated in the UI.
const ADMIN_ONLY_TABS = new Set(["adjust", "count", "recount", "excess", "duplicates", "displayrecs"]);

export default function StockView({ products = [] }) {
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

  return (
    <div className="sky-stock" data-testid="stock-view" style={{ fontFamily: FONT }}>
      <StockTabRow tabs={TABS} tab={tab} onPick={setTab} />
      {syncing ? <div className="sky-stock__sync" role="status">Syncing {pending}…</div> : null}
      <div className="sky-stock__body">
        {tab === "transfer" && <Transfer {...shared} />}
        {tab === "intransit" && <InTransit {...shared} />}
        {tab === "excess"   && isAdmin && <MoveExcess {...shared} />}
        {tab === "locate"   && <Locator {...shared} />}
        {tab === "setqty"   && canStock && <SetQuantity {...shared} canStock={canStock} isAdmin={isAdmin} />}
        {tab === "adjust"   && <Adjust {...shared} isAdmin={isAdmin} />}
        {tab === "history"  && <MovementHistory {...shared} />}
        {tab === "count"    && isAdmin && <CountSession {...shared} />}
        {tab === "recount"  && isAdmin && <StockErrorBoundary><CountedStockReview {...shared} /></StockErrorBoundary>}
        {tab === "duplicates" && isAdmin && <StockErrorBoundary><DuplicatesTab products={products} registry={registry} /></StockErrorBoundary>}
        {tab === "displayrecs" && isAdmin && <StockErrorBoundary><DisplayRecordsTab products={products} isAdmin={isAdmin} mode="records" /></StockErrorBoundary>}
      </div>
    </div>
  );
}

// The tool row: a tablist of compact pills that never wrap. The selected tab
// is brought into view on mount and on every change — a persisted tab far to
// the right would otherwise open off-screen. Only the row scrolls (the page
// never does: inline "nearest" with the row as the only overflow box).
function StockTabRow({ tabs, tab, onPick }) {
  const rowRef = useScrollRow(tab);
  return (
    <div className="sky-stock__tabs-wrap">
      <div ref={rowRef} className="sky-stock__tabs sky-row1" role="tablist" aria-label="Stock tools" data-chip-row="">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`stock-tab-${k}`}
                  className="sky-stock__tab" onClick={() => onPick(k)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
