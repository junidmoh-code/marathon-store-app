// ─── WHICH TILL'S SLIP THIS ACCOUNT SENDS ────────────────────────────────────
// The client half of functions/lib/card-slip-scope.cjs (Junid, 16 Oct 2026).
// The scope sits on the person's own /users record — the one AuthGate already
// subscribes to — as cardSlipTills/{storeId}/{tillId} = true, written by the
// Admin SDK only. Which terminal stands at that till is the registry's answer
// (its placement in force now, else its own row), exactly as the server asks
// it. The SERVER decides; this only chooses what to draw.
//
// Kept in step with the server by a contract test (slipScope.test.js), which
// runs both over the same inputs.

import { captureCards, typesTotal } from "./terminalRegistry";

export const SLIP_SCOPE_FIELD = "cardSlipTills";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** The tills a stored scope grants, as "storeId/tillId". Anything malformed grants nothing. */
export function readSlipScope(raw) {
  const out = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [storeId, tills] of Object.entries(raw)) {
    if (!ID_RE.test(storeId) || !tills || typeof tills !== "object" || Array.isArray(tills)) continue;
    for (const [tillId, on] of Object.entries(tills)) {
      if (on === true && ID_RE.test(tillId)) out.push(`${storeId}/${tillId}`);
    }
  }
  return out.sort();
}

/** Does this /users record give its holder any till's slip to send? */
export function hasSlipScope(permRecord) {
  return readSlipScope(permRecord?.[SLIP_SCOPE_FIELD]).length > 0;
}

/** Where a registry row's machine stands at `atMs`: its placement in force, else its own till. */
export function tillNow(row, atMs) {
  const placements = Object.values(row?.placements || {})
    .filter((p) => p && typeof p.storeId === "string" && p.storeId && typeof p.tillId === "string" && p.tillId
      && Number.isFinite(Number(p.effectiveFrom)))
    .sort((a, b) => Number(a.effectiveFrom) - Number(b.effectiveFrom));
  let hit = null;
  if (Number.isFinite(atMs)) for (const p of placements) { if (Number(p.effectiveFrom) <= atMs) hit = p; else break; }
  return hit ? { storeId: hit.storeId, tillId: hit.tillId, label: hit.label || null }
    : { storeId: row?.storeId, tillId: row?.tillId, label: row?.label || null };
}

/**
 * The tills this account sends the slip for, each with the machine standing
 * at it now: [{ tid, storeId, tillId, label }], in registry order. A retired
 * machine is never one (captureCards drops it).
 */
export function slipTills(terminals, permRecord, nowMs) {
  const scope = readSlipScope(permRecord?.[SLIP_SCOPE_FIELD]);
  if (!scope.length) return [];
  return captureCards(terminals)
    // typed: the machine prints no readable total (Trophy Till 2), so the
    // person types it beside the photo. Every other till: the photo alone —
    // the total is read off it (Junid, 17 Oct 2026).
    .map((t) => ({ tid: t.tid, typed: typesTotal(t), ...tillNow(t, nowMs) }))
    .map((t) => ({ ...t, label: t.label || `${t.storeId} · ${t.tillId}` }))
    .filter((t) => scope.includes(`${t.storeId}/${t.tillId}`));
}
