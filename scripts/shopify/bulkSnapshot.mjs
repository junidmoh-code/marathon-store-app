// ─── EVERY ACTIVE SHOPIFY VARIANT IN ONE READ — the nightly sweep's eyes ─────
//
// The sweep has to know, for every active listing, every variant's tracking,
// policy and quantity. Asking product by product costs ~200 query-cost points
// each (a `variants(first: 100)` connection is priced at its maximum), and the
// shop's throttle restores ~100 points a second — so the first version of the
// sweep took well over half an hour for 1,832 listings. A BULK OPERATION has no
// throttle: Shopify runs the query on its side and hands back one JSONL file.
// One mutation, a few polls, one download.
//
// What comes back is only READ here. Every correction still goes through
// syncProduct, which re-reads the product it is about to write and
// compare-and-sets against that fresh read — a snapshot minutes old never
// becomes a baseline for a write.

export const BULK_POLL_MS = 3000;
export const BULK_TIMEOUT_MS = 20 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bulkQuery(locationId) {
  return `{
    products(query: "status:active") {
      edges { node { id
        variants { edges { node { id title inventoryPolicy
          inventoryItem { id tracked
            inventoryLevel(locationId: "${locationId}") { quantities(names: ["available", "on_hand"]) { name quantity } }
          }
        } } }
      } }
    }
  }`;
}

/**
 * PURE: the JSONL Shopify returns → Map(productGid → { variants, baseline }).
 * `variants` has readProductVariants' shape; `baseline` maps inventory item →
 * on_hand, readAvailable's shape — so planProduct takes them unchanged.
 */
export function parseSnapshot(jsonl) {
  const products = new Map();
  const lines = String(jsonl || "").split("\n").filter((l) => l.trim());
  const variantLines = [];
  for (const line of lines) {
    const o = JSON.parse(line);
    if (o.__parentId) variantLines.push(o);
    else if (String(o.id).includes("/Product/")) products.set(o.id, { variants: [], baseline: new Map() });
  }
  for (const v of variantLines) {
    const p = products.get(v.__parentId);
    if (!p) continue;
    const itemId = v.inventoryItem?.id ?? null;
    p.variants.push({
      variantId: v.id, title: v.title, inventoryItemId: itemId,
      tracked: v.inventoryItem?.tracked, inventoryPolicy: v.inventoryPolicy,
    });
    // No inventory level at the location = UNKNOWN, exactly as readAvailable
    // treats it: such an item cannot be written, so it is never a baseline.
    const qs = v.inventoryItem?.inventoryLevel?.quantities;
    if (itemId && Array.isArray(qs)) {
      const q = qs.find((x) => x.name === "on_hand") ?? qs.find((x) => x.name === "available");
      p.baseline.set(itemId, q?.quantity ?? 0);
    }
  }
  return products;
}

/** Run the bulk query, wait for it, download and parse it. */
export async function readShopSnapshot(graphql, locationId, { fetchImpl = fetch, log = () => {} } = {}) {
  const started = Date.now();
  let op = null;
  // Another bulk query of this app may be running (only one at a time): wait.
  for (;;) {
    const res = await graphql(
      `mutation ($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
      { q: bulkQuery(locationId) }, { mutation: true },
    );
    const errs = res.bulkOperationRunQuery.userErrors || [];
    if (!errs.length) { op = res.bulkOperationRunQuery.bulkOperation; break; }
    if (!errs.some((e) => /already in progress/i.test(e.message)) || Date.now() - started > BULK_TIMEOUT_MS) {
      throw new Error(`bulkOperationRunQuery refused: ${JSON.stringify(errs)}`);
    }
    log("  another bulk query is running — waiting");
    await sleep(15_000);
  }
  for (;;) {
    await sleep(BULK_POLL_MS);
    const r = await graphql(`query ($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } } }`, { id: op.id });
    const n = r.node;
    if (n.status === "COMPLETED") {
      // No file means nothing matched. The CALLER decides whether an empty
      // shop is believable (it checks against the published products).
      if (!n.url) return new Map();
      const res = await fetchImpl(n.url);
      if (!res.ok) throw new Error(`bulk snapshot download failed: HTTP ${res.status}`);
      const snap = parseSnapshot(await res.text());
      return snap;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(n.status)) throw new Error(`bulk snapshot ${n.status} (${n.errorCode || "no code"})`);
    if (Date.now() - started > BULK_TIMEOUT_MS) throw new Error(`bulk snapshot still ${n.status} after ${BULK_TIMEOUT_MS / 60000} min`);
  }
}
