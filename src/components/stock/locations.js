// ─── LOCATION REGISTRY HELPERS ────────────────────────────────────────────────
// The location registry (/locations) is the closed set of valid stock locations.
// CRITICAL: this module intentionally exposes NO routing logic — the topology is
// FLEXIBLE (any location may transfer to any other). We only label/filter the set;
// we never constrain from→to. See design/INVENTORY-DESIGN.md §1.2.
//
// DEFAULT_LOCATIONS is the approved seed (design §1.1). It is used to bootstrap the
// /locations node once (via the Stock UI / a seed script) — it is NOT the runtime
// source of truth; useLocations() reads /locations live. Kept here so the seed and
// the labels share one definition.

// The physical location set. Central is the receiving warehouse for inbound stock;
// hubs (1–3) are storage; shops are sellable. Each location holds its own per-size
// count under /stock/{id}/{productId}/{size} — independent numbers for the same
// product+size across locations. `in_transit` is kept for transfer backward-compat
// (excluded from the entry/transfer-target pickers).
//
// MERGED LOCATIONS (2026-07-26) — `studio` and `base` are DEACTIVATED, not removed.
// They were separate stock buckets inside Central's own building (building "A" in
// transitLanes.js), so they were consolidated into `central`: 1,347 ledger
// transfers moved 5,480 units across, leaving both drained to 0.
//
// They MUST stay in this list and in /locations. The live stock_movements rule
// validates from/to with root.child('locations').child(X).exists() — EXISTENCE, not
// `active` — so keeping them registered is what lets historical movements remain
// valid and a rollback remain possible. Deleting them would invalidate every
// movement that references them. `active: false` is enough to remove them from
// every picker, since all pickers funnel through activeLocations() below.
export const DEFAULT_LOCATIONS = [
  { id: "studio",        label: "Studio",         kind: "warehouse", sellable: false, active: false },
  { id: "central",       label: "Central",        kind: "warehouse", sellable: false, active: true },
  { id: "base",          label: "Base",           kind: "warehouse", sellable: false, active: false },
  { id: "hub1",          label: "Hub 1",          kind: "warehouse", sellable: false, active: true },
  { id: "hub2",          label: "Hub 2",          kind: "warehouse", sellable: false, active: true },
  { id: "hub3",          label: "Hub 3",          kind: "warehouse", sellable: false, active: true },
  { id: "marathon-pe",   label: "Marathon PE",    kind: "store",     sellable: true,  active: true },
  { id: "trophy",        label: "Trophy",         kind: "store",     sellable: true,  active: true },
  { id: "marathon-pine", label: "Pine",           kind: "store",     sellable: true,  active: true },
  { id: "in_transit",    label: "In Transit",     kind: "transit",   sellable: false, active: true },
];

const _defaultById = Object.fromEntries(DEFAULT_LOCATIONS.map(l => [l.id, l]));

// Label for a location id, falling back to the live registry then the seed then
// the raw id (so an un-seeded id still renders something readable).
export function labelFor(locationId, registry) {
  if (registry && registry[locationId]?.label) return registry[locationId].label;
  return _defaultById[locationId]?.label || locationId || "—";
}

// registry: the object map from useLocations() ({ id: {…} }) OR undefined/empty (→ seed).
// useLocations() returns {} before /locations is seeded, so an empty object must fall
// back to the seed — otherwise every picker would be empty pre-rollout.
function asArray(registry) {
  if (registry && typeof registry === "object" && Object.keys(registry).length > 0) return Object.values(registry);
  return DEFAULT_LOCATIONS;
}

export const activeLocations    = (registry) => asArray(registry).filter(l => l && l.active !== false);
export const sellableLocations  = (registry) => activeLocations(registry).filter(l => l.kind === "store" && l.sellable);
export const warehouseLocations = (registry) => activeLocations(registry).filter(l => l.kind === "warehouse");
// Transfer targets = EVERY active location except in_transit (which is the implicit
// holding, never a manual target). Deliberately returns ALL of them — no routing.
export const transferTargets    = (registry) => activeLocations(registry).filter(l => l.id !== "in_transit");

// EVERY registered location id, active or not. Not a picker helper — every
// picker wants the ACTIVE ones — but a carriage CONTEXT is not a picker: a
// deactivated warehouse (studio, base) still holds cells the engine counts, and
// a product's held stock must be reported from all of them. Falls back to the
// seed exactly as activeLocations does, so an unseeded /locations node does not
// silently narrow the snapshot. (Was private to SeatingTab; the product-actions
// sheet needs the same list, so there is now ONE definition.)
export function allLocationIds(registry) {
  const ids = registry && typeof registry === "object" ? Object.keys(registry) : [];
  return ids.length ? ids : DEFAULT_LOCATIONS.map((l) => l.id);
}

export const IN_TRANSIT = "in_transit";

// Default receiving warehouse: the pre-selected destination for the New Product /
// edit-page receive pickers and the transfer source default (any can be changed in
// the picker). "central" is a real seeded /locations id.
export const RECEIVING_DEFAULT = "central";
