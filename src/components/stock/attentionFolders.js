// ─── ATTENTION · FOLDERS ──────────────────────────────────────────────────────
// Named collections of products, gathered from the Attention grid and kept for
// later ("Winter clearance", "Reorder Monday", "Ask supplier about these").
//
// STORAGE: /attention_folders/{folderId}. This is a marathon-store-app path and
// the FIRST thing Attention writes — everything else on the screen is read-only.
//
// NOT /marketing. That tree belongs to marathon-ai (weekly advertising
// campaigns, Wednesday→Wednesday) and SCHEMA.md is explicit that this app never
// reads or writes it. A folder is a private working set, not a campaign; if the
// two are ever wired together it should be a deliberate hand-off, not this
// screen quietly writing into another app's data.
//
// SHAPE
//   /attention_folders/{folderId} = {
//     name:          string,          // trimmed, 1..NAME_MAX chars
//     createdAt:     number,          // ms since epoch
//     createdBy:     string,          // uid
//     createdByName: string,          // display snapshot, for "who made this"
//     items: { [productId]: { addedAt: number, addedBy: string } }
//   }
//
// Items are keyed BY PRODUCT ID, so adding the same product twice is idempotent
// — a folder can't accumulate duplicates however many times it's tapped.

export const NAME_MAX = 60;

// Trim and bound a folder name. Returns null when there's nothing usable, so
// callers have one "not a valid name" answer instead of guessing at empties.
export function normaliseFolderName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.slice(0, NAME_MAX);
}

// The record written on create. `nowMs` is passed in rather than read from the
// clock so this stays pure and testable.
export function newFolderRecord({ name, uid, displayName, nowMs }) {
  const clean = normaliseFolderName(name);
  if (!clean) throw new Error("A folder needs a name.");
  return {
    name: clean,
    createdAt: nowMs,
    createdBy: uid || null,
    createdByName: displayName || null,
    // No `items` key: RTDB drops empty objects, and an absent items node reads
    // back as "no items" everywhere below. Writing {} would be a lie that
    // survives exactly until the first read.
  };
}

export function newItemRecord({ uid, nowMs }) {
  return { addedAt: nowMs, addedBy: uid || null };
}

// Raw /attention_folders snapshot → display list, newest first.
// Defensive about shape: a folder without a name or with a non-object `items`
// is still listed (with a count of 0) rather than crashing the panel.
export function folderList(raw) {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .map(([id, f]) => ({
      id,
      name: typeof f?.name === "string" && f.name.trim() ? f.name : "Untitled folder",
      createdAt: Number.isFinite(f?.createdAt) ? f.createdAt : 0,
      createdBy: f?.createdBy || null,
      createdByName: f?.createdByName || null,
      productIds: itemIds(f),
    }))
    .map((f) => ({ ...f, count: f.productIds.length }))
    .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}

export function itemIds(folder) {
  const items = folder?.items;
  if (!items || typeof items !== "object") return [];
  return Object.keys(items);
}

// Which folders already hold this product — drives the tick in the add menu, so
// tapping "+" tells you where the product already is rather than silently
// re-adding it.
export function foldersHolding(list, productId) {
  const out = new Set();
  for (const f of list || []) if (f.productIds.includes(productId)) out.add(f.id);
  return out;
}

// A folder's products, in the order they were added, resolved against the
// catalogue. Products that have since left the catalogue are returned as
// `missing` rather than dropped, so a folder never silently shrinks — the
// operator can see something was removed and clear it.
export function resolveFolderProducts(folder, productsById) {
  return (folder?.productIds || []).map((id) => {
    const product = productsById?.[id];
    return product
      ? { id, product, missing: false, name: product.name || id, photo: product.photoUrl || product.photo || null }
      : { id, product: null, missing: true, name: id, photo: null };
  });
}
