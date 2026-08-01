// ─── ATTENTION · LISTS ────────────────────────────────────────────────────────
// Two fixed destinations for products picked off the Attention grid:
//
//   MARKETING — the week's advertising shortlist.
//   DISPLAY   — what should go out on the shop floor.
//
// FIXED, not free-form. There is no "create a folder" step: the ✚ on a product
// offers exactly these two, so picking is one tap and the same two lists mean
// the same thing to everyone using the app. Adding a third is a code change,
// which is the right amount of friction for something two people have to agree
// on.
//
// STORAGE: /attention_lists/{listId}/items/{productId}. This is the ONLY path
// Attention writes; everything else that screen shows it reads.
//
// NOT /marketing. That tree belongs to marathon-ai (weekly advertising
// campaigns) and SCHEMA.md is explicit that this app never reads or writes it.
// The Marketing list here is a shortlist a human is still assembling — if it
// ever feeds a real campaign that should be a deliberate hand-off, not this
// screen writing into another app's data.
//
// Items are keyed BY PRODUCT ID, so adding the same product twice is
// idempotent — a list can't accumulate duplicates however many times it's
// tapped, and removing is a single delete at a known path.

export const LIST_MARKETING = "marketing";
export const LIST_DISPLAY = "display";

export const LISTS = Object.freeze([
  { id: LIST_MARKETING, label: "Marketing", blurb: "Picked to advertise" },
  { id: LIST_DISPLAY,   label: "Display",   blurb: "Send out to the floor" },
]);

export const isListId = (id) => LISTS.some((l) => l.id === id);

export function newItemRecord({ uid, nowMs }) {
  return { addedAt: nowMs, addedBy: uid || null };
}

// Product ids in one list, oldest addition first — the order they were picked,
// which is the order someone would work through them.
export function itemIds(listNode) {
  const items = listNode?.items;
  if (!items || typeof items !== "object") return [];
  return Object.entries(items)
    .sort((a, b) => (a[1]?.addedAt || 0) - (b[1]?.addedAt || 0))
    .map(([pid]) => pid);
}

// Raw /attention_lists snapshot → both lists, always both, always in the same
// order. A missing node is an EMPTY list, not an absent one: the tabs must not
// appear and disappear depending on whether anyone has picked anything yet.
export function listSummaries(raw) {
  return LISTS.map((l) => {
    const productIds = itemIds(raw?.[l.id]);
    return { ...l, productIds, count: productIds.length };
  });
}

// Which lists already hold this product — drives the ticks in the ✚ menu, so
// the button also answers "have I already picked this?".
export function listsHolding(summaries, productId) {
  const out = new Set();
  for (const l of summaries || []) if (l.productIds.includes(productId)) out.add(l.id);
  return out;
}

// A list's products resolved against the catalogue. Ids that have since left
// /products are returned flagged as `missing` rather than dropped, so a list
// never silently shrinks — the operator can see something went and clear it.
export function resolveListProducts(summary, productsById) {
  return (summary?.productIds || []).map((id) => {
    const product = productsById?.[id];
    return product
      ? { id, product, missing: false, name: product.name || id, photo: product.photoUrl || product.photo || null }
      : { id, product: null, missing: true, name: id, photo: null };
  });
}
