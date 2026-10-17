// ─── ONE-SHOP VIEWERS: WHICH STOCK LOCATIONS A SCREEN MAY SHOW ───────────────
// An account scoped to one shop (/users/{uid}/destShop — the same field the
// live /orders read rule and the Store Assistant screen scope by) sees that
// shop and the hubs holding its back stock, and no other shop (owner,
// 2026-10-17: a Marathon PE assistant never sees Trophy's stock, and the other
// way round). No destShop = every location, exactly as before.
//
// The hubs are shared back stock (registry.backStock): Marathon PE and Trophy
// both draw on Hub 1 and Hub 2, so a hub is never "the other store's".
//
// /stock is readable by every signed-in account in the live rules, so this is
// the screens' scope, not the database's; see PR #737.
import { SEED_REGISTRY } from "./networkRegistry.js";

/** null = no scope (every location); otherwise the location ids this viewer may see. */
export function scopedLocationIds(destShop, registry = SEED_REGISTRY) {
  if (!destShop) return null;
  const back = (registry?.backStock || SEED_REGISTRY.backStock)?.[destShop] || {};
  return [destShop, ...new Set(Object.values(back).filter(Boolean))];
}

/** Keep only the entries a scoped viewer may see; `idOf` reads an entry's location id. */
export function withinScope(list, destShop, idOf = (x) => x?.id, registry) {
  const ids = scopedLocationIds(destShop, registry);
  return ids ? (list || []).filter((x) => ids.includes(idOf(x))) : list || [];
}
