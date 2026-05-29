// ─── PER-USER STORE ASSIGNMENT (Phase 15) ────────────────────────────────────
// Pure helpers for restricting which operational store(s) a staff member may
// place orders against. Kept React-free so they can be unit-tested directly and
// reused by both the admin UI (UserManagement) and the order flow (AssistantView).
//
// Data model — /users/{uid}.storeIds: string[] of STORE_IDS values.
//   • field ABSENT (legacy users)  → all-access (backward-compatible, no migration)
//   • field present, non-empty     → exactly those stores
//   • field present, empty []      → NO store access (order flow blocks)
//
// This scope is SEPARATE from marathon-pos-app's /users/{uid}/posAccess.storeIds —
// the two apps each track their own store scope.

// The two operational stores an order can be placed against. Mirrors the
// Central / Pine toggle in AssistantView.
export const STORE_IDS = ["central", "pine"];

export const STORE_LABELS = { central: "Central", pine: "Pine" };

// Resolve the stores a user may actually place orders against.
//   • super-admin               → all stores (bypass, per ADMIN_EMAIL)
//   • no storeIds field (legacy) → all stores (backward-compatible)
//   • storeIds present           → that list, filtered to known stores
// An empty result means "no store access" — the caller should block the flow.
export function effectiveStoreIds(permRecord, isSuperAdmin = false) {
  if (isSuperAdmin) return [...STORE_IDS];
  const raw = permRecord?.storeIds;
  if (!Array.isArray(raw)) return [...STORE_IDS]; // legacy = all-access
  return raw.filter((s) => STORE_IDS.includes(s));
}

// Compute the next storeIds array after toggling one store on/off.
// Seeds from all stores when the field is absent so a legacy (all-access) user
// who unchecks ONE store keeps access to the other — rather than collapsing to
// just the toggled store. Result is always filtered to known stores and ordered
// by STORE_IDS for stable persistence.
export function nextStoreIds(currentStoreIds, storeId, on) {
  const base = Array.isArray(currentStoreIds) ? currentStoreIds : [...STORE_IDS];
  const set = new Set(base.filter((s) => STORE_IDS.includes(s)));
  if (on) set.add(storeId);
  else set.delete(storeId);
  return STORE_IDS.filter((s) => set.has(s));
}

// Does this user place orders? Used to decide whether an empty store scope is a
// problem worth flagging. role "store_assistant" or the place_orders /
// store_assistant permissions all mean "takes orders".
export function placesOrders(user) {
  if (!user) return false;
  if (user.role === "store_assistant") return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes("place_orders") || perms.includes("store_assistant");
}

// Warn on the admin row/detail when an order-taker has been locked out of every
// store (explicit empty array). Absent field is fine — that's all-access.
export function shouldWarnNoStore(user) {
  return Array.isArray(user?.storeIds) && user.storeIds.length === 0 && placesOrders(user);
}
