// ─── WHEN A PRODUCT MAY BE DELETED (Junid, 25 Oct 2026) ──────────────────────
//
// The admin product page's Delete removes /products/{pid} and NOTHING else.
// Finance found nine live Shopify listings pointing at products deleted that
// way: their /stock cells and their Shopify link outlived the record, so the
// nightly sweep kept pushing the orphaned cells to the website and web orders
// sold pairs no till could ring (no product to scan). A merge never does this —
// the merged-away record keeps its node with `mergedInto` (product-merge.cjs).
//
// So Delete is only for a record that never became anything: no stock cell at
// any location (a cell exists once stock ever moved, even at qty 0 — it is
// history, and sales are stamped with the id) and no Shopify link. Anything
// else is a finished line (Deactivate, on the Leftovers tab) or a duplicate
// (Merge), and both keep the record.
//
// FAILS CLOSED: a read that throws is a refusal, never a pass.

// Pure. `cells`: [{ loc, sizes }] for every location holding a node for this
// product; `shopifyProductId` / `publishState`: the link, or null;
// `mergedInto`: set on a merged-away record, whose node IS the redirect that
// old sales, scans and devices follow to the survivor.
export function judgeProductDelete({ cells = [], shopifyProductId = null, publishState = null, mergedInto = null } = {}) {
  const reasons = [];
  if (mergedInto) reasons.push(`it was merged into ${mergedInto} and its record is the redirect old sales and labels follow`);
  const held = cells.filter((c) => c && c.sizes > 0);
  if (held.length) reasons.push(`it has stock records at ${held.map((c) => c.loc).join(", ")}`);
  if (shopifyProductId || publishState) reasons.push("it is linked to a Shopify listing");
  if (!reasons.length) return { ok: true };
  return {
    ok: false,
    reasons,
    message: `This product can't be deleted: ${reasons.join(" and ")}. ` +
      "Deleting it would leave that stock and the website listing pointing at nothing. " +
      "If the line is finished, Deactivate it (Leftovers tab). If it is a duplicate, Merge it into the right product.",
  };
}

// `read(path)` resolves to the value at that path (null when absent).
// /locations is the registry the merge reads too; in_transit is not in it.
export async function checkProductDelete(read, pid) {
  try {
    const registry = await read("locations");
    if (!registry || typeof registry !== "object" || !Object.keys(registry).length) {
      return { ok: false, reasons: ["unreadable registry"], message: "The location list could not be read, so this product was not deleted. Try again." };
    }
    const locs = [...new Set([...Object.keys(registry), "in_transit"])];
    const nodes = await Promise.all(locs.map((loc) => read(`stock/${loc}/${pid}`)));
    const cells = locs.map((loc, i) => ({ loc, sizes: nodes[i] && typeof nodes[i] === "object" ? Object.keys(nodes[i]).length : 0 }));
    // state OR desiredState: a first publish still pending has no state yet.
    const [shopifyProductId, state, desiredState, mergedInto] = await Promise.all([
      read(`shopify_sync/${pid}/shopifyProductId`),
      read(`shopify_publish/${pid}/state`),
      read(`shopify_publish/${pid}/desiredState`),
      read(`products/${pid}/mergedInto`),
    ]);
    return judgeProductDelete({ cells, shopifyProductId, publishState: state ?? desiredState, mergedInto });
  } catch (e) {
    return { ok: false, reasons: ["read failed"], message: `Could not check this product (${String(e?.message || e)}), so it was not deleted.` };
  }
}
