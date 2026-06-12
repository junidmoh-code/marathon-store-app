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

export const DEFAULT_LOCATIONS = [
  { id: "warehouse1",    label: "Warehouse 1",    kind: "warehouse", sellable: false, active: true },
  { id: "hub1",          label: "Hub 1",          kind: "warehouse", sellable: false, active: true },
  { id: "hub2",          label: "Hub 2",          kind: "warehouse", sellable: false, active: true },
  { id: "hub2b",         label: "Hub 2B",         kind: "warehouse", sellable: false, active: true },
  { id: "hub3",          label: "Hub 3",          kind: "warehouse", sellable: false, active: true },
  { id: "hubC",          label: "Hub C",          kind: "warehouse", sellable: false, active: true },
  { id: "marathon-pe",   label: "Marathon PE",    kind: "store",     sellable: true,  active: true },
  { id: "marathon-pine", label: "Marathon Pine",  kind: "store",     sellable: true,  active: true },
  { id: "trophy",        label: "Trophy",         kind: "store",     sellable: true,  active: true },
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

export const IN_TRANSIT = "in_transit";
