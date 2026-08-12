// ─── STOCK HOLD — MASTER FLAG + ACCESS GATE ──────────────────────────────────
// TEMPORARY MODULE, same removal contract as src/config/hubSneakerCount.js:
// this exists so the hub count can run while trading continues. When the count
// is finished, flip STOCK_HOLD_ENABLED to false and the release card and route
// go dark in one line; deleting the module later is a clean removal.
//
// WHAT IT GATES: the central→hub HELD-CREDIT lane. Staff fulfil exactly as
// today, but the destination hub credit is parked at stock/in_transit until
// the OWNER confirms the physical box arrived — one tap per shipment, where a
// shipment is everything fulfilled between two release windows.
//
// ── TWO SWITCHES, DIFFERENT JOBS ─────────────────────────────────────────────
//   • STOCK_HOLD_ENABLED (here, code)  — does the UI exist at all.
//   • /settings/stockHold/config/enabled (RTDB) — is HOLDING actually on.
//     ABSENT OR FALSE MEANS OFF (fail-safe, the ruleBasedTargets grammar):
//     fulfil credits the hub instantly, exactly today's behaviour. This is THE
//     kill switch — deletable from any console, no deploy.
//
// DEPLOY ORDER MATTERS: the engine must be reading held lines as inbound
// (functions/refill-scan.cjs) BEFORE the RTDB switch is turned on, or every
// held cell double-orders. The switch defaulting to OFF is what makes the
// hosting deploy safe on its own.

import { ADMIN_EMAIL } from "../components/PermissionsContext";

export const STOCK_HOLD_ENABLED = true;

// The one RTDB subtree this feature owns — under /settings for the same reason
// as the count session: the only node the live rules let a signed-in app user
// write without a rules change. (Hardening rule to add in the console later:
// /settings/stockHold: .write auth != null && non-anonymous.)
export const STOCK_HOLD_ROOT = "settings/stockHold";

export function isStockHoldSuperAdmin(viewer) {
  return !!viewer && viewer.email === ADMIN_EMAIL;
}

/**
 * May this viewer see the release card and release shipments?
 * The OWNER, plus any uid the owner has named as a delegate in
 * /settings/stockHold/config/delegates — so a trusted admin can release while
 * the owner travels and hub cells do not understate for days.
 */
export function canReleaseStockHold(viewer, config) {
  if (!STOCK_HOLD_ENABLED) return false;
  if (isStockHoldSuperAdmin(viewer)) return true;
  const delegates = config && config.delegates;
  return !!(viewer && viewer.uid && delegates && delegates[viewer.uid]);
}

/** Should the temporary home card render for this viewer? */
export function stockHoldCardVisibleForViewer(viewer, config) {
  return canReleaseStockHold(viewer, config);
}
